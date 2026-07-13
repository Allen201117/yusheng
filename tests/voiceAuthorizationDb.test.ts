import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dataDir = "";
let db: typeof import("../src/lib/db");

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-auth-db-"));
  process.env.DATA_DIR = dataDir;
  db = await import("../src/lib/db");
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
  });
  assert.equal(authorization.userId, "__dev__");
});
