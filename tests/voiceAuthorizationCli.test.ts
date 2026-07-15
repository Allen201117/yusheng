import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

let dataDir = "";
let db: typeof import("../src/lib/db");
const REVIEW_TOKEN = "test-review-token-with-at-least-32-bytes";
const TARGET = "a".repeat(32);

function args(decision: "approve" | "reject", reason: string, confirmed = true) {
  const values = [
    "--authorization-id", "auth-cli", "--decision", decision, "--reason", reason,
    "--expected-environment", "local", "--expected-target", TARGET,
  ];
  if (confirmed) values.push("--confirm", `review:local:${TARGET}:auth-cli:${decision}`);
  return values;
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-auth-cli-"));
  process.env.DATA_DIR = dataDir;
  db = await import("../src/lib/db");
  const database = db.getDb();
  database.prepare(
    `INSERT INTO deployment_identity
       (singleton, environment, target_fingerprint, configured_at, configured_by)
     VALUES (1, 'local', ?, ?, 'test')`,
  ).run(TARGET, "2026-07-15T00:00:00.000Z");
  database.prepare(
    `INSERT INTO voice_review_operators
       (reviewer_id, credential_sha256, active, created_at)
     VALUES ('operator-1', ?, 1, ?)`,
  ).run(createHash("sha256").update(REVIEW_TOKEN).digest("hex"), "2026-07-15T00:00:00.000Z");
  db.replaceVoiceAuthorization({
    id: "auth-cli", voiceId: "voice-cli", userId: "__dev__", speakerStatus: "deceased",
    basis: "close_relative_request", status: "pending_review", reasonCode: "manual_review_required",
    noticeVersion: "voice-authorization-2026-07-13", separateConsentConfirmed: true,
    thirdPartyProcessingConfirmed: true, syntheticDisclosureConfirmed: true,
    attestedAt: "2026-07-15T00:00:00.000Z", reviewedAt: null, reviewedBy: null,
  });
  const voicesDir = path.join(dataDir, "voices");
  await mkdir(voicesDir, { recursive: true });
  await writeFile(path.join(voicesDir, "voice-cli.wav"), Buffer.from("fixture"));
  await writeFile(path.join(voicesDir, "voice-cli.meta.json"), JSON.stringify({
    voiceId: "voice-cli", userId: "__dev__", promptText: "fixture",
    createdAt: "2026-07-15T00:00:00.000Z", audioFile: path.join(voicesDir, "voice-cli.wav"),
    mimeType: "audio/wav", providerVoiceId: null, providerVoiceStatus: "not_created",
  }));
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/review-voice-authorization.ts", ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      STORAGE_BACKEND: "local",
      NODE_ENV: "test",
      VOICE_AUTH_REVIEWER_TOKEN: REVIEW_TOKEN,
      ...env,
    },
    encoding: "utf8",
  });
}

it("fails safely with one JSON object when confirmation is missing", () => {
  const result = run(args("reject", "invalid", false));
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, errorCode: "confirmation_required" });
  assert.equal(result.stderr, "");
});

it("rejects a missing value before the next flag without writing the database", () => {
  const result = run([
    "--authorization-id", "auth-cli", "--decision", "reject", "--reason",
    "--expected-environment", "local", "--expected-target", TARGET,
  ]);
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, errorCode: "missing_argument_value" });
  assert.equal(result.stderr, "");
  assert.equal(db.getCurrentVoiceAuthorization("voice-cli", "__dev__")?.status, "pending_review");
});

it("rejects duplicate and unknown flags without writing the database", () => {
  const duplicate = run([
    ...args("reject", "invalid"), "--reason", "again",
  ]);
  assert.equal(duplicate.status, 2);
  assert.deepEqual(JSON.parse(duplicate.stdout), { ok: false, errorCode: "duplicate_argument" });

  const unknown = run([
    ...args("reject", "invalid"), "--reviewer-id", "operator-1",
  ]);
  assert.equal(unknown.status, 2);
  assert.deepEqual(JSON.parse(unknown.stdout), { ok: false, errorCode: "unknown_argument" });
  assert.equal(duplicate.stderr + unknown.stderr, "");
  assert.equal(db.getCurrentVoiceAuthorization("voice-cli", "__dev__")?.status, "pending_review");
});

it("sanitizes configuration failures instead of printing raw configuration or secrets", () => {
  const result = run([
    ...args("approve", "verified"),
  ], { NODE_ENV: "production", STORAGE_BACKEND: "local", DATABASE_URL: "must-not-leak" });
  assert.equal(result.status, 3);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, errorCode: "review_unavailable" });
  assert.doesNotMatch(result.stdout + result.stderr, /must-not-leak|DATABASE_URL|Production requires/);
});

it("fails closed for a wrong reviewer credential or deployment target", () => {
  const wrongReviewer = run(args("reject", "invalid"), {
    VOICE_AUTH_REVIEWER_TOKEN: "wrong-review-token-with-at-least-32-bytes",
  });
  assert.equal(wrongReviewer.status, 2);
  assert.deepEqual(JSON.parse(wrongReviewer.stdout), {
    ok: false, errorCode: "authorization_reviewer_unauthorized",
  });

  const wrongTargetArgs = args("reject", "invalid");
  const fingerprintIndex = wrongTargetArgs.indexOf("--expected-target") + 1;
  wrongTargetArgs[fingerprintIndex] = "c".repeat(32);
  const confirmIndex = wrongTargetArgs.indexOf("--confirm") + 1;
  wrongTargetArgs[confirmIndex] = `review:local:${"c".repeat(32)}:auth-cli:reject`;
  const wrongTarget = run(wrongTargetArgs);
  assert.equal(wrongTarget.status, 2);
  assert.deepEqual(JSON.parse(wrongTarget.stdout), {
    ok: false, errorCode: "authorization_target_mismatch",
  });
  assert.equal(db.getCurrentVoiceAuthorization("voice-cli", "__dev__")?.status, "pending_review");
});

it("reviews a temporary SQLite authorization without contacting a provider", () => {
  const result = run(args("reject", "insufficient_evidence"));
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, status: "rejected", authorizationId: "auth-cli", cleanupPending: false,
  });
  assert.equal(result.stderr, "");
  const event = db.getDb().prepare(
    `SELECT actor_id, target_environment, target_fingerprint, decision
     FROM audit_events WHERE target_id = 'auth-cli'`,
  ).get() as Record<string, unknown>;
  assert.deepEqual(event, {
    actor_id: "operator-1", target_environment: "local",
    target_fingerprint: TARGET, decision: "reject",
  });
});
