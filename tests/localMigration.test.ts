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

type FakePersona = {
  id: string;
  user_id: string;
  voice_id: string;
  name: string;
  relation: string;
  persona_desc: string;
  created_at: string;
};

type FakeMigrationState = {
  users: Array<{ id: string; email: null; phone: null }>;
  voices: Array<{ id: string; user_id: string; checksum_sha256: string }>;
  personas: Map<string, FakePersona>;
  sources: Map<string, Record<string, unknown>>;
  memories: Map<string, Record<string, unknown>>;
  links: Map<string, Record<string, unknown>>;
  messages: Map<string, Record<string, unknown>>;
};

function cloneMigrationState(state: FakeMigrationState): FakeMigrationState {
  return {
    users: structuredClone(state.users),
    voices: structuredClone(state.voices),
    personas: new Map(structuredClone([...state.personas])),
    sources: new Map(structuredClone([...state.sources])),
    memories: new Map(structuredClone([...state.memories])),
    links: new Map(structuredClone([...state.links])),
    messages: new Map(structuredClone([...state.messages])),
  };
}

function commitMigrationState(target: FakeMigrationState, source: FakeMigrationState) {
  for (const key of ["personas", "sources", "memories", "links", "messages"] as const) {
    target[key].clear();
    for (const [id, row] of source[key]) target[key].set(id, row as never);
  }
}

function createMigrationExecutor(
  state: FakeMigrationState,
  options: { failLinkFor?: string } = {},
): { sql: SqlExecutor; calls: Array<{ text: string; params: unknown[] }>; transactions: () => number } {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  let transactionCount = 0;
  const makeExecutor = (active: FakeMigrationState, transactional: boolean): SqlExecutor => ({
    async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (text.includes("SELECT id, email, phone FROM users")) return active.users as unknown as T[];
      if (text.includes("SELECT id, user_id, checksum_sha256 FROM voice_profiles")) return active.voices as unknown as T[];
      if (text.includes("FROM personas") && text.trimStart().startsWith("SELECT")) {
        return [...active.personas.values()] as unknown as T[];
      }
      if (text.includes("INSERT INTO personas")) {
        const id = String(params[0]);
        if (active.personas.has(id)) return [] as T[];
        active.personas.set(id, {
          id,
          user_id: String(params[1]),
          name: String(params[2]),
          relation: String(params[3]),
          voice_id: String(params[4]),
          persona_desc: String(params[5]),
          created_at: String(params[6]),
        });
        return [{ id }] as unknown as T[];
      }
      if (text.includes("INSERT INTO persona_sources")) {
        const id = String(params[0]);
        if (active.sources.has(id)) return [] as T[];
        active.sources.set(id, {
          id,
          persona_id: params[1],
          source_type: "legacy_import",
          content_text: null,
          object_path: null,
          checksum_algorithm: "legacy_id",
          checksum: id,
          status: "ready",
          created_by: params[2],
          created_at: params[3],
          revoked_at: null,
        });
        return [{ id }] as unknown as T[];
      }
      if (text.includes("FROM persona_sources") && text.includes("FOR UPDATE")) {
        const row = active.sources.get(String(params[0]));
        return (row ? [row] : []) as T[];
      }
      if (text.includes("INSERT INTO relationship_memories")) {
        const id = String(params[0]);
        if (active.memories.has(id)) return [] as T[];
        active.memories.set(id, {
          id,
          persona_id: params[1],
          content: params[2],
          occurred_at: null,
          location: null,
          participants: [],
          embedding: params[3],
          status: "confirmed",
          conflict_group_id: null,
          confirmed_by: null,
          confirmed_at: params[4],
          created_at: params[4],
          updated_at: params[4],
          revoked_at: null,
        });
        return [{ id }] as unknown as T[];
      }
      if (text.includes("FROM relationship_memories") && text.includes("FOR UPDATE")) {
        const row = active.memories.get(String(params[0]));
        return (row ? [row] : []) as T[];
      }
      if (text.includes("INSERT INTO persona_item_sources")) {
        const itemId = String(params[1]);
        if (options.failLinkFor === itemId) throw new Error("forced_link_failure");
        const key = `${params[0]}:${itemId}:${params[2]}`;
        if (active.links.has(key)) return [] as T[];
        const source = active.sources.get(String(params[2]));
        const memory = active.memories.get(itemId);
        const personaId = params[5];
        if (!source || !memory || source.persona_id !== personaId || memory.persona_id !== personaId) return [] as T[];
        active.links.set(key, {
          item_kind: params[0], item_id: itemId, source_id: params[2], source_excerpt: params[3],
          created_at: params[4],
        });
        return [{ item_id: itemId }] as unknown as T[];
      }
      if (text.includes("FROM persona_item_sources") && text.includes("FOR UPDATE")) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        const row = active.links.get(key);
        return (row ? [row] : []) as T[];
      }
      if (text.includes("INSERT INTO messages")) {
        const id = String(params[0]);
        active.messages.set(id, { id, persona_id: params[1] });
        return [{ id }] as unknown as T[];
      }
      return [] as T[];
    },
    async transaction<T>(work: (transaction: SqlExecutor) => Promise<T>) {
      if (transactional) return work(makeExecutor(active, true));
      transactionCount += 1;
      const draft = cloneMigrationState(active);
      const result = await work(makeExecutor(draft, true));
      commitMigrationState(active, draft);
      return result;
    },
  });
  return { sql: makeExecutor(state, false), calls, transactions: () => transactionCount };
}

