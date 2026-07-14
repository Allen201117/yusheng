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

it("uses confirmed relationship memories as the local runtime source of truth", () => {
  const oldMemoryCount = (database.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number }).count;
  dbModule.insertMemory({
    id: "manual-memory",
    personaId: "persona-1",
    content: "妈妈手写的菜谱",
    embedding: Float32Array.from([0.75, 0.5]),
    createdBy: "user-1",
    sourceId: "manual-source",
    checksumAlgorithm: "sha256",
    checksum: "manual-checksum",
  });

  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number }).count,
    oldMemoryCount,
  );
  assert.equal(dbModule.listMemories("persona-1").some((memory) => memory.id === "manual-memory"), true);
  assert.deepEqual(dbModule.getMemoryById("manual-memory"), {
    id: "manual-memory",
    personaId: "persona-1",
    content: "妈妈手写的菜谱",
  });
  assert.deepEqual(
    dbModule.loadMemoriesWithEmbeddings("persona-1")
      .find((memory) => memory.id === "manual-memory")?.embedding,
    Float32Array.from([0.75, 0.5]),
  );

  const source = database.prepare(
    "SELECT persona_id, source_type, checksum_algorithm, checksum, status, created_by FROM persona_sources WHERE id = ?",
  ).get("manual-source") as Record<string, unknown>;
  assert.deepEqual(source, {
    persona_id: "persona-1",
    source_type: "manual_text",
    checksum_algorithm: "sha256",
    checksum: "manual-checksum",
    status: "ready",
    created_by: "user-1",
  });
  assert.equal(
    (database.prepare(
      "SELECT COUNT(*) AS count FROM persona_item_sources WHERE item_kind = 'relationship_memory' AND item_id = ? AND source_id = ?",
    ).get("manual-memory", "manual-source") as { count: number }).count,
    1,
  );

  assert.equal(dbModule.deleteMemory("manual-memory"), true);
  assert.equal(dbModule.deleteMemory("manual-memory"), false);
  assert.equal(dbModule.listMemories("persona-1").some((memory) => memory.id === "manual-memory"), false);
  assert.equal(dbModule.loadMemoriesWithEmbeddings("persona-1").some((memory) => memory.id === "manual-memory"), false);
  assert.equal(dbModule.getMemoryById("manual-memory"), null);
  const revoked = database.prepare(
    "SELECT status, confirmed_by, confirmed_at, revoked_at FROM relationship_memories WHERE id = ?",
  ).get("manual-memory") as Record<string, unknown>;
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.confirmed_by, null);
  assert.equal(revoked.confirmed_at, null);
  assert.ok(revoked.revoked_at);
});

it("rolls back the source and memory when a runtime source link fails", () => {
  database.exec(
    `CREATE TEMP TRIGGER fail_manual_memory_link
     BEFORE INSERT ON persona_item_sources
     WHEN NEW.source_id = 'rollback-source'
     BEGIN
       SELECT RAISE(ABORT, 'forced link failure');
     END`,
  );

  assert.throws(
    () => dbModule.insertMemory({
      id: "rollback-memory",
      personaId: "persona-1",
      content: "不应留下的记忆",
      embedding: Float32Array.from([0.1, 0.2]),
      createdBy: "user-1",
      sourceId: "rollback-source",
      checksumAlgorithm: "sha256",
      checksum: "rollback-checksum",
    }),
    /forced link failure/,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM persona_sources WHERE id = ?").get("rollback-source") as { count: number }).count,
    0,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM relationship_memories WHERE id = ?").get("rollback-memory") as { count: number }).count,
    0,
  );
});

it("rolls back every memory when the second runtime batch item fails", () => {
  database.exec(
    `CREATE TEMP TRIGGER fail_second_batch_link
     BEFORE INSERT ON persona_item_sources
     WHEN NEW.source_id = 'batch-source-2'
     BEGIN
       SELECT RAISE(ABORT, 'forced second link failure');
     END`,
  );
  const makeInput = (suffix: string) => ({
    id: `batch-memory-${suffix}`,
    personaId: "persona-1",
    content: `批量记忆-${suffix}`,
    embedding: Float32Array.from([0.1, 0.2]),
    createdBy: "user-1",
    sourceId: `batch-source-${suffix}`,
    checksumAlgorithm: "sha256" as const,
    checksum: `batch-checksum-${suffix}`,
  });

  assert.throws(
    () => dbModule.insertMemories([makeInput("1"), makeInput("2")]),
    /forced second link failure/,
  );
  for (const table of ["persona_sources", "relationship_memories", "persona_item_sources"]) {
    const count = database.prepare(
      `SELECT COUNT(*) AS count FROM ${table}
       WHERE ${table === "persona_sources" ? "id" : table === "relationship_memories" ? "id" : "source_id"}
       LIKE 'batch-%'`,
    ).get() as { count: number };
    assert.equal(count.count, 0, table);
  }
});

