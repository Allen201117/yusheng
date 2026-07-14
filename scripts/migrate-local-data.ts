import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { getStorageConfig } from "../src/lib/storage/config";
import { getSql, type SqlExecutor } from "../src/lib/storage/postgres";
import { getVoiceObjectStore, type VoiceObjectStore } from "../src/lib/storage/voiceObjectStore";

type LocalUser = {
  id: string;
  email: string | null;
  phone: string | null;
  password: string | null;
  createdAt: string;
};

type LocalPersona = {
  id: string;
  userId: string;
  name: string;
  relation: string;
  voiceId: string;
  personaDesc: string;
  createdAt: string;
};

type LocalMemory = {
  id: string;
  personaId: string;
  content: string;
  embedding: Buffer | null;
  createdAt: string;
};

type LocalMessage = {
  id: string;
  personaId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type LocalVoiceState = "ready" | "missing_audio" | "missing_meta";

export type LocalVoice = {
  voiceId: string;
  userId: string;
  promptText: string;
  mimeType: string;
  durationSec: number | null;
  createdAt: string;
  audioPath: string;
  checksum: string | null;
  state: LocalVoiceState;
};

export type LocalInventory = {
  databaseFound: boolean;
  users: LocalUser[];
  personas: LocalPersona[];
  memories: LocalMemory[];
  messages: LocalMessage[];
  voices: LocalVoice[];
};

export type MigrationStatus = "imported" | "skipped" | "missing" | "failed";
export type MigrationEntity = "database" | "user" | "voice" | "persona" | "memory" | "message";

export type MigrationReportItem = {
  entity: MigrationEntity;
  id: string;
  status: MigrationStatus;
  reason: string;
  targetId?: string;
};

export type MigrationReport = {
  dryRun: boolean;
  source: string;
  generatedAt: string;
  counts: Record<string, Record<MigrationStatus | "total", number>>;
  items: MigrationReportItem[];
};

type VoicePlanInput = {
  voiceId: string;
  userId: string;
  checksum: string | null;
  audioPath: string;
};

export function classifyLocalVoice(input: {
  metaExists: boolean;
  audioExists: boolean;
}): LocalVoiceState {
  if (!input.metaExists) return "missing_meta";
  if (!input.audioExists) return "missing_audio";
  return "ready";
}

export function planVoiceMigration(
  voices: VoicePlanInput[],
  existingChecksums: Set<string>,
): Array<{ voiceId: string; action: "upload" | "skip" | "missing"; reason: string }> {
  return voices.map((voice) => {
    if (!voice.checksum) return { voiceId: voice.voiceId, action: "missing", reason: "missing_audio" };
    if (existingChecksums.has(voice.checksum)) {
      return { voiceId: voice.voiceId, action: "skip", reason: "checksum_exists" };
    }
    return { voiceId: voice.voiceId, action: "upload", reason: "new_checksum" };
  });
}

export function resolveLocalVoiceOwner(
  voice: Pick<LocalVoice, "voiceId" | "userId">,
  personas: Array<Pick<LocalPersona, "voiceId" | "userId">>,
): string {
  if (voice.userId !== "__legacy__") return voice.userId;
  const referencingOwners = new Set(
    personas.filter((persona) => persona.voiceId === voice.voiceId).map((persona) => persona.userId),
  );
  return referencingOwners.size === 1 ? [...referencingOwners][0] : voice.userId;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function readSqliteInventory(dbPath: string): Omit<LocalInventory, "voices" | "databaseFound"> {
  const empty = { users: [], personas: [], memories: [], messages: [] };
  if (!Database) return empty;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const users = tableExists(db, "users")
      ? (db.prepare("SELECT id, email, phone, password, created_at FROM users ORDER BY id").all() as Array<Record<string, unknown>>)
        .map((row) => ({
          id: String(row.id),
          email: row.email ? String(row.email) : null,
          phone: row.phone ? String(row.phone) : null,
          password: row.password ? String(row.password) : null,
          createdAt: String(row.created_at),
        }))
      : [];
    const personas = tableExists(db, "personas")
      ? (db.prepare("SELECT id, user_id, name, relation, voice_id, persona_desc, created_at FROM personas ORDER BY id").all() as Array<Record<string, unknown>>)
        .map((row) => ({
          id: String(row.id),
          userId: String(row.user_id || "__legacy__"),
          name: String(row.name),
          relation: String(row.relation),
          voiceId: String(row.voice_id),
          personaDesc: String(row.persona_desc || ""),
          createdAt: String(row.created_at),
        }))
      : [];
    const memories = tableExists(db, "memories")
      ? (db.prepare("SELECT id, persona_id, content, embedding, created_at FROM memories ORDER BY id").all() as Array<Record<string, unknown>>)
        .map((row) => ({
          id: String(row.id),
          personaId: String(row.persona_id),
          content: String(row.content),
          embedding: row.embedding ? Buffer.from(row.embedding as Buffer) : null,
          createdAt: String(row.created_at),
        }))
      : [];
    const messages = tableExists(db, "messages")
      ? (db.prepare("SELECT id, persona_id, role, content, created_at FROM messages ORDER BY id").all() as Array<Record<string, unknown>>)
        .map((row) => ({
          id: String(row.id),
          personaId: String(row.persona_id),
          role: row.role === "assistant" ? "assistant" as const : "user" as const,
          content: String(row.content),
          createdAt: String(row.created_at),
        }))
      : [];
    return { users, personas, memories, messages };
  } finally {
    db.close();
  }
}

async function resolveAudioPath(dataDir: string, configuredPath: string): Promise<string> {
  if (path.isAbsolute(configuredPath)) return configuredPath;
  const portablePath = path.join(dataDir, "voices", path.basename(configuredPath));
  if (await fileExists(portablePath)) return portablePath;
  return path.resolve(process.cwd(), configuredPath);
}

async function readVoiceInventory(dataDir: string): Promise<LocalVoice[]> {
  const directory = path.join(dataDir, "voices");
  if (!await fileExists(directory)) return [];
  const files = await readdir(directory);
  const voices: LocalVoice[] = [];
  const referencedAudio = new Set<string>();

  for (const metaName of files.filter((name) => name.endsWith(".meta.json")).sort()) {
    const metaPath = path.join(directory, metaName);
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
      const voiceId = String(meta.voiceId || metaName.replace(/\.meta\.json$/, ""));
      const configuredAudio = String(meta.audioFile || path.join(directory, `${voiceId}.wav`));
      const audioPath = await resolveAudioPath(dataDir, configuredAudio);
      const audioExists = await fileExists(audioPath);
      referencedAudio.add(path.resolve(audioPath));
      const body = audioExists ? await readFile(audioPath) : null;
      voices.push({
        voiceId,
        userId: String(meta.userId || "__legacy__"),
        promptText: String(meta.promptText || ""),
        mimeType: String(meta.mimeType || "audio/wav"),
        durationSec: typeof meta.durationSec === "number" ? meta.durationSec : null,
        createdAt: String(meta.createdAt || new Date(0).toISOString()),
        audioPath,
        checksum: body ? createHash("sha256").update(body).digest("hex") : null,
        state: classifyLocalVoice({ metaExists: true, audioExists }),
      });
    } catch {
      voices.push({
        voiceId: metaName.replace(/\.meta\.json$/, ""),
        userId: "__legacy__",
        promptText: "",
        mimeType: "application/octet-stream",
        durationSec: null,
        createdAt: new Date(0).toISOString(),
        audioPath: "",
        checksum: null,
        state: "missing_meta",
      });
    }
  }

  for (const audioName of files.filter((name) => !name.endsWith(".meta.json"))) {
    const audioPath = path.resolve(directory, audioName);
    if (referencedAudio.has(audioPath)) continue;
    voices.push({
      voiceId: path.parse(audioName).name,
      userId: "__legacy__",
      promptText: "",
      mimeType: "application/octet-stream",
      durationSec: null,
      createdAt: new Date(0).toISOString(),
      audioPath,
      checksum: createHash("sha256").update(await readFile(audioPath)).digest("hex"),
      state: "missing_meta",
    });
  }

  return voices.sort((a, b) => a.voiceId.localeCompare(b.voiceId));
}

