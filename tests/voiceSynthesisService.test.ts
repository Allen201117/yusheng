import { it } from "node:test";
import assert from "node:assert/strict";
import { synthesizeStoredVoice } from "../src/lib/voiceSynthesisService";
import { synthesizeResolvedVoice } from "../src/lib/voiceSynthesisService";
import { resolveTtsVoiceId } from "../src/lib/ttsVoiceBinding";
import { resolveVoiceSynthesisSource } from "../src/lib/voiceSynthesisSource";
import type { AppRepository, Persona, VoiceMeta } from "../src/lib/storage/types";
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
          code: "provider_http_404",
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
    "state:failed:provider_http_404",
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

it("keeps an external sentence retry on the same persona voice and source", async () => {
  const personas: Record<string, Persona> = {
    "persona-A": {
      id: "persona-A", userId: "user-1", name: "A", relation: "mother",
      voiceId: "voice-A", personaDesc: "", createdAt: "2026-01-01T00:00:00.000Z",
    },
    "persona-B": {
      id: "persona-B", userId: "user-1", name: "B", relation: "aunt",
      voiceId: "voice-B", personaDesc: "", createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const voices: Record<string, VoiceMeta> = {
    "voice-A": { ...meta, voiceId: "voice-A", providerVoiceId: "provider-source-A" },
    "voice-B": { ...meta, voiceId: "voice-B", providerVoiceId: "provider-source-B" },
  };
  const personaLookups: string[] = [];
  const sourceLookups: string[] = [];
  const providerSources: string[] = [];
  let attempts = 0;
  const store = {
    async getMeta(voiceId: string, userId: string) {
      sourceLookups.push(`${userId}:${voiceId}`);
      return voices[voiceId] ?? null;
    },
  } as unknown as VoiceObjectStore;
  const repository = {
    async getPersonaForUser(personaId: string, userId: string) {
      personaLookups.push(`${userId}:${personaId}`);
      const persona = personas[personaId];
      return persona?.userId === userId ? persona : null;
    },
  } as AppRepository;
  const synthesize = async (input: { presetVoiceId?: string }) => {
    attempts += 1;
    providerSources.push(input.presetVoiceId ?? "dynamic");
    if (attempts === 1) {
      throw Object.assign(new Error("temporary outage"), { status: 503 });
    }
    return Buffer.from("retried audio");
  };
  const synthesizePersonaA = async () => {
    const binding = await resolveTtsVoiceId({
      requestedVoiceId: "",
      personaId: "persona-A",
      userId: "user-1",
      repository,
    });
    assert.deepEqual(binding, { status: "resolved", voiceId: "voice-A" });
    if (binding.status !== "resolved") throw new Error("voice binding failed");
    const source = await resolveVoiceSynthesisSource(store, binding.voiceId, "user-1");
    assert.ok(source);
    return synthesizeResolvedVoice({
      voiceId: binding.voiceId,
      userId: "user-1",
      text: "这是同一句话",
      source,
      store,
      repository,
      synthesize,
    });
  };

  await assert.rejects(synthesizePersonaA(), /temporary outage/);
  const retried = await synthesizePersonaA();

  assert.equal(retried.audio.toString(), "retried audio");
  assert.equal(retried.source, "preset");
  assert.deepEqual(personaLookups, ["user-1:persona-A", "user-1:persona-A"]);
  assert.deepEqual(sourceLookups, ["user-1:voice-A", "user-1:voice-A"]);
  assert.deepEqual(providerSources, ["provider-source-A", "provider-source-A"]);
  assert.equal(personaLookups.some((value) => value.includes("persona-B")), false);
  assert.equal(sourceLookups.some((value) => value.includes("voice-B")), false);
  assert.equal(providerSources.some((value) => value.includes("source-B")), false);
});
