import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

let dataDir = "";
let db: typeof import("../src/lib/db");
const secureReview = {
  reviewerCredentialHash: "b".repeat(64),
  expectedEnvironment: "local" as const,
  expectedTargetFingerprint: "a".repeat(32),
  auditEventId: "audit-db-review",
  requestId: "request-db-review",
};

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-auth-db-"));
  process.env.DATA_DIR = dataDir;
  db = await import("../src/lib/db");
  const database = db.getDb();
  database.prepare(
    `INSERT INTO deployment_identity
       (singleton, environment, target_fingerprint, configured_at, configured_by)
     VALUES (1, 'local', ?, ?, 'test')`,
  ).run("a".repeat(32), "2026-07-15T00:00:00.000Z");
  database.prepare(
    `INSERT INTO voice_review_operators
       (reviewer_id, credential_sha256, active, created_at)
     VALUES ('operator-1', ?, 1, ?)`,
  ).run("b".repeat(64), "2026-07-15T00:00:00.000Z");
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

it("persists and revokes the current local voice authorization", () => {
  const user = db.createUserByEmail("owner@example.com");
  const input = {
    id: "auth-1", voiceId: "voice-1", userId: user.id, speakerStatus: "living" as const,
    basis: "self" as const, status: "approved" as const, reasonCode: null,
    noticeVersion: "voice-authorization-2026-07-13",
    separateConsentConfirmed: true, thirdPartyProcessingConfirmed: true,
    syntheticDisclosureConfirmed: true, attestedAt: "2026-07-13T09:00:00.000Z",
    reviewedAt: "2026-07-13T09:00:00.000Z", reviewedBy: "policy:self",
  };

  assert.equal(db.replaceVoiceAuthorization(input).status, "approved");
  assert.equal(db.getCurrentVoiceAuthorization("voice-1", user.id)?.id, "auth-1");
  assert.equal(db.getCurrentVoiceAuthorization("voice-1", "other-user"), null);
  assert.equal(db.revokeVoiceAuthorization("voice-1", user.id)?.status, "revoked");
  assert.equal(db.getCurrentVoiceAuthorization("voice-1", user.id)?.status, "revoked");
});

it("supports the explicit local development user without a users row", () => {
  const authorization = db.replaceVoiceAuthorization({
    id: "auth-dev", voiceId: "voice-dev", userId: "__dev__", speakerStatus: "living",
    basis: "self", status: "approved", reasonCode: null,
    noticeVersion: "voice-authorization-2026-07-13",
    separateConsentConfirmed: true, thirdPartyProcessingConfirmed: true,
    syntheticDisclosureConfirmed: true, attestedAt: "2026-07-13T09:00:00.000Z",
    reviewedAt: "2026-07-13T09:00:00.000Z", reviewedBy: "policy:self",
  });
  assert.equal(authorization.userId, "__dev__");
});

