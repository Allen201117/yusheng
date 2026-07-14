import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dataDir = "";
let previousDataDir: string | undefined;
let database: ReturnType<typeof import("../src/lib/db")["getDb"]>;
let dbModule: typeof import("../src/lib/db");

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-persona-knowledge-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  dbModule = await import("../src/lib/db");
  database = dbModule.getDb();
});

after(async () => {
  database?.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

it("copies each legacy memory into confirmed persona knowledge only once", () => {
  database.prepare(
    `INSERT INTO personas
       (id, user_id, name, relation, voice_id, persona_desc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "persona-1",
    "user-1",
    "妈妈",
    "母亲",
    "voice-1",
    "温和",
    "2026-07-14T00:00:00.000Z",
  );
  database.prepare(
    `INSERT INTO memories (id, persona_id, content, embedding, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "legacy-memory",
    "persona-1",
    "一起去海边",
    Buffer.from(Float32Array.from([0.25, 0.5]).buffer),
    "2026-07-14T00:01:00.000Z",
  );

  dbModule.migrateLegacyPersonaKnowledge(database);
  dbModule.migrateLegacyPersonaKnowledge(database);

  const memory = database.prepare(
    `SELECT id, status, COUNT(*) AS count
     FROM relationship_memories
     WHERE id = ?
     GROUP BY id, status`,
  ).get("legacy-memory") as { id: string; status: string; count: number };
  assert.deepEqual(memory, {
    id: "legacy-memory",
    status: "confirmed",
    count: 1,
  });

  const source = database.prepare(
    `SELECT id, status, checksum_algorithm, checksum
     FROM persona_sources
     WHERE id = ?`,
  ).get("legacy-memory-source:persona-1") as {
    id: string;
    status: string;
    checksum_algorithm: string;
    checksum: string;
  };
  assert.deepEqual(source, {
    id: "legacy-memory-source:persona-1",
    status: "ready",
    checksum_algorithm: "legacy_id",
    checksum: "legacy-memory-source:persona-1",
  });

  const link = database.prepare(
    `SELECT item_id, source_id, COUNT(*) AS count
     FROM persona_item_sources
     WHERE item_id = ?
     GROUP BY item_id, source_id`,
  ).get("legacy-memory") as { item_id: string; source_id: string; count: number };
  assert.deepEqual(link, {
    item_id: "legacy-memory",
    source_id: "legacy-memory-source:persona-1",
    count: 1,
  });
});
