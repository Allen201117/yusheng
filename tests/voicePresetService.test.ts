import { it } from "node:test";
import assert from "node:assert/strict";
import {
  deleteVoiceEverywhere,
  provisionVoicePreset,
} from "../src/lib/voicePresetService";
import type { AppRepository, VoiceMeta } from "../src/lib/storage/types";
import type { VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";

function voiceMeta(overrides: Partial<VoiceMeta> = {}): VoiceMeta {
  return {
    voiceId: "voice-1",
    userId: "user-1",
    objectPath: "users/user-1/voice.wav",
    audioFile: "users/user-1/voice.wav",
    checksumSha256: "abc",
    promptText: "你好",
    mimeType: "audio/wav",
    durationSec: 8,
    providerVoiceId: null,
    providerVoiceStatus: "not_created",
    providerVoiceErrorCode: null,
    providerVoiceUpdatedAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function fixture(initial = voiceMeta()) {
  let meta: VoiceMeta | null = initial;
  const calls: string[] = [];
  const repository = {
    async updateVoiceProviderState(_voiceId: string, userId: string, input: {
      status: VoiceMeta["providerVoiceStatus"];
      providerVoiceId: string | null;
      errorCode: string | null;
    }) {
      calls.push(`state:${input.status}`);
      if (!meta || meta.userId !== userId) return null;
      meta = {
        ...meta,
        providerVoiceStatus: input.status,
        providerVoiceId: input.providerVoiceId,
        providerVoiceErrorCode: input.errorCode,
        providerVoiceUpdatedAt: "2026-07-13T00:01:00.000Z",
      };
      return meta;
    },
  } as AppRepository;
  const store = {
    async getMeta(_voiceId: string, userId: string) {
      calls.push("meta");
      return meta?.userId === userId ? meta : null;
    },
    async get(_voiceId: string, userId: string) {
      calls.push("audio");
      return meta?.userId === userId ? { meta, body: Buffer.from("reference") } : null;
    },
    async delete(_voiceId: string, userId: string) {
      calls.push("store:delete");
      if (meta?.userId !== userId) return false;
      meta = null;
      return true;
    },
  } as VoiceObjectStore;
  return { repository, store, calls, get meta() { return meta; } };
}

it("provisions a stored voice through pending to ready", async () => {
  const f = fixture();
  const result = await provisionVoicePreset("voice-1", "user-1", {
    repository: f.repository,
    store: f.store,
    upload: async (input) => {
      f.calls.push(`provider:upload:${input.voiceId}:${input.audio.toString()}`);
      return "speech:yusheng-voice-1:provider-id";
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(result.meta?.providerVoiceId, "speech:yusheng-voice-1:provider-id");
  assert.deepEqual(f.calls, [
    "meta",
    "state:pending",
    "audio",
    "provider:upload:voice-1:reference",
    "state:ready",
  ]);
});

it("does not upload an already ready preset again", async () => {
  const f = fixture(voiceMeta({
    providerVoiceStatus: "ready",
    providerVoiceId: "speech:yusheng-voice-1:provider-id",
  }));
  let uploads = 0;
  const result = await provisionVoicePreset("voice-1", "user-1", {
    repository: f.repository,
    store: f.store,
    upload: async () => { uploads += 1; return "unused"; },
  });

  assert.equal(result.status, "ready");
  assert.equal(uploads, 0);
  assert.deepEqual(f.calls, ["meta"]);
});

it("records a stable failed state while keeping dynamic audio available", async () => {
  const f = fixture();
  const error = Object.assign(new Error("provider details"), { code: "provider_http_403_10001" });
  const result = await provisionVoicePreset("voice-1", "user-1", {
    repository: f.repository,
    store: f.store,
    upload: async () => { throw error; },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "provider_http_403_10001");
  assert.equal(f.meta?.providerVoiceStatus, "failed");
  assert.equal((await f.store.get("voice-1", "user-1"))?.body.toString(), "reference");
});

it("removes the provider preset before deleting private storage", async () => {
  const f = fixture(voiceMeta({
    providerVoiceStatus: "ready",
    providerVoiceId: "speech:yusheng-voice-1:provider-id",
  }));
  const deleted = await deleteVoiceEverywhere("voice-1", "user-1", {
    repository: f.repository,
    store: f.store,
    removePreset: async (uri) => { f.calls.push(`provider:delete:${uri}`); },
  });

  assert.equal(deleted, true);
  assert.deepEqual(f.calls, [
    "meta",
    "state:deleting",
    "provider:delete:speech:yusheng-voice-1:provider-id",
    "state:not_created",
    "store:delete",
  ]);
});

it("keeps metadata retryable when provider deletion fails", async () => {
  const f = fixture(voiceMeta({
    providerVoiceStatus: "ready",
    providerVoiceId: "speech:yusheng-voice-1:provider-id",
  }));
  const error = Object.assign(new Error("no"), { code: "provider_http_503_unknown" });

  await assert.rejects(
    deleteVoiceEverywhere("voice-1", "user-1", {
      repository: f.repository,
      store: f.store,
      removePreset: async () => { throw error; },
    }),
    /provider preset deletion failed/,
  );
  assert.equal(f.meta?.providerVoiceStatus, "failed");
  assert.equal(f.meta?.providerVoiceId, "speech:yusheng-voice-1:provider-id");
  assert.doesNotMatch(f.calls.join(","), /store:delete/);
});