const basePersona: FakePersona = {
  id: "p1",
  user_id: "owner-1",
  voice_id: "v1",
  name: "妈妈",
  relation: "母亲",
  persona_desc: "温和",
  created_at: "2026-07-13T00:01:00.000Z",
};

function makeMigrationState(persona: FakePersona = basePersona): FakeMigrationState {
  return {
    users: [{ id: "owner-1", email: null, phone: null }],
    voices: [{ id: "v1", user_id: "owner-1", checksum_sha256: "voice-checksum" }],
    personas: new Map([[persona.id, structuredClone(persona)]]),
    sources: new Map(),
    memories: new Map(),
    links: new Map(),
    messages: new Map(),
  };
}

function makeInventory(overrides: Record<string, unknown> = {}) {
  return {
    databaseFound: true,
    users: [],
    personas: [{
      id: "p1", userId: "local-owner", name: "妈妈", relation: "母亲",
      voiceId: "v1", personaDesc: "温和", createdAt: "2026-07-13T00:01:00.000Z",
    }],
    voices: [{
      voiceId: "v1",
      userId: "local-owner",
      promptText: "你好",
      mimeType: "audio/wav",
      durationSec: 6,
      createdAt: "2026-07-13T00:00:30.000Z",
      audioPath: "/tmp/v1.wav",
      checksum: "voice-checksum",
      state: "ready" as const,
    }],
    messages: [],
    memories: [{
      id: "r1", personaId: "p1", content: "一起去海边", embedding: null,
      createdAt: "2026-07-13T00:02:00.000Z",
    }],
    ...overrides,
  };
}

const migrationUserMap = { "local-owner": "owner-1" };
const emptyVoiceStore = {} as VoiceObjectStore;

it("blocks cross-owner and same-owner identity collisions from importing dependent rows", async () => {
  for (const [persona, reason] of [
    [{ ...basePersona, user_id: "other-owner" }, "persona_owner_conflict"],
    [{ ...basePersona, name: "另一个人" }, "persona_identity_conflict"],
  ] as const) {
    const state = makeMigrationState(persona);
    const fake = createMigrationExecutor(state);
    const inventory = makeInventory({
      messages: [{ id: "m1", personaId: "p1", role: "user" as const, content: "想你", createdAt: "2026-07-13T00:03:00.000Z" }],
    });
    const report = await migrateInventory("/tmp/yusheng", inventory, migrationUserMap, fake.sql, emptyVoiceStore);

    assert.equal(report.items.find((item) => item.entity === "persona" && item.id === "p1")?.reason, reason);
    assert.equal(report.items.find((item) => item.entity === "memory" && item.id === "r1")?.reason, "missing_persona_dependency");
    assert.equal(report.items.find((item) => item.entity === "message" && item.id === "m1")?.reason, "missing_persona_dependency");
    assert.equal(state.memories.size, 0);
    assert.equal(state.messages.size, 0);
  }
});

it("does not use an unrelated cloud persona when the local inventory has no matching persona", async () => {
  const state = makeMigrationState();
  const fake = createMigrationExecutor(state);
  const report = await migrateInventory(
    "/tmp/yusheng",
    makeInventory({ personas: [] }),
    migrationUserMap,
    fake.sql,
    emptyVoiceStore,
  );
  assert.equal(report.items.find((item) => item.id === "r1")?.reason, "missing_persona_dependency");
  assert.equal(state.memories.size, 0);
});

it("does not reuse a cloud voice id owned by someone else or with different audio", async () => {
  for (const [voice, reason] of [
    [{ id: "v1", user_id: "other-owner", checksum_sha256: "voice-checksum" }, "voice_owner_conflict"],
    [{ id: "v1", user_id: "owner-1", checksum_sha256: "different-checksum" }, "voice_checksum_conflict"],
  ] as const) {
    const state = makeMigrationState();
    state.voices = [voice];
    const fake = createMigrationExecutor(state);
    const report = await migrateInventory(
      "/tmp/yusheng",
      makeInventory(),
      migrationUserMap,
      fake.sql,
      emptyVoiceStore,
    );

    assert.equal(report.items.find((item) => item.entity === "voice" && item.id === "v1")?.reason, reason);
    assert.equal(report.items.find((item) => item.entity === "persona" && item.id === "p1")?.reason, "missing_voice_dependency");
    assert.equal(report.items.find((item) => item.entity === "memory" && item.id === "r1")?.reason, "missing_persona_dependency");
    assert.equal(state.memories.size, 0);
  }
});

