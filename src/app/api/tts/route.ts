import { NextRequest, NextResponse } from "next/server";
import { loadVoiceForUser, readAudioBase64ForUser } from "@/lib/voiceStore";
import { synthesizeWithClonedVoice } from "@/lib/cosyvoice";
import { getPersonaForUser } from "@/lib/db";
import { requireAuth } from "@/lib/guard";
import { checkTtsRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  // 速率限制
  const limit = checkTtsRateLimit(auth.userId);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `今日 TTS 额度已用完（${limit.remaining}/50），明天重置。`,
        resetAt: new Date(limit.resetAt).toISOString(),
      },
      { status: 429 },
    );
  }

  let body: { voiceId?: string; personaId?: string; text?: string };
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
    const p = getPersonaForUser(body.personaId.trim(), auth.userId);
    if (!p) return NextResponse.json({ error: "personaId 不存在或不属于你" }, { status: 403 });
    voiceId = p.voiceId;
  }
  if (!voiceId) {
    return NextResponse.json({ error: "缺少 voiceId 或 personaId" }, { status: 400 });
  }

  const meta = await loadVoiceForUser(voiceId, auth.userId);
  if (!meta) return NextResponse.json({ error: "voiceId 不存在或不属于你" }, { status: 404 });

  const refB64 = await readAudioBase64ForUser(voiceId, auth.userId);
  if (!refB64) return NextResponse.json({ error: "参考音频读取失败" }, { status: 500 });

  const refMime = meta.mimeType || "audio/wav";

  try {
    const audio = await synthesizeWithClonedVoice({
      text,
      referenceAudioBase64: refB64,
      referenceMime: refMime,
      referenceText: meta.promptText,
      responseFormat: "mp3",
      // 不传 instruct：让 CosyVoice2 完全从参考音频学习语调和韵律
    });
    const bodyOut = new Uint8Array(audio);
    return new NextResponse(bodyOut, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "Content-Length": String(bodyOut.byteLength),
        "X-RateLimit-Remaining": String(limit.remaining),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
