import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executePersonaCreation } from "../src/lib/personaCreation";

let dataDir = "";
let db: typeof import("../src/lib/db");

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-persona-auth-"));
  process.env.DATA_DIR = dataDir;
  db = await import("../src/lib/db");
});

after(async () => { await rm(dataDir, { recursive: true, force: true }); });

function approved(id: string, voiceId: string) {
  return db.replaceVoiceAuthorization({
    id, voiceId, userId: "__dev__", speakerStatus: "living", basis: "self",
    status: "approved", reasonCode: null, noticeVersion: "test",
    separateConsentConfirmed: true, thirdPartyProcessingConfirmed: true,
    syntheticDisclosureConfirmed: true, attestedAt: "2026-07-15T00:00:00.000Z",
    reviewedAt: "2026-07-15T00:00:00.000Z", reviewedBy: "policy:self",
  });
}

it("refuses SQLite persona insertion when revocation commits first", async () => {
  approved("auth-denied", "voice-denied");
  db.revokeVoiceAuthorization("voice-denied", "__dev__");
  const result = db.createPersonaWithApprovedVoice({
    id: "persona-denied", userId: "__dev__", name: "妈妈", relation: "母亲",
    voiceId: "voice-denied", personaDesc: "",
  });
  assert.deepEqual(result, { status: "authorization_denied" });
  assert.equal(db.getPersonaForUser("persona-denied", "__dev__"), null);
});

it("allows SQLite creation to commit first but later revocation still blocks authorization", async () => {
  approved("auth-created", "voice-created");
  const result = db.createPersonaWithApprovedVoice({
    id: "persona-created", userId: "__dev__", name: "妈妈", relation: "母亲",
    voiceId: "voice-created", personaDesc: "",
  });
  assert.equal(result.status, "created");
  db.revokeVoiceAuthorization("voice-created", "__dev__");
  assert.equal(db.getPersonaForUser("persona-created", "__dev__")?.voiceId, "voice-created");
  assert.equal(db.getCurrentVoiceAuthorization("voice-created", "__dev__")?.status, "revoked");
});

it("maps atomic repository outcomes to stable route responses without raw errors", async () => {
  const input = { id: "persona-1", userId: "user-1", name: "妈妈", relation: "母亲", voiceId: "voice-1", personaDesc: "" };
  assert.deepEqual(await executePersonaCreation(input, {
    createPersonaWithApprovedVoice: async () => ({ status: "voice_not_found" }),
  }), { status: 404, body: { error: "voiceId 不存在或不属于你", reasonCode: "VOICE_NOT_FOUND" } });
  assert.deepEqual(await executePersonaCreation(input, {
    createPersonaWithApprovedVoice: async () => ({ status: "authorization_denied" }),
  }), { status: 403, body: { error: "声音授权尚未通过", reasonCode: "VOICE_AUTHORIZATION_REQUIRED" } });
  const persona = { ...input, createdAt: "2026-07-15T00:00:00.000Z" };
  assert.deepEqual(await executePersonaCreation(input, {
    createPersonaWithApprovedVoice: async () => ({ status: "created", persona }),
  }), { status: 200, body: { ok: true, persona } });
  assert.deepEqual(await executePersonaCreation(input, {
    createPersonaWithApprovedVoice: async () => { throw new Error("DATABASE_URL=secret"); },
  }), { status: 500, body: { error: "人物创建失败，请稍后重试", reasonCode: "PERSONA_CREATE_FAILED" } });
  assert.deepEqual(await executePersonaCreation(input, () => {
    throw new Error("STORAGE_BACKEND=secret");
  }), { status: 500, body: { error: "人物创建失败，请稍后重试", reasonCode: "PERSONA_CREATE_FAILED" } });
});