it("keeps every non-confirmed status outside the legacy memory delete path", () => {
  const now = "2026-07-14T08:00:00.000Z";
  for (const status of ["pending", "conflicted", "rejected", "revoked"] as const) {
    database.prepare(
      `INSERT INTO relationship_memories
         (id, persona_id, content, participants, status, created_at, updated_at)
       VALUES (?, 'persona-1', ?, '[]', ?, ?, ?)`,
    ).run(`legacy-delete-${status}`, status, status, now, now);
    assert.equal(dbModule.getMemoryById(`legacy-delete-${status}`), null);
    assert.equal(dbModule.deleteMemory(`legacy-delete-${status}`), false);
    assert.equal(
      (database.prepare("SELECT status FROM relationship_memories WHERE id = ?")
        .get(`legacy-delete-${status}`) as { status: string }).status,
      status,
    );
  }
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

it("serializes fact reviews and applies edits with the decision", () => {
  const now = "2026-07-14T03:00:00.000Z";
  const insert = database.prepare(
    `INSERT INTO persona_facts
       (id, persona_id, fact_type, fact_key, content, normalized_value, status, created_at, updated_at)
     VALUES (?, 'persona-1', 'preference', 'atomic drink', ?, ?, 'pending', ?, ?)`,
  );
  insert.run("fact-atomic-tea", "喜欢茶", "茶", now, now);
  insert.run("fact-atomic-coffee", "喜欢咖啡", "咖啡", now, now);

  const first = dbModule.reviewPersonaKnowledgeAtomically({
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "fact",
    id: "fact-atomic-tea",
    action: "confirm",
  });
  assert.equal(first.item.status, "confirmed");

  const second = dbModule.reviewPersonaKnowledgeAtomically({
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "fact",
    id: "fact-atomic-coffee",
    action: "confirm",
  });
  assert.equal(second.item.status, "conflicted");
  assert.deepEqual(second.conflicts.map((item) => item.id), ["fact-atomic-tea"]);
  assert.equal(second.conflicts[0].conflictGroupId, second.item.conflictGroupId);
  const statuses = database.prepare(
    "SELECT id, status FROM persona_facts WHERE id IN (?, ?) ORDER BY id",
  ).all("fact-atomic-coffee", "fact-atomic-tea") as Array<{ id: string; status: string }>;
  assert.deepEqual(statuses.map((row) => row.status), ["conflicted", "conflicted"]);

  insert.run("fact-atomic-edited", "喜欢咖啡", "咖啡", now, now);
  const edited = dbModule.reviewPersonaKnowledgeAtomically({
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "fact",
    id: "fact-atomic-edited",
    action: "confirm",
    edits: { content: "喜欢茶", normalizedValue: "茶" },
  });
  assert.equal(edited.item.status, "confirmed");
  assert.equal(edited.item.content, "喜欢茶");
});

it("rolls back edits when the status decision fails", () => {
  const now = "2026-07-14T04:00:00.000Z";
  database.prepare(
    `INSERT INTO persona_facts
       (id, persona_id, fact_type, fact_key, content, normalized_value, status, created_at, updated_at)
     VALUES ('fact-rollback', 'persona-1', 'preference', 'rollback drink',
             '原内容', '原值', 'pending', ?, ?)`,
  ).run(now, now);
  database.exec(
    `CREATE TEMP TRIGGER fail_fact_review_status
     BEFORE UPDATE OF status ON persona_facts
     WHEN OLD.id = 'fact-rollback' AND NEW.status = 'confirmed'
     BEGIN
       SELECT RAISE(ABORT, 'forced status failure');
     END`,
  );

  try {
    assert.throws(() => dbModule.reviewPersonaKnowledgeAtomically({
      personaId: "persona-1",
      actorUserId: "user-1",
      kind: "fact",
      id: "fact-rollback",
      action: "confirm",
      edits: { content: "改后内容", normalizedValue: "改后值" },
      embedding: {
        content: "改后内容",
        vector: new Float32Array(1024).fill(0.01),
      },
    }), /forced status failure/);
  } finally {
    database.exec("DROP TRIGGER IF EXISTS fail_fact_review_status");
  }

  const row = database.prepare(
    "SELECT content, normalized_value, status, embedding FROM persona_facts WHERE id = ?",
  ).get("fact-rollback") as {
    content: string;
    normalized_value: string;
    status: string;
    embedding: Buffer | null;
  };
  assert.deepEqual(row, {
    content: "原内容",
    normalized_value: "原值",
    status: "pending",
    embedding: null,
  });
});

it("does not edit a terminal item", () => {
  const now = "2026-07-14T05:00:00.000Z";
  database.prepare(
    `INSERT INTO persona_facts
       (id, persona_id, fact_type, fact_key, content, normalized_value, status, created_at, updated_at)
     VALUES ('fact-terminal', 'persona-1', 'preference', 'terminal drink',
             '不能改', '原值', 'rejected', ?, ?)`,
  ).run(now, now);

  assert.throws(() => dbModule.reviewPersonaKnowledgeAtomically({
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "fact",
    id: "fact-terminal",
    action: "confirm",
    edits: { content: "试图复活", normalizedValue: "新值" },
  }), /invalid_transition:rejected:confirmed/);
  const row = database.prepare(
    "SELECT content, normalized_value, status FROM persona_facts WHERE id = ?",
  ).get("fact-terminal") as { content: string; normalized_value: string; status: string };
  assert.deepEqual(row, { content: "不能改", normalized_value: "原值", status: "rejected" });
});

it("stores a matching fact embedding before confirmation", () => {
  const now = "2026-07-14T06:00:00.000Z";
  database.prepare(
    `INSERT INTO persona_facts
       (id, persona_id, fact_type, fact_key, content, normalized_value, status, created_at, updated_at)
     VALUES ('fact-embedded', 'persona-1', 'preference', 'embedded drink',
             '她最喜欢桂花茶', '桂花茶', 'pending', ?, ?)`,
  ).run(now, now);
  const vector = new Float32Array(1024).fill(0.01);

  const result = dbModule.reviewPersonaKnowledgeAtomically({
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "fact",
    id: "fact-embedded",
    action: "confirm",
    embedding: { content: "她最喜欢桂花茶", vector },
  });

  assert.equal(result.item.status, "confirmed");
  const row = database.prepare(
    "SELECT embedding FROM persona_facts WHERE id = ?",
  ).get("fact-embedded") as { embedding: Buffer };
  assert.deepEqual(new Float32Array(
    row.embedding.buffer,
    row.embedding.byteOffset,
    row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
  ), vector);
});

it("rejects invalid confirmation embeddings and keeps knowledge unconfirmed", () => {
  const now = "2026-07-14T07:00:00.000Z";
  database.prepare(
    `INSERT INTO persona_facts
       (id, persona_id, fact_type, fact_key, content, normalized_value, status, created_at, updated_at)
     VALUES ('fact-invalid-embedding', 'persona-1', 'preference', 'invalid embedding',
             '事务内最终内容', '最终内容', 'pending', ?, ?)`,
  ).run(now, now);
  database.prepare(
    `INSERT INTO speech_style_items
       (id, persona_id, category, content, status, created_at, updated_at)
     VALUES ('style-invalid-embedding', 'persona-1', 'tone', '慢慢来', 'pending', ?, ?)`,
  ).run(now, now);

  for (const input of [
    {
      kind: "fact" as const,
      id: "fact-invalid-embedding",
      embedding: { content: "过期内容", vector: new Float32Array(1024) },
    },
    {
      kind: "fact" as const,
      id: "fact-invalid-embedding",
      embedding: { content: "事务内最终内容", vector: new Float32Array(1023) },
    },
    {
      kind: "speech_style" as const,
      id: "style-invalid-embedding",
      embedding: { content: "慢慢来", vector: new Float32Array(1024) },
    },
  ]) {
    assert.throws(() => dbModule.reviewPersonaKnowledgeAtomically({
      personaId: "persona-1",
      actorUserId: "user-1",
      kind: input.kind,
      id: input.id,
      action: "confirm",
      embedding: input.embedding,
    }), /knowledge_embedding_stale/);
  }

  assert.equal(dbModule.getPersonaKnowledgeItem(
    "fact",
    "fact-invalid-embedding",
    "persona-1",
  )?.status, "pending");
  assert.equal(dbModule.getPersonaKnowledgeItem(
    "speech_style",
    "style-invalid-embedding",
    "persona-1",
  )?.status, "pending");
});