it("rejects conflicting legacy sources and memories without leaving partial rows", async () => {
  const sourceConflict = makeMigrationState();
  sourceConflict.sources.set("legacy-memory-source:p1", {
    id: "legacy-memory-source:p1", persona_id: "other-persona", source_type: "legacy_import",
    content_text: null, object_path: null,
    checksum_algorithm: "legacy_id", checksum: "legacy-memory-source:p1", status: "ready",
    created_by: "owner-1", created_at: basePersona.created_at, revoked_at: null,
  });
  const sourceFake = createMigrationExecutor(sourceConflict);
  const sourceReport = await migrateInventory("/tmp/yusheng", makeInventory(), migrationUserMap, sourceFake.sql, emptyVoiceStore);
  assert.equal(sourceReport.items.find((item) => item.id === "r1")?.reason, "legacy_source_conflict");
  assert.equal(sourceConflict.memories.size, 0);
  assert.equal(sourceConflict.links.size, 0);

  const revokedSource = makeMigrationState();
  revokedSource.sources.set("legacy-memory-source:p1", {
    id: "legacy-memory-source:p1", persona_id: "p1", source_type: "legacy_import",
    content_text: null, object_path: null,
    checksum_algorithm: "legacy_id", checksum: "legacy-memory-source:p1", status: "revoked",
    created_by: "owner-1", created_at: basePersona.created_at, revoked_at: "2026-07-14T00:00:00.000Z",
  });
  const revokedFake = createMigrationExecutor(revokedSource);
  const revokedReport = await migrateInventory("/tmp/yusheng", makeInventory(), migrationUserMap, revokedFake.sql, emptyVoiceStore);
  assert.equal(revokedReport.items.find((item) => item.id === "r1")?.reason, "legacy_source_conflict");
  assert.equal(revokedSource.memories.size, 0);

  const memoryConflict = makeMigrationState();
  memoryConflict.memories.set("r1", {
    id: "r1", persona_id: "other-persona", content: "别人的记忆",
    occurred_at: null, location: null, participants: [], embedding: null,
    status: "confirmed", confirmed_at: "2026-07-13T00:02:00.000Z",
    conflict_group_id: null, confirmed_by: null,
    created_at: "2026-07-13T00:02:00.000Z", updated_at: "2026-07-13T00:02:00.000Z", revoked_at: null,
  });
  const memoryFake = createMigrationExecutor(memoryConflict);
  const memoryReport = await migrateInventory("/tmp/yusheng", makeInventory(), migrationUserMap, memoryFake.sql, emptyVoiceStore);
  assert.equal(memoryReport.items.find((item) => item.id === "r1")?.reason, "legacy_memory_conflict");
  assert.equal(memoryConflict.sources.size, 0);
  assert.equal(memoryConflict.links.size, 0);

  const contentConflict = makeMigrationState();
  contentConflict.memories.set("r1", {
    id: "r1", persona_id: "p1", content: "内容不一致",
    occurred_at: null, location: null, participants: [], embedding: null,
    status: "confirmed", confirmed_at: "2026-07-13T00:02:00.000Z",
    conflict_group_id: null, confirmed_by: null,
    created_at: "2026-07-13T00:02:00.000Z", updated_at: "2026-07-13T00:02:00.000Z", revoked_at: null,
  });
  const contentFake = createMigrationExecutor(contentConflict);
  const contentReport = await migrateInventory("/tmp/yusheng", makeInventory(), migrationUserMap, contentFake.sql, emptyVoiceStore);
  assert.equal(contentReport.items.find((item) => item.id === "r1")?.reason, "legacy_memory_conflict");
  assert.equal(contentConflict.sources.size, 0);
});

