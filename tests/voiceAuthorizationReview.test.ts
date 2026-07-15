import { it } from "node:test";
import assert from "node:assert/strict";
import { parseReviewArgs } from "../scripts/review-voice-authorization";
import { reviewStoredVoiceAuthorization } from "../src/lib/voiceAuthorizationService";
import type { AppRepository, VoiceAuthorization, VoiceMeta } from "../src/lib/storage/types";
import type { VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";

const pending: VoiceAuthorization = {
  id: "auth-1", voiceId: "voice-1", userId: "user-1", speakerStatus: "deceased",
  basis: "close_relative_request", status: "pending_review", reasonCode: "manual_review_required",
  noticeVersion: "voice-authorization-2026-07-13", separateConsentConfirmed: true,
  thirdPartyProcessingConfirmed: true, syntheticDisclosureConfirmed: true,
  attestedAt: "2026-07-15T00:00:00.000Z", reviewedAt: null, reviewedBy: null,
  revokedAt: null, createdAt: "2026-07-15T00:00:00.000Z",
};
const voice: VoiceMeta = {
  voiceId: "voice-1", userId: "user-1", objectPath: "users/user-1/voice.wav",
  audioFile: "users/user-1/voice.wav", checksumSha256: "abc", promptText: "你好",
  mimeType: "audio/wav", durationSec: 8, providerVoiceId: null,
  providerVoiceStatus: "not_created", providerVoiceErrorCode: null,
  providerVoiceUpdatedAt: null, createdAt: "2026-07-15T00:00:00.000Z",
};

it("requires every operator argument and an explicit confirmation flag", () => {
  assert.deepEqual(parseReviewArgs([]), { ok: false, errorCode: "missing_authorization_id" });
  assert.deepEqual(parseReviewArgs(["--authorization-id", "auth-1"]), { ok: false, errorCode: "missing_decision" });
  assert.deepEqual(parseReviewArgs(["--authorization-id", "auth-1", "--decision", "approve", "--reviewer-id", "r", "--reason", "ok"]), { ok: false, errorCode: "confirmation_required" });
  assert.deepEqual(parseReviewArgs(["--authorization-id", "auth-1", "--decision", "maybe", "--reviewer-id", "r", "--reason", "ok", "--confirm"]), { ok: false, errorCode: "invalid_decision" });
});

it("approves by repository snapshot before provisioning that exact owner voice", async () => {
  const calls: string[] = [];
  const approved = { ...pending, status: "approved" as const, reasonCode: "evidence_verified", reviewedAt: "2026-07-15T01:00:00.000Z", reviewedBy: "operator-1" };
  const repository = {
    async reviewVoiceAuthorization() { calls.push("review"); return { status: "reviewed" as const, authorization: approved }; },
    async getCurrentVoiceAuthorization() { return approved; },
  } as unknown as AppRepository;
  const result = await reviewStoredVoiceAuthorization({
    authorizationId: "auth-1", decision: "approve", reviewerId: "operator-1", reason: "evidence_verified",
  }, {
    repository, store: {} as VoiceObjectStore, nowIso: () => "2026-07-15T01:00:00.000Z",
    provision: async (voiceId, userId) => {
      calls.push(`provision:${voiceId}:${userId}`);
      return { status: "ready", meta: voice };
    },
  });
  assert.equal(result.status, "approved");
  assert.deepEqual(calls, ["review", "provision:voice-1:user-1"]);
});

it("rejects and removes a ready preset without ever provisioning", async () => {
  const calls: string[] = [];
  const rejected = { ...pending, status: "rejected" as const, reasonCode: "insufficient_evidence", reviewedAt: "2026-07-15T01:00:00.000Z", reviewedBy: "operator-1" };
  const result = await reviewStoredVoiceAuthorization({
    authorizationId: "auth-1", decision: "reject", reviewerId: "operator-1", reason: "insufficient_evidence",
  }, {
    repository: { async reviewVoiceAuthorization() { calls.push("review"); return { status: "reviewed" as const, authorization: rejected }; } } as unknown as AppRepository,
    store: {} as VoiceObjectStore, nowIso: () => "2026-07-15T01:00:00.000Z",
    provision: async () => { throw new Error("must not provision"); },
    revokePreset: async (voiceId, userId) => { calls.push(`revoke:${voiceId}:${userId}`); return "revoked"; },
  });
  assert.deepEqual(result, { status: "rejected", authorization: rejected, cleanupPending: false });
  assert.deepEqual(calls, ["review", "revoke:voice-1:user-1"]);
});

it("returns stable repository failures and does not expose raw errors", async () => {
  const result = await reviewStoredVoiceAuthorization({
    authorizationId: "missing", decision: "approve", reviewerId: "operator-1", reason: "ok",
  }, {
    repository: { async reviewVoiceAuthorization() { return { status: "not_found" as const }; } } as unknown as AppRepository,
    store: {} as VoiceObjectStore,
  });
  assert.deepEqual(result, { status: "not_found" });
});

it("keeps approval durable when preset provisioning fails with a stable code", async () => {
  const approved = { ...pending, status: "approved" as const, reviewedAt: "2026-07-15T01:00:00.000Z", reviewedBy: "operator-1" };
  const result = await reviewStoredVoiceAuthorization({
    authorizationId: approved.id, decision: "approve", reviewerId: "operator-1", reason: "verified",
  }, {
    repository: {
      async reviewVoiceAuthorization() { return { status: "reviewed" as const, authorization: approved }; },
      async getCurrentVoiceAuthorization() { return approved; },
    } as unknown as AppRepository,
    store: {} as VoiceObjectStore,
    provision: async () => ({ status: "failed", meta: voice, errorCode: "provider_unavailable" }),
  });
  assert.equal(result.status, "approved");
  if (result.status === "approved") {
    assert.deepEqual(result.preset, { status: "failed", meta: voice, errorCode: "provider_unavailable" });
  }
});

it("removes a newly provisioned preset if authorization changes during provisioning", async () => {
  const approved = { ...pending, status: "approved" as const, reviewedAt: "2026-07-15T01:00:00.000Z", reviewedBy: "operator-1" };
  const revoked = { ...approved, status: "revoked" as const, revokedAt: "2026-07-15T01:00:01.000Z" };
  const calls: string[] = [];
  const result = await reviewStoredVoiceAuthorization({
    authorizationId: approved.id, decision: "approve", reviewerId: "operator-1", reason: "verified",
  }, {
    repository: {
      async reviewVoiceAuthorization() { return { status: "reviewed" as const, authorization: approved }; },
      async getCurrentVoiceAuthorization() { calls.push("authorization:recheck"); return revoked; },
    } as unknown as AppRepository,
    store: {} as VoiceObjectStore,
    provision: async () => { calls.push("provider:ready"); return { status: "ready", meta: voice }; },
    revokePreset: async () => { calls.push("provider:revoke"); return "revoked"; },
  });
  assert.equal(result.status, "approved");
  if (result.status === "approved") {
    assert.equal(result.preset.status, "failed");
    assert.equal(result.preset.status === "failed" && result.preset.errorCode, "authorization_changed_during_provision");
  }
  assert.deepEqual(calls, ["provider:ready", "authorization:recheck", "provider:revoke"]);
});

it("keeps rejection durable and reports retryable preset cleanup", async () => {
  const rejected = { ...pending, status: "rejected" as const, reviewedAt: "2026-07-15T01:00:00.000Z", reviewedBy: "operator-1" };
  const result = await reviewStoredVoiceAuthorization({
    authorizationId: rejected.id, decision: "reject", reviewerId: "operator-1", reason: "invalid",
  }, {
    repository: { async reviewVoiceAuthorization() { return { status: "reviewed" as const, authorization: rejected }; } } as unknown as AppRepository,
    store: {} as VoiceObjectStore,
    revokePreset: async () => { throw new Error("raw-provider-detail"); },
  });
  assert.deepEqual(result, { status: "rejected", authorization: rejected, cleanupPending: true });
  assert.doesNotMatch(JSON.stringify(result), /raw-provider-detail/);
});
