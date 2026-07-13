import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/guard";
import { checkTtsRateLimit } from "@/lib/rateLimit";
import { getRepository } from "@/lib/storage/repository";
import { getVoiceObjectStore } from "@/lib/storage/voiceObjectStore";
import { logger } from "@/lib/logger";
import { normalizeSpeechControls } from "@/lib/speechPlanning";
import { resolveVoiceSynthesisSource } from "@/lib/voiceSynthesisSource";
import { synthesizeResolvedVoice } from "@/lib/voiceSynthesisService";
import {
  canSynthesizeVoice,
  isVoiceAuthorizationEnforced,
} from "@/lib/voiceAuthorizationPolicy";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const requestStartedAt = performance.now();
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const repository = getRepository();

  let body: { voiceId?: string; personaId?: string; text?: string; speech?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const text = (body.text || "").trim();
  if (!text) return NextResponse.json({ error: "缺少 text" }, { status: 400 });
  if (text.length > 500) {
    return NextResponse.json({ error: "text 不得超过 500 字" }, { status: 400 });
  }

  let voiceId = (body.voiceId || "").trim();
  if (!voiceId && body.personaId) {
    const p = await repository.getPersonaForUser(body.personaId.trim(), auth.userId);
    if (!p) return NextResponse.json({ error: "personaId 不存在或不属于你" }, { status: 403 });
    voiceId = p.voiceId;
  }
  if (!voiceId) {
    return NextResponse.json({ error: "缺少 voiceId 或 personaId" }, { status: 400 });
  }

  const authorization = await repository.getCurrentVoiceAuthorization(voiceId, auth.userId);
  if (!canSynthesizeVoice({
    authorization,
    enforcementEnabled: isVoiceAuthorizationEnforced(),
  })) {
    const revoked = authorization?.status === "revoked";
    return NextResponse.json({
      error: revoked ? "该声音的合成授权已撤回" : "该声音尚未完成授权",
      code: revoked ? "VOICE_AUTHORIZATION_REVOKED" : "VOICE_AUTHORIZATION_REQUIRED",
    }, { status: 403 });
  }

  const voice = await resolveVoiceSynthesisSource(
    getVoiceObjectStore(),
    voiceId,
    auth.userId,
  );
  if (!voice) return NextResponse.json({ error: "voiceId 不存在或不属于你" }, { status: 404 });
  const storageMs = Math.round(performance.now() - requestStartedAt);

  // 只让通过校验且确实要调用供应商的请求消耗额度
  const limit = checkTtsRateLimit(auth.userId);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `今日 TTS 额度已用完（剩余 ${limit.remaining} 次），明天重置。`,
        resetAt: new Date(limit.resetAt).toISOString(),
      },
      { status: 429 },
    );
  }

  const speech = normalizeSpeechControls(body.speech);

  try {
    const providerStartedAt = performance.now();
    const synthesis = await synthesizeResolvedVoice({
      voiceId,
      userId: auth.userId,
      text,
      speech: speech || undefined,
      source: voice,
      store: getVoiceObjectStore(),
      repository,
    });
    const audio = synthesis.audio;
    const providerMs = Math.round(performance.now() - providerStartedAt);
    const totalMs = Math.round(performance.now() - requestStartedAt);
    logger.info("tts_completed", {
      voiceId,
      userId: auth.userId,
      characters: text.length,
      emotion: speech?.emotion || "natural",
      voiceSource: synthesis.source,
      presetFallback: synthesis.fellBack,
      storageMs,
      providerMs,
      totalMs,
    });
    const bodyOut = new Uint8Array(audio);
    return new NextResponse(bodyOut, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "Content-Length": String(bodyOut.byteLength),
        "X-RateLimit-Remaining": String(limit.remaining),
        "X-TTS-Ms": String(totalMs),
        "X-Voice-Source": synthesis.source,
        "X-Voice-Fallback": synthesis.fellBack ? "preset-to-dynamic" : "none",
        "Server-Timing": `storage;dur=${storageMs}, tts;dur=${providerMs}, total;dur=${totalMs}`,
      },
    });
  } catch (err) {
    const providerCode = err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code || "")
      : "";
    if (providerCode.endsWith("_20015")) {
      return NextResponse.json(
        { error: "当前绑定的参考声音超过 CosyVoice 单段 30 秒上限。请把长音频切成多段素材上传，并在人物里绑定其中一段 10 到 30 秒的清晰人声。" },
        { status: 400 },
      );
    }
    logger.error("tts_failed", {
      voiceId,
      userId: auth.userId,
      errorType: err instanceof Error ? err.name : "unknown",
      totalMs: Math.round(performance.now() - requestStartedAt),
    });
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return NextResponse.json(
      { error: timeout ? "语音生成超时，请重试" : "语音生成暂时失败，请稍后重试" },
      { status: timeout ? 504 : 502 },
    );
  }
}
