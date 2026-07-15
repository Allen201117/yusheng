import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let dataDir = "";
let db: typeof import("../src/lib/db");

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-auth-cli-"));
  process.env.DATA_DIR = dataDir;
  db = await import("../src/lib/db");
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
    env: { ...process.env, DATA_DIR: dataDir, STORAGE_BACKEND: "local", NODE_ENV: "test", ...env },
    encoding: "utf8",
  });
}

it("fails safely with one JSON object when confirmation is missing", () => {
  const result = run(["--authorization-id", "auth-cli", "--decision", "reject", "--reviewer-id", "operator-1", "--reason", "invalid"]);
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, errorCode: "confirmation_required" });
  assert.equal(result.stderr, "");
});

it("rejects a missing value before the next flag without writing the database", () => {
  const result = run([
    "--authorization-id", "auth-cli", "--decision", "reject", "--reviewer-id",
    "--reason", "invalid", "--confirm",
  ]);
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, errorCode: "missing_argument_value" });
  assert.equal(result.stderr, "");
  assert.equal(db.getCurrentVoiceAuthorization("voice-cli", "__dev__")?.status, "pending_review");
});

it("rejects duplicate and unknown flags without writing the database", () => {
  const duplicate = run([
    "--authorization-id", "auth-cli", "--decision", "reject", "--reviewer-id", "operator-1",
    "--reason", "invalid", "--reason", "again", "--confirm",
  ]);
  assert.equal(duplicate.status, 2);
  assert.deepEqual(JSON.parse(duplicate.stdout), { ok: false, errorCode: "duplicate_argument" });

  const unknown = run([
    "--authorization-id", "auth-cli", "--decision", "reject", "--reviewer-id", "operator-1",
    "--reason", "invalid", "--confirm", "--force",
  ]);
  assert.equal(unknown.status, 2);
  assert.deepEqual(JSON.parse(unknown.stdout), { ok: false, errorCode: "unknown_argument" });
  assert.equal(duplicate.stderr + unknown.stderr, "");
  assert.equal(db.getCurrentVoiceAuthorization("voice-cli", "__dev__")?.status, "pending_review");
});

it("sanitizes configuration failures instead of printing raw configuration or secrets", () => {
  const result = run([
    "--authorization-id", "auth-cli", "--decision", "approve", "--reviewer-id", "operator-1",
    "--reason", "verified", "--confirm",
  ], { NODE_ENV: "production", STORAGE_BACKEND: "local", DATABASE_URL: "must-not-leak" });
  assert.equal(result.status, 3);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, errorCode: "review_unavailable" });
  assert.doesNotMatch(result.stdout + result.stderr, /must-not-leak|DATABASE_URL|Production requires/);
});

it("reviews a temporary SQLite authorization without contacting a provider", () => {
  const result = run(["--authorization-id", "auth-cli", "--decision", "reject", "--reviewer-id", "operator-1", "--reason", "insufficient_evidence", "--confirm"]);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, status: "rejected", authorizationId: "auth-cli", cleanupPending: false,
  });
  assert.equal(result.stderr, "");
});
