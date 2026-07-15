import assert from "node:assert/strict";
import { it } from "node:test";
import { revokeStoredVoiceAuthorization } from "../src/lib/voiceAuthorizationService";
import { createPresetVoiceName } from "../src/lib/siliconFlowVoice";
import type {
  AppRepository,
  VoiceAuthorization,
  VoiceDeletionJob,
  VoiceMeta,
} from "../src/lib/storage/types";
import type { VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";

const authorization: VoiceAuthorization = {
  id: "auth-1", voiceId: "voice-1", userId: "user-1", speakerStatus: "living", basis: "self",
  status: "approved", reasonCode: null, noticeVersion: "v1", separateConsentConfirmed: true,
  thirdPartyProcessingConfirmed: true, syntheticDisclosureConfirmed: true,
  attestedAt: "2026-07-15T00:00:00.000Z", reviewedAt: "2026-07-15T00:00:00.000Z",
  reviewedBy: "policy:self", revokedAt: null, createdAt: "2026-07-15T00:00:00.000Z",
};

const meta: VoiceMeta = {
  voiceId: "voice-1", userId: "user-1", objectPath: "private/voice.wav", audioFile: "private/voice.wav",
  checksumSha256: "abc", promptText: "你好", mimeType: "audio/wav", durationSec: 8,
  providerVoiceId: "speech:voice-1", providerVoiceStatus: "ready", providerVoiceErrorCode: null,
  providerVoiceUpdatedAt: null, providerVoiceGeneration: 3, createdAt: "2026-07-15T00:00:00.000Z",
};

function fixture(options: {
  providerFails?: boolean;
  sourceFails?: boolean;
  providerInFlight?: boolean;
  providerStale?: boolean;
} = {}) {
  const calls: string[] = [];
  let job: VoiceDeletionJob | null = null;
  let voice: VoiceMeta | null = meta;
  const repository = {
    async getCurrentVoiceAuthorization() { return authorization; },
    async getActiveVoiceDeletionJob() { return job?.status === "completed" ? null : job; },
    async beginVoiceDeletion(input: any) {
      calls.push("authorization:revoke+job");
      if (job) return job;
      job = {
        ...input, providerGeneration: 4, status: "pending", currentStep: "provider",
        lastErrorCode: null, attemptCount: 0, leaseToken: null,
        createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z", completedAt: null,
      };
      return job;
    },
    async claimVoiceDeletionJob(_id: string, _userId: string, leaseToken: string) {
      if (!job || job.status === "completed" || job.status === "processing") return null;
      job = { ...job, status: "processing", leaseToken, attemptCount: job.attemptCount + 1 };
      return job;
    },
    async updateVoiceDeletionJob(input: any) {
      if (!job || job.leaseToken !== input.leaseToken) return null;
      job = {
        ...job, currentStep: input.currentStep, status: input.status,
        lastErrorCode: input.lastErrorCode, leaseToken: input.status === "processing" ? input.leaseToken : null,
        completedAt: input.status === "completed" ? "2026-07-15T00:01:00.000Z" : null,
      };
      calls.push(`job:${input.status}:${input.currentStep}`);
      return job;
    },
    async softDeletePersonasForVoice() { calls.push("personas:delete"); return 2; },
    async purgeVoiceData() { calls.push("database:purge"); },
    async completeVoiceProviderOperation() { return voice; },
    async listPendingVoiceProviderOperations() {
      return options.providerInFlight || options.providerStale
        ? [{
            generation: 3,
            status: "pending" as const,
            providerVoiceId: null,
            errorCode: null,
            updatedAt: options.providerStale
              ? "2020-01-01T00:00:00.000Z"
              : new Date().toISOString(),
          }]
        : [];
    },
    async settleSupersededVoiceProviderOperation() { calls.push("operation:settle"); },
  } as unknown as AppRepository;
  const store = {
    async getMeta() { return voice; },
    async delete() {
      calls.push("source:delete");
      if (options.sourceFails) throw new Error("blob unavailable");
      voice = null;
      return true;
    },
  } as unknown as VoiceObjectStore;
  return { repository, store, calls, get job() { return job; } };
}

it("revokes immediately then completes provider, persona, source and database deletion", async () => {
  const f = fixture();
  const result = await revokeStoredVoiceAuthorization("voice-1", "user-1", {
    repository: f.repository, store: f.store,
    removePreset: async (uri) => { f.calls.push(`provider:delete:${uri}`); },
  }, { deleteConversationData: true });

  assert.equal(result.status, "completed");
  assert.deepEqual(f.calls, [
    "authorization:revoke+job", "provider:delete:speech:voice-1", "job:processing:personas",
    "personas:delete", "job:processing:source", "source:delete", "database:purge",
    "job:completed:completed",
  ]);
});

it("persists a retryable step and never reports completed when provider deletion fails", async () => {
  const f = fixture();
  const result = await revokeStoredVoiceAuthorization("voice-1", "user-1", {
    repository: f.repository, store: f.store,
    removePreset: async () => { throw Object.assign(new Error("down"), { code: "provider_http_503" }); },
  }, { deleteConversationData: true });

  assert.equal(result.status, "processing");
  assert.equal(result.currentStep, "provider");
  assert.equal(result.errorCode, "provider_http_503");
  assert.equal(f.job?.status, "retry_pending");
  assert.doesNotMatch(f.calls.join(","), /personas:delete|source:delete|database:purge/);
});

it("resumes at the persisted failed source step without repeating completed provider/persona work", async () => {
  const first = fixture({ sourceFails: true });
  const pending = await revokeStoredVoiceAuthorization("voice-1", "user-1", {
    repository: first.repository, store: first.store,
    removePreset: async () => { first.calls.push("provider:delete"); },
  }, { deleteConversationData: true });
  assert.equal(pending.status, "processing");
  assert.equal(pending.currentStep, "source");
  assert.equal(first.calls.filter((call) => call === "provider:delete").length, 1);
  assert.equal(first.calls.filter((call) => call === "personas:delete").length, 1);
});

it("requires the caller to explicitly choose complete conversation deletion", async () => {
  const f = fixture();
  const result = await revokeStoredVoiceAuthorization("voice-1", "user-1", {
    repository: f.repository, store: f.store,
  }, { deleteConversationData: false as true });
  assert.deepEqual(result, { status: "confirmation_required" });
  assert.deepEqual(f.calls, []);
});

it("waits for an older in-flight provider upload before deleting source data", async () => {
  const f = fixture({ providerInFlight: true });
  const result = await revokeStoredVoiceAuthorization("voice-1", "user-1", {
    repository: f.repository, store: f.store,
    removePreset: async () => { throw new Error("must not delete an unknown URI"); },
  }, { deleteConversationData: true });
  assert.equal(result.status, "processing");
  if (result.status === "processing") {
    assert.equal(result.errorCode, "voice_provider_operation_in_flight");
  }
  assert.doesNotMatch(f.calls.join(","), /personas:delete|source:delete/);
});

it("reconciles a stale unknown provider upload by deterministic custom name", async () => {
  const f = fixture({ providerStale: true });
  const result = await revokeStoredVoiceAuthorization("voice-1", "user-1", {
    repository: f.repository,
    store: f.store,
    listPresets: async () => [{
      customName: createPresetVoiceName("voice-1"),
      uri: "speech:yusheng-voice-1:orphan",
    }],
    removePreset: async (uri) => { f.calls.push(`provider:delete:${uri}`); },
  }, { deleteConversationData: true });

  assert.equal(result.status, "completed");
  assert.match(f.calls.join(","), /provider:delete:speech:yusheng-voice-1:orphan/);
  assert.match(f.calls.join(","), /source:delete/);
});

it("keeps stale unknown provider work retryable until reconciliation succeeds", async () => {
  const f = fixture({ providerStale: true });
  const result = await revokeStoredVoiceAuthorization("voice-1", "user-1", {
    repository: f.repository,
    store: f.store,
    listPresets: async () => { throw new Error("provider list unavailable"); },
    removePreset: async () => { throw new Error("must not delete without a list"); },
  }, { deleteConversationData: true });

  assert.equal(result.status, "processing");
  assert.doesNotMatch(f.calls.join(","), /operation:settle|personas:delete|source:delete/);
});
