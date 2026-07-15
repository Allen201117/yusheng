import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyMigrations, createMigrationPlan } from "../scripts/apply-migrations";
import { createPostgresRepository } from "../src/lib/storage/postgresRepository";
import type { SqlExecutor } from "../src/lib/storage/postgres";

function createFakeSql(
  resolver: (text: string, params: unknown[]) => Array<Record<string, unknown>> = () => [],
) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  let transactions = 0;
  const executor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return resolver(text, params) as T[];
    },
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>) {
      transactions += 1;
      return work(executor);
    },
  };
  return { executor, calls, get transactions() { return transactions; } };
}

function assertContiguousPostgresPlaceholders(call: { text: string; params: unknown[] }) {
  const placeholders = Array.from(
    new Set(Array.from(call.text.matchAll(/\$(\d+)/g), (match) => Number(match[1]))),
  ).sort((left, right) => left - right);
  assert.deepEqual(
    placeholders,
    Array.from({ length: call.params.length }, (_, index) => index + 1),
    `SQL placeholders and parameters diverged: ${placeholders.join(",")} / ${call.params.length}`,
  );
}

it("applies only migrations missing from schema_migrations", () => {
  const plan = createMigrationPlan(["001_production_foundation.sql"], new Set());
  assert.deepEqual(plan, ["001_production_foundation.sql"]);
  assert.deepEqual(createMigrationPlan(plan, new Set(plan)), []);
});