export async function inventoryLocalData(dataDir: string): Promise<LocalInventory> {
  const absoluteDataDir = path.resolve(dataDir);
  const dbPath = path.join(absoluteDataDir, "yusheng.sqlite");
  const databaseFound = await fileExists(dbPath);
  const sqlite = databaseFound
    ? readSqliteInventory(dbPath)
    : { users: [], personas: [], memories: [], messages: [] };
  return { databaseFound, ...sqlite, voices: await readVoiceInventory(absoluteDataDir) };
}

function reportCounts(items: MigrationReportItem[]): MigrationReport["counts"] {
  const result: MigrationReport["counts"] = {};
  for (const entity of ["database", "user", "voice", "persona", "memory", "message"] as const) {
    const selected = items.filter((item) => item.entity === entity);
    result[entity] = {
      total: selected.length,
      imported: selected.filter((item) => item.status === "imported").length,
      skipped: selected.filter((item) => item.status === "skipped").length,
      missing: selected.filter((item) => item.status === "missing").length,
      failed: selected.filter((item) => item.status === "failed").length,
    };
  }
  return result;
}

function makeReport(dataDir: string, dryRun: boolean, items: MigrationReportItem[]): MigrationReport {
  return {
    dryRun,
    source: path.resolve(dataDir),
    generatedAt: new Date().toISOString(),
    counts: reportCounts(items),
    items,
  };
}

