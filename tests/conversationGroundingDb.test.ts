import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppRepository } from "../src/lib/storage/types";

let dataDir = "";
let previousDataDir: string | undefined;
let database: ReturnType<typeof import("../src/lib/db")["getDb"]>;
let repository: AppRepository;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-conversation-grounding-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  const dbModule = await import("../src/lib/db");
  database = dbModule.getDb();
  const repositoryModule = await import("../src/lib/storage/repository");
  repository = repositoryModule.createLocalRepository();
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

function resetConversationFixtures() {
  database.exec(`
    DELETE FROM message_evidence;
    DELETE FROM conversation_turn_evidence;
    DELETE FROM conversation_turns;
    DELETE FROM messages;
    DELETE FROM persona_item_sources;
    DELETE FROM speech_style_items;
    DELETE FROM relationship_memories;
    DELETE FROM persona_facts;
    DELETE FROM persona_sources;
    DELETE FROM personas;
  `);
  const now = "2026-07-14T00:00:00.000Z";
  const insertPersona = database.prepare(
    `INSERT INTO personas (id, user_id, name, relation, voice_id, persona_desc, created_at)
     VALUES (?, 'user-1', ?, '母亲', 'voice-1', '', ?)`,
  );
  insertPersona.run("persona-1", "妈妈", now);
  insertPersona.run("persona-2", "阿姨", now);
}

function insertSource(id: string, personaId: string, status: "ready" | "failed" | "revoked" = "ready") {
  database.prepare(
    `INSERT INTO persona_sources
       (id, persona_id, source_type, content_text, checksum_algorithm, checksum,
        status, created_by, created_at)
     VALUES (?, ?, 'manual_text', ?, 'sha256', ?, ?, 'user-1', ?)`,
  ).run(id, personaId, id, `checksum-${id}`, status, "2026-07-14T00:00:00.000Z");
}

function linkSource(
  kind: "fact" | "relationship_memory" | "speech_style",
  itemId: string,
  sourceId: string,
) {
  database.prepare(
    `INSERT INTO persona_item_sources
       (item_kind, item_id, source_id, source_excerpt, created_at)
     VALUES (?, ?, ?, '', ?)`,
  ).run(kind, itemId, sourceId, "2026-07-14T00:00:00.000Z");
}

