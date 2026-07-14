import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "./guard";
import { logger } from "./logger";
import { stableProviderErrorCode } from "./providerErrors";
import { checkTtsRateLimit } from "./rateLimit";
import { normalizeSpeechControls, sanitizeSpeechText } from "./speechPlanning";
import { getRepository } from "./storage/repository";
import { getVoiceObjectStore } from "./storage/voiceObjectStore";
import type { VoiceObjectStore } from "./storage/voiceObjectStore";
import type { AppRepository } from "./storage/types";
import { resolveTtsVoiceId } from "./ttsVoiceBinding";
import { synthesizeResolvedVoice } from "./voiceSynthesisService";
import { resolveVoiceSynthesisSource } from "./voiceSynthesisSource";
import {
  canSynthesizeVoice,
  isVoiceAuthorizationEnforced,
} from "./voiceAuthorizationPolicy";

export const TTS_MODEL = process.env.COSYVOICE_MODEL || "FunAudioLLM/CosyVoice2-0.5B";
export const TTS_CONFIG_VERSION = "speech-plan-v1";

type AuthResult = Awaited<ReturnType<typeof requireAuth>>;
type StableLogFields = Record<string, string | number | boolean | null>;

export type TtsRouteDependencies = {
  requireAuth: (request: NextRequest) => Promise<AuthResult>;
  getRepository: () => AppRepository;
  getVoiceObjectStore: () => VoiceObjectStore;
  checkTtsRateLimit: typeof checkTtsRateLimit;
  resolveVoiceSynthesisSource: typeof resolveVoiceSynthesisSource;
  synthesizeResolvedVoice: typeof synthesizeResolvedVoice;
  isVoiceAuthorizationEnforced: () => boolean;
  randomUUID: () => string;
  nowMs: () => number;
  logInfo: (event: string, data?: StableLogFields) => void;
  logError: (event: string, data?: StableLogFields) => void;
};

