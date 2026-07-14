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
    turnId: "turn-1", personaId: "persona-1", userMessageId: "user-message-1",
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
  const assistantInsert = fake.calls.find((call) =>
    call.text.includes("INSERT INTO messages") && call.params[0] === "assistant-1")!;
  assert.match(assistantInsert.text, /'assistant'/);
  const completionUpdate = fake.calls.find((call) => call.text.includes("UPDATE conversation_turns"))!;
  assert.match(completionUpdate.text, /id = \$1 AND persona_id = \$2 AND status = 'started'/);
  assert.ok(fake.calls.some((call) =>
    call.text.includes("INSERT INTO message_evidence") && call.text.includes("conversation_turn_evidence")));
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
