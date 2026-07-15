import { it } from "node:test";
import assert from "node:assert/strict";
import {
  submitVoiceAuthorization,
} from "../src/lib/voiceAuthorizationService";
import type {
  AppRepository,
  VoiceAuthorization,
  VoiceMeta,
} from "../src/lib/storage/types";
import type { VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";

const voice: VoiceMeta = {
  voiceId: "voice-1", userId: "user-1", objectPath: "users/user-1/voice.wav",
  audioFile: "users/user-1/voice.wav", checksumSha256: "abc", promptText: "你好",
  mimeType: "audio/wav", durationSec: 8, providerVoiceId: null,
  providerVoiceStatus: "not_created", providerVoiceErrorCode: null,
  providerVoiceUpdatedAt: null, createdAt: "2026-07-13T00:00:00.000Z",
};

function fixture(ownerMatch = true, storedVoice = voice) {
  const calls: string[] = [];
  let authorization: VoiceAuthorization | null = null;
  const store = {
    async getMeta(_voiceId: string, userId: string) {
      calls.push("voice:owner-check");
      return ownerMatch && userId === storedVoice.userId ? storedVoice : null;
    },
  } as unknown as VoiceObjectStore;
  const repository = {
    async replaceVoiceAuthorization(input: Omit<VoiceAuthorization, "revokedAt" | "createdAt">) {
      calls.push(`auth:store:${input.status}`);
      authorization = {
        ...input,
        reviewedAt: input.reviewedAt,
        reviewedBy: input.reviewedBy,
        revokedAt: null,
        createdAt: input.attestedAt,
      };
      return authorization;
    },
    async getCurrentVoiceAuthorization() { return authorization; },
    async revokeVoiceAuthorization() {
      calls.push("auth:revoke");
      if (!authorization) return null;
      if (authorization.status !== "approved" && authorization.status !== "pending_review") {
        return authorization;
      }
      authorization = {
        ...authorization,
        status: "revoked",
        revokedAt: "2026-07-13T10:01:00.000Z",
      };
      return authorization;
    },
  } as unknown as AppRepository;
  return {
    calls,
    store,
    repository,
    get authorization() { return authorization; },
    setAuthorization(value: VoiceAuthorization) { authorization = value; },
  };
}

const confirmed = {
  separateConsentConfirmed: true,
  thirdPartyProcessingConfirmed: true,
  syntheticDisclosureConfirmed: true,
};

it("rejects a voice that is not owned by the authenticated user", async () => {
  const f = fixture(false);
  const result = await submitVoiceAuthorization({
    voiceId: "voice-1", userId: "user-1", speakerStatus: "living", basis: "self",
    ...confirmed,
  }, {
    repository: f.repository,
    store: f.store,
    provision: async () => { throw new Error("must not run"); },
  });

  assert.deepEqual(result, { status: "not_found" });
  assert.deepEqual(f.calls, ["voice:owner-check"]);
});

it("rejects missing separate confirmation without persisting or provisioning", async () => {
  const f = fixture();
  const result = await submitVoiceAuthorization({
    voiceId: "voice-1", userId: "user-1", speakerStatus: "living", basis: "self",
    ...confirmed,
    separateConsentConfirmed: false,
  }, {
    repository: f.repository,
    store: f.store,
    provision: async () => { throw new Error("must not run"); },
  });

  assert.deepEqual(result, {
    status: "rejected",
    reasonCode: "required_confirmation_missing",
  });
  assert.deepEqual(f.calls, ["voice:owner-check"]);
});

it("stores self authorization before provisioning a reusable voice", async () => {
  const f = fixture();
  const result = await submitVoiceAuthorization({
    voiceId: "voice-1", userId: "user-1", speakerStatus: "living", basis: "self",
    ...confirmed,
  }, {
    repository: f.repository,
    store: f.store,
    provision: async () => {
      f.calls.push("provider:provision");
      return { status: "ready", meta: voice };
    },
  });

  assert.equal(result.status, "approved");
  assert.equal(f.authorization?.reviewedBy, "policy:self");
  assert.equal(f.authorization?.reviewedAt, f.authorization?.attestedAt);
  assert.deepEqual(f.calls, [
    "voice:owner-check",
    "auth:store:approved",
    "provider:provision",
  ]);
});

it("stores living third-party and deceased requests as pending without provider upload", async () => {
  for (const input of [
    { speakerStatus: "living" as const, basis: "speaker_separate_consent" as const },
    { speakerStatus: "deceased" as const, basis: "close_relative_request" as const },
  ]) {
    const f = fixture();
    const result = await submitVoiceAuthorization({
      voiceId: "voice-1", userId: "user-1", ...input, ...confirmed,
    }, {
      repository: f.repository,
      store: f.store,
      provision: async () => { throw new Error("must not run"); },
    });
    assert.equal(result.status, "pending_review");
    assert.deepEqual(f.calls, ["voice:owner-check", "auth:store:pending_review"]);
  }
});

it("cannot relabel a pending deceased voice as living self to bypass review", async () => {
  const f = fixture();
  f.setAuthorization({
    id: "auth-pending", voiceId: "voice-1", userId: "user-1", speakerStatus: "deceased",
    basis: "close_relative_request", status: "pending_review", reasonCode: "manual_review_required",
    noticeVersion: "voice-authorization-2026-07-13", ...confirmed,
    attestedAt: "2026-07-13T10:00:00.000Z", reviewedAt: null, reviewedBy: null,
    revokedAt: null, createdAt: "2026-07-13T10:00:00.000Z",
  });
  const result = await submitVoiceAuthorization({
    voiceId: "voice-1", userId: "user-1", speakerStatus: "living", basis: "self", ...confirmed,
  }, {
    repository: f.repository,
    store: f.store,
    provision: async () => { throw new Error("must not run"); },
  });
  assert.deepEqual(result, {
    status: "rejected",
    reasonCode: "authorization_classification_locked",
  });
  assert.deepEqual(f.calls, ["voice:owner-check"]);
});

it("revokes an existing provider preset when a replacement authorization is pending", async () => {
  const readyVoice = {
    ...voice,
    providerVoiceId: "speech:yusheng-voice-1:provider-id",
    providerVoiceStatus: "ready" as const,
  };
  const f = fixture(true, readyVoice);
  const result = await submitVoiceAuthorization({
    voiceId: "voice-1", userId: "user-1", speakerStatus: "deceased",
    basis: "close_relative_request", ...confirmed,
  }, {
    repository: f.repository,
    store: f.store,
    provision: async () => { throw new Error("must not run"); },
    revokePreset: async () => {
      f.calls.push("provider:revoke");
      return "revoked";
    },
  });

  assert.equal(result.status, "pending_review");
  assert.equal(result.cleanupPending, false);
  assert.deepEqual(f.calls, [
    "voice:owner-check",
    "auth:store:pending_review",
    "provider:revoke",
  ]);
});
