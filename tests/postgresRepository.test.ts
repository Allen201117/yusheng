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

it("serializes memory vectors and restores them as Float32Array", async () => {
  const fake = createFakeSql((text, params) => {
    if (text.includes("INSERT INTO memories")) return [];
    return [{ id: "memory-1", content: "一起去海边", embedding: "[0.25,0.5]" }];
  });
  const repo = createPostgresRepository(fake.executor);

  await repo.insertMemory({
    id: "memory-1", personaId: "persona-1", content: "一起去海边",
    embedding: Float32Array.from([0.25, 0.5]),
  });
  assert.equal(fake.calls[0].params[3], "[0.25,0.5]");
  const memories = await repo.loadMemoriesWithEmbeddings("persona-1");
  assert.deepEqual(Array.from(memories[0].embedding), [0.25, 0.5]);
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

it("lists, gets and deletes memory records", async () => {
  const fake = createFakeSql((text) => {
    if (text.includes("SELECT id, persona_id, content, created_at")) {
      return [{ id: "memory-1", persona_id: "persona-1", content: "记忆", created_at: "2026-07-13T05:00:00.000Z" }];
    }
    if (text.includes("SELECT id, persona_id, content") && !text.includes("created_at")) {
      return [{ id: "memory-1", persona_id: "persona-1", content: "记忆" }];
    }
    return [];
  });
  const repo = createPostgresRepository(fake.executor);
  assert.equal((await repo.listMemories("persona-1"))[0].createdAt, "2026-07-13T05:00:00.000Z");
  assert.equal((await repo.getMemoryById("memory-1"))?.personaId, "persona-1");
  await repo.deleteMemory("memory-1");
  assert.ok(fake.calls.some((call) => call.text.includes("DELETE FROM memories")));
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