it("revokes authorization and keeps a minimal retry job after local voice data is purged", () => {
  const user = db.createUserByEmail("delete-owner@example.com");
  db.replaceVoiceAuthorization({
    id: "auth-delete", voiceId: "voice-delete", userId: user.id, speakerStatus: "living",
    basis: "self", status: "approved", reasonCode: null,
    noticeVersion: "voice-authorization-2026-07-13", separateConsentConfirmed: true,
    thirdPartyProcessingConfirmed: true, syntheticDisclosureConfirmed: true,
    attestedAt: "2026-07-15T00:00:00.000Z", reviewedAt: "2026-07-15T00:00:00.000Z",
    reviewedBy: "policy:self",
  });
  db.createPersona({
    id: "persona-delete", userId: user.id, name: "家人", relation: "亲人",
    voiceId: "voice-delete", personaDesc: "",
  });
  db.insertMessage({ id: "message-delete", personaId: "persona-delete", role: "user", content: "你好" });

  const job = db.beginVoiceDeletion({
    id: "job-delete", voiceId: "voice-delete", userId: user.id,
    authorizationId: "auth-delete", providerVoiceId: "speech:delete",
  });
  assert.equal(job?.status, "pending");
  assert.equal(db.getCurrentVoiceAuthorization("voice-delete", user.id)?.status, "revoked");
  assert.equal(db.softDeletePersonasForVoice("voice-delete", user.id, "job-delete"), 1);
  assert.equal(db.getPersonaForUser("persona-delete", user.id), null);
  assert.equal(db.listMessages("persona-delete").length, 0);
  assert.throws(() => db.insertMessage({
    id: "message-after-delete",
    personaId: "persona-delete",
    role: "user",
    content: "不应写回",
  }), /persona_deleted/);
  const database = db.getDb();
  assert.equal((database.prepare(
    "SELECT COUNT(*) AS count FROM persona_deletion_tombstones WHERE persona_id = ?",
  ).get("persona-delete") as { count: number }).count, 1);
  assert.equal((database.prepare(
    "SELECT COUNT(*) AS count FROM voice_deletion_events WHERE job_id = ? AND event_type = 'started'",
  ).get("job-delete") as { count: number }).count, 1);
  const claimed = db.claimVoiceDeletionJob("job-delete", user.id, "lease-delete");
  assert.equal(claimed?.status, "processing");
  db.updateVoiceDeletionJob({
    id: "job-delete",
    userId: user.id,
    leaseToken: "lease-delete",
    currentStep: "source",
    status: "retry_pending",
    lastErrorCode: "voice_deletion_source_failed",
  });
  assert.equal((database.prepare(
    "SELECT COUNT(*) AS count FROM voice_deletion_events WHERE job_id = ? AND event_type = 'retry_pending'",
  ).get("job-delete") as { count: number }).count, 1);
  assert.throws(() => database.prepare(
    "DELETE FROM persona_deletion_tombstones WHERE persona_id = ?",
  ).run("persona-delete"), /voice_deletion_audit_is_append_only/);
  assert.throws(() => database.prepare(
    "UPDATE voice_deletion_events SET error_code = NULL WHERE job_id = ?",
  ).run("job-delete"), /voice_deletion_audit_is_append_only/);
  db.purgeVoiceData("voice-delete", user.id);
  assert.equal(db.getCurrentVoiceAuthorization("voice-delete", user.id), null);
  assert.equal(db.getActiveVoiceDeletionJob("voice-delete", user.id)?.id, "job-delete");
});

