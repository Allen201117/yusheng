import { it } from "node:test";
import assert from "node:assert/strict";
import { resolveVoiceSynthesisSource } from "../src/lib/voiceSynthesisSource";
import type { VoiceMeta } from "../src/lib/storage/types";
import type { VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";

const base: VoiceMeta = {
  voiceId: "voice-1",
  userId: "user-1",
  objectPath: "users/user-1/voice.wav",
  audioFile: "users/user-1/voice.wav",
  checksumSha256: "abc",
  promptText: "你好",
  mimeType: "audio/wav",
  durationSec: 8,
  providerVoiceId: "speech:yusheng-voice-1:provider-id",
  providerVoiceStatus: "ready",
  providerVoiceErrorCode: null,
  providerVoiceUpdatedAt: "2026-07-13T00:01:00.000Z",
  createdAt: "2026-07-13T00:00:00.000Z",
};

it("resolves a ready preset without downloading private audio", async () => {
  let downloads = 0;
  const store = {
    async getMeta() { return base; },
    async get() { downloads += 1; return { meta: base, body: Buffer.from("reference") }; },
  } as unknown as VoiceObjectStore;

  const source = await resolveVoiceSynthesisSource(store, "voice-1", "user-1");
  assert.deepEqual(source, {
    mode: "preset",
    meta: base,
    presetVoiceId: "speech:yusheng-voice-1:provider-id",
  });
  assert.equal(downloads, 0);
});

it("falls back to owner-scoped dynamic audio when preset is unavailable", async () => {
  const failed = { ...base, providerVoiceId: null, providerVoiceStatus: "failed" as const };
  const store = {
    async getMeta() { return failed; },
    async get() { return { meta: failed, body: Buffer.from("reference") }; },
  } as unknown as VoiceObjectStore;

  const source = await resolveVoiceSynthesisSource(store, "voice-1", "user-1");
  assert.equal(source?.mode, "dynamic");
  if (source?.mode === "dynamic") assert.equal(source.body.toString(), "reference");
});

it("refuses synthesis while voice deletion is in progress", async () => {
  let downloads = 0;
  const deleting = { ...base, providerVoiceStatus: "deleting" as const };
  const store = {
    async getMeta() { return deleting; },
    async get() { downloads += 1; return { meta: deleting, body: Buffer.from("reference") }; },
  } as unknown as VoiceObjectStore;

  assert.equal(await resolveVoiceSynthesisSource(store, "voice-1", "user-1"), null);
  assert.equal(downloads, 0);
});
