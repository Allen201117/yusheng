import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  classifyLocalVoice,
  createDryRunReport,
  inventoryLocalData,
  planVoiceMigration,
  resolveLocalVoiceOwner,
} from "../scripts/migrate-local-data";

it("does not upload an object whose checksum already exists", () => {
  const plan = planVoiceMigration(
    [{ voiceId: "v1", userId: "u1", checksum: "abc", audioPath: "/tmp/v1.wav" }],
    new Set(["abc"]),
  );
  assert.deepEqual(plan, [{ voiceId: "v1", action: "skip", reason: "checksum_exists" }]);
});

it("reports a missing local audio file instead of marking success", () => {
  assert.equal(classifyLocalVoice({ metaExists: true, audioExists: false }), "missing_audio");
  assert.equal(classifyLocalVoice({ metaExists: false, audioExists: true }), "missing_meta");
  assert.equal(classifyLocalVoice({ metaExists: true, audioExists: true }), "ready");
});

it("assigns a legacy voice to the one persona owner that actually references it", () => {
  assert.equal(resolveLocalVoiceOwner(
    { voiceId: "v1", userId: "__legacy__" },
    [
      { voiceId: "v1", userId: "u1" },
      { voiceId: "other", userId: "u2" },
    ],
  ), "u1");
  assert.equal(resolveLocalVoiceOwner(
    { voiceId: "v1", userId: "__legacy__" },
    [{ voiceId: "v1", userId: "u1" }, { voiceId: "v1", userId: "u2" }],
  ), "__legacy__");
});

it("inventories SQLite rows and voice checksums without changing the source", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-migration-"));
  const dbPath = path.join(dataDir, "yusheng.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, phone TEXT, password TEXT, created_at TEXT);
    CREATE TABLE personas (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT, relation TEXT,
      voice_id TEXT, persona_desc TEXT, created_at TEXT
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, persona_id TEXT, content TEXT, embedding BLOB, created_at TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, persona_id TEXT, role TEXT, content TEXT, created_at TEXT
    );
    INSERT INTO users VALUES ('u1', 'owner@example.com', NULL, 'hash', '2026-07-13T00:00:00.000Z');
    INSERT INTO personas VALUES ('p1', 'u1', '妈妈', '母亲', 'v1', '温和', '2026-07-13T00:01:00.000Z');
    INSERT INTO memories VALUES ('r1', 'p1', '一起去海边', NULL, '2026-07-13T00:02:00.000Z');
    INSERT INTO messages VALUES ('m1', 'p1', 'user', '想你了', '2026-07-13T00:03:00.000Z');
  `);
  db.close();

  const voicesDir = path.join(dataDir, "voices");
  await mkdir(voicesDir);
  const audioPath = path.join(voicesDir, "v1.wav");
  await writeFile(audioPath, Buffer.from("voice bytes"));
  await writeFile(path.join(voicesDir, "v1.meta.json"), JSON.stringify({
    voiceId: "v1",
    userId: "u1",
    promptText: "你好",
    createdAt: "2026-07-13T00:00:30.000Z",
    audioFile: audioPath,
    mimeType: "audio/wav",
    durationSec: 6,
  }));

  const before = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  const inventory = await inventoryLocalData(dataDir);
  const afterDb = new Database(dbPath, { readonly: true });
  const after = afterDb.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  afterDb.close();

  assert.equal(before.count, after.count);
  assert.deepEqual(
    {
      users: inventory.users.length,
      personas: inventory.personas.length,
      memories: inventory.memories.length,
      messages: inventory.messages.length,
      voices: inventory.voices.length,
    },
    { users: 1, personas: 1, memories: 1, messages: 1, voices: 1 },
  );
  assert.ok(inventory.voices[0].checksum);
  assert.match(inventory.voices[0].checksum, /^[a-f0-9]{64}$/);
  assert.equal(inventory.voices[0].state, "ready");
});

it("keeps a broken voice in the inventory as missing", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-missing-voice-"));
  const voicesDir = path.join(dataDir, "voices");
  await mkdir(voicesDir);
  await writeFile(path.join(voicesDir, "broken.meta.json"), JSON.stringify({
    voiceId: "broken",
    userId: "u1",
    promptText: "你好",
    createdAt: "2026-07-13T00:00:00.000Z",
    audioFile: path.join(voicesDir, "broken.wav"),
    mimeType: "audio/wav",
  }));

  const inventory = await inventoryLocalData(dataDir);
  assert.equal(inventory.voices[0].state, "missing_audio");
  assert.equal(inventory.voices[0].checksum, null);
  assert.equal(inventory.databaseFound, false);
  assert.deepEqual(
    createDryRunReport(dataDir, inventory).items.find((item) => item.entity === "database"),
    { entity: "database", id: path.join(dataDir, "yusheng.sqlite"), status: "missing", reason: "missing_sqlite" },
  );
});