it("atomically reviews only pending local authorizations and records the reviewer", () => {
  const pending = db.replaceVoiceAuthorization({
    id: "auth-review", voiceId: "voice-review", userId: "__dev__",
    speakerStatus: "deceased", basis: "close_relative_request", status: "pending_review",
    reasonCode: "manual_review_required", noticeVersion: "voice-authorization-2026-07-13",
    separateConsentConfirmed: true, thirdPartyProcessingConfirmed: true,
    syntheticDisclosureConfirmed: true, attestedAt: "2026-07-15T00:00:00.000Z",
    reviewedAt: null, reviewedBy: null,
  });
  assert.equal(pending.reviewedBy, null);
  const reviewed = db.reviewVoiceAuthorization({
    authorizationId: pending.id, decision: "approve", ...secureReview,
    reason: "evidence_verified", reviewedAt: "2026-07-15T01:00:00.000Z",
  });
  assert.equal(reviewed.status, "reviewed");
  if (reviewed.status === "reviewed") {
    assert.equal(reviewed.authorization.status, "approved");
    assert.equal(reviewed.authorization.reviewedBy, "operator-1");
    assert.equal(reviewed.authorization.reasonCode, "evidence_verified");
  }
  assert.deepEqual(db.reviewVoiceAuthorization({
    authorizationId: pending.id, decision: "reject", ...secureReview,
    auditEventId: "audit-db-late", requestId: "request-db-late",
    reason: "late_rejection", reviewedAt: "2026-07-15T02:00:00.000Z",
  }), { status: "not_pending" });
  assert.deepEqual(db.reviewVoiceAuthorization({
    authorizationId: "missing", decision: "approve", ...secureReview,
    auditEventId: "audit-db-missing", requestId: "request-db-missing",
    reason: "ok", reviewedAt: "2026-07-15T01:00:00.000Z",
  }), { status: "not_found" });

  const database = db.getDb();
  const audit = database.prepare(
    `SELECT event_type, actor_id, target_id, target_environment,
            target_fingerprint, decision, reason_code
     FROM audit_events WHERE id = ?`,
  ).get(secureReview.auditEventId) as Record<string, unknown>;
  assert.deepEqual(audit, {
    event_type: "voice_authorization.reviewed",
    actor_id: "operator-1",
    target_id: pending.id,
    target_environment: "local",
    target_fingerprint: "a".repeat(32),
    decision: "approve",
    reason_code: "evidence_verified",
  });
  assert.throws(() => database.prepare(
    "UPDATE audit_events SET reason_code = 'changed' WHERE id = ?",
  ).run(secureReview.auditEventId), /audit_event_is_append_only/);
  assert.throws(() => database.prepare(
    "DELETE FROM audit_events WHERE id = ?",
  ).run(secureReview.auditEventId), /audit_event_is_append_only/);
  assert.throws(() => database.prepare(
    "UPDATE voice_authorizations SET reviewed_by = 'forged' WHERE id = ?",
  ).run(pending.id), /voice_authorization_review_is_immutable/);
  assert.throws(() => database.prepare(
    "UPDATE voice_authorizations SET status = 'pending_review' WHERE id = ?",
  ).run(pending.id), /voice_authorization_review_is_immutable/);

  const revoked = db.revokeVoiceAuthorization("voice-review", "__dev__");
  assert.equal(revoked?.status, "revoked");
  assert.equal(revoked?.reviewedBy, "operator-1");
});

it("fails closed before mutation and rolls back when the audit append fails", () => {
  const database = db.getDb();
  const createPending = (id: string) => db.replaceVoiceAuthorization({
    id, voiceId: `voice-${id}`, userId: "__dev__", speakerStatus: "deceased",
    basis: "close_relative_request", status: "pending_review",
    reasonCode: "manual_review_required", noticeVersion: "voice-authorization-2026-07-13",
    separateConsentConfirmed: true, thirdPartyProcessingConfirmed: true,
    syntheticDisclosureConfirmed: true, attestedAt: "2026-07-15T00:00:00.000Z",
    reviewedAt: null, reviewedBy: null,
  });

  const targetPending = createPending("auth-target-mismatch");
  assert.deepEqual(db.reviewVoiceAuthorization({
    authorizationId: targetPending.id, decision: "reject", reason: "invalid",
    reviewedAt: "2026-07-15T01:00:00.000Z", ...secureReview,
    expectedTargetFingerprint: "c".repeat(32), auditEventId: "audit-target-mismatch",
    requestId: "request-target-mismatch",
  }), { status: "target_mismatch" });
  assert.equal(db.getCurrentVoiceAuthorization(targetPending.voiceId, "__dev__")?.status, "pending_review");

  const reviewerPending = createPending("auth-reviewer-mismatch");
  assert.deepEqual(db.reviewVoiceAuthorization({
    authorizationId: reviewerPending.id, decision: "reject", reason: "invalid",
    reviewedAt: "2026-07-15T01:00:00.000Z", ...secureReview,
    reviewerCredentialHash: "c".repeat(64), auditEventId: "audit-reviewer-mismatch",
    requestId: "request-reviewer-mismatch",
  }), { status: "reviewer_unauthorized" });
  assert.equal(db.getCurrentVoiceAuthorization(reviewerPending.voiceId, "__dev__")?.status, "pending_review");

  database.prepare(
    `INSERT INTO audit_events
       (id, event_type, actor_type, actor_id, target_type, target_id,
        target_environment, target_fingerprint, decision, reason_code, request_id, created_at)
     VALUES ('audit-existing', 'test', 'system', 'test', 'test', 'test',
             'local', ?, NULL, NULL, 'duplicate-request', ?)`,
  ).run("a".repeat(32), "2026-07-15T00:00:00.000Z");
  const rollbackPending = createPending("auth-audit-rollback");
  assert.throws(() => db.reviewVoiceAuthorization({
    authorizationId: rollbackPending.id, decision: "approve", reason: "verified",
    reviewedAt: "2026-07-15T01:00:00.000Z", ...secureReview,
    auditEventId: "audit-rollback", requestId: "duplicate-request",
  }), /UNIQUE constraint failed: audit_events.request_id/);
  assert.equal(db.getCurrentVoiceAuthorization(rollbackPending.voiceId, "__dev__")?.status, "pending_review");
  assert.equal((database.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE id = 'audit-rollback'",
  ).get() as { count: number }).count, 0);
});

