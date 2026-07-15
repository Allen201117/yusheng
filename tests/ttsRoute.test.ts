import { it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import {
  createTtsHandlers,
  TTS_CONFIG_VERSION,
  TTS_MODEL,
} from "../src/lib/ttsRoute";
import type {
  AppRepository,
  ConversationSentence,
  TtsAttempt,
  VoiceAuthorization,
  VoiceMeta,
} from "../src/lib/storage/types";
import type { VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";
import { buildTrackedTtsRequest } from "../src/lib/chatSpeechClient";

const sentence: ConversationSentence & { voiceId: string } = {
  id: "sentence-1",
  sessionId: "session-1",
  turnId: "turn-1",
  personaId: "persona-1",
  voiceId: "voice-1",
  sentenceIndex: 0,
  text: "服务端保存的话。",
  emotion: "warm",
  intensity: 55,
  speed: 0.96,
  pauseAfterMs: 360,
  plannerVersion: "keyword-v1",
  createdAt: "2026-07-14T10:00:00.000Z",
};

const voiceMeta: VoiceMeta = {
  voiceId: "voice-1",
  userId: "user-1",
  objectPath: "users/user-1/voice.wav",
  audioFile: "users/user-1/voice.wav",
  checksumSha256: "checksum",
  promptText: "参考文字",
  mimeType: "audio/wav",
  durationSec: 8,
  providerVoiceId: "provider-voice-1",
  providerVoiceStatus: "ready",
  providerVoiceErrorCode: null,
  providerVoiceUpdatedAt: "2026-07-14T09:00:00.000Z",
  createdAt: "2026-07-14T09:00:00.000Z",
};

const authorization = (status: VoiceAuthorization["status"] = "approved"): VoiceAuthorization => ({
  id: "auth-1",
  voiceId: "voice-1",
  userId: "user-1",
  speakerStatus: "living",
  basis: "self",
  separateConsentConfirmed: true,
  thirdPartyProcessingConfirmed: true,
  syntheticDisclosureConfirmed: true,
  status,
  reasonCode: null,
  noticeVersion: "v1",
  attestedAt: "2026-07-14T09:00:00.000Z",
  reviewedAt: "2026-07-14T09:00:00.000Z",
  reviewedBy: "policy:self",
  revokedAt: status === "revoked" ? "2026-07-14T10:00:00.000Z" : null,
  createdAt: "2026-07-14T09:00:00.000Z",
});

function attempt(input: Record<string, unknown>, status: TtsAttempt["status"] = "started"): TtsAttempt {
  return {
    id: String(input.id),
    sentenceId: String(input.sentenceId ?? sentence.id),
    sessionId: sentence.sessionId,
    turnId: sentence.turnId,
    personaId: sentence.personaId,
    voiceId: sentence.voiceId,
    attemptNo: 1,
    status,
    voiceSource: status === "started" ? "preset" : String(input.voiceSource ?? "preset") as "preset",
    providerVoiceId: voiceMeta.providerVoiceId,
    ttsModel: TTS_MODEL,
    ttsConfigVersion: TTS_CONFIG_VERSION,
    fellBack: Boolean(input.fellBack),
    storageMs: status === "completed" ? Number(input.storageMs) : null,
    providerMs: status === "completed" ? Number(input.providerMs) : null,
    totalMs: status === "started" ? null : Number(input.totalMs),
    stableErrorCode: status === "failed" ? String(input.stableErrorCode) : null,
    createdAt: "2026-07-14T10:00:00.000Z",
    completedAt: status === "started" ? null : "2026-07-14T10:00:01.000Z",
  };
}

type FixtureOptions = {
  sentenceOwner?: boolean;
  authorizationStatus?: VoiceAuthorization["status"];
  completionError?: Error;
  providerError?: unknown;
  rateAllowed?: boolean;
};

function fixture(options: FixtureOptions = {}) {
  const order: string[] = [];
  const starts: Array<Record<string, unknown>> = [];
  const completes: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const synthesisInputs: Array<Record<string, unknown>> = [];
  let providerCalls = 0;
  let clock = 0;
  const logs: Array<{ level: "info" | "error"; event: string; data?: Record<string, unknown> }> = [];
  const repository = {
    async getConversationSentenceForSynthesis(sentenceId: string, userId: string) {
      order.push("sentence");
      return options.sentenceOwner === false || sentenceId !== sentence.id || userId !== "user-1"
        ? null
        : sentence;
    },
    async getCurrentVoiceAuthorization() {
      order.push("authorization");
      return authorization(options.authorizationStatus ?? "approved");
    },
    async startTtsAttempt(input: Record<string, unknown>) {
      order.push("attempt");
      starts.push(input);
      return attempt(input);
    },
    async completeTtsAttempt(input: Record<string, unknown>) {
      order.push("complete");
      completes.push(input);
      if (options.completionError) throw options.completionError;
      return attempt(input, "completed");
    },
    async failTtsAttempt(input: Record<string, unknown>) {
      order.push("fail");
      failures.push(input);
      return true;
    },
    async getPersonaForUser() { return { voiceId: "voice-1" }; },
  } as unknown as AppRepository;
  const store = {} as VoiceObjectStore;
  const handlers = createTtsHandlers({
    requireAuth: async () => ({ userId: "user-1" }),
    getRepository: () => repository,
    getVoiceObjectStore: () => store,
    checkTtsRateLimit: () => {
      order.push("rate");
      return { allowed: options.rateAllowed !== false, remaining: 49, resetAt: 2_000_000_000_000 };
    },
    resolveVoiceSynthesisSource: async (_store, voiceId, userId) => {
      order.push("source");
      return voiceId === "voice-1" && userId === "user-1"
        ? { mode: "preset" as const, meta: voiceMeta, presetVoiceId: "provider-voice-1" }
        : null;
    },
    synthesizeResolvedVoice: async (input) => {
      order.push("provider");
      providerCalls += 1;
      synthesisInputs.push(input as unknown as Record<string, unknown>);
      if (options.providerError) throw options.providerError;
      return { audio: Buffer.from("audio"), source: "preset" as const, fellBack: false };
    },
    isVoiceAuthorizationEnforced: () => true,
    randomUUID: () => "attempt-1",
    nowMs: () => clock += 10,
    logInfo: (event, data) => logs.push({ level: "info", event, data }),
    logError: (event, data) => logs.push({ level: "error", event, data }),
  });
  return {
    handlers, order, starts, completes, failures, synthesisInputs,
    providerCalls: () => providerCalls, logs,
  };
}

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("tracked TTS trusts only the stored sentence, controls, persona and voice", async () => {
  const f = fixture();
  const response = await f.handlers.POST(request({
    sentenceId: sentence.id,
    text: "客户端伪造文字",
    personaId: "persona-other",
    voiceId: "voice-other",
    speech: { emotion: "happy", intensity: 100, speed: 1.15 },
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-TTS-Attempt-ID"), "attempt-1");
  assert.deepEqual(f.order, ["sentence", "authorization", "source", "rate", "attempt", "provider", "complete"]);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.starts[0], {
    id: "attempt-1",
    sentenceId: sentence.id,
    evaluatorUserId: "user-1",
    voiceSource: "preset",
    providerVoiceId: "provider-voice-1",
    ttsModel: TTS_MODEL,
    ttsConfigVersion: TTS_CONFIG_VERSION,
  });
  assert.equal(f.synthesisInputs[0].voiceId, "voice-1");
  assert.equal(f.synthesisInputs[0].text, "服务端保存的话。");
  assert.deepEqual(f.synthesisInputs[0].speech, {
    emotion: "warm", intensity: 55, speed: 0.96,
  });
  assert.equal(f.completes.length, 1);
  assert.deepEqual(f.completes[0], {
    id: "attempt-1",
    evaluatorUserId: "user-1",
    voiceSource: "preset",
    fellBack: false,
    storageMs: 10,
    providerMs: 10,
    totalMs: 40,
  });
  assert.equal(f.failures.length, 0);
});

it("tracks the exact request body produced from a browser SSE sentence", async () => {
  const f = fixture();
  const browserRequest = buildTrackedTtsRequest({
    sentenceId: sentence.id,
    index: sentence.sentenceIndex,
    text: sentence.text,
    emotion: sentence.emotion,
    intensity: sentence.intensity,
    speed: sentence.speed,
    pauseAfterMs: sentence.pauseAfterMs,
  });

  const response = await f.handlers.POST(request(browserRequest));

  assert.deepEqual(browserRequest, { sentenceId: sentence.id });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-TTS-Attempt-ID"), "attempt-1");
  assert.equal(f.starts.length, 1);
  assert.equal(f.completes.length, 1);
});

it("rejects a cross-owner sentence before source lookup, rate limit, attempt or provider", async () => {
  const f = fixture({ sentenceOwner: false });
  const response = await f.handlers.POST(request({ sentenceId: sentence.id }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "sentenceId 不存在或不属于你" });
  assert.deepEqual(f.order, ["sentence"]);
  assert.equal(f.providerCalls(), 0);
});

it("does not start an attempt when authorization is revoked or rate limit is denied", async () => {
  const revoked = fixture({ authorizationStatus: "revoked" });
  const revokedResponse = await revoked.handlers.POST(request({ sentenceId: sentence.id }));
  assert.equal(revokedResponse.status, 403);
  assert.deepEqual(revoked.order, ["sentence", "authorization"]);

  const limited = fixture({ rateAllowed: false });
  const limitedResponse = await limited.handlers.POST(request({ sentenceId: sentence.id }));
  assert.equal(limitedResponse.status, 429);
  assert.deepEqual(limited.order, ["sentence", "authorization", "source", "rate"]);
  assert.equal(limited.starts.length, 0);
});

it("reduces an arbitrary provider code to provider_unknown without leaking it", async () => {
  const f = fixture({
    providerError: Object.assign(new Error("raw provider secret response"), {
      status: 503,
      code: "customer_token_sk_live_ABC123",
      body: "sensitive upstream body",
    }),
  });
  const response = await f.handlers.POST(request({ sentenceId: sentence.id }));
  assert.equal(response.status, 502);
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].stableErrorCode, "provider_unknown");
  assert.doesNotMatch(JSON.stringify(await response.json()), /raw provider secret response|busy/);
  assert.deepEqual(f.logs, [{
    level: "error",
    event: "tts_failed",
    data: {
      voiceId: "voice-1",
      userId: "user-1",
      attemptId: "attempt-1",
      stableErrorCode: "provider_unknown",
      errorName: "Error",
      totalMs: 30,
    },
  }]);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /raw provider secret response|sensitive upstream body|customer_token_sk_live_ABC123/,
  );
});

it("does not return untracked audio when authorization is revoked before attempt completion", async () => {
  const f = fixture({ completionError: new Error("tts_attempt_authorization_denied raw") });
  const response = await f.handlers.POST(request({ sentenceId: sentence.id }));
  assert.notEqual(response.status, 200);
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.completes.length, 1);
  assert.equal(f.failures.length, 1);
  assert.doesNotMatch(await response.text(), /authorization_denied raw/);
});

it("keeps legacy untracked preview synthesis without writing a qualifying attempt", async () => {
  const f = fixture();
  const response = await f.handlers.POST(request({
    voiceId: "voice-1",
    text: "  （轻声）预览文字。 ",
    speech: { emotion: "happy", intensity: 70, speed: 1.05 },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-TTS-Attempt-ID"), null);
  assert.equal(f.starts.length, 0);
  assert.equal(f.completes.length, 0);
  assert.equal(f.failures.length, 0);
  assert.equal(f.synthesisInputs[0].text, "预览文字。");
});

it("keeps auth failures untouched", async () => {
  const handlers = createTtsHandlers({
    requireAuth: async () => ({
      error: NextResponse.json({ error: "未登录", code: "UNAUTHORIZED" }, { status: 401 }),
    }),
  });
  const response = await handlers.POST(request({ sentenceId: sentence.id }));
  assert.equal(response.status, 401);
});