export function createDryRunReport(dataDir: string, inventory: LocalInventory): MigrationReport {
  const items: MigrationReportItem[] = [];
  if (!inventory.databaseFound) {
    items.push({
      entity: "database",
      id: path.join(path.resolve(dataDir), "yusheng.sqlite"),
      status: "missing",
      reason: "missing_sqlite",
    });
  }
  const dbEntities: Array<[MigrationEntity, Array<{ id: string }>]> = [
    ["user", inventory.users],
    ["persona", inventory.personas],
    ["memory", inventory.memories],
    ["message", inventory.messages],
  ];
  for (const [entity, rows] of dbEntities) {
    for (const row of rows) items.push({ entity, id: row.id, status: "skipped", reason: "dry_run" });
  }
  for (const voice of inventory.voices) {
    items.push({
      entity: "voice",
      id: voice.voiceId,
      status: voice.state === "ready" ? "skipped" : "missing",
      reason: voice.state === "ready" ? "dry_run" : voice.state,
    });
  }
  return makeReport(dataDir, true, items);
}

function serializeEmbedding(buffer: Buffer | null): string | null {
  if (!buffer) return null;
  if (buffer.byteLength % 4 !== 0) throw new Error("invalid_embedding_bytes");
  const values: number[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += 4) {
    values.push(buffer.readFloatLE(offset));
  }
  if (values.length !== 1024) throw new Error(`invalid_embedding_dimensions:${values.length}`);
  return `[${values.join(",")}]`;
}

async function insertReturningId(
  sql: SqlExecutor,
  query: string,
  params: unknown[],
): Promise<boolean> {
  return Boolean((await sql.query<{ id: string }>(query, params))[0]);
}

type ExistingUser = { id: string; email: string | null; phone: string | null };
type ExistingVoice = { id: string; user_id: string; checksum_sha256: string };
type ExistingPersona = {
  id: string;
  user_id: string;
  voice_id: string;
  name: string;
  relation: string;
  persona_desc: string;
  created_at: Date | string;
};

type ExistingLegacySource = {
  id: string;
  persona_id: string;
  source_type: string;
  content_text: string | null;
  object_path: string | null;
  checksum_algorithm: string;
  checksum: string;
  status: string;
  created_by: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
};

type ExistingLegacyMemory = {
  id: string;
  persona_id: string;
  content: string;
  occurred_at: Date | string | null;
  location: string | null;
  participants: unknown;
  embedding: string | number[] | null;
  status: string;
  conflict_group_id: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_at: Date | string | null;
};

type ExistingLegacyLink = {
  item_kind: string;
  item_id: string;
  source_id: string;
  source_excerpt: string;
};