it("prevents a local pending authorization from being relabeled during replacement", () => {
  db.replaceVoiceAuthorization({
    id: "auth-locked", voiceId: "voice-locked", userId: "__dev__",
    speakerStatus: "deceased", basis: "close_relative_request", status: "pending_review",
    reasonCode: "manual_review_required", noticeVersion: "voice-authorization-2026-07-13",
    separateConsentConfirmed: true, thirdPartyProcessingConfirmed: true,
    syntheticDisclosureConfirmed: true, attestedAt: "2026-07-15T00:00:00.000Z",
    reviewedAt: null, reviewedBy: null,
  });
  assert.throws(() => db.replaceVoiceAuthorization({
    id: "auth-bypass", voiceId: "voice-locked", userId: "__dev__",
    speakerStatus: "living", basis: "self", status: "approved", reasonCode: null,
    noticeVersion: "voice-authorization-2026-07-13", separateConsentConfirmed: true,
    thirdPartyProcessingConfirmed: true, syntheticDisclosureConfirmed: true,
    attestedAt: "2026-07-15T00:01:00.000Z", reviewedAt: "2026-07-15T00:01:00.000Z",
    reviewedBy: "policy:self",
  }), /authorization_classification_locked/);
  assert.equal(db.getCurrentVoiceAuthorization("voice-locked", "__dev__")?.status, "pending_review");
});

it("idempotently upgrades a legacy SQLite authorization table", () => {
  const legacy = new Database(":memory:");
  try {
    legacy.exec(`
      CREATE TABLE voice_authorizations (
        id TEXT PRIMARY KEY, voice_id TEXT NOT NULL, user_id TEXT NOT NULL,
        speaker_status TEXT NOT NULL, basis TEXT NOT NULL, status TEXT NOT NULL,
        reason_code TEXT, notice_version TEXT NOT NULL,
        separate_consent_confirmed INTEGER NOT NULL,
        third_party_processing_confirmed INTEGER NOT NULL,
        synthetic_disclosure_confirmed INTEGER NOT NULL,
        attested_at TEXT NOT NULL, reviewed_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO voice_authorizations VALUES (
        'legacy-auth','legacy-voice','legacy-user','living','self','approved',NULL,'legacy',
        1,1,1,'2026-01-01T00:00:00.000Z',NULL,NULL,'2026-01-01T00:00:00.000Z'
      );
    `);
    db.migrateVoiceAuthorizationReviewSchema(legacy);
    db.migrateVoiceAuthorizationReviewSchema(legacy);
    const columns = legacy.pragma("table_info(voice_authorizations)") as { name: string }[];
    assert.equal(columns.filter((column) => column.name === "reviewed_by").length, 1);
    const row = legacy.prepare(
      "SELECT reviewed_at, reviewed_by FROM voice_authorizations WHERE id = 'legacy-auth'",
    ).get() as { reviewed_at: string; reviewed_by: string };
    assert.deepEqual(row, {
      reviewed_at: "2026-01-01T00:00:00.000Z",
      reviewed_by: "policy:self",
    });
  } finally {
    legacy.close();
  }
});
