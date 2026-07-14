import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dataDir = "";
let previousDataDir: string | undefined;
let database: ReturnType<typeof import("../src/lib/db")["getDb"]>;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-conversation-grounding-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  const dbModule = await import("../src/lib/db");
  database = dbModule.getDb();
});

after(async () => {
  database?.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

it("creates grounded conversation tables and fact embedding storage in a fresh SQLite DB", () => {
  const factColumns = database.pragma("table_info(persona_facts)") as Array<{ name: string }>;
  assert.ok(factColumns.some((column) => column.name === "embedding"));

  const tables = database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN (?, ?, ?)
     ORDER BY name`,
  ).all(
    "conversation_turns",
    "conversation_turn_evidence",
    "message_evidence",
  ) as Array<{ name: string }>;
  assert.deepEqual(tables.map((table) => table.name), [
    "conversation_turn_evidence",
    "conversation_turns",
    "message_evidence",
  ]);
});
