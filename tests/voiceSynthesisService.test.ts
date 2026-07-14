import { it } from "node:test";
import assert from "node:assert/strict";
import { synthesizeStoredVoice } from "../src/lib/voiceSynthesisService";
import type { AppRepository, VoiceMeta } from "../src/lib/storage/types";
import type { VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";

const meta: VoiceMeta = {
  voiceId: "voice-1",
  userId: "user-1",
  objectPath: "users/user-1/voice.wav",
  audioFile: "users/user-1/voice.wav",
  checksumSha256: "abc",
  promptText: "参考文字",
  mimeType: "audio/wav",
  durationSec: 8,
  providerVoiceId: "speech:yusheng-voice-1:provider-id",
  providerVoiceStatus: "ready",
  providerVoiceErrorCode: null,
  providerVoiceUpdatedAt: "2026-07-13T00:01:00.000Z",
  createdAt: "2026-07-13T00:00:00.000Z",
};

function fixture() {
  const calls: string[] = [];
  const store = {
    async getMeta() { calls.push("meta"); return meta; },
    async get() { calls.push("audio"); return { meta, body: Buffer.from("reference") }; },
  } as unknown as VoiceObjectStore;
  const repository = {
    async updateVoiceProviderState(_voiceId: string, _userId: string, input: {
      status: string;
      providerVoiceId: string | null;
      errorCode: string | null;
    }) {
      calls.push(`state:${input.status}:${input.errorCode}`);
      return { ...meta, providerVoiceStatus: input.status, providerVoiceErrorCode: input.errorCode };
    },
  } as unknown as AppRepository;
  return { calls, store, repository };
}

it("uses the preset fast path when it succeeds", async () => {
  const f = fixture();
  const result = await synthesizeStoredVoice({
    voiceId: "voice-1",
    userId: "user-1",
    text: "你好",
    store: f.store,
    repository: f.repository,
    synthesize: async (input) => {
      f.calls.push(`tts:${"presetVoiceId" in input ? "preset" : "dynamic"}`);
      return Buffer.from("audio");
    },
  });

  assert.equal(result.source, "preset");
  assert.equal(result.fellBack, false);
  assert.deepEqual(f.calls, ["meta", "tts:preset"]);
});

it("marks a stale preset failed and retries once with private reference audio", async () => {
  const f = fixture();
  let attempts = 0;
  const result = await synthesizeStoredVoice({
    voiceId: "voice-1",
    userId: "user-1",
    text: "你好",
    store: f.store,
    repository: f.repository,
    synthesize: async (input) => {
      attempts += 1;
      f.calls.push(`tts:${"presetVoiceId" in input ? "preset" : "dynamic"}`);
      if (attempts === 1) {
        throw Object.assign(new Error("stale voice"), {
          status: 404,
          code: "provider_http_404_voice_not_found",
        });
      }
      return Buffer.from("fallback-audio");
    },
  });

  assert.equal(result.audio.toString(), "fallback-audio");
  assert.equal(result.source, "dynamic");
  assert.equal(result.fellBack, true);
  assert.deepEqual(f.calls, [
    "meta",
    "tts:preset",
    "state:failed:provider_http_404_voice_not_found",
    "audio",
    "tts:dynamic",
  ]);
});

it("does not double-call the provider for a general outage", async () => {
  const f = fixture();
  let attempts = 0;
  await assert.rejects(
    synthesizeStoredVoice({
      voiceId: "voice-1",
      userId: "user-1",
      text: "你好",
      store: f.store,
      repository: f.repository,
      synthesize: async () => {
        attempts += 1;
        throw Object.assign(new Error("outage"), { status: 503, code: "provider_http_503" });
      },
    }),
    /outage/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(f.calls, ["meta"]);
});

it("retries a sentence with the same voice and resolved source", async () => {
  const requestedVoices: Array<{ voiceId: string; userId: string }> = [];
  const providerSources: string[] = [];
  let attempts = 0;
  const store = {
    async getMeta(voiceId: string, userId: string) {
      requestedVoices.push({ voiceId, userId });
      return meta;
    },
  } as unknown as VoiceObjectStore;
  const repository = {} as AppRepository;
  const synthesize = async (input: { presetVoiceId?: string }) => {
    attempts += 1;
    providerSources.push(input.presetVoiceId ?? "dynamic");
    if (attempts === 1) {
      throw Object.assign(new Error("temporary outage"), { status: 503 });
    }
    return Buffer.from("retried audio");
  };
  const sentence = {
    voiceId: "voice-1",
    userId: "user-1",
    text: "这是同一句话",
    store,
    repository,
    synthesize,
  };

  await assert.rejects(synthesizeStoredVoice(sentence), /temporary outage/);
  const retried = await synthesizeStoredVoice(sentence);

  assert.equal(retried.audio.toString(), "retried audio");
  assert.equal(retried.source, "preset");
  assert.deepEqual(requestedVoices, [
    { voiceId: "voice-1", userId: "user-1" },
    { voiceId: "voice-1", userId: "user-1" },
  ]);
  assert.deepEqual(providerSources, [meta.providerVoiceId, meta.providerVoiceId]);
  assert.equal(requestedVoices.some(({ voiceId }) => voiceId !== "voice-1"), false);
});