const defaults: TtsRouteDependencies = {
  requireAuth,
  getRepository,
  getVoiceObjectStore,
  checkTtsRateLimit,
  resolveVoiceSynthesisSource,
  synthesizeResolvedVoice,
  isVoiceAuthorizationEnforced,
  randomUUID,
  nowMs: () => performance.now(),
  logInfo: (event, data) => logger.info(event, data),
  logError: (event, data) => logger.error(event, data),
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function jsonError(error: string, status: number, code?: string): NextResponse {
  return NextResponse.json(code ? { error, code } : { error }, { status });
}

function normalizedOptionalId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authorizationError(status: string | undefined): NextResponse {
  const revoked = status === "revoked";
  return NextResponse.json({
    error: revoked ? "该声音的合成授权已撤回" : "该声音尚未完成授权",
    code: revoked ? "VOICE_AUTHORIZATION_REVOKED" : "VOICE_AUTHORIZATION_REQUIRED",
  }, { status: 403 });
}

function rateLimitError(limit: { remaining: number; resetAt: number }): NextResponse {
  return NextResponse.json(
    {
      error: `今日 TTS 额度已用完（剩余 ${limit.remaining} 次），明天重置。`,
      resetAt: new Date(limit.resetAt).toISOString(),
    },
    { status: 429 },
  );
}

export function createTtsHandlers(overrides: Partial<TtsRouteDependencies> = {}) {
  const deps = { ...defaults, ...overrides };

  async function POST(request: NextRequest): Promise<NextResponse> {
    const requestStartedAt = deps.nowMs();
    const auth = await deps.requireAuth(request);
    if ("error" in auth) return auth.error;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("请求体必须是 JSON", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError("请求体必须是 JSON 对象", 400);
    }
    const input = body as Record<string, unknown>;
    const hasSentenceId = Object.prototype.hasOwnProperty.call(input, "sentenceId");
    const sentenceId = normalizedOptionalId(input.sentenceId);
    if (hasSentenceId && (!sentenceId || sentenceId.length > 200)) {
      return jsonError("sentenceId 无效", 400);
    }

    const repository = deps.getRepository();
    const store = deps.getVoiceObjectStore();
    let voiceId: string;
    let spokenText: string;
    let speech: ReturnType<typeof normalizeSpeechControls>;

    if (hasSentenceId) {
      const sentence = await repository.getConversationSentenceForSynthesis(
        sentenceId,
        auth.userId,
      );
      if (!sentence) return jsonError("sentenceId 不存在或不属于你", 404);
      voiceId = sentence.voiceId;
      spokenText = sanitizeSpeechText(sentence.text);
      speech = {
        emotion: sentence.emotion,
        intensity: sentence.intensity,
        speed: sentence.speed,
      };
    } else {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) return jsonError("缺少 text", 400);
      if (text.length > 500) return jsonError("text 不得超过 500 字", 400);
      spokenText = sanitizeSpeechText(text);
      if (!spokenText) return jsonError("没有可朗读的内容", 400);
      const binding = await resolveTtsVoiceId({
        requestedVoiceId: input.voiceId,
        personaId: input.personaId,
        userId: auth.userId,
        repository,
      });
      if (binding.status === "persona_not_found") {
        return jsonError("personaId 不存在或不属于你", 403);
      }
      if (binding.status === "voice_required") {
        return jsonError("缺少 voiceId 或 personaId", 400);
      }
      voiceId = binding.voiceId;
      speech = normalizeSpeechControls(input.speech);
    }

    if (!spokenText) return jsonError("没有可朗读的内容", 400);
    const authorization = await repository.getCurrentVoiceAuthorization(voiceId, auth.userId);
    if (!canSynthesizeVoice({
      authorization,
      enforcementEnabled: deps.isVoiceAuthorizationEnforced(),
    })) {
      return authorizationError(authorization?.status);
    }

    const source = await deps.resolveVoiceSynthesisSource(store, voiceId, auth.userId);
    if (!source) return jsonError("voiceId 不存在或不属于你", 404);
    const storageMs = Math.round(deps.nowMs() - requestStartedAt);
    const limit = deps.checkTtsRateLimit(auth.userId);
    if (!limit.allowed) return rateLimitError(limit);

    let attemptId: string | null = null;
    if (hasSentenceId) {
      attemptId = deps.randomUUID();
      try {
        await repository.startTtsAttempt({
          id: attemptId,
          sentenceId,
          evaluatorUserId: auth.userId,
          voiceSource: source.mode,
          providerVoiceId: source.mode === "preset" ? source.presetVoiceId : null,
          ttsModel: TTS_MODEL,
          ttsConfigVersion: TTS_CONFIG_VERSION,
        });
      } catch (error) {
        deps.logError("tts_attempt_start_failed", {
          sentenceId,
          userId: auth.userId,
          errorName: errorName(error),
        });
        return jsonError("语音追踪创建失败，请重试", 409, "TTS_ATTEMPT_START_FAILED");
      }
    }

    try {
      const providerStartedAt = deps.nowMs();
      const synthesis = await deps.synthesizeResolvedVoice({
        voiceId,
        userId: auth.userId,
        text: spokenText,
        speech: speech || undefined,
        source,
        store,
        repository,
      });
      const providerMs = Math.round(deps.nowMs() - providerStartedAt);
      const totalMs = Math.round(deps.nowMs() - requestStartedAt);
      if (attemptId) {
        await repository.completeTtsAttempt({
          id: attemptId,
          evaluatorUserId: auth.userId,
          voiceSource: synthesis.source,
          fellBack: synthesis.fellBack,
          storageMs,
          providerMs,
          totalMs,
        });
      }
      deps.logInfo("tts_completed", {
        voiceId,
        userId: auth.userId,
        attemptId,
        characters: spokenText.length,
        emotion: speech?.emotion || "natural",
        voiceSource: synthesis.source,
        presetFallback: synthesis.fellBack,
        storageMs,
        providerMs,
        totalMs,
      });
      const bodyOut = new Uint8Array(synthesis.audio);
      const headers: Record<string, string> = {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "Content-Length": String(bodyOut.byteLength),
        "X-RateLimit-Remaining": String(limit.remaining),
        "X-TTS-Ms": String(totalMs),
        "X-Voice-Source": synthesis.source,
        "X-Voice-Fallback": synthesis.fellBack ? "preset-to-dynamic" : "none",
        "Server-Timing": `storage;dur=${storageMs}, tts;dur=${providerMs}, total;dur=${totalMs}`,
      };
      if (attemptId) headers["X-TTS-Attempt-ID"] = attemptId;
      return new NextResponse(bodyOut, { status: 200, headers });
    } catch (error) {
      const totalMs = Math.round(deps.nowMs() - requestStartedAt);
      const stableErrorCode = stableProviderErrorCode(error);
      if (attemptId) {
        try {
          await repository.failTtsAttempt({
            id: attemptId,
            evaluatorUserId: auth.userId,
            stableErrorCode,
            totalMs,
          });
        } catch (persistenceError) {
          deps.logError("tts_attempt_failure_persistence_failed", {
            attemptId,
            userId: auth.userId,
            errorName: errorName(persistenceError),
          });
        }
      }
      deps.logError("tts_failed", {
        voiceId,
        userId: auth.userId,
        attemptId,
        stableErrorCode,
        errorName: errorName(error),
        totalMs,
      });
      if (stableErrorCode.endsWith("_20015")) {
        return jsonError(
          "当前绑定的参考声音超过 CosyVoice 单段 30 秒上限。请把长音频切成多段素材上传，并在人物里绑定其中一段 10 到 30 秒的清晰人声。",
          400,
        );
      }
      const timeout = stableErrorCode === "provider_timeout";
      return jsonError(timeout ? "语音生成超时，请重试" : "语音生成暂时失败，请稍后重试", timeout ? 504 : 502);
    }
  }

  return { POST };
}
