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
  migrateInventory,
  planVoiceMigration,
  resolveLocalVoiceOwner,
} from "../scripts/migrate-local-data";
import type { SqlExecutor } from "../src/lib/storage/postgres";
import type { VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";

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

it("migrates each legacy memory into a source, confirmed memory, and link transactionally", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sources = new Set<string>();
  const memories = new Set<string>();
  const links = new Set<string>();
  let transactions = 0;
  const sql: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (text.includes("SELECT id, email, phone FROM users")) {
        return [{ id: "mapped-owner", email: null, phone: null }] as unknown as T[];
      }
      if (text.includes("SELECT id, user_id, checksum_sha256 FROM voice_profiles")) {
        return [{ id: "v1", user_id: "mapped-owner", checksum_sha256: "voice-checksum" }] as unknown as T[];
      }
      if (text.includes("SELECT id") && text.includes("FROM personas")) {
        return [{ id: "p1", user_id: "owner-1", created_at: "2026-07-13T00:01:00.000Z" }] as unknown as T[];
      }
      if (text.includes("INSERT INTO persona_sources")) {
        sources.add(String(params[0]));
        return [] as T[];
      }
      if (text.includes("INSERT INTO relationship_memories")) {
        const id = String(params[0]);
        if (memories.has(id)) return [] as T[];
        memories.add(id);
        return [{ id }] as unknown as T[];
      }
      if (text.includes("INSERT INTO persona_item_sources")) {
        links.add(`${params[0]}:${params[1]}:${params[2]}`);
        return [] as T[];
      }
      return [] as T[];
    },
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>) {
      transactions += 1;
      return work(sql);
    },
  };
  const voiceStore = {} as VoiceObjectStore;
  const inventory = {
    databaseFound: true,
    users: [],
    personas: [{
      id: "p1",
      userId: "local-owner",
      name: "妈妈",
      relation: "母亲",
      voiceId: "v1",
      personaDesc: "温和",
      createdAt: "2000-01-01T00:00:00.000Z",
    }],
    voices: [],
    messages: [],
    memories: [
      {
        id: "r1",
        personaId: "p1",
        content: "一起去海边",
        embedding: Buffer.alloc(1024 * 4),
        createdAt: "2026-07-13T00:02:00.000Z",
      },
      {
        id: "missing-persona-memory",
        personaId: "missing-persona",
        content: "无归属",
        embedding: null,
        createdAt: "2026-07-13T00:03:00.000Z",
      },
    ],
  };

  const userMap = { "local-owner": "mapped-owner" };
  const first = await migrateInventory("/tmp/yusheng", inventory, userMap, sql, voiceStore);
  const second = await migrateInventory("/tmp/yusheng", inventory, userMap, sql, voiceStore);

  assert.deepEqual(
    first.items.find((item) => item.id === "r1"),
    { entity: "memory", id: "r1", status: "imported", reason: "inserted" },
  );
  assert.deepEqual(
    second.items.find((item) => item.id === "r1"),
    { entity: "memory", id: "r1", status: "skipped", reason: "id_exists" },
  );
  assert.equal(first.items.find((item) => item.id === "missing-persona-memory")?.status, "failed");
  assert.equal(transactions, 2);
  assert.deepEqual([...sources], ["legacy-memory-source:p1"]);
  assert.deepEqual([...memories], ["r1"]);
  assert.deepEqual([...links], ["relationship_memory:r1:legacy-memory-source:p1"]);
  const sourceCall = calls.find((call) => call.text.includes("INSERT INTO persona_sources"));
  assert.deepEqual(sourceCall?.params, [
    "legacy-memory-source:p1",
    "p1",
    "owner-1",
    "2026-07-13T00:01:00.000Z",
  ]);
  assert.match(sourceCall?.text || "", /'legacy_import'[\s\S]*'legacy_id'[\s\S]*'ready'/);
  const memoryCall = calls.find((call) => call.text.includes("INSERT INTO relationship_memories"));
  assert.match(memoryCall?.text || "", /'confirmed'/);
  assert.equal(calls.some((call) => call.text.includes("INSERT INTO memories")), false);
});