function sameTimestamp(actual: Date | string | null, expected: Date | string): boolean {
  if (actual === null) return false;
  try {
    return new Date(actual).toISOString() === new Date(expected).toISOString();
  } catch {
    return false;
  }
}

function hasNoParticipants(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

function normalizeVector(value: string | number[] | null): number[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(Number);
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  if (trimmed === "[]") return [];
  return trimmed.slice(1, -1).split(",").map(Number);
}

function vectorsEqual(
  actual: string | number[] | null,
  expected: string | null,
): boolean {
  const left = normalizeVector(actual);
  const right = normalizeVector(expected);
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => {
    const expectedValue = right[index];
    if (!Number.isFinite(value) || !Number.isFinite(expectedValue)) return false;
    const scale = Math.max(1, Math.abs(value), Math.abs(expectedValue));
    return Math.abs(value - expectedValue) <= 1e-6 * scale;
  });
}

export async function migrateInventory(
  dataDir: string,
  inventory: LocalInventory,
  userMap: Record<string, string>,
  sql: SqlExecutor,
  voiceStore: VoiceObjectStore,
): Promise<MigrationReport> {
  const items: MigrationReportItem[] = [];
  if (!inventory.databaseFound) {
    items.push({
      entity: "database",
      id: path.join(path.resolve(dataDir), "yusheng.sqlite"),
      status: "missing",
      reason: "missing_sqlite",
    });
  }
  const resolvedUsers = new Map<string, string>(Object.entries(userMap));
  const existingUsers = await sql.query<ExistingUser>("SELECT id, email, phone FROM users");
  const usersById = new Map(existingUsers.map((user) => [user.id, user]));
  const usersByEmail = new Map(existingUsers.filter((user) => user.email).map((user) => [user.email!, user]));
  const usersByPhone = new Map(existingUsers.filter((user) => user.phone).map((user) => [user.phone!, user]));

  for (const user of inventory.users) {
    const requestedId = resolvedUsers.get(user.id) || user.id;
    const existing = usersById.get(requestedId)
      || (user.email ? usersByEmail.get(user.email) : undefined)
      || (user.phone ? usersByPhone.get(user.phone) : undefined);
    if (existing) {
      resolvedUsers.set(user.id, existing.id);
      items.push({ entity: "user", id: user.id, targetId: existing.id, status: "skipped", reason: "identity_exists" });
      continue;
    }
    try {
      const inserted = await insertReturningId(
        sql,
        `INSERT INTO users (id, email, phone, password, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [requestedId, user.email, user.phone, user.password, user.createdAt],
      );
      resolvedUsers.set(user.id, requestedId);
      const created = { id: requestedId, email: user.email, phone: user.phone };
      usersById.set(requestedId, created);
      if (user.email) usersByEmail.set(user.email, created);
      if (user.phone) usersByPhone.set(user.phone, created);
      items.push({ entity: "user", id: user.id, targetId: requestedId, status: inserted ? "imported" : "skipped", reason: inserted ? "inserted" : "id_exists" });
    } catch (error) {
      items.push({ entity: "user", id: user.id, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const owners = new Set([
    ...inventory.personas.map((persona) => persona.userId),
    ...inventory.voices.map((voice) => resolveLocalVoiceOwner(voice, inventory.personas)),
  ]);
  for (const sourceOwner of owners) {
    if (resolvedUsers.has(sourceOwner) && usersById.has(resolvedUsers.get(sourceOwner)!)) continue;
    const targetId = resolvedUsers.get(sourceOwner) || sourceOwner;
    if (usersById.has(targetId)) {
      resolvedUsers.set(sourceOwner, targetId);
      continue;
    }
    try {
      const inserted = await insertReturningId(
        sql,
        "INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id",
        [targetId, new Date(0).toISOString()],
      );
      resolvedUsers.set(sourceOwner, targetId);
      usersById.set(targetId, { id: targetId, email: null, phone: null });
      items.push({ entity: "user", id: sourceOwner, targetId, status: inserted ? "imported" : "skipped", reason: "derived_owner" });
    } catch (error) {
      items.push({ entity: "user", id: sourceOwner, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const existingVoices = await sql.query<ExistingVoice>(
    "SELECT id, user_id, checksum_sha256 FROM voice_profiles WHERE deleted_at IS NULL",
  );
  const voicesById = new Map(existingVoices.map((voice) => [voice.id, voice]));
  const voicesByOwnerChecksum = new Map(existingVoices.map((voice) => [`${voice.user_id}:${voice.checksum_sha256}`, voice]));
  const resolvedVoices = new Map<string, string>();

  for (const voice of inventory.voices) {
    if (voice.state !== "ready" || !voice.checksum) {
      items.push({ entity: "voice", id: voice.voiceId, status: "missing", reason: voice.state });
      continue;
    }
    const sourceOwner = resolveLocalVoiceOwner(voice, inventory.personas);
    const ownerId = resolvedUsers.get(sourceOwner);
    if (!ownerId) {
      items.push({ entity: "voice", id: voice.voiceId, status: "failed", reason: "missing_owner_dependency" });
      continue;
    }
    const byId = voicesById.get(voice.voiceId);
    const byChecksum = voicesByOwnerChecksum.get(`${ownerId}:${voice.checksum}`);
    if (byId && byId.user_id !== ownerId) {
      items.push({ entity: "voice", id: voice.voiceId, status: "failed", reason: "voice_owner_conflict" });
      continue;
    }
    if (byId && byId.checksum_sha256 !== voice.checksum) {
      items.push({ entity: "voice", id: voice.voiceId, status: "failed", reason: "voice_checksum_conflict" });
      continue;
    }
    const existing = byId || byChecksum;
    if (existing) {
      resolvedVoices.set(voice.voiceId, existing.id);
      items.push({ entity: "voice", id: voice.voiceId, targetId: existing.id, status: "skipped", reason: byId ? "id_exists" : "checksum_exists" });
      continue;
    }
    try {
      const body = await readFile(voice.audioPath);
      const created = await voiceStore.put({
        voiceId: voice.voiceId,
        userId: ownerId,
        body,
        promptText: voice.promptText,
        mimeType: voice.mimeType,
        durationSec: voice.durationSec,
      });
      resolvedVoices.set(voice.voiceId, created.voiceId);
      const existingVoice = { id: created.voiceId, user_id: ownerId, checksum_sha256: voice.checksum };
      voicesById.set(created.voiceId, existingVoice);
      voicesByOwnerChecksum.set(`${ownerId}:${voice.checksum}`, existingVoice);
      items.push({ entity: "voice", id: voice.voiceId, targetId: created.voiceId, status: "imported", reason: "uploaded" });
    } catch (error) {
      items.push({ entity: "voice", id: voice.voiceId, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const existingPersonaRows = await sql.query<ExistingPersona>(
    `SELECT id, user_id, voice_id, name, relation, persona_desc, created_at
     FROM personas`,
  );
  const existingPersonas = new Map(existingPersonaRows.map((persona) => [persona.id, persona]));
  const migratablePersonaIds = new Set<string>();
  for (const persona of inventory.personas) {
    const ownerId = resolvedUsers.get(persona.userId);
    const voiceId = resolvedVoices.get(persona.voiceId);
    if (!ownerId || !voiceId) {
      items.push({ entity: "persona", id: persona.id, status: "failed", reason: !ownerId ? "missing_owner_dependency" : "missing_voice_dependency" });
      continue;
    }
    const existing = existingPersonas.get(persona.id);
    if (existing) {
      if (existing.user_id !== ownerId) {
        items.push({ entity: "persona", id: persona.id, status: "failed", reason: "persona_owner_conflict" });
        continue;
      }
      if (
        existing.voice_id !== voiceId
        || existing.name !== persona.name
        || existing.relation !== persona.relation
        || existing.persona_desc !== persona.personaDesc
        || !sameTimestamp(existing.created_at, persona.createdAt)
      ) {
        items.push({ entity: "persona", id: persona.id, status: "failed", reason: "persona_identity_conflict" });
        continue;
      }
      migratablePersonaIds.add(persona.id);
      items.push({ entity: "persona", id: persona.id, status: "skipped", reason: "id_exists" });
      continue;
    }
    try {
      const inserted = await insertReturningId(
        sql,
        `INSERT INTO personas (id, user_id, name, relation, voice_id, persona_desc, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [persona.id, ownerId, persona.name, persona.relation, voiceId, persona.personaDesc, persona.createdAt],
      );
      if (inserted) {
        existingPersonas.set(persona.id, {
          id: persona.id,
          user_id: ownerId,
          voice_id: voiceId,
          name: persona.name,
          relation: persona.relation,
          persona_desc: persona.personaDesc,
          created_at: persona.createdAt,
        });
        migratablePersonaIds.add(persona.id);
      }
      items.push({
        entity: "persona",
        id: persona.id,
        status: inserted ? "imported" : "failed",
        reason: inserted ? "inserted" : "persona_identity_conflict",
      });
    } catch (error) {
      items.push({ entity: "persona", id: persona.id, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const memory of inventory.memories) {
    const persona = existingPersonas.get(memory.personaId);
    if (!persona || !migratablePersonaIds.has(memory.personaId)) {
      items.push({ entity: "memory", id: memory.id, status: "failed", reason: "missing_persona_dependency" });
      continue;
    }
    try {
      const vector = serializeEmbedding(memory.embedding);
      const inserted = await sql.transaction(async (transaction) => {
        const sourceId = `legacy-memory-source:${memory.personaId}`;
        const sourceInserted = await transaction.query<{ id: string }>(
          `INSERT INTO persona_sources
             (id, persona_id, source_type, checksum_algorithm, checksum, status,
              created_by, created_at)
           VALUES ($1, $2, 'legacy_import', 'legacy_id', $1, 'ready', $3, $4)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [sourceId, memory.personaId, persona.user_id, persona.created_at],
        );
        if (!sourceInserted[0]) {
          const sourceRows = await transaction.query<ExistingLegacySource>(
            `SELECT id, persona_id, source_type, content_text, object_path,
                    checksum_algorithm, checksum, status,
                    created_by, created_at, revoked_at
             FROM persona_sources
             WHERE id = $1
             FOR UPDATE`,
            [sourceId],
          );
          const source = sourceRows[0];
          if (
            !source
            || source.persona_id !== memory.personaId
            || source.source_type !== "legacy_import"
            || source.content_text !== null
            || source.object_path !== null
            || source.checksum_algorithm !== "legacy_id"
            || source.checksum !== sourceId
            || source.status !== "ready"
            || source.created_by !== persona.user_id
            || !sameTimestamp(source.created_at, persona.created_at)
            || source.revoked_at !== null
          ) {
            throw new Error("legacy_source_conflict");
          }
        }
        const memoryInserted = await insertReturningId(
          transaction,
          `INSERT INTO relationship_memories
             (id, persona_id, content, participants, embedding, status,
              confirmed_at, created_at, updated_at)
           VALUES ($1, $2, $3, '[]'::jsonb, $4::vector, 'confirmed', $5, $5, $5)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [memory.id, memory.personaId, memory.content, vector, memory.createdAt],
        );
        if (!memoryInserted) {
          const memoryRows = await transaction.query<ExistingLegacyMemory>(
            `SELECT id, persona_id, content, occurred_at, location, participants,
                    embedding::text AS embedding, status, conflict_group_id, confirmed_by,
                    confirmed_at, created_at, updated_at, revoked_at
             FROM relationship_memories
             WHERE id = $1
             FOR UPDATE`,
            [memory.id],
          );
          const existingMemory = memoryRows[0];
          if (
            !existingMemory
            || existingMemory.persona_id !== memory.personaId
            || existingMemory.content !== memory.content
            || existingMemory.occurred_at !== null
            || existingMemory.location !== null
            || !hasNoParticipants(existingMemory.participants)
            || !vectorsEqual(existingMemory.embedding, vector)
            || existingMemory.status !== "confirmed"
            || existingMemory.conflict_group_id !== null
            || existingMemory.confirmed_by !== null
            || !sameTimestamp(existingMemory.confirmed_at, memory.createdAt)
            || !sameTimestamp(existingMemory.created_at, memory.createdAt)
            || !sameTimestamp(existingMemory.updated_at, memory.createdAt)
            || existingMemory.revoked_at !== null
          ) {
            throw new Error("legacy_memory_conflict");
          }
        }
        const linkInserted = await transaction.query<{ item_id: string }>(
          `INSERT INTO persona_item_sources
             (item_kind, item_id, source_id, source_excerpt, created_at)
           SELECT $1, memory.id, source.id, $4, $5
           FROM relationship_memories memory
           JOIN persona_sources source ON source.persona_id = memory.persona_id
           WHERE memory.id = $2 AND memory.persona_id = $6
             AND source.id = $3 AND source.persona_id = $6 AND source.status = 'ready'
           ON CONFLICT (item_kind, item_id, source_id) DO NOTHING
           RETURNING item_id`,
          ["relationship_memory", memory.id, sourceId, memory.content, memory.createdAt, memory.personaId],
        );
        if (!linkInserted[0]) {
          const linkRows = await transaction.query<ExistingLegacyLink>(
            `SELECT item_kind, item_id, source_id, source_excerpt
             FROM persona_item_sources
             WHERE item_kind = $1 AND item_id = $2 AND source_id = $3
             FOR UPDATE`,
            ["relationship_memory", memory.id, sourceId],
          );
          const link = linkRows[0];
          if (
            !link
            || link.item_kind !== "relationship_memory"
            || link.item_id !== memory.id
            || link.source_id !== sourceId
            || link.source_excerpt !== memory.content
          ) {
            throw new Error("legacy_source_link_conflict");
          }
        }
        return memoryInserted;
      });
      items.push({ entity: "memory", id: memory.id, status: inserted ? "imported" : "skipped", reason: inserted ? "inserted" : "id_exists" });
    } catch (error) {
      items.push({ entity: "memory", id: memory.id, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const message of inventory.messages) {
    if (!migratablePersonaIds.has(message.personaId)) {
      items.push({ entity: "message", id: message.id, status: "failed", reason: "missing_persona_dependency" });
      continue;
    }
    try {
      const inserted = await insertReturningId(
        sql,
        `INSERT INTO messages (id, persona_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [message.id, message.personaId, message.role, message.content, message.createdAt],
      );
      items.push({ entity: "message", id: message.id, status: inserted ? "imported" : "skipped", reason: inserted ? "inserted" : "id_exists" });
    } catch (error) {
      items.push({ entity: "message", id: message.id, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return makeReport(dataDir, false, items);
}

type CliOptions = {
  dataDir: string;
  dryRun: boolean;
  reportPath: string;
  userMapPath?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: "./data",
    dryRun: false,
    reportPath: "./migration-report.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--data-dir") options.dataDir = argv[++index] || options.dataDir;
    else if (arg === "--report") options.reportPath = argv[++index] || options.reportPath;
    else if (arg === "--user-map") options.userMapPath = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function loadUserMap(file?: string): Promise<Record<string, string>> {
  if (!file) return {};
  const value = JSON.parse(await readFile(path.resolve(file), "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--user-map must contain a JSON object");
  }
  return Object.fromEntries(
    Object.entries(value).map(([source, target]) => {
      if (typeof target !== "string" || !target) throw new Error(`Invalid user map target for ${source}`);
      return [source, target];
    }),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inventory = await inventoryLocalData(options.dataDir);
  let report: MigrationReport;
  if (options.dryRun) {
    report = createDryRunReport(options.dataDir, inventory);
  } else {
    const config = getStorageConfig();
    if (config.backend !== "cloud") throw new Error("Live migration requires STORAGE_BACKEND=cloud");
    report = await migrateInventory(
      options.dataDir,
      inventory,
      await loadUserMap(options.userMapPath),
      getSql(config.databaseUrl),
      getVoiceObjectStore(),
    );
  }
  await writeFile(path.resolve(options.reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ report: path.resolve(options.reportPath), counts: report.counts }, null, 2)}\n`);
  if (!options.dryRun && report.items.some((item) => item.status === "failed" || item.status === "missing")) {
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
