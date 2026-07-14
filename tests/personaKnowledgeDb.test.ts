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

it("persists persona knowledge atomically with scoped edits, status changes, and source revocation", () => {
  database.prepare(
    `INSERT INTO personas
       (id, user_id, name, relation, voice_id, persona_desc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("persona-2", "user-1", "爸爸", "父亲", "voice-2", "沉稳", "2026-07-14T01:00:00.000Z");

  const source = {
    id: "source-1",
    personaId: "persona-1",
    sourceType: "manual_text" as const,
    contentText: "妈妈喜欢茉莉花",
    objectPath: null,
    checksumAlgorithm: "sha256" as const,
    checksum: "checksum-1",
    status: "ready" as const,
    createdBy: "user-1",
  };
  const candidates = [
    {
      kind: "fact" as const,
      id: "fact-1",
      personaId: "persona-1",
      factType: "Preference",
      factKey: " favorite   drink ",
      content: "妈妈喜欢茉莉花",
      normalizedValue: "茉莉花",
      sourceId: "source-1",
      sourceExcerpt: "喜欢茉莉花",
    },
    {
      kind: "relationship_memory" as const,
      id: "memory-1",
      personaId: "persona-1",
      content: "一起做饭",
      occurredAt: null,
      location: "家里",
      participants: ["我", "妈妈"],
      embedding: Float32Array.from([0.25, 0.5]),
      sourceId: "source-1",
      sourceExcerpt: "一起做饭",
    },
    {
      kind: "speech_style" as const,
      id: "style-1",
      personaId: "persona-1",
      category: "comfort",
      content: "先安慰再给建议",
      example: "别急，慢慢来",
      sourceId: "source-1",
      sourceExcerpt: "别急",
    },
  ];

  assert.throws(
    () => dbModule.createPersonaKnowledgeCandidates({
      source: { ...source, id: "bad-source", checksum: "bad" },
      candidates: [{ ...candidates[0], id: "bad-fact", personaId: "persona-2", sourceId: "bad-source" }],
    }),
    /persona_mismatch/,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM persona_sources WHERE id = ?").get("bad-source") as { count: number }).count,
    0,
  );

  const created = dbModule.createPersonaKnowledgeCandidates({ source, candidates });
  assert.deepEqual(created.facts.map((item) => item.status), ["pending"]);
  assert.deepEqual(created.memories[0].participants, ["我", "妈妈"]);
  assert.equal(dbModule.listPersonaKnowledge("persona-1").styles.length, 1);
  assert.equal(dbModule.getPersonaKnowledgeItem("fact", "fact-1", "persona-2"), null);
  assert.equal(
    dbModule.updatePersonaKnowledgeCandidate({
      kind: "fact",
      id: "fact-1",
      personaId: "persona-2",
      expectedStatus: "pending",
      patch: { content: "越权修改" },
    }),
    null,
  );

  const edited = dbModule.updatePersonaKnowledgeCandidate({
    kind: "fact",
    id: "fact-1",
    personaId: "persona-1",
    expectedStatus: "pending",
    patch: { content: "妈妈最喜欢茉莉花", normalizedValue: "茉莉花", status: "confirmed" },
  });
  assert.equal(edited?.content, "妈妈最喜欢茉莉花");
  assert.equal(edited?.status, "pending");

  const confirmed = dbModule.setPersonaKnowledgeStatuses([{
    kind: "fact",
    id: "fact-1",
    personaId: "persona-1",
    expectedStatus: "pending",
    nextStatus: "confirmed",
    actorUserId: "user-1",
    conflictGroupId: null,
  }]);
  assert.equal(confirmed[0].status, "confirmed");
  assert.equal(dbModule.findConfirmedFacts("persona-1", "preference", "favorite drink").length, 1);
  assert.throws(
    () => dbModule.setPersonaKnowledgeStatuses([{
      kind: "fact",
      id: "fact-1",
      personaId: "persona-2",
      expectedStatus: "confirmed",
      nextStatus: "revoked",
      actorUserId: "user-1",
      conflictGroupId: null,
    }]),
    /knowledge_status_changed/,
  );

  database.prepare(
    `INSERT INTO persona_sources
       (id, persona_id, source_type, checksum_algorithm, checksum, status, created_by, created_at)
     VALUES (?, ?, 'manual_text', 'sha256', ?, 'ready', ?, ?)`,
  ).run("source-2", "persona-1", "checksum-2", "user-1", "2026-07-14T02:00:00.000Z");
  database.prepare(
    `INSERT INTO persona_item_sources (item_kind, item_id, source_id, source_excerpt, created_at)
     VALUES ('fact', ?, ?, '', ?)`,
  ).run("fact-1", "source-2", "2026-07-14T02:00:00.000Z");

  dbModule.setPersonaKnowledgeStatuses([{
    kind: "speech_style",
    id: "style-1",
    personaId: "persona-1",
    expectedStatus: "pending",
    nextStatus: "rejected",
    actorUserId: "user-1",
    conflictGroupId: null,
  }]);

  assert.deepEqual(dbModule.revokePersonaSource("source-1", "persona-2", "user-1"), {
    sourceRevoked: false,
    revokedItems: [],
  });
  assert.deepEqual(dbModule.revokePersonaSource("source-1", "persona-1", "user-1"), {
    sourceRevoked: true,
    revokedItems: [{ kind: "relationship_memory", id: "memory-1" }],
  });
  assert.equal(dbModule.getPersonaKnowledgeItem("speech_style", "style-1", "persona-1")?.status, "rejected");
  assert.equal(dbModule.getPersonaKnowledgeItem("fact", "fact-1", "persona-1")?.status, "confirmed");
  assert.deepEqual(dbModule.revokePersonaSource("source-2", "persona-1", "user-1"), {
    sourceRevoked: true,
    revokedItems: [{ kind: "fact", id: "fact-1" }],
  });
  assert.equal(dbModule.getPersonaKnowledgeItem("fact", "fact-1", "persona-1")?.status, "revoked");
  assert.deepEqual(dbModule.revokePersonaSource("source-2", "persona-1", "user-1"), {
    sourceRevoked: false,
    revokedItems: [],
  });

  const embedded = dbModule.loadMemoriesWithEmbeddings("persona-1");
  assert.ok(embedded.every((item) => item.id !== "memory-1"));
});