it("repairs a missing legacy link, then skips a fully consistent rerun", async () => {
  const state = makeMigrationState();
  state.sources.set("legacy-memory-source:p1", {
    id: "legacy-memory-source:p1", persona_id: "p1", source_type: "legacy_import",
    content_text: null, object_path: null,
    checksum_algorithm: "legacy_id", checksum: "legacy-memory-source:p1", status: "ready",
    created_by: "owner-1", created_at: basePersona.created_at, revoked_at: null,
  });
  state.memories.set("r1", {
    id: "r1", persona_id: "p1", content: "一起去海边",
    occurred_at: null, location: null, participants: [], embedding: null,
    status: "confirmed", confirmed_at: "2026-07-13T00:02:00.000Z",
    conflict_group_id: null, confirmed_by: null,
    created_at: "2026-07-13T00:02:00.000Z", updated_at: "2026-07-13T00:02:00.000Z", revoked_at: null,
  });
  const fake = createMigrationExecutor(state);
  const first = await migrateInventory("/tmp/yusheng", makeInventory(), migrationUserMap, fake.sql, emptyVoiceStore);
  const second = await migrateInventory("/tmp/yusheng", makeInventory(), migrationUserMap, fake.sql, emptyVoiceStore);
  assert.equal(first.items.find((item) => item.id === "r1")?.status, "skipped");
  assert.equal(second.items.find((item) => item.id === "r1")?.status, "skipped");
  assert.equal(state.links.size, 1);
});

it("accepts the rounded pgvector text for the same Float32 legacy embedding", async () => {
  const state = makeMigrationState();
  const sourceId = "legacy-memory-source:p1";
  const createdAt = "2026-07-13T00:02:00.000Z";
  const embedding = Buffer.alloc(1024 * 4);
  for (let offset = 0; offset < embedding.byteLength; offset += 4) {
    embedding.writeFloatLE(0.1, offset);
  }
  state.sources.set(sourceId, {
    id: sourceId, persona_id: "p1", source_type: "legacy_import",
    content_text: null, object_path: null, checksum_algorithm: "legacy_id",
    checksum: sourceId, status: "ready", created_by: "owner-1",
    created_at: basePersona.created_at, revoked_at: null,
  });
  state.memories.set("r1", {
    id: "r1", persona_id: "p1", content: "一起去海边", occurred_at: null,
    location: null, participants: [], embedding: `[${Array(1024).fill("0.1").join(",")}]`,
    status: "confirmed", conflict_group_id: null, confirmed_by: null,
    confirmed_at: createdAt, created_at: createdAt, updated_at: createdAt, revoked_at: null,
  });
  state.links.set(`relationship_memory:r1:${sourceId}`, {
    item_kind: "relationship_memory", item_id: "r1", source_id: sourceId,
    source_excerpt: "一起去海边", created_at: createdAt,
  });
  const fake = createMigrationExecutor(state);
  const report = await migrateInventory(
    "/tmp/yusheng",
    makeInventory({ memories: [{
      id: "r1", personaId: "p1", content: "一起去海边", embedding, createdAt,
    }] }),
    migrationUserMap,
    fake.sql,
    emptyVoiceStore,
  );

  assert.equal(report.items.find((item) => item.entity === "memory" && item.id === "r1")?.status, "skipped");
});

it("rejects an existing legacy link with a mismatched excerpt", async () => {
  const state = makeMigrationState();
  state.sources.set("legacy-memory-source:p1", {
    id: "legacy-memory-source:p1", persona_id: "p1", source_type: "legacy_import",
    content_text: null, object_path: null,
    checksum_algorithm: "legacy_id", checksum: "legacy-memory-source:p1", status: "ready",
    created_by: "owner-1", created_at: basePersona.created_at, revoked_at: null,
  });
  state.memories.set("r1", {
    id: "r1", persona_id: "p1", content: "一起去海边",
    occurred_at: null, location: null, participants: [], embedding: null,
    status: "confirmed", confirmed_at: "2026-07-13T00:02:00.000Z",
    conflict_group_id: null, confirmed_by: null,
    created_at: "2026-07-13T00:02:00.000Z", updated_at: "2026-07-13T00:02:00.000Z", revoked_at: null,
  });
  state.links.set("relationship_memory:r1:legacy-memory-source:p1", {
    item_kind: "relationship_memory", item_id: "r1", source_id: "legacy-memory-source:p1",
    source_excerpt: "错误摘录",
    created_at: "2026-07-13T00:02:00.000Z",
  });
  const fake = createMigrationExecutor(state);
  const report = await migrateInventory("/tmp/yusheng", makeInventory(), migrationUserMap, fake.sql, emptyVoiceStore);
  assert.equal(report.items.find((item) => item.id === "r1")?.reason, "legacy_source_link_conflict");
});

it("rolls back new legacy source and memory rows when link creation fails", async () => {
  const state = makeMigrationState();
  const fake = createMigrationExecutor(state, { failLinkFor: "r1" });
  const report = await migrateInventory("/tmp/yusheng", makeInventory(), migrationUserMap, fake.sql, emptyVoiceStore);
  assert.equal(report.items.find((item) => item.id === "r1")?.status, "failed");
  assert.equal(state.sources.size, 0);
  assert.equal(state.memories.size, 0);
  assert.equal(state.links.size, 0);
  assert.equal(fake.transactions(), 1);
});