function insertFact(
  id: string,
  personaId: string,
  status: "pending" | "confirmed" | "rejected" | "conflicted" | "revoked",
  embedding: Buffer | null = null,
) {
  database.prepare(
    `INSERT INTO persona_facts
       (id, persona_id, fact_type, fact_key, content, normalized_value, embedding,
        status, created_at, updated_at)
     VALUES (?, ?, 'preference', 'drink', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    personaId,
    "她爱喝桂花茶。",
    "桂花茶",
    embedding,
    status,
    "2026-07-14T00:00:00.000Z",
    "2026-07-14T00:00:00.000Z",
  );
}

function insertMemory(
  id: string,
  personaId: string,
  status: "pending" | "confirmed" | "rejected" | "conflicted" | "revoked",
  embedding: Buffer | null = null,
) {
  database.prepare(
    `INSERT INTO relationship_memories
       (id, persona_id, content, participants, embedding, status, created_at, updated_at)
     VALUES (?, ?, ?, '["user-1"]', ?, ?, ?, ?)`,
  ).run(
    id,
    personaId,
    "一起在桂花树下喝茶。",
    embedding,
    status,
    "2026-07-14T00:00:00.000Z",
    "2026-07-14T00:00:00.000Z",
  );
}

it("loads only confirmed persona-scoped conversation knowledge and safely backfills embeddings", async () => {
  resetConversationFixtures();
  insertSource("source-1", "persona-1");
  insertSource("source-2", "persona-2");
  insertFact("fact-confirmed", "persona-1", "confirmed");
  insertMemory("memory-confirmed", "persona-1", "confirmed");
  insertFact("fact-pending", "persona-1", "pending");
  insertFact("fact-rejected", "persona-1", "rejected");
  insertFact("fact-conflicted", "persona-1", "conflicted");
  insertFact("fact-revoked", "persona-1", "revoked");
  insertFact("fact-other-persona", "persona-2", "confirmed");
  database.prepare(
    `INSERT INTO speech_style_items
       (id, persona_id, category, content, status, created_at, updated_at)
     VALUES
       ('style-confirmed', 'persona-1', 'tone', '慢慢说', 'confirmed', ?, ?),
       ('style-pending', 'persona-1', 'tone', '慢慢说', 'pending', ?, ?),
       ('style-other-persona', 'persona-2', 'tone', '慢慢说', 'confirmed', ?, ?)`,
  ).run(...Array(6).fill("2026-07-14T00:00:00.000Z"));

  const loaded = await repository.loadConfirmedConversationKnowledge("persona-1");
  assert.deepEqual(loaded.evidence.map((item) => item.id), ["fact-confirmed", "memory-confirmed"]);
  assert.ok(loaded.evidence.every((item) => item.embedding === null));
  assert.deepEqual(loaded.styles.map((item) => item.id), ["style-confirmed"]);

  const vector = new Float32Array(1024).fill(0.25);
  await repository.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "fact-confirmed", embedding: vector },
    { kind: "relationship_memory", id: "memory-confirmed", embedding: vector },
  ]);
  const stored = database.prepare(
    `SELECT embedding FROM persona_facts WHERE id = 'fact-confirmed'
     UNION ALL
     SELECT embedding FROM relationship_memories WHERE id = 'memory-confirmed'`,
  ).all() as Array<{ embedding: Buffer }>;
  assert.deepEqual(stored.map((row) => row.embedding.byteLength), [4096, 4096]);

  await repository.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "fact-confirmed", embedding: vector },
  ]);
  insertMemory("memory-concurrent", "persona-1", "confirmed");
  await Promise.all([
    repository.storeConfirmedConversationEmbeddings("persona-1", [
      { kind: "relationship_memory", id: "memory-concurrent", embedding: vector },
    ]),
    repository.storeConfirmedConversationEmbeddings("persona-1", [
      { kind: "relationship_memory", id: "memory-concurrent", embedding: vector },
    ]),
  ]);

  insertFact("fact-batch", "persona-1", "confirmed");
  await assert.rejects(repository.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "fact-batch", embedding: vector },
    { kind: "fact", id: "fact-other-persona", embedding: vector },
  ]), /conversation_embedding_status_changed/);
  assert.equal(
    (database.prepare("SELECT embedding FROM persona_facts WHERE id = 'fact-batch'").get() as { embedding: Buffer | null }).embedding,
    null,
  );

  insertFact("fact-malformed", "persona-1", "confirmed", Buffer.alloc(4));
  await assert.rejects(repository.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "fact-malformed", embedding: vector },
  ]), /conversation_embedding_status_changed/);
  await assert.rejects(repository.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "fact-confirmed", embedding: new Float32Array(1023) },
  ]), /conversation_embedding_status_changed/);
  insertFact("fact-prevalidation", "persona-1", "confirmed");
  await assert.rejects(repository.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "fact-prevalidation", embedding: vector },
    { kind: "fact", id: "fact-confirmed", embedding: new Float32Array(1023) },
  ]), /conversation_embedding_status_changed/);
  assert.equal(
    (database.prepare("SELECT embedding FROM persona_facts WHERE id = ?").get("fact-prevalidation") as { embedding: Buffer | null }).embedding,
    null,
  );
  await assert.rejects(repository.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "missing", embedding: vector },
  ]), /conversation_embedding_status_changed/);

  insertSource("source-backfill-first", "persona-1");
  insertFact("fact-backfill-first", "persona-1", "confirmed");
  linkSource("fact", "fact-backfill-first", "source-backfill-first");
  await repository.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "fact-backfill-first", embedding: vector },
  ]);
  await repository.revokePersonaSource("source-backfill-first", "persona-1", "user-1");
  assert.equal(
    (database.prepare("SELECT status FROM persona_facts WHERE id = ?").get("fact-backfill-first") as { status: string }).status,
    "revoked",
  );

  insertSource("source-revoke-first", "persona-1");
  insertFact("fact-revoke-first", "persona-1", "confirmed");
  linkSource("fact", "fact-revoke-first", "source-revoke-first");
  await repository.revokePersonaSource("source-revoke-first", "persona-1", "user-1");
  await assert.rejects(repository.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "fact-revoke-first", embedding: vector },
  ]), /conversation_embedding_status_changed/);
  assert.equal(
    (database.prepare("SELECT embedding FROM persona_facts WHERE id = ?").get("fact-revoke-first") as { embedding: Buffer | null }).embedding,
    null,
  );
});

it("atomically persists a grounded turn and freezes selection-time evidence", async () => {
  resetConversationFixtures();
  insertSource("source-ready", "persona-1");
  insertFact("fact-confirmed", "persona-1", "confirmed");
  linkSource("fact", "fact-confirmed", "source-ready");

  const started = await repository.startConversationTurn({
    turnId: "turn-1",
    personaId: "persona-1",
    userMessageId: "user-message-1",
    content: "她喜欢喝什么？",
  });
  assert.equal(started.status, "started");
  assert.deepEqual(
    database.prepare("SELECT persona_id, role, content FROM messages WHERE id = ?").get("user-message-1"),
    { persona_id: "persona-1", role: "user", content: "她喜欢喝什么？" },
  );

  const bound = await repository.bindConversationTurnEvidence({
    turnId: "turn-1",
    personaId: "persona-1",
    evidence: [{ kind: "fact", itemId: "fact-confirmed" }],
  });
  assert.deepEqual(bound.map((item) => item.itemId), ["fact-confirmed"]);

  const completed = await repository.completeConversationTurn({
    turnId: "turn-1",
    personaId: "persona-1",
    assistantMessageId: "assistant-1",
    content: "她爱喝桂花茶。",
    mode: "grounded",
    boundaryKind: null,
    degradationReason: null,
    retrievalMs: 12,
    firstSentenceMs: 40,
    totalMs: 80,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.assistantMessageId, "assistant-1");
  assert.deepEqual(
    database.prepare("SELECT persona_id, role, content FROM messages WHERE id = ?").get("assistant-1"),
    { persona_id: "persona-1", role: "assistant", content: "她爱喝桂花茶。" },
  );
  const messageEvidence = await repository.listMessageEvidence("assistant-1", "persona-1");
  assert.equal(messageEvidence.length, 1);
  assert.equal(messageEvidence[0].itemId, "fact-confirmed");
  assert.equal(Number.isNaN(Date.parse(messageEvidence[0].createdAt)), false);

  const revoked = await repository.revokePersonaSource("source-ready", "persona-1", "user-1");
  assert.equal(revoked.sourceRevoked, true);
  assert.equal((database.prepare("SELECT status FROM persona_facts WHERE id = ?").get("fact-confirmed") as { status: string }).status, "revoked");
  assert.equal((await repository.listMessageEvidence("assistant-1", "persona-1")).length, 1);
  assert.equal(await repository.failConversationTurn({
    turnId: "turn-1",
    personaId: "persona-1",
    status: "generation_failed",
    degradationReason: "model_failed",
    totalMs: 90,
  }), false);

  await repository.startConversationTurn({
    turnId: "turn-after-revoke",
    personaId: "persona-1",
    userMessageId: "user-after-revoke",
    content: "再问一次",
  });
  await assert.rejects(repository.bindConversationTurnEvidence({
    turnId: "turn-after-revoke",
    personaId: "persona-1",
    evidence: [{ kind: "fact", itemId: "fact-confirmed" }],
  }), /conversation_evidence_unavailable/);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM conversation_turn_evidence WHERE turn_id = ?").get("turn-after-revoke") as { count: number }).count,
    0,
  );
});

it("enforces turn mode rules, compare-and-set failure status, and transaction rollback", async () => {
  resetConversationFixtures();
  insertSource("source-ready", "persona-1");
  insertFact("fact-confirmed", "persona-1", "confirmed");
  insertFact("fact-pending", "persona-1", "pending");
  linkSource("fact", "fact-confirmed", "source-ready");
  linkSource("fact", "fact-pending", "source-ready");

  await repository.startConversationTurn({
    turnId: "turn-invalid-bind",
    personaId: "persona-1",
    userMessageId: "user-invalid-bind",
    content: "test",
  });
  await assert.rejects(repository.bindConversationTurnEvidence({
    turnId: "turn-invalid-bind",
    personaId: "persona-1",
    evidence: [{ kind: "fact", itemId: "fact-pending" }],
  }), /conversation_evidence_unavailable/);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM conversation_turn_evidence WHERE turn_id = ?").get("turn-invalid-bind") as { count: number }).count,
    0,
  );

  await assert.rejects(repository.completeConversationTurn({
    turnId: "turn-invalid-bind",
    personaId: "persona-1",
    assistantMessageId: "assistant-no-evidence",
    content: "answer",
    mode: "grounded",
    boundaryKind: null,
    degradationReason: "no_relevant_evidence",
    retrievalMs: 1,
    firstSentenceMs: null,
    totalMs: 2,
  }), /conversation_turn_evidence_mismatch/);
  assert.equal(database.prepare("SELECT id FROM messages WHERE id = ?").get("assistant-no-evidence"), undefined);

  const failed = await repository.failConversationTurn({
    turnId: "turn-invalid-bind",
    personaId: "persona-1",
    status: "generation_failed",
    degradationReason: "model_failed",
    totalMs: 3,
  });
  assert.equal(failed, true);
  assert.equal(await repository.failConversationTurn({
    turnId: "turn-invalid-bind",
    personaId: "persona-1",
    status: "assistant_persistence_failed",
    degradationReason: "assistant_persistence_failed",
    totalMs: 4,
  }), false);

  await repository.startConversationTurn({
    turnId: "turn-rollback",
    personaId: "persona-1",
    userMessageId: "user-rollback",
    content: "test rollback",
  });
  await repository.bindConversationTurnEvidence({
    turnId: "turn-rollback",
    personaId: "persona-1",
    evidence: [{ kind: "fact", itemId: "fact-confirmed" }],
  });
  await assert.rejects(repository.completeConversationTurn({
    turnId: "turn-rollback",
    personaId: "persona-1",
    assistantMessageId: "assistant-wrong-mode",
    content: "answer",
    mode: "companionship",
    boundaryKind: null,
    degradationReason: null,
    retrievalMs: 1,
    firstSentenceMs: 2,
    totalMs: 3,
  }), /conversation_turn_evidence_mismatch/);
  assert.equal(database.prepare("SELECT id FROM messages WHERE id = ?").get("assistant-wrong-mode"), undefined);
  database.exec(`
    CREATE TEMP TRIGGER fail_message_evidence_insert
    BEFORE INSERT ON message_evidence
    BEGIN
      SELECT RAISE(ABORT, 'forced_evidence_failure');
    END;
  `);
  await assert.rejects(repository.completeConversationTurn({
    turnId: "turn-rollback",
    personaId: "persona-1",
    assistantMessageId: "assistant-rollback",
    content: "answer",
    mode: "grounded",
    boundaryKind: null,
    degradationReason: null,
    retrievalMs: 1,
    firstSentenceMs: 2,
    totalMs: 3,
  }), /forced_evidence_failure/);
  database.exec("DROP TRIGGER fail_message_evidence_insert");
  assert.equal(database.prepare("SELECT id FROM messages WHERE id = ?").get("assistant-rollback"), undefined);
  assert.equal(
    (database.prepare("SELECT status FROM conversation_turns WHERE id = ?").get("turn-rollback") as { status: string }).status,
    "started",
  );

  await repository.startConversationTurn({
    turnId: "turn-start-atomic",
    personaId: "persona-1",
    userMessageId: "user-original",
    content: "original",
  });
  await assert.rejects(repository.startConversationTurn({
    turnId: "turn-start-atomic",
    personaId: "persona-1",
    userMessageId: "user-must-rollback",
    content: "duplicate turn",
  }));
  assert.equal(database.prepare("SELECT id FROM messages WHERE id = ?").get("user-must-rollback"), undefined);

  await repository.startConversationTurn({
    turnId: "turn-boundary",
    personaId: "persona-1",
    userMessageId: "user-boundary",
    content: "boundary",
  });
  const boundary = await repository.completeConversationTurn({
    turnId: "turn-boundary",
    personaId: "persona-1",
    assistantMessageId: "assistant-boundary",
    content: "boundary answer",
    mode: "boundary",
    boundaryKind: "identity",
    degradationReason: null,
    retrievalMs: 1,
    firstSentenceMs: 2,
    totalMs: 3,
  });
  assert.equal(boundary.status, "completed");
  assert.equal((await repository.listMessageEvidence("assistant-boundary", "persona-1")).length, 0);
});