it("defines the complete durable schema with vector memory storage", async () => {
  const sql = await readFile(
    new URL("../migrations/001_production_foundation.sql", import.meta.url),
    "utf8",
  );

  for (const table of [
    "schema_migrations",
    "users",
    "verification_codes",
    "voice_profiles",
    "personas",
    "memories",
    "messages",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(sql, /embedding vector\(1024\)/);
  assert.match(sql, /voice_id text NOT NULL REFERENCES voice_profiles\(id\) ON DELETE RESTRICT/);
});

it("adds durable provider voice lifecycle fields", async () => {
  const sql = await readFile(
    new URL("../migrations/002_provider_voice_lifecycle.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /provider_voice_id text/);
  assert.match(sql, /provider_voice_status text NOT NULL DEFAULT 'not_created'/);
  assert.match(sql, /provider_voice_error_code text/);
  assert.match(sql, /provider_voice_updated_at timestamptz/);
  assert.match(sql, /not_created.*pending.*ready.*failed.*deleting/s);
});

it("adds owner-scoped auditable voice authorization records", async () => {
  const sql = await readFile(
    new URL("../migrations/003_voice_authorizations.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS voice_authorizations/);
  assert.match(sql, /voice_id text NOT NULL REFERENCES voice_profiles\(id\)/);
  assert.match(sql, /user_id text NOT NULL REFERENCES users\(id\)/);
  assert.match(sql, /speaker_status IN \('living', 'deceased'\)/);
  assert.match(sql, /basis IN \('self', 'speaker_separate_consent', 'legal_representative', 'close_relative_request'\)/);
  assert.match(sql, /status IN \('pending_review', 'approved', 'rejected', 'revoked'\)/);
  assert.match(sql, /notice_version text NOT NULL/);
  assert.match(sql, /separate_consent_confirmed boolean NOT NULL/);
  assert.match(sql, /third_party_processing_confirmed boolean NOT NULL/);
  assert.match(sql, /synthetic_disclosure_confirmed boolean NOT NULL/);
  assert.match(sql, /attested_at timestamptz NOT NULL/);
  assert.match(sql, /revoked_at timestamptz/);
  assert.match(sql, /WHERE status IN \('pending_review', 'approved'\)/);
});

it("adds persona knowledge tables and idempotently copies legacy memories", async () => {
  const sql = await readFile(
    new URL("../migrations/004_persona_knowledge.sql", import.meta.url),
    "utf8",
  );

  for (const table of [
    "persona_sources",
    "persona_facts",
    "relationship_memories",
    "speech_style_items",
    "persona_item_sources",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(
    sql,
    /status text NOT NULL CHECK \(status IN \('pending', 'confirmed', 'rejected', 'conflicted', 'revoked'\)\)/,
  );
  assert.match(sql, /INSERT INTO relationship_memories[\s\S]*SELECT[\s\S]*FROM memories/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(sql, /WHERE status = 'confirmed'/);
});

it("adds grounded conversation durability and confirmed fact embeddings", async () => {
  const sql = await readFile(
    new URL("../migrations/005_grounded_conversation.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /ALTER TABLE persona_facts ADD COLUMN IF NOT EXISTS embedding vector\(1024\)/);
  for (const table of [
    "conversation_turns",
    "conversation_turn_evidence",
    "message_evidence",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /mode[^\n]*CHECK \(mode IN \('grounded', 'companionship', 'boundary'\)\)/);
  assert.match(
    sql,
    /assistant_message_id text UNIQUE REFERENCES messages\(id\) ON DELETE CASCADE/,
  );

  const turnsBody = sql.match(
    /CREATE TABLE IF NOT EXISTS conversation_turns \(([\s\S]*?)\n\);/,
  )?.[1];
  assert.ok(turnsBody, "conversation_turns CREATE TABLE body must be extractable");
  assert.match(
    turnsBody,
    /status[^\n]*CHECK \(status IN \('started', 'completed', 'generation_failed', 'assistant_persistence_failed'\)\)/,
  );
  assert.match(
    turnsBody,
    /status = 'completed'[\s\S]*assistant_message_id IS NOT NULL/,
  );
});

it("adds owner-consistent auditable restoration feedback schema", async () => {
  const sql = await readFile(
    new URL("../migrations/006_restoration_feedback.sql", import.meta.url),
    "utf8",
  );

  for (const table of [
    "conversation_sessions",
    "conversation_sentences",
    "tts_attempts",
    "playback_events",
    "conversation_feedback",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /ADD COLUMN IF NOT EXISTS session_id text REFERENCES conversation_sessions\(id\) ON DELETE SET NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS speech_tracking_failed boolean NOT NULL DEFAULT false/);
  assert.match(sql, /WHERE status = 'active'/);
  assert.match(sql, /UNIQUE \(turn_id, sentence_index\)/);
  assert.match(sql, /UNIQUE \(sentence_id, attempt_no\)/);
  assert.match(sql, /event_id text PRIMARY KEY/);
  assert.match(sql, /UNIQUE \(session_id, evaluator_user_id\)/);
  for (const score of [
    "voice_similarity",
    "expression_similarity",
    "emotion_fit",
    "fact_trust",
    "discomfort",
  ]) {
    assert.match(sql, new RegExp(`${score} integer NOT NULL CHECK \\(${score} BETWEEN 1 AND 5\\)`));
  }
  assert.match(sql, /CHECK \(knows_voice_owner = true\)/);
  assert.match(sql, /CHECK \(heard_all_rounds = true\)/);
  assert.match(sql, /FOREIGN KEY \(persona_id, evaluator_user_id, voice_id\)[\s\S]*REFERENCES personas\(id, user_id, voice_id\)/);
  assert.match(sql, /ON voice_authorizations\(id, voice_id, user_id, speaker_status\)/);
  assert.match(sql, /FOREIGN KEY \(voice_authorization_id, voice_id, evaluator_user_id, cohort\)[\s\S]*REFERENCES voice_authorizations\(id, voice_id, user_id, speaker_status\)/);
  assert.match(sql, /CHECK \(comment IS NULL OR char_length\(comment\) <= 1000\)/);
});

it("adds the one-event-type-per-attempt playback uniqueness migration", async () => {
  const sql = await readFile(
    new URL("../migrations/007_playback_event_cardinality.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /DELETE FROM playback_events/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_events_one_type_per_attempt\s+ON playback_events\(tts_attempt_id, event_type\)/,
  );
  const lockAt = sql.indexOf("LOCK TABLE playback_events IN SHARE ROW EXCLUSIVE MODE");
  const deleteAt = sql.indexOf("DELETE FROM playback_events");
  const createAt = sql.indexOf("CREATE UNIQUE INDEX");
  assert.ok(lockAt >= 0);
  assert.ok(lockAt < deleteAt);
  assert.ok(deleteAt < createAt);
});

it("locks the owner-scoped persona before atomically reusing an active restoration session", async () => {
  const now = "2026-07-14T10:00:00.000Z";
  const fake = createFakeSql((text) => {
    if (text.includes("FROM personas") && text.includes("FOR UPDATE")) {
      return [{ id: "persona-1" }];
    }
    if (text.includes("FROM voice_authorizations") && text.includes("FOR UPDATE")) {
      return [{ id: "auth-1" }];
    }
    if (text.includes("UPDATE conversation_sessions") && text.includes("status = 'expired'")) {
      return [];
    }
    if (text.includes("FROM conversation_sessions") && text.includes("status = 'active'")) {
      return [{
        id: "session-existing",
        persona_id: "persona-1",
        evaluator_user_id: "user-1",
        voice_id: "voice-1",
        voice_authorization_id: "auth-1",
        cohort: "living",
        status: "active",
        started_at: now,
        last_activity_at: "2026-07-14T09:50:00.000Z",
        rated_at: null,
      }];
    }
    if (text.includes("UPDATE conversation_sessions") && text.includes("last_activity_at =")) {
      return [{
        id: "session-existing", persona_id: "persona-1", evaluator_user_id: "user-1",
        voice_id: "voice-1", voice_authorization_id: "auth-1", cohort: "living",
        status: "active", started_at: now, last_activity_at: now, rated_at: null,
      }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);
  const session = await repo.getOrStartConversationSession({
    proposedSessionId: "session-proposed",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1",
    cohort: "living",
    now,
    staleBefore: "2026-07-14T09:30:00.000Z",
  });

  assert.equal(session.id, "session-existing");
  assert.equal(session.cohort, "living");
  assert.equal(session.lastActivityAt, now);
  assert.equal(fake.transactions, 1);
  const personaLock = fake.calls.findIndex((call) =>
    call.text.includes("FROM personas") && call.text.includes("FOR UPDATE"));
  const expiry = fake.calls.findIndex((call) =>
    call.text.includes("UPDATE conversation_sessions") && call.text.includes("status = 'expired'"));
  const activeSelect = fake.calls.findIndex((call) =>
    call.text.includes("FROM conversation_sessions") && call.text.includes("status = 'active'"));
  const authorizationLock = fake.calls.findIndex((call) =>
    call.text.includes("FROM voice_authorizations") && call.text.includes("FOR UPDATE"));
  const touch = fake.calls.findIndex((call) =>
    call.text.includes("UPDATE conversation_sessions") && call.text.includes("last_activity_at ="));
  assert.ok(
    personaLock >= 0 && personaLock < authorizationLock
      && authorizationLock < expiry && expiry < activeSelect && activeSelect < touch,
  );
  assert.match(fake.calls[personaLock].text, /id = \$1 AND user_id = \$2 AND voice_id = \$3/);
  assert.match(fake.calls[authorizationLock].text, /status = 'approved'/);
  assert.match(fake.calls[authorizationLock].text, /speaker_status = \$4/);
  assert.match(fake.calls[expiry].text, /last_activity_at <= \$3/);
  assert.match(fake.calls[expiry].text, /voice_authorization_id <> \$5/);
  assert.doesNotMatch(fake.calls[expiry].text, /SET[\s\S]*last_activity_at\s*=/);
  assert.deepEqual(fake.calls[expiry].params, [
    "persona-1", "user-1", "2026-07-14T09:30:00.000Z", "voice-1", "auth-1", "living",
  ]);
});

it("creates a new Postgres session with immutable voice authorization and cohort snapshots", async () => {
  const now = "2026-07-14T10:00:00.000Z";
  const fake = createFakeSql((text, params) => {
    if (text.includes("FROM personas") && text.includes("FOR UPDATE")) return [{ id: "persona-2" }];
    if (text.includes("FROM voice_authorizations") && text.includes("FOR UPDATE")) return [{ id: "auth-2" }];
    if (text.includes("UPDATE conversation_sessions") && text.includes("status = 'expired'")) return [];
    if (text.includes("FROM conversation_sessions") && text.includes("status = 'active'")) return [];
    if (text.includes("INSERT INTO conversation_sessions")) return [{
      id: params[0],
      persona_id: params[1],
      evaluator_user_id: params[2],
      voice_id: params[3],
      voice_authorization_id: params[4],
      cohort: params[5],
      status: "active",
      started_at: params[6],
      last_activity_at: params[6],
      rated_at: null,
    }];
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);
  const session = await repo.getOrStartConversationSession({
    proposedSessionId: "session-new",
    personaId: "persona-2",
    evaluatorUserId: "user-2",
    voiceId: "voice-2",
    voiceAuthorizationId: "auth-2",
    cohort: "deceased",
    now,
    staleBefore: "2026-07-14T09:30:00.000Z",
  });
  assert.deepEqual(session, {
    id: "session-new",
    personaId: "persona-2",
    evaluatorUserId: "user-2",
    voiceId: "voice-2",
    voiceAuthorizationId: "auth-2",
    cohort: "deceased",
    status: "active",
    startedAt: now,
    lastActivityAt: now,
    ratedAt: null,
  });
  const insert = fake.calls.find((call) => call.text.includes("INSERT INTO conversation_sessions"))!;
  assert.deepEqual(insert.params, [
    "session-new", "persona-2", "user-2", "voice-2", "auth-2", "deceased", now,
  ]);
});

it("rejects revoked or mismatched authorization before mutating Postgres sessions", async () => {
  const fake = createFakeSql((text) => {
    if (text.includes("FROM personas") && text.includes("FOR UPDATE")) return [{ id: "persona-1" }];
    if (text.includes("FROM voice_authorizations") && text.includes("FOR UPDATE")) return [];
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);
  await assert.rejects(repo.getOrStartConversationSession({
    proposedSessionId: "session-denied",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-revoked",
    cohort: "deceased",
    now: "2026-07-14T10:00:00.000Z",
    staleBefore: "2026-07-14T09:30:00.000Z",
  }), /conversation_session_authorization_denied/);
  assert.equal(fake.calls.some((call) =>
    call.text.includes("UPDATE conversation_sessions") || call.text.includes("INSERT INTO conversation_sessions")), false);
});

it("rejects a turn/session persona mismatch before persisting its user message", async () => {
  const fake = createFakeSql((text) => {
    if (text.includes("FROM personas") && text.includes("FOR UPDATE")) {
      return [{ id: "persona-2" }];
    }
    if (text.includes("FROM conversation_sessions") && text.includes("FOR UPDATE")) return [];
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);
  await assert.rejects(repo.startConversationTurn({
    turnId: "turn-mismatch",
    sessionId: "session-1",
    personaId: "persona-2",
    userMessageId: "message-mismatch",
    content: "不应保存",
  }), /conversation_turn_session_mismatch/);
  assert.equal(fake.calls.some((call) => call.text.includes("INSERT INTO messages")), false);
  assert.equal(fake.transactions, 1);
});

it("applies a pending migration and records it in one transaction", async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  let transactions = 0;
  const executor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      if (text.includes("SELECT version")) return [] as T[];
      return [] as T[];
    },
    async transaction<T>(work: (sql: SqlExecutor) => Promise<T>) {
      transactions += 1;
      return work(executor);
    },
  };

  const result = await applyMigrations(
    [{ version: "001.sql", sql: "CREATE TABLE example (id text);" }],
    executor,
  );

  assert.deepEqual(result, { applied: ["001.sql"], skipped: [] });
  assert.equal(transactions, 1);
  assert.ok(queries.some((entry) => entry.text.includes("CREATE TABLE example")));
  assert.ok(queries.some((entry) => entry.text.includes("INSERT INTO schema_migrations")));
});

it("queries a persona with both persona id and owner id", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return [{
        id: "persona-1",
        user_id: "user-1",
        name: "妈妈",
        relation: "母亲",
        voice_id: "voice-1",
        persona_desc: "温和",
        created_at: new Date("2026-07-13T00:00:00.000Z"),
      }] as unknown as T[];
    },
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>) {
      return work(sql);
    },
  };
  const repo = createPostgresRepository(sql);

  assert.deepEqual(await repo.getPersonaForUser("persona-1", "user-1"), {
    id: "persona-1",
    userId: "user-1",
    name: "妈妈",
    relation: "母亲",
    voiceId: "voice-1",
    personaDesc: "温和",
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  assert.match(calls[0].text, /id = \$1 AND user_id = \$2/);
  assert.deepEqual(calls[0].params, ["persona-1", "user-1"]);
});

it("maps a user returned by email", async () => {
  const fake = createFakeSql(() => [{
    id: "user-1",
    email: "owner@example.com",
    phone: null,
    password: "hash",
    created_at: "2026-07-13T01:00:00.000Z",
  }]);
  const repo = createPostgresRepository(fake.executor);

  assert.deepEqual(await repo.getUserByEmail("owner@example.com"), {
    id: "user-1",
    email: "owner@example.com",
    phone: "",
    password: "hash",
    createdAt: "2026-07-13T01:00:00.000Z",
  });
  assert.deepEqual(fake.calls[0].params, ["owner@example.com"]);
});

it("creates a user with an application-generated id", async () => {
  const fake = createFakeSql((_text, params) => [{
    id: params[0],
    email: params[1],
    phone: null,
    password: params[2],
    created_at: "2026-07-13T01:00:00.000Z",
  }]);
  const repo = createPostgresRepository(fake.executor);

  const user = await repo.createUserByEmail("new@example.com", "hash");
  assert.equal(user.email, "new@example.com");
  assert.equal(user.password, "hash");
  assert.match(user.id, /^[0-9a-f-]{36}$/);
  assert.match(fake.calls[0].text, /INSERT INTO users/);
});

it("creates and consumes a verification code atomically", async () => {
  const fake = createFakeSql((text) => {
    if (text.includes("UPDATE verification_codes")) return [{ id: "code-1" }];
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  await repo.createVerificationCode({ email: "owner@example.com" }, "123456", 5);
  assert.equal(await repo.verifyCode({ email: "owner@example.com" }, "123456"), true);
  assert.equal(fake.transactions, 1);
  assert.ok(fake.calls.some((call) => call.text.includes("INSERT INTO verification_codes")));
  assert.ok(fake.calls.some((call) => call.text.includes("UPDATE verification_codes")));
});

it("creates and lists personas for one owner", async () => {
  const fake = createFakeSql((text, params) => {
    if (text.includes("INSERT INTO personas")) {
      return [{
        id: params[0], user_id: params[1], name: params[2], relation: params[3],
        voice_id: params[4], persona_desc: params[5], created_at: "2026-07-13T02:00:00.000Z",
      }];
    }
    if (text.includes("FROM personas") && text.includes("ORDER BY")) {
      return [{
        id: "persona-1", user_id: "user-1", name: "爸爸", relation: "父亲",
        voice_id: "voice-1", persona_desc: "沉稳", created_at: "2026-07-13T02:00:00.000Z",
      }];
    }
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  const created = await repo.createPersona({
    id: "persona-1", userId: "user-1", name: "爸爸", relation: "父亲",
    voiceId: "voice-1", personaDesc: "沉稳",
  });
  assert.equal(created.userId, "user-1");
  assert.deepEqual(await repo.listPersonas("user-1"), [created]);
  assert.ok(fake.calls.every((call) => !call.text.includes("FROM personas") || call.params.includes("user-1")));
});

it("deletes a persona for its owner in one transaction", async () => {
  const fake = createFakeSql((text) => text.includes("DELETE FROM personas") ? [{
    id: "persona-1", user_id: "user-1", name: "爸爸", relation: "父亲",
    voice_id: "voice-1", persona_desc: "沉稳", created_at: "2026-07-13T02:00:00.000Z",
  }] : []);
  const repo = createPostgresRepository(fake.executor);

  const deleted = await repo.deletePersona("persona-1", "user-1");
  assert.equal(deleted?.voiceId, "voice-1");
  assert.equal(fake.transactions, 1);
  assert.deepEqual(fake.calls.find((call) => call.text.includes("DELETE FROM personas"))?.params, ["persona-1", "user-1"]);
});

it("stores a confirmed memory, its source, and its link in one transaction", async () => {
  const fake = createFakeSql((text) => {
    if (text.includes("INSERT INTO persona_sources")) return [{ id: "source-1" }];
    if (text.includes("INSERT INTO relationship_memories")) return [{ id: "memory-1" }];
    if (text.includes("INSERT INTO persona_item_sources")) return [{ item_id: "memory-1" }];
    if (text.includes("embedding::text")) {
      return [{ id: "memory-1", content: "一起去海边", embedding: "[0.25,0.5]" }];
    }
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  await repo.insertMemory({
    id: "memory-1", personaId: "persona-1", content: "一起去海边",
    embedding: Float32Array.from([0.25, 0.5]),
    createdBy: "user-1",
    sourceId: "source-1",
    checksumAlgorithm: "sha256",
    checksum: "checksum-1",
  });
  assert.equal(fake.transactions, 1);
  const sourceInsert = fake.calls.find((call) => call.text.includes("INSERT INTO persona_sources"));
  const memoryInsert = fake.calls.find((call) => call.text.includes("INSERT INTO relationship_memories"));
  const linkInsert = fake.calls.find((call) => call.text.includes("INSERT INTO persona_item_sources"));
  assert.ok(sourceInsert);
  assert.deepEqual(sourceInsert.params, [
    "source-1", "persona-1", "一起去海边", "sha256", "checksum-1", "user-1",
  ]);
  assert.ok(memoryInsert);
  assert.match(memoryInsert.text, /'confirmed'/);
  assert.ok(memoryInsert.params.includes("[0.25,0.5]"));
  assert.ok(linkInsert);
  assert.match(linkInsert.text, /'relationship_memory'/);
  assert.equal(fake.calls.some((call) => call.text.includes("INSERT INTO memories")), false);

  const memories = await repo.loadMemoriesWithEmbeddings("persona-1");
  assert.deepEqual(Array.from(memories[0].embedding), [0.25, 0.5]);
});

it("stores a whole memory batch in one transaction executor", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  let transactions = 0;
  let rootQueries = 0;
  const transactionExecutor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (text.includes("INSERT INTO persona_sources")) return [{ id: params[0] }] as unknown as T[];
      if (text.includes("INSERT INTO relationship_memories")) return [{ id: params[0] }] as unknown as T[];
      if (text.includes("INSERT INTO persona_item_sources")) return [{ item_id: params[0] }] as unknown as T[];
      return [] as T[];
    },
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>) {
      return work(transactionExecutor);
    },
  };
  const rootExecutor: SqlExecutor = {
    async query<T extends Record<string, unknown>>() {
      rootQueries += 1;
      return [] as T[];
    },
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>) {
      transactions += 1;
      return work(transactionExecutor);
    },
  };
  const repo = createPostgresRepository(rootExecutor);
  const makeInput = (suffix: string) => ({
    id: `memory-${suffix}`,
    personaId: "persona-1",
    content: `记忆-${suffix}`,
    embedding: Float32Array.from([0.25, 0.5]),
    createdBy: "user-1",
    sourceId: `source-${suffix}`,
    checksumAlgorithm: "sha256" as const,
    checksum: `checksum-${suffix}`,
  });

  await repo.insertMemories([makeInput("1"), makeInput("2")]);

  assert.equal(transactions, 1);
  assert.equal(rootQueries, 0);
  assert.equal(calls.filter((call) => call.text.includes("INSERT INTO persona_sources")).length, 2);
  assert.equal(calls.filter((call) => call.text.includes("INSERT INTO relationship_memories")).length, 2);
  assert.equal(calls.filter((call) => call.text.includes("INSERT INTO persona_item_sources")).length, 2);
});

it("returns messages in chronological order", async () => {
  const fake = createFakeSql(() => [
    { id: "m2", persona_id: "p1", role: "assistant", content: "后", created_at: "2026-07-13T03:01:00.000Z" },
    { id: "m1", persona_id: "p1", role: "user", content: "先", created_at: "2026-07-13T03:00:00.000Z" },
  ]);
  const repo = createPostgresRepository(fake.executor);

  const messages = await repo.listMessages("p1", 50);
  assert.deepEqual(messages.map((message) => message.id), ["m1", "m2"]);
  assert.deepEqual(fake.calls[0].params, ["p1", 50]);
});

it("stores and owner-scopes voice profile metadata", async () => {
  const fake = createFakeSql((text, params) => {
    if (text.includes("INSERT INTO voice_profiles")) return [{
      id: params[0], user_id: params[1], object_path: params[2], checksum_sha256: params[3],
      prompt_text: params[4], mime_type: params[5], duration_sec: params[6],
      created_at: "2026-07-13T04:00:00.000Z",
    }];
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  const voice = await repo.createVoiceProfile({
    voiceId: "voice-1", userId: "user-1", objectPath: "users/user-1/voices/voice-1/a.wav",
    checksumSha256: "abc", promptText: "你好", mimeType: "audio/wav", durationSec: 2,
  });
  assert.equal(voice.userId, "user-1");
  await repo.getVoiceProfileForUser("voice-1", "user-1");
  assert.deepEqual(fake.calls[1].params, ["voice-1", "user-1"]);
});

it("updates provider voice state only for the owning user", async () => {
  const fake = createFakeSql((text, params) => {
    if (!text.includes("UPDATE voice_profiles")) return [];
    return [{
      id: "voice-1", user_id: "user-1", object_path: "users/user-1/voice.wav",
      checksum_sha256: "abc", prompt_text: "你好", mime_type: "audio/wav",
      duration_sec: 2, provider_voice_id: params[2], provider_voice_status: params[3],
      provider_voice_error_code: params[4], provider_voice_updated_at: "2026-07-13T08:00:00.000Z",
      created_at: "2026-07-13T07:00:00.000Z",
    }];
  });
  const repo = createPostgresRepository(fake.executor);

  const voice = await repo.updateVoiceProviderState("voice-1", "user-1", {
    status: "ready",
    providerVoiceId: "speech:yusheng-voice-1:provider-id",
    errorCode: null,
  });

  assert.equal(voice?.providerVoiceStatus, "ready");
  assert.equal(voice?.providerVoiceId, "speech:yusheng-voice-1:provider-id");
  assert.deepEqual(fake.calls[0].params.slice(0, 2), ["voice-1", "user-1"]);
  assert.match(fake.calls[0].text, /id = \$1 AND user_id = \$2 AND deleted_at IS NULL/);
});

it("replaces, reads and revokes owner-scoped voice authorization atomically", async () => {
  const row = {
    id: "auth-1", voice_id: "voice-1", user_id: "user-1", speaker_status: "living",
    basis: "self", status: "approved", reason_code: null,
    notice_version: "voice-authorization-2026-07-13",
    separate_consent_confirmed: true, third_party_processing_confirmed: true,
    synthetic_disclosure_confirmed: true,
    attested_at: "2026-07-13T09:00:00.000Z", reviewed_at: null,
    revoked_at: null, created_at: "2026-07-13T09:00:00.000Z",
  };
  const fake = createFakeSql((text) => {
    if (text.includes("INSERT INTO voice_authorizations")) return [row];
    if (text.includes("UPDATE voice_authorizations") && text.includes("RETURNING")) {
      return [{ ...row, status: "revoked", revoked_at: "2026-07-13T09:01:00.000Z" }];
    }
    if (text.includes("SELECT") && text.includes("voice_authorizations")) return [row];
    return [];
  });
  const repo = createPostgresRepository(fake.executor);
  const input = {
    id: "auth-1", voiceId: "voice-1", userId: "user-1", speakerStatus: "living" as const,
    basis: "self" as const, status: "approved" as const, reasonCode: null,
    noticeVersion: "voice-authorization-2026-07-13",
    separateConsentConfirmed: true, thirdPartyProcessingConfirmed: true,
    syntheticDisclosureConfirmed: true, attestedAt: "2026-07-13T09:00:00.000Z",
  };

  assert.equal((await repo.replaceVoiceAuthorization(input)).status, "approved");
  assert.equal(fake.transactions, 1);
  assert.equal((await repo.getCurrentVoiceAuthorization("voice-1", "user-1"))?.id, "auth-1");
  assert.equal((await repo.revokeVoiceAuthorization("voice-1", "user-1"))?.status, "revoked");
  assert.ok(fake.calls
    .filter((call) => call.text.includes("voice_authorizations"))
    .every((call) => call.params.includes("user-1")));
});

it("updates a password by normalized email", async () => {
  const fake = createFakeSql();
  const repo = createPostgresRepository(fake.executor);
  await repo.setUserPassword("owner@example.com", "new-hash");
  assert.match(fake.calls[0].text, /UPDATE users SET password/);
  assert.deepEqual(fake.calls[0].params, ["new-hash", "owner@example.com"]);
});

it("counts only the owner's personas using a voice", async () => {
  const fake = createFakeSql(() => [{ count: 2 }]);
  const repo = createPostgresRepository(fake.executor);
  assert.equal(await repo.countPersonasUsingVoice("voice-1", "user-1"), 2);
  assert.deepEqual(fake.calls[0].params, ["voice-1", "user-1"]);
});

it("lists and loads only confirmed relationship memories and soft-revokes them", async () => {
  let deletes = 0;
  const fake = createFakeSql((text) => {
    if (text.includes("SELECT id, persona_id, content, created_at")) {
      return [{ id: "memory-1", persona_id: "persona-1", content: "记忆", created_at: "2026-07-13T05:00:00.000Z" }];
    }
    if (text.includes("SELECT id, persona_id, content") && !text.includes("created_at")) {
      return [{ id: "memory-1", persona_id: "persona-1", content: "记忆" }];
    }
    if (text.includes("UPDATE relationship_memories")) {
      deletes += 1;
      return deletes === 1 ? [{ id: "memory-1" }] : [];
    }
    return [];
  });
  const repo = createPostgresRepository(fake.executor);
  assert.equal((await repo.listMemories("persona-1"))[0].createdAt, "2026-07-13T05:00:00.000Z");
  assert.equal((await repo.getMemoryById("memory-1"))?.personaId, "persona-1");
  assert.equal(await repo.deleteMemory("memory-1"), true);
  assert.equal(await repo.deleteMemory("memory-1"), false);
  const listCall = fake.calls.find((call) => call.text.includes("created_at"));
  const getCall = fake.calls.find((call) => call.text.includes("SELECT id, persona_id, content") && !call.text.includes("created_at"));
  const deleteCall = fake.calls.find((call) => call.text.includes("UPDATE relationship_memories"));
  assert.match(listCall?.text || "", /FROM relationship_memories[\s\S]*status = 'confirmed'/);
  assert.match(getCall?.text || "", /FROM relationship_memories[\s\S]*status = 'confirmed'/);
  assert.match(deleteCall?.text || "", /status = 'revoked'/);
  assert.match(deleteCall?.text || "", /status = 'confirmed'[\s\S]*RETURNING id/);
  assert.equal(fake.calls.some((call) => /DELETE FROM (?:relationship_)?memories/.test(call.text)), false);
});

it("inserts a message with a generated timestamp", async () => {
  const fake = createFakeSql((_text, params) => [{
    id: params[0], persona_id: params[1], role: params[2], content: params[3],
    created_at: "2026-07-13T06:00:00.000Z",
  }]);
  const repo = createPostgresRepository(fake.executor);
  const message = await repo.insertMessage({ id: "m1", personaId: "p1", role: "user", content: "你好" });
  assert.equal(message.createdAt, "2026-07-13T06:00:00.000Z");
  assert.match(fake.calls[0].text, /INSERT INTO messages/);
});

it("lists and soft-deletes owner-scoped voice metadata", async () => {
  const row = {
    id: "voice-1", user_id: "user-1", object_path: "users/user-1/voice.wav",
    checksum_sha256: "abc", prompt_text: "你好", mime_type: "audio/wav",
    duration_sec: 2, created_at: "2026-07-13T07:00:00.000Z",
  };
  const fake = createFakeSql((text) => {
    if (text.includes("SELECT") && text.includes("voice_profiles")) return [row];
    if (text.includes("UPDATE voice_profiles")) return [{ id: "voice-1" }];
    return [];
  });
  const repo = createPostgresRepository(fake.executor);
  assert.equal((await repo.listVoiceProfiles("user-1"))[0].voiceId, "voice-1");
  assert.equal(await repo.deleteVoiceProfile("voice-1", "user-1"), true);
  assert.ok(fake.calls.every((call) => !call.text.includes("voice_profiles") || call.params.includes("user-1")));
});

it("creates pending persona knowledge candidates in one scoped transaction", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  const fake = createFakeSql((text, params) => {
    if (text.includes("INSERT INTO persona_sources")) return [{
      id: params[0], persona_id: params[1], source_type: params[2], content_text: params[3],
      object_path: params[4], checksum_algorithm: params[5], checksum: params[6], status: params[7],
      created_by: params[8], created_at: now, revoked_at: null,
    }];
    if (text.includes("INSERT INTO persona_facts")) return [{
      id: params[0], persona_id: params[1], fact_type: params[2], fact_key: params[3],
      content: params[4], normalized_value: params[5], status: "pending", conflict_group_id: null,
      confirmed_by: null, confirmed_at: null, revoked_at: null, created_at: now, updated_at: now,
    }];
    if (text.includes("INSERT INTO persona_item_sources")) return [{ item_id: params[1] }];
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  const bundle = await repo.createPersonaKnowledgeCandidates({
    source: {
      id: "source-1", personaId: "persona-1", sourceType: "manual_text", contentText: "喜欢茉莉花",
      objectPath: null, checksumAlgorithm: "sha256", checksum: "sum-1", status: "ready", createdBy: "user-1",
    },
    candidates: [{
      kind: "fact", id: "fact-1", personaId: "persona-1", factType: "preference", factKey: "flower",
      content: "喜欢茉莉花", normalizedValue: "茉莉花", sourceId: "source-1", sourceExcerpt: "茉莉花",
    }],
  });

  assert.equal(fake.transactions, 1);
  assert.equal(bundle.facts[0].status, "pending");
  const knowledgeCalls = fake.calls.filter((call) => /persona_(sources|facts|item_sources)/.test(call.text));
  assert.ok(knowledgeCalls.every((call) => call.params.includes("persona-1") || call.text.includes("persona_item_sources")));
  assert.ok(fake.calls.some((call) => call.text.includes("persona_item_sources")));
});

it("rolls back candidate creation when the source link is not inserted", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  const fake = createFakeSql((text, params) => {
    if (text.includes("INSERT INTO persona_sources")) return [{
      id: params[0], persona_id: params[1], source_type: params[2], content_text: params[3],
      object_path: params[4], checksum_algorithm: params[5], checksum: params[6], status: params[7],
      created_by: params[8], created_at: now, revoked_at: null,
    }];
    if (text.includes("INSERT INTO persona_facts")) return [{
      id: params[0], persona_id: params[1], fact_type: params[2], fact_key: params[3],
      content: params[4], normalized_value: params[5], status: "pending", conflict_group_id: null,
      confirmed_by: null, confirmed_at: null, revoked_at: null, created_at: now, updated_at: now,
    }];
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  await assert.rejects(
    repo.createPersonaKnowledgeCandidates({
      source: {
        id: "source-missing", personaId: "persona-1", sourceType: "manual_text", contentText: "x",
        objectPath: null, checksumAlgorithm: "sha256", checksum: "sum-x", status: "ready", createdBy: "user-1",
      },
      candidates: [{
        kind: "fact", id: "fact-missing", personaId: "persona-1", factType: "preference",
        factKey: "drink", content: "x", normalizedValue: "x", sourceId: "source-missing", sourceExcerpt: "x",
      }],
    }),
    /persona_source_link_failed/,
  );
  assert.equal(fake.transactions, 1);
});

it("finds confirmed facts with normalized type and key", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  const fake = createFakeSql((text, params) => {
    if (text.includes("FROM persona_facts") && params.length === 1) return [{
      id: "fact-1", persona_id: "persona-1", fact_type: "Preference",
      fact_key: " favorite   drink ", content: "喜欢桂花茶", normalized_value: "桂花茶",
      status: "confirmed", conflict_group_id: null, confirmed_by: "user-1", confirmed_at: now,
      revoked_at: null, created_at: now, updated_at: now,
    }];
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  const facts = await repo.findConfirmedFacts("persona-1", "preference", "favorite drink");
  assert.deepEqual(facts.map((fact) => fact.id), ["fact-1"]);
  assert.deepEqual(fake.calls[0].params, ["persona-1"]);
});

it("reviews persona knowledge under one transaction-scoped persona lock", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  const transactionCalls: Array<{ text: string; params: unknown[] }> = [];
  let transactions = 0;
  const pendingRow = {
    id: "fact-new", persona_id: "persona-1", fact_type: "preference",
    fact_key: "favorite drink", content: "喜欢咖啡", normalized_value: "咖啡",
    status: "pending", conflict_group_id: null, confirmed_by: null, confirmed_at: null,
    revoked_at: null, created_at: now, updated_at: now,
  };
  const confirmedRow = {
    ...pendingRow,
    id: "fact-old",
    content: "喜欢茶",
    normalized_value: "茶",
    status: "confirmed",
    confirmed_by: "user-1",
    confirmed_at: now,
  };
  const transactionExecutor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      transactionCalls.push({ text, params });
      if (text.includes("pg_advisory_xact_lock")) return [] as T[];
      if (text.includes("FROM persona_facts") && text.includes("WHERE id = $1")) {
        return [pendingRow] as unknown as T[];
      }
      if (text.includes("FROM persona_facts") && text.includes("status = 'confirmed'")) {
        return [confirmedRow] as unknown as T[];
      }
      if (text.includes("UPDATE persona_facts") && text.includes("status = 'pending'")) {
        return [{
          ...pendingRow,
          content: params[3],
          normalized_value: params[4],
        }] as unknown as T[];
      }
      if (text.includes("UPDATE persona_facts") && text.includes("SET embedding")) {
        return [{ id: "fact-new" }] as unknown as T[];
      }
      if (text.includes("UPDATE persona_facts")) {
        const source = params[0] === "fact-old" ? confirmedRow : pendingRow;
        return [{
          ...source,
          status: params[3],
          confirmed_by: params[3] === "confirmed" ? params[4] : null,
          confirmed_at: params[3] === "confirmed" ? now : null,
          conflict_group_id: params[5],
          updated_at: now,
        }] as unknown as T[];
      }
      throw new Error(`unexpected transaction query: ${text}`);
    },
    async transaction() {
      throw new Error("nested_transaction");
    },
  };
  const executor: SqlExecutor = {
    async query() {
      throw new Error("review escaped transaction");
    },
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>) {
      transactions += 1;
      return work(transactionExecutor);
    },
  };
  const repo = createPostgresRepository(executor);

  const result = await repo.reviewPersonaKnowledgeAtomically({
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "fact",
    id: "fact-new",
    action: "confirm",
    edits: { content: "改后喜欢咖啡", normalizedValue: "咖啡" },
    embedding: {
      content: "改后喜欢咖啡",
      vector: new Float32Array(1024).fill(0.01),
    },
  });

  assert.equal(transactions, 1);
  assert.match(transactionCalls[0].text, /pg_advisory_xact_lock/);
  assert.deepEqual(transactionCalls[0].params, ["persona-1"]);
  const itemReadIndex = transactionCalls.findIndex((call) =>
    call.text.includes("FROM persona_facts") && call.text.includes("WHERE id = $1"));
  assert.ok(itemReadIndex > 0);
  assert.match(transactionCalls[itemReadIndex].text, /FOR UPDATE/);
  const editIndex = transactionCalls.findIndex((call) =>
    call.text.includes("UPDATE persona_facts") && call.text.includes("status = 'pending'"));
  const conflictReadIndex = transactionCalls.findIndex((call) =>
    call.text.includes("FROM persona_facts") && call.text.includes("status = 'confirmed'"));
  const embeddingIndex = transactionCalls.findIndex((call) =>
    call.text.includes("UPDATE persona_facts") && call.text.includes("SET embedding"));
  const statusIndex = transactionCalls.findIndex((call) =>
    call.text.includes("UPDATE persona_facts") && call.text.includes("status = $4"));
  assert.ok(
    itemReadIndex < editIndex
    && editIndex < embeddingIndex
    && embeddingIndex < conflictReadIndex
    && conflictReadIndex < statusIndex,
  );
  assert.equal(transactionCalls[embeddingIndex].params[0], "fact-new");
  assert.equal(transactionCalls[embeddingIndex].params[1], "persona-1");
  assert.match(String(transactionCalls[embeddingIndex].params[2]), /^\[0\.009999/);
  assert.equal(result.item.id, "fact-new");
  assert.equal(result.item.status, "conflicted");
  assert.deepEqual(result.conflicts.map((item) => item.id), ["fact-old"]);
  assert.equal(result.conflicts[0].conflictGroupId, result.item.conflictGroupId);
});

it("rejects stale, speech-style, and wrong-sized confirmation embeddings before status changes", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  const rows = {
    fact: {
      id: "fact-1", persona_id: "persona-1", fact_type: "preference",
      fact_key: "favorite drink", content: "她喜欢茶", normalized_value: "茶",
      status: "pending", conflict_group_id: null, confirmed_by: null, confirmed_at: null,
      revoked_at: null, created_at: now, updated_at: now,
    },
    speech_style: {
      id: "style-1", persona_id: "persona-1", category: "tone", content: "慢慢来",
      example: null, status: "pending", conflict_group_id: null, confirmed_by: null,
      confirmed_at: null, revoked_at: null, created_at: now, updated_at: now,
    },
  } as const;

  for (const scenario of [
    { kind: "fact" as const, id: "fact-1", content: "过期内容", vector: new Float32Array(1024) },
    { kind: "speech_style" as const, id: "style-1", content: "慢慢来", vector: new Float32Array(1024) },
    { kind: "fact" as const, id: "fact-1", content: "她喜欢茶", vector: new Float32Array(1023) },
  ]) {
    const fake = createFakeSql((text) => {
      if (text.includes("pg_advisory_xact_lock")) return [];
      if (text.includes("FROM persona_facts") && text.includes("WHERE id = $1")) return [rows.fact];
      if (text.includes("FROM speech_style_items") && text.includes("WHERE id = $1")) {
        return [rows.speech_style];
      }
      throw new Error(`unexpected query after invalid embedding: ${text}`);
    });
    const repo = createPostgresRepository(fake.executor);

    await assert.rejects(repo.reviewPersonaKnowledgeAtomically({
      personaId: "persona-1",
      actorUserId: "user-1",
      kind: scenario.kind,
      id: scenario.id,
      action: "confirm",
      embedding: { content: scenario.content, vector: scenario.vector },
    }), /knowledge_embedding_stale/);
    assert.equal(
      fake.calls.some((call) => call.text.includes("SET status = $4")),
      false,
    );
  }
});

it("uses confirmed relationship memories and compare-and-set status updates", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  const fake = createFakeSql((text, params) => {
    if (text.includes("FROM relationship_memories") && text.includes("embedding::text")) {
      return [{ id: "memory-1", content: "一起做饭", embedding: "[0.25,0.5]" }];
    }
    if (text.includes("UPDATE persona_facts")) return [{
      id: params[0], persona_id: params[1], fact_type: "preference", fact_key: "flower",
      content: "喜欢茉莉花", normalized_value: "茉莉花", status: params[3],
      conflict_group_id: params[5], confirmed_by: params[4], confirmed_at: now,
      revoked_at: null, created_at: now, updated_at: now,
    }];
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  const memories = await repo.loadMemoriesWithEmbeddings("persona-1");
  assert.deepEqual(Array.from(memories[0].embedding), [0.25, 0.5]);
  const changed = await repo.setPersonaKnowledgeStatuses([{
    kind: "fact", id: "fact-1", personaId: "persona-1", expectedStatus: "pending",
    nextStatus: "confirmed", actorUserId: "user-1", conflictGroupId: null,
  }]);
  assert.equal(changed[0].status, "confirmed");
  const loadCall = fake.calls.find((call) => call.text.includes("embedding::text"))!;
  assert.match(loadCall.text, /status = 'confirmed'/);
  assert.deepEqual(loadCall.params, ["persona-1"]);
  const updateCall = fake.calls.find((call) => call.text.includes("UPDATE persona_facts"))!;
  assert.match(updateCall.text, /persona_id = \$2/);
  assert.match(updateCall.text, /status = \$3/);
  assert.deepEqual(updateCall.params.slice(0, 3), ["fact-1", "persona-1", "pending"]);
});

it("revokes only unsupported persona knowledge for an owner-scoped source", async () => {
  const fake = createFakeSql((text, params) => {
    if (text.includes("UPDATE persona_sources") && text.includes("RETURNING")) return [{ id: "source-1" }];
    if (text.includes("COUNT(*)") && text.includes("persona_item_sources")) {
      return [{ count: params.includes("style-1") ? 1 : 0 }];
    }
    if (text.includes("FROM persona_item_sources")) return [
      { item_kind: "fact", item_id: "fact-1" },
      { item_kind: "speech_style", item_id: "style-1" },
    ];
    if (text.includes("FOR UPDATE")) return [{ id: params[0] }];
    if (text.includes("UPDATE persona_facts")) return [{ id: "fact-1" }];
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  const result = await repo.revokePersonaSource("source-1", "persona-1", "user-1");
  assert.equal(result.sourceRevoked, true);
  assert.deepEqual(result.revokedItems, [{ kind: "fact", id: "fact-1" }]);
  assert.equal(fake.transactions, 1);
  for (const item of [
    { table: "persona_facts", id: "fact-1" },
    { table: "speech_style_items", id: "style-1" },
  ]) {
    const lockIndex = fake.calls.findIndex((call) =>
      call.text.includes(`FROM ${item.table}`) && call.text.includes("FOR UPDATE") && call.params.includes(item.id));
    const countIndex = fake.calls.findIndex((call) =>
      call.text.includes("COUNT(*)") && call.params.includes(item.id));
    assert.ok(lockIndex >= 0 && lockIndex < countIndex, `${item.id} must be locked before support count`);
  }
  const revokeUpdate = fake.calls.find((call) => call.text.includes("UPDATE persona_facts"))!;
  assert.match(revokeUpdate.text, /status IN \('pending', 'confirmed', 'conflicted'\)/);
  const orderedLinks = fake.calls.find((call) =>
    call.text.includes("FROM persona_item_sources") && call.text.includes("ORDER BY"))!;
  assert.match(
    orderedLinks.text,
    /ORDER BY links\.item_kind COLLATE "C", links\.item_id COLLATE "C"/,
  );
  assert.ok(fake.calls
    .filter((call) => /persona_sources|persona_item_sources|persona_facts|speech_style_items/.test(call.text))
    .every((call) => call.params.includes("persona-1") || call.text.includes("persona_item_sources")));
});

it("loads only confirmed conversation evidence and styles with nullable embeddings", async () => {
  const fake = createFakeSql((text) => {
    assert.match(text, /persona_id = \$1/);
    assert.match(text, /status = 'confirmed'/);
    if (text.includes("FROM persona_facts")) return [{
      id: "fact-confirmed",
      content: "她爱喝桂花茶。",
      fact_type: "preference",
      fact_key: "drink",
      embedding: null,
    }];
    if (text.includes("FROM relationship_memories")) return [{
      id: "memory-confirmed",
      content: "一起喝茶。",
      occurred_at: null,
      location: null,
      participants: ["user-1"],
      embedding: null,
    }];
    if (text.includes("FROM speech_style_items")) return [{
      id: "style-confirmed",
      category: "tone",
      content: "慢慢说",
      example: null,
    }];
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);

  const result = await repo.loadConfirmedConversationKnowledge("persona-1");

  assert.deepEqual(result.evidence.map((item) => item.id), ["fact-confirmed", "memory-confirmed"]);
  assert.ok(result.evidence.every((item) => item.embedding === null));
  assert.deepEqual(result.styles.map((item) => item.id), ["style-confirmed"]);
  assert.equal(fake.calls.length, 3);
  assert.ok(fake.calls.slice(0, 2).every((call) => call.text.includes("embedding::text")));
  assert.ok(fake.calls.every((call) => !call.text.includes("persona_sources")));
  assert.ok(fake.calls.every((call) => !call.text.includes("listPersonaKnowledge")));
});

it("backfills confirmed embeddings with owner/status/null CAS and idempotent re-read", async () => {
  const vector = new Float32Array(1024).fill(0.5);
  const fake = createFakeSql((text, params) => {
    if (text.includes("UPDATE persona_facts") && params[0] === "fact-null") {
      return [{ id: "fact-null" }];
    }
    if (text.includes("UPDATE relationship_memories") && params[0] === "memory-raced") {
      return [];
    }
    if (text.includes("SELECT status") && text.includes("relationship_memories")) {
      return [{ status: "confirmed", embedding: `[${Array(1024).fill(0.5).join(",")}]` }];
    }
    return [];
  });
  const repo = createPostgresRepository(fake.executor);

  await repo.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "fact", id: "fact-null", embedding: vector },
    { kind: "relationship_memory", id: "memory-raced", embedding: vector },
  ]);

  assert.equal(fake.transactions, 1);
  const updates = fake.calls.filter((call) => call.text.includes("SET embedding"));
  assert.equal(updates.length, 2);
  for (const update of updates) {
    assert.match(update.text, /persona_id = \$2/);
    assert.match(update.text, /status = 'confirmed'/);
    assert.match(update.text, /embedding IS NULL/);
    assert.equal(update.params[1], "persona-1");
  }
  const reread = fake.calls.find((call) => call.text.includes("SELECT status"))!;
  assert.match(reread.text, /WHERE id = \$1 AND persona_id = \$2/);
  assert.deepEqual(reread.params, ["memory-raced", "persona-1"]);

  const invalid = createFakeSql((text) => {
    if (text.includes("UPDATE persona_facts")) return [];
    if (text.includes("SELECT status")) return [{ status: "revoked", embedding: null }];
    return [];
  });
  await assert.rejects(createPostgresRepository(invalid.executor)
    .storeConfirmedConversationEmbeddings("persona-1", [
      { kind: "fact", id: "fact-revoked", embedding: vector },
    ]), /conversation_embedding_status_changed/);
  assert.equal(invalid.transactions, 1);

  const wrongSize = createFakeSql();
  await assert.rejects(createPostgresRepository(wrongSize.executor)
    .storeConfirmedConversationEmbeddings("persona-1", [
      { kind: "fact", id: "fact-null", embedding: new Float32Array(1023) },
    ]), /conversation_embedding_status_changed/);
  assert.equal(wrongSize.calls.length, 0);
});

it("deduplicates and canonically orders conversation embedding row locks", async () => {
  const fake = createFakeSql((text, params) =>
    text.includes("SET embedding") ? [{ id: params[0] }] : []);
  const repo = createPostgresRepository(fake.executor);
  const vector = new Float32Array(1024).fill(0.25);

  await repo.storeConfirmedConversationEmbeddings("persona-1", [
    { kind: "relationship_memory", id: "memory-b", embedding: vector },
    { kind: "fact", id: "fact-z", embedding: vector },
    { kind: "relationship_memory", id: "memory-a", embedding: vector },
    { kind: "fact", id: "fact-a", embedding: vector },
    { kind: "fact", id: "fact-a", embedding: vector },
  ]);

  assert.deepEqual(
    fake.calls
      .filter((call) => call.text.includes("SET embedding"))
      .map((call) => [
        call.text.includes("persona_facts") ? "fact" : "relationship_memory",
        call.params[0],
      ]),
    [
      ["fact", "fact-a"],
      ["fact", "fact-z"],
      ["relationship_memory", "memory-a"],
      ["relationship_memory", "memory-b"],
    ],
  );
});

it("starts, binds, and completes a grounded turn in transactions with stable lock order", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  const startedTurn = {
    id: "turn-1",
    session_id: "session-1",
    persona_id: "persona-1",
    user_message_id: "user-message-1",
    assistant_message_id: null,
    mode: null,
    status: "started",
    boundary_kind: null,
    degradation_reason: null,
    retrieval_ms: null,
    first_sentence_ms: null,
    total_ms: null,
    created_at: now,
    updated_at: now,
  };
  const fake = createFakeSql((text, params) => {
    if (text.includes("FROM personas") && text.includes("FOR UPDATE")) {
      return [{ id: "persona-1" }];
    }
    if (text.includes("FROM conversation_sessions") && text.includes("FOR UPDATE")) {
      return [{ id: "session-1" }];
    }
    if (text.includes("UPDATE conversation_sessions") && text.includes("last_activity_at")) {
      return [{ id: "session-1" }];
    }
    if (text.includes("INSERT INTO messages") && params[0] === "user-message-1") return [{
      id: "user-message-1", persona_id: "persona-1", role: "user",
      content: params[2], created_at: now,
    }];
    if (text.includes("INSERT INTO conversation_turns")) return [startedTurn];
    if (text.includes("FROM conversation_turns") && text.includes("FOR UPDATE")) return [startedTurn];
    if (text.includes("FROM persona_item_sources") && text.includes("source_id")) return [
      { item_kind: "fact", item_id: "fact-confirmed", source_id: "source-b" },
      { item_kind: "fact", item_id: "fact-confirmed", source_id: "source-a" },
    ];
    if (text.includes("FROM persona_sources") && text.includes("FOR UPDATE")) return [
      { id: "source-a" }, { id: "source-b" },
    ];
    if (text.includes("FROM persona_facts") && text.includes("FOR UPDATE")) return [{ id: "fact-confirmed" }];
    if (text.includes("INSERT INTO conversation_turn_evidence")) return [{
      turn_id: "turn-1", persona_id: "persona-1", item_kind: "fact",
      item_id: "fact-confirmed", created_at: now,
    }];
    if (text.includes("SELECT turn_id") && text.includes("conversation_turn_evidence")) return [{
      turn_id: "turn-1", persona_id: "persona-1", item_kind: "fact",
      item_id: "fact-confirmed", created_at: now,
    }];
    if (text.includes("INSERT INTO messages") && params[0] === "assistant-1") return [{
      id: "assistant-1", persona_id: "persona-1", role: "assistant",
      content: params[2], created_at: now,
    }];
    if (text.includes("INSERT INTO message_evidence")) return [{
      assistant_message_id: "assistant-1", persona_id: "persona-1",
      item_kind: "fact", item_id: "fact-confirmed", created_at: now,
    }];
    if (text.includes("UPDATE conversation_turns")) return [{
      ...startedTurn,
      assistant_message_id: "assistant-1",
      mode: "grounded",
      status: "completed",
      retrieval_ms: 12,
      first_sentence_ms: 40,
      total_ms: 80,
    }];
    if (text.includes("FROM message_evidence")) return [{
      assistant_message_id: "assistant-1", persona_id: "persona-1",
      item_kind: "fact", item_id: "fact-confirmed", created_at: now,
    }];
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);

  await repo.startConversationTurn({
    turnId: "turn-1", sessionId: "session-1", personaId: "persona-1", userMessageId: "user-message-1",
    content: "她喜欢喝什么？",
  });
  const bound = await repo.bindConversationTurnEvidence({
    turnId: "turn-1", personaId: "persona-1",
    evidence: [{ kind: "fact", itemId: "fact-confirmed" }],
  });
  assert.equal(bound.length, 1);
  const completed = await repo.completeConversationTurn({
    turnId: "turn-1", personaId: "persona-1", assistantMessageId: "assistant-1",
    content: "她爱喝桂花茶。", mode: "grounded", boundaryKind: null,
    degradationReason: null, retrievalMs: 12, firstSentenceMs: 40, totalMs: 80,
    speechTrackingFailed: false,
  });
  assert.equal(completed.status, "completed");
  assert.equal((await repo.listMessageEvidence("assistant-1", "persona-1")).length, 1);
  assert.equal(fake.transactions, 3);

  const sourceLockIndex = fake.calls.findIndex((call) =>
    call.text.includes("FROM persona_sources") && call.text.includes("FOR UPDATE"));
  const itemLockIndex = fake.calls.findIndex((call) =>
    call.text.includes("FROM persona_facts") && call.text.includes("FOR UPDATE"));
  assert.ok(sourceLockIndex >= 0 && sourceLockIndex < itemLockIndex);
  assert.match(fake.calls[sourceLockIndex].text, /ORDER BY id COLLATE "C"/);
  const sourceDiscovery = fake.calls.find((call) =>
    call.text.includes("FROM persona_item_sources") && call.text.includes("source.id AS source_id"))!;
  assert.match(sourceDiscovery.text, /ORDER BY source.id COLLATE "C"/);

  const userInsert = fake.calls.find((call) =>
    call.text.includes("INSERT INTO messages") && call.params[0] === "user-message-1")!;
  assert.match(userInsert.text, /'user'/);
  assert.deepEqual(userInsert.params, ["user-message-1", "persona-1", "她喜欢喝什么？"]);
  const sessionLock = fake.calls.find((call) =>
    call.text.includes("FROM conversation_sessions sessions") && call.text.includes("FOR UPDATE"))!;
  assert.match(sessionLock.text, /JOIN voice_authorizations authorization/);
  assert.match(sessionLock.text, /authorization\.status = 'approved'/);
  assert.match(sessionLock.text, /FOR UPDATE OF authorization/);
  assert.doesNotMatch(sessionLock.text, /FOR UPDATE\s*$/m);
  const personaLock = fake.calls.find((call) =>
    call.text.includes("FROM personas") && call.text.includes("FOR UPDATE"))!;
  assert.equal(fake.calls[0], personaLock);
  assert.ok(fake.calls.indexOf(personaLock) < fake.calls.indexOf(sessionLock));
  assert.match(personaLock.text, /WHERE id = \$1/);
  const assistantInsert = fake.calls.find((call) =>
    call.text.includes("INSERT INTO messages") && call.params[0] === "assistant-1")!;
  assert.match(assistantInsert.text, /'assistant'/);
  const completionUpdate = fake.calls.find((call) => call.text.includes("UPDATE conversation_turns"))!;
  assert.match(completionUpdate.text, /id = \$1 AND persona_id = \$2 AND status = 'started'/);
  assert.ok(fake.calls.some((call) =>
    call.text.includes("INSERT INTO message_evidence") && call.text.includes("conversation_turn_evidence")));
});

it("locks Postgres sentences while allocating attempts and uses owner-scoped CAS", async () => {
  const now = "2026-07-14T10:00:00.000Z";
  const sentenceRow = {
    id: "sentence-1",
    session_id: "session-1",
    turn_id: "turn-1",
    persona_id: "persona-1",
    sentence_index: 0,
    text: "服务端句子。",
    emotion: "warm",
    intensity: 55,
    speed: 0.96,
    pause_after_ms: 360,
    planner_version: "keyword-v1",
    created_at: now,
    voice_id: "voice-1",
  };
  const attemptRow = {
    id: "attempt-1",
    sentence_id: "sentence-1",
    session_id: "session-1",
    turn_id: "turn-1",
    persona_id: "persona-1",
    voice_id: "voice-1",
    attempt_no: 1,
    status: "started",
    voice_source: "preset",
    provider_voice_id: "provider-1",
    tts_model: "cosyvoice-v1",
    tts_config_version: "config-v1",
    fell_back: false,
    storage_ms: null,
    provider_ms: null,
    total_ms: null,
    stable_error_code: null,
    created_at: now,
    completed_at: null,
  };
  const fake = createFakeSql((text) => {
    if (text.includes("FROM conversation_turns") && text.includes("FOR UPDATE")) {
      return [{ id: "turn-1" }];
    }
    if (text.includes("INSERT INTO conversation_sentences")) return [sentenceRow];
    if (text.includes("FROM conversation_sentences sentence") && text.includes("FOR UPDATE OF persona")) {
      return [{
        persona_id: "persona-1",
        session_id: "session-1",
        voice_id: "voice-1",
        voice_authorization_id: "auth-1",
        cohort: "living",
      }];
    }
    if (text.includes("FROM voice_authorizations") && text.includes("FOR UPDATE")) {
      return [{ id: "auth-1" }];
    }
    if (text.includes("FROM conversation_sessions") && text.includes("FOR UPDATE")) {
      return [{ id: "session-1" }];
    }
    if (text.includes("FROM conversation_sentences sentence") && text.includes("FOR UPDATE OF sentence")) {
      return [sentenceRow];
    }
    if (text.includes("FROM conversation_sentences sentence")) return [sentenceRow];
    if (text.includes("INSERT INTO tts_attempts")) return [attemptRow];
    if (text.includes("FROM tts_attempts attempt") && text.includes("FOR UPDATE OF attempt")) {
      return [{ id: "attempt-1" }];
    }
    if (text.includes("UPDATE tts_attempts") && text.includes("status = 'completed'")) {
      return [{
        ...attemptRow,
        status: "completed",
        voice_source: "dynamic",
        fell_back: true,
        storage_ms: 10,
        provider_ms: 20,
        total_ms: 30,
        completed_at: now,
      }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);

  const stored = await repo.recordConversationSentence({
    id: "sentence-1",
    sessionId: "session-1",
    turnId: "turn-1",
    personaId: "persona-1",
    plan: {
      index: 0,
      text: "服务端句子。",
      emotion: "warm",
      intensity: 55,
      speed: 0.96,
      pauseAfterMs: 360,
    },
    plannerVersion: "keyword-v1",
  });
  assert.equal(stored.id, "sentence-1");
  assert.equal(
    (await repo.getConversationSentenceForSynthesis("sentence-1", "user-1"))?.voiceId,
    "voice-1",
  );
  const started = await repo.startTtsAttempt({
    id: "attempt-1",
    sentenceId: "sentence-1",
    evaluatorUserId: "user-1",
    voiceSource: "preset",
    providerVoiceId: "provider-1",
    ttsModel: "cosyvoice-v1",
    ttsConfigVersion: "config-v1",
  });
  assert.equal(started.attemptNo, 1);
  const completed = await repo.completeTtsAttempt({
    id: "attempt-1",
    evaluatorUserId: "user-1",
    voiceSource: "dynamic",
    fellBack: true,
    storageMs: 10,
    providerMs: 20,
    totalMs: 30,
  });
  assert.equal(completed.status, "completed");
  assert.equal(fake.transactions, 3);

  const sentenceLock = fake.calls.find((call) =>
    call.text.includes("FROM conversation_sentences sentence")
      && call.text.includes("FOR UPDATE OF sentence"))!;
  assert.match(sentenceLock.text, /sessions\.evaluator_user_id = \$4/);
  const personaLock = fake.calls.find((call) => call.text.includes("FOR UPDATE OF persona"))!;
  const authorizationLock = fake.calls.find((call) =>
    call.text.includes("FROM voice_authorizations") && call.text.includes("FOR UPDATE"))!;
  const sessionLock = fake.calls.find((call) =>
    call.text.includes("FROM conversation_sessions") && call.text.includes("FOR UPDATE"))!;
  assert.ok(personaLock);
  assert.ok(authorizationLock);
  assert.ok(sessionLock);
  assert.match(personaLock.text, /FOR UPDATE OF persona/);
  assert.match(authorizationLock.text, /status = 'approved'/);
  assert.match(authorizationLock.text, /FOR UPDATE\s*$/);
  assert.match(sessionLock.text, /status = 'active'[\s\S]*FOR UPDATE\s*$/);
  assert.match(sentenceLock.text, /FOR UPDATE OF sentence/);
  assert.deepEqual(authorizationLock.params, ["auth-1", "voice-1", "user-1", "living"]);
  assert.ok(fake.calls.indexOf(personaLock) < fake.calls.indexOf(authorizationLock));
  assert.ok(fake.calls.indexOf(authorizationLock) < fake.calls.indexOf(sessionLock));
  assert.ok(fake.calls.indexOf(sessionLock) < fake.calls.indexOf(sentenceLock));
  const attemptInsert = fake.calls.find((call) => call.text.includes("INSERT INTO tts_attempts"))!;
  assert.match(attemptInsert.text, /COALESCE\(MAX\(attempt_no\), 0\) \+ 1/);
  const completionLock = fake.calls.find((call) =>
    call.text.includes("FROM tts_attempts attempt") && call.text.includes("FOR UPDATE OF attempt"))!;
  assert.match(completionLock.text, /authorization\.status = 'approved'/);
  assert.match(completionLock.text, /sessions\.evaluator_user_id = \$2/);
  const completionUpdate = fake.calls.find((call) =>
    call.text.includes("UPDATE tts_attempts") && call.text.includes("status = 'completed'"))!;
  assert.match(completionUpdate.text, /WHERE id = \$1 AND status = 'started'/);
  assertContiguousPostgresPlaceholders(completionUpdate);
  for (const call of fake.calls) assertContiguousPostgresPlaceholders(call);
});

it("rejects a revoked authorization after the persona lock and before session or sentence locks", async () => {
  const fake = createFakeSql((text) => {
    if (text.includes("FOR UPDATE OF persona")) return [{
      persona_id: "persona-1",
      session_id: "session-1",
      voice_id: "voice-1",
      voice_authorization_id: "auth-1",
      cohort: "living",
    }];
    if (text.includes("FROM voice_authorizations") && text.includes("FOR UPDATE")) return [];
    throw new Error(`unexpected query after revoked authorization: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);

  await assert.rejects(repo.startTtsAttempt({
    id: "attempt-revoked",
    sentenceId: "sentence-1",
    evaluatorUserId: "user-1",
    voiceSource: "preset",
    providerVoiceId: "provider-1",
    ttsModel: "cosyvoice-v1",
    ttsConfigVersion: "config-v1",
  }), /tts_attempt_authorization_denied/);

  assert.equal(fake.calls[0].text.includes("FOR UPDATE OF persona"), true);
  assert.equal(fake.calls[1].text.includes("FROM voice_authorizations"), true);
  assert.equal(fake.calls.some((call) => call.text.includes("INSERT INTO tts_attempts")), false);
  assert.equal(fake.calls.some((call) => call.text.includes("FOR UPDATE OF sentence")), false);
});

it("fails a Postgres TTS attempt only for its evaluator and started status", async () => {
  const fake = createFakeSql((text) => text.includes("UPDATE tts_attempts attempt")
    ? [{ id: "attempt-1" }]
    : []);
  const repo = createPostgresRepository(fake.executor);
  assert.equal(await repo.failTtsAttempt({
    id: "attempt-1",
    evaluatorUserId: "user-1",
    stableErrorCode: "provider_http_503",
    totalMs: 30,
  }), true);
  assert.match(fake.calls[0].text, /attempt\.status = 'started'/);
  assert.match(fake.calls[0].text, /sessions\.evaluator_user_id = \$2/);
  assert.deepEqual(fake.calls[0].params, [
    "attempt-1", "user-1", "provider_http_503", 30,
  ]);
});

it("records playback events with an owner lock and conflict-safe insert", async () => {
  const now = "2026-07-15T00:00:00.000Z";
  const eventRow = {
    event_id: "event-1",
    tts_attempt_id: "attempt-1",
    event_type: "play_started",
    client_elapsed_ms: 42,
    received_at: now,
  };
  const fake = createFakeSql((text) => {
    if (text.includes("FROM tts_attempts attempt") && text.includes("FOR UPDATE OF attempt")) {
      return [{ id: "attempt-1" }];
    }
    if (text.includes("INSERT INTO playback_events")) return [eventRow];
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);
  const result = await repo.recordPlaybackEvent({
    eventId: "event-1",
    ttsAttemptId: "attempt-1",
    evaluatorUserId: "user-1",
    eventType: "play_started",
    clientElapsedMs: 42,
  });
  assert.equal(result.created, true);
  assert.equal(result.event.eventId, "event-1");
  assert.equal(fake.transactions, 1);
  assert.match(fake.calls[0].text, /attempt\.status = 'completed'/);
  assert.match(fake.calls[0].text, /sessions\.evaluator_user_id = \$2/);
  assert.match(fake.calls[0].text, /FOR UPDATE OF attempt/);
  assert.match(fake.calls[1].text, /ON CONFLICT DO NOTHING/);
  assert.match(fake.calls[1].text, /RETURNING event_id/);
  for (const call of fake.calls) assertContiguousPostgresPlaceholders(call);
});

it("returns false only for an identical Postgres playback retry", async () => {
  const now = "2026-07-15T00:00:00.000Z";
  const eventRow = {
    event_id: "event-1",
    tts_attempt_id: "attempt-1",
    event_type: "play_started",
    client_elapsed_ms: 42,
    received_at: now,
  };
  const fake = createFakeSql((text) => {
    if (text.includes("FROM tts_attempts attempt")) return [{ id: "attempt-1" }];
    if (text.includes("INSERT INTO playback_events")) return [];
    if (text.includes("FROM playback_events WHERE event_id")) return [eventRow];
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);
  const input = {
    eventId: "event-1",
    ttsAttemptId: "attempt-1",
    evaluatorUserId: "user-1",
    eventType: "play_started" as const,
    clientElapsedMs: 42,
  };
  assert.equal((await repo.recordPlaybackEvent(input)).created, false);
  assert.equal(fake.transactions, 1);
});

it("models the SQL conflict outcomes so two identical writes cannot both report created", async () => {
  const now = "2026-07-15T00:00:00.000Z";
  const eventRow = {
    event_id: "event-concurrent",
    tts_attempt_id: "attempt-1",
    event_type: "play_started",
    client_elapsed_ms: 42,
    received_at: now,
  };
  let inserted = false;
  const fake = createFakeSql((text) => {
    if (text.includes("FROM tts_attempts attempt")) return [{ id: "attempt-1" }];
    if (text.includes("INSERT INTO playback_events")) {
      if (inserted) return [];
      inserted = true;
      return [eventRow];
    }
    if (text.includes("FROM playback_events WHERE event_id")) return [eventRow];
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);
  const input = {
    eventId: "event-concurrent",
    ttsAttemptId: "attempt-1",
    evaluatorUserId: "user-1",
    eventType: "play_started" as const,
    clientElapsedMs: 42,
  };
  const results = await Promise.all([
    repo.recordPlaybackEvent(input),
    repo.recordPlaybackEvent(input),
  ]);
  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
  const inserts = fake.calls.filter((call) => call.text.includes("INSERT INTO playback_events"));
  assert.equal(inserts.length, 2);
  for (const insert of inserts) assert.match(insert.text, /ON CONFLICT DO NOTHING/);
});

it("treats a new event id with the same attempt, type and elapsed as a semantic retry", async () => {
  const now = "2026-07-15T00:00:00.000Z";
  const eventRow = {
    event_id: "event-original",
    tts_attempt_id: "attempt-1",
    event_type: "play_started",
    client_elapsed_ms: 42,
    received_at: now,
  };
  const fake = createFakeSql((text) => {
    if (text.includes("FROM tts_attempts attempt")) return [{ id: "attempt-1" }];
    if (text.includes("INSERT INTO playback_events")) return [];
    if (text.includes("FROM playback_events") && text.includes("event_type")) return [eventRow];
    throw new Error(`unexpected query: ${text}`);
  });
  const result = await createPostgresRepository(fake.executor).recordPlaybackEvent({
    eventId: "event-new-retry-id",
    ttsAttemptId: "attempt-1",
    evaluatorUserId: "user-1",
    eventType: "play_started",
    clientElapsedMs: 42,
  });
  assert.equal(result.created, false);
  assert.equal(result.event.eventId, "event-original");
  assert.match(
    fake.calls.find((call) => call.text.includes("FROM playback_events"))!.text,
    /event_id = \$1[\s\S]*tts_attempt_id = \$2[\s\S]*event_type = \$3/,
  );
});

const POSTGRES_FEEDBACK_INPUT = {
  id: "feedback-1",
  sessionId: "session-1",
  evaluatorUserId: "user-1",
  evaluatorRelation: "family" as const,
  knowsVoiceOwner: true as const,
  heardAllRounds: true as const,
  scores: {
    voiceSimilarity: 5,
    expressionSimilarity: 4,
    emotionFit: 4,
    factTrust: 5,
    discomfort: 2,
    majorFabrication: false,
    identityImpersonation: false,
    authorizationViolation: false,
  },
  comment: "像本人",
};

it("reads only owner-scoped feedback eligibility from distinct audible turns", async () => {
  const fake = createFakeSql((text) => {
    if (text.includes("WITH owned_session AS")) {
      return [{
        status: "active",
        already_submitted: false,
        completed_audible_turn_count: "3",
        has_no_started_turn: true,
        has_no_started_attempt: true,
      }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  const result = await createPostgresRepository(fake.executor)
    .getFeedbackEligibility("session-1", "user-1");
  assert.deepEqual(result, {
    completedAudibleTurnCount: 3,
    requiredAudibleTurnCount: 3,
    eligible: true,
    sessionStatus: "active",
    alreadySubmitted: false,
  });
  assert.equal(fake.calls.length, 1);
  const count = fake.calls[0];
  assert.match(count.text, /WITH owned_session AS/);
  assert.match(count.text, /turn\.status = 'completed'/);
  assert.match(count.text, /turn\.mode IN \('grounded', 'companionship'\)/);
  assert.match(count.text, /turn\.speech_tracking_failed = false/);
  assert.match(count.text, /attempt\.status = 'completed'/);
  assert.match(count.text, /playback\.event_type = 'play_started'/);
  assert.match(count.text, /status = 'started'/);
  assert.match(count.text, /NOT EXISTS|has_started_turn/);
  assert.match(count.text, /tts_attempts[\s\S]*status = 'started'/);
  assert.doesNotMatch(count.text, /play_completed/);
  assert.deepEqual(count.params, ["session-1", "user-1"]);
  assertContiguousPostgresPlaceholders(count);
});

it("returns null eligibility for unknown and non-owned sessions without probing evidence", async () => {
  const fake = createFakeSql(() => []);
  assert.equal(
    await createPostgresRepository(fake.executor).getFeedbackEligibility("session-x", "user-2"),
    null,
  );
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].text, /id = \$1 AND evaluator_user_id = \$2/);
});

it("atomically submits feedback using only the locked session identity snapshot", async () => {
  const now = "2026-07-15T00:00:00.000Z";
  const session = {
    id: "session-1",
    persona_id: "persona-server",
    evaluator_user_id: "user-1",
    voice_id: "voice-server",
    voice_authorization_id: "auth-server",
    cohort: "deceased",
    status: "active",
    started_at: now,
    last_activity_at: now,
    rated_at: null,
  };
  const feedback = {
    id: "feedback-1",
    session_id: "session-1",
    persona_id: "persona-server",
    evaluator_user_id: "user-1",
    evaluator_relation: "family",
    knows_voice_owner: true,
    heard_all_rounds: true,
    voice_similarity: 5,
    expression_similarity: 4,
    emotion_fit: 4,
    fact_trust: 5,
    discomfort: 2,
    major_fabrication: false,
    identity_impersonation: false,
    authorization_violation: false,
    comment: "像本人",
    created_at: now,
  };
  const fake = createFakeSql((text) => {
    if (text.includes("FROM conversation_sessions") && !text.includes("FOR UPDATE")) return [session];
    if (text.includes("FROM personas") && text.includes("FOR UPDATE")) return [{ id: "persona-server" }];
    if (text.includes("FROM conversation_sessions") && text.includes("FOR UPDATE")) return [session];
    if (text.includes("SELECT id FROM conversation_feedback")) return [];
    if (text.includes("COUNT(DISTINCT turn.id)")) {
      return [{ count: 3, has_started_turn: false, has_started_attempt: false }];
    }
    if (text.includes("INSERT INTO conversation_feedback")) return [feedback];
    if (text.includes("UPDATE conversation_sessions")) return [{ id: "session-1" }];
    throw new Error(`unexpected query: ${text}`);
  });
  const result = await createPostgresRepository(fake.executor)
    .submitConversationFeedback(POSTGRES_FEEDBACK_INPUT);
  assert.equal(fake.transactions, 1);
  assert.equal(result.personaId, "persona-server");
  assert.equal(result.evaluatorUserId, "user-1");
  const identityRead = fake.calls[0];
  assert.match(identityRead.text, /id = \$1 AND evaluator_user_id = \$2/);
  assert.doesNotMatch(identityRead.text, /FOR UPDATE/);
  const personaLockIndex = fake.calls.findIndex((call) =>
    call.text.includes("FROM personas") && call.text.includes("FOR UPDATE"));
  const sessionLockIndex = fake.calls.findIndex((call) =>
    call.text.includes("FROM conversation_sessions") && call.text.includes("FOR UPDATE"));
  assert.ok(personaLockIndex > 0);
  assert.ok(sessionLockIndex > personaLockIndex);
  const lock = fake.calls[sessionLockIndex];
  assert.match(lock.text, /persona_id = \$2/);
  assert.match(lock.text, /evaluator_user_id = \$3/);
  assert.match(lock.text, /voice_authorization_id = \$5/);
  assert.match(lock.text, /cohort = \$6/);
  assert.match(lock.text, /status = \$7/);
  const count = fake.calls.find((call) => call.text.includes("COUNT(DISTINCT turn.id)"))!;
  assert.match(count.text, /COUNT\(DISTINCT turn\.id\)/);
  assert.match(count.text, /status = 'started'/);
  assert.match(count.text, /tts_attempts[\s\S]*status = 'started'/);
  assert.deepEqual(count.params, ["session-1", "persona-server"]);
  const insert = fake.calls.find((call) => call.text.includes("INSERT INTO conversation_feedback"))!;
  assert.deepEqual(insert.params.slice(0, 5), [
    "feedback-1", "session-1", "persona-server", "user-1", "family",
  ]);
  assert.equal(insert.params.includes("deceased"), false);
  assert.equal(insert.params.includes("voice-server"), false);
  assert.equal(insert.params.includes("auth-server"), false);
  const rating = fake.calls.find((call) => call.text.includes("UPDATE conversation_sessions"))!;
  assert.match(rating.text, /status = 'active'/);
  for (const call of fake.calls) assertContiguousPostgresPlaceholders(call);
});

it("rejects duplicate or insufficient feedback before insertion", async () => {
  const now = "2026-07-15T00:00:00.000Z";
  const session = {
    id: "session-1",
    persona_id: "persona-1",
    evaluator_user_id: "user-1",
    voice_id: "voice-1",
    voice_authorization_id: "auth-1",
    cohort: "living",
    status: "active",
    started_at: now,
    last_activity_at: now,
    rated_at: null,
  };
  const duplicate = createFakeSql((text) => {
    if (text.includes("FROM conversation_sessions")) return [session];
    if (text.includes("FROM personas")) return [{ id: "persona-1" }];
    if (text.includes("SELECT id FROM conversation_feedback")) return [{ id: "existing" }];
    throw new Error(`unexpected query: ${text}`);
  });
  await assert.rejects(
    createPostgresRepository(duplicate.executor).submitConversationFeedback(POSTGRES_FEEDBACK_INPUT),
    /feedback_already_submitted/,
  );
  assert.equal(duplicate.calls.some((call) => call.text.includes("INSERT INTO conversation_feedback")), false);

  const insufficient = createFakeSql((text) => {
    if (text.includes("FROM conversation_sessions")) return [session];
    if (text.includes("FROM personas")) return [{ id: "persona-1" }];
    if (text.includes("SELECT id FROM conversation_feedback")) return [];
    if (text.includes("COUNT(DISTINCT turn.id)")) {
      return [{ count: 2, has_started_turn: false, has_started_attempt: false }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  await assert.rejects(
    createPostgresRepository(insufficient.executor).submitConversationFeedback(POSTGRES_FEEDBACK_INPUT),
    (error: unknown) => {
      assert.equal((error as Error).message, "feedback_session_not_eligible");
      assert.equal((error as { completedAudibleTurnCount: number }).completedAudibleTurnCount, 2);
      return true;
    },
  );
  assert.equal(insufficient.calls.some((call) => call.text.includes("INSERT INTO conversation_feedback")), false);
});

it("blocks Postgres feedback while any turn in the locked session is started", async () => {
  const now = "2026-07-15T00:00:00.000Z";
  const session = {
    id: "session-1",
    persona_id: "persona-1",
    evaluator_user_id: "user-1",
    voice_id: "voice-1",
    voice_authorization_id: "auth-1",
    cohort: "living",
    status: "active",
    started_at: now,
    last_activity_at: now,
    rated_at: null,
  };
  const fake = createFakeSql((text) => {
    if (text.includes("FROM conversation_sessions")) return [session];
    if (text.includes("FROM personas")) return [{ id: "persona-1" }];
    if (text.includes("SELECT id FROM conversation_feedback")) return [];
    if (text.includes("COUNT(DISTINCT turn.id)")) {
      return [{ count: 3, has_started_turn: true, has_started_attempt: false }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  await assert.rejects(
    createPostgresRepository(fake.executor).submitConversationFeedback(POSTGRES_FEEDBACK_INPUT),
    (error: unknown) => {
      assert.equal((error as Error).message, "feedback_session_not_eligible");
      assert.equal((error as { completedAudibleTurnCount: number }).completedAudibleTurnCount, 3);
      return true;
    },
  );
  const qualification = fake.calls.find((call) => call.text.includes("COUNT(DISTINCT turn.id)"))!;
  assert.match(qualification.text, /status = 'started'/);
  assert.equal(fake.calls.some((call) => call.text.includes("INSERT INTO conversation_feedback")), false);
  assert.equal(fake.calls.some((call) => call.text.includes("UPDATE conversation_sessions")), false);
});

it("maps a concurrent session status change without feedback to not eligible", async () => {
  const now = "2026-07-15T00:00:00.000Z";
  const active = {
    id: "session-1",
    persona_id: "persona-1",
    evaluator_user_id: "user-1",
    voice_id: "voice-1",
    voice_authorization_id: "auth-1",
    cohort: "living",
    status: "active",
    started_at: now,
    last_activity_at: now,
    rated_at: null,
  };
  let sessionReads = 0;
  const fake = createFakeSql((text) => {
    if (text.includes("FROM personas")) return [{ id: "persona-1" }];
    if (text.includes("FROM conversation_sessions")) {
      sessionReads += 1;
      if (sessionReads === 1) return [active];
      if (sessionReads === 2) return [];
      return [{ status: "expired", already_submitted: false }];
    }
    if (text.includes("COUNT(DISTINCT turn.id)")) {
      return [{ count: 3, has_started_turn: false, has_started_attempt: false }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  await assert.rejects(
    createPostgresRepository(fake.executor).submitConversationFeedback(POSTGRES_FEEDBACK_INPUT),
    (error: unknown) => {
      assert.equal((error as Error).message, "feedback_session_not_eligible");
      assert.equal((error as { completedAudibleTurnCount: number }).completedAudibleTurnCount, 3);
      return true;
    },
  );
  assert.equal(fake.calls.some((call) => call.text.includes("INSERT INTO conversation_feedback")), false);
});

it("blocks Postgres feedback while speech synthesis is still started", async () => {
  const now = "2026-07-15T00:00:00.000Z";
  const session = {
    id: "session-1",
    persona_id: "persona-1",
    evaluator_user_id: "user-1",
    voice_id: "voice-1",
    voice_authorization_id: "auth-1",
    cohort: "living",
    status: "active",
    started_at: now,
    last_activity_at: now,
    rated_at: null,
  };
  const fake = createFakeSql((text) => {
    if (text.includes("FROM conversation_sessions")) return [session];
    if (text.includes("FROM personas")) return [{ id: "persona-1" }];
    if (text.includes("SELECT id FROM conversation_feedback")) return [];
    if (text.includes("COUNT(DISTINCT turn.id)")) {
      return [{ count: 3, has_started_turn: false, has_started_attempt: true }];
    }
    throw new Error(`unexpected query: ${text}`);
  });
  await assert.rejects(
    createPostgresRepository(fake.executor).submitConversationFeedback(POSTGRES_FEEDBACK_INPUT),
    (error: unknown) => {
      assert.equal((error as Error).message, "feedback_session_not_eligible");
      assert.equal((error as { completedAudibleTurnCount: number }).completedAudibleTurnCount, 3);
      return true;
    },
  );
  const qualification = fake.calls.find((call) => call.text.includes("COUNT(DISTINCT turn.id)"))!;
  assert.match(qualification.text, /tts_attempts[\s\S]*status = 'started'/);
  assert.equal(fake.calls.some((call) => call.text.includes("INSERT INTO conversation_feedback")), false);
  assert.equal(fake.calls.some((call) => call.text.includes("UPDATE conversation_sessions")), false);
});

it("queries and maps only the aggregate restoration metric whitelist", async () => {
  const fake = createFakeSql((text) => {
    if (!text.includes("FROM conversation_feedback")) throw new Error(`unexpected query: ${text}`);
    return [{
      session_id: "session-report",
      evaluator_user_id: "user-report",
      cohort: "deceased",
      voice_similarity: 5,
      expression_similarity: 4,
      emotion_fit: 4,
      fact_trust: 5,
      discomfort: 1,
      major_fabrication: false,
      identity_impersonation: false,
      authorization_violation: false,
    }];
  });

  const rows = await createPostgresRepository(fake.executor).listRestorationMetricRows();
  assert.deepEqual(rows, [{
    sessionId: "session-report",
    evaluatorUserId: "user-report",
    cohort: "deceased",
    voiceSimilarity: 5,
    expressionSimilarity: 4,
    emotionFit: 4,
    factTrust: 5,
    discomfort: 1,
    majorFabrication: false,
    identityImpersonation: false,
    authorizationViolation: false,
  }]);
  assert.equal(fake.calls.length, 1);
  const query = fake.calls[0];
  assert.deepEqual(query.params, []);
  for (const column of [
    "feedback.session_id",
    "feedback.evaluator_user_id",
    "sessions.cohort",
    "feedback.voice_similarity",
    "feedback.expression_similarity",
    "feedback.emotion_fit",
    "feedback.fact_trust",
    "feedback.discomfort",
    "feedback.major_fabrication",
    "feedback.identity_impersonation",
    "feedback.authorization_violation",
  ]) assert.match(query.text, new RegExp(column.replace(".", "\\.")));
  assert.doesNotMatch(
    query.text,
    /\b(email|persona_name|comment|sentence|text|voice_id|provider|object_path|audio)\b/i,
  );
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "authorizationViolation",
    "cohort",
    "discomfort",
    "emotionFit",
    "evaluatorUserId",
    "expressionSimilarity",
    "factTrust",
    "identityImpersonation",
    "majorFabrication",
    "sessionId",
    "voiceSimilarity",
  ]);
});

it("locks the persona before persisting a null-session boundary turn", async () => {
  const now = "2026-07-14T00:00:00.000Z";
  const startedBoundary = {
    id: "turn-boundary",
    session_id: null,
    persona_id: "persona-1",
    user_message_id: "message-boundary",
    assistant_message_id: null,
    mode: null,
    status: "started",
    boundary_kind: null,
    degradation_reason: null,
    retrieval_ms: null,
    first_sentence_ms: null,
    total_ms: null,
    created_at: now,
    updated_at: now,
  };
  const fake = createFakeSql((text) => {
    if (text.includes("FROM personas") && text.includes("FOR UPDATE")) return [{ id: "persona-1" }];
    if (text.includes("INSERT INTO messages")) return [{ id: "message-boundary" }];
    if (text.includes("INSERT INTO conversation_turns")) return [startedBoundary];
    throw new Error(`unexpected query: ${text}`);
  });
  const repo = createPostgresRepository(fake.executor);
  const started = await repo.startConversationTurn({
    turnId: "turn-boundary",
    sessionId: null,
    personaId: "persona-1",
    userMessageId: "message-boundary",
    content: "固定边界回复",
  });
  assert.equal(started.sessionId, null);
  assert.match(fake.calls[0].text, /FROM personas[\s\S]*WHERE id = \$1[\s\S]*FOR UPDATE/);
  assert.equal(fake.calls.some((call) => call.text.includes("FROM voice_authorizations")), false);
  assert.equal(fake.calls.some((call) => call.text.includes("FROM conversation_sessions")), false);
  const messageInsert = fake.calls.findIndex((call) => call.text.includes("INSERT INTO messages"));
  assert.ok(messageInsert > 0);
});

it("fails only a matching started turn with owner/status compare-and-set", async () => {
  const fake = createFakeSql((text) => text.includes("UPDATE conversation_turns")
    ? [{ id: "turn-1" }]
    : []);
  const repo = createPostgresRepository(fake.executor);

  assert.equal(await repo.failConversationTurn({
    turnId: "turn-1",
    personaId: "persona-1",
    status: "generation_failed",
    degradationReason: "model_failed",
    totalMs: 10,
  }), true);
  const update = fake.calls[0];
  assert.match(update.text, /WHERE id = \$1 AND persona_id = \$2 AND status = 'started'/);
  assert.deepEqual(update.params, ["turn-1", "persona-1", "generation_failed", "model_failed", 10]);
});
