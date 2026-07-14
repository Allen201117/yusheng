/**
 * SQLite 数据层（better-sqlite3，同步 API，跑在 Node.js runtime）
 *
 * 所有人物数据按 user_id 隔离，记忆和消息通过 persona 归属间接隔离。
 * 如果数据库里已有 Slice 2 的数据（没有 user_id 列），
 * 自动做 ALTER TABLE 迁移，旧数据归属到 "__legacy__" 用户。
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { normalizePersonaKnowledgeText } from "./personaKnowledge";
import type {
  CreatePersonaKnowledgeCandidateInput,
  CreatePersonaSourceInput,
  PersonaFact,
  PersonaKnowledgeBundle,
  PersonaKnowledgeItem,
  PersonaKnowledgeKind,
  PersonaKnowledgeStatus,
  PersonaSource,
  RelationshipMemory,
  SpeechStyleItem,
  CreateVoiceAuthorizationInput,
  VoiceAuthorization,
} from "./storage/types";

const DATA_DIR = process.env.DATA_DIR || "./data";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbFile = path.join(DATA_DIR, "yusheng.sqlite");
  _db = new Database(dbFile);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  migrateUserColumn(_db);
  migrateLegacyPersonaKnowledge(_db);
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT UNIQUE,
      phone      TEXT UNIQUE,
      password   TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id         TEXT PRIMARY KEY,
      email      TEXT,
      phone      TEXT,
      code       TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_vcodes_email ON verification_codes(email, used);
    CREATE INDEX IF NOT EXISTS idx_vcodes_phone ON verification_codes(phone, used);

    CREATE TABLE IF NOT EXISTS personas (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL DEFAULT '__legacy__',
      name         TEXT NOT NULL,
      relation     TEXT NOT NULL,
      voice_id     TEXT NOT NULL,
      persona_desc TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,
      embedding   BLOB,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_persona ON memories(persona_id);

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_persona ON messages(persona_id, created_at);

    CREATE TABLE IF NOT EXISTS voice_authorizations (
      id                                  TEXT PRIMARY KEY,
      voice_id                            TEXT NOT NULL,
      user_id                             TEXT NOT NULL,
      speaker_status                      TEXT NOT NULL CHECK (speaker_status IN ('living','deceased')),
      basis                               TEXT NOT NULL CHECK (basis IN ('self','speaker_separate_consent','legal_representative','close_relative_request')),
      status                              TEXT NOT NULL CHECK (status IN ('pending_review','approved','rejected','revoked')),
      reason_code                         TEXT,
      notice_version                      TEXT NOT NULL,
      separate_consent_confirmed          INTEGER NOT NULL,
      third_party_processing_confirmed    INTEGER NOT NULL,
      synthetic_disclosure_confirmed      INTEGER NOT NULL,
      attested_at                         TEXT NOT NULL,
      reviewed_at                         TEXT,
      revoked_at                          TEXT,
      created_at                          TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_authorizations_one_active
      ON voice_authorizations(voice_id, user_id)
      WHERE status IN ('pending_review','approved');
    CREATE INDEX IF NOT EXISTS idx_voice_authorizations_owner_created
      ON voice_authorizations(user_id, voice_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS persona_sources (
      id                 TEXT PRIMARY KEY,
      persona_id         TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      source_type        TEXT NOT NULL CHECK (source_type IN ('manual_text','chat_export','audio_transcript','text_document','legacy_import')),
      content_text       TEXT,
      object_path        TEXT,
      checksum_algorithm TEXT NOT NULL CHECK (checksum_algorithm IN ('sha256','legacy_id')),
      checksum           TEXT NOT NULL,
      status             TEXT NOT NULL CHECK (status IN ('ready','failed','revoked')),
      created_by         TEXT NOT NULL,
      created_at         TEXT NOT NULL,
      revoked_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS persona_facts (
      id                TEXT PRIMARY KEY,
      persona_id        TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      fact_type         TEXT NOT NULL,
      fact_key          TEXT NOT NULL,
      content           TEXT NOT NULL,
      normalized_value  TEXT NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','conflicted','revoked')),
      conflict_group_id TEXT,
      confirmed_by      TEXT,
      confirmed_at      TEXT,
      revoked_at        TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relationship_memories (
      id                TEXT PRIMARY KEY,
      persona_id        TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      content           TEXT NOT NULL,
      occurred_at       TEXT,
      location          TEXT,
      participants      TEXT NOT NULL DEFAULT '[]',
      embedding         BLOB,
      status            TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','conflicted','revoked')),
      conflict_group_id TEXT,
      confirmed_by      TEXT,
      confirmed_at      TEXT,
      revoked_at        TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS speech_style_items (
      id                TEXT PRIMARY KEY,
      persona_id        TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      category          TEXT NOT NULL,
      content           TEXT NOT NULL,
      example           TEXT,
      status            TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','conflicted','revoked')),
      conflict_group_id TEXT,
      confirmed_by      TEXT,
      confirmed_at      TEXT,
      revoked_at        TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS persona_item_sources (
      item_kind     TEXT NOT NULL CHECK (item_kind IN ('fact','relationship_memory','speech_style')),
      item_id       TEXT NOT NULL,
      source_id     TEXT NOT NULL REFERENCES persona_sources(id) ON DELETE CASCADE,
      source_excerpt TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      PRIMARY KEY (item_kind, item_id, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_persona_sources_persona
      ON persona_sources(persona_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_persona_facts_confirmed
      ON persona_facts(persona_id, fact_type, fact_key)
      WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS idx_relationship_memories_confirmed
      ON relationship_memories(persona_id, created_at DESC)
      WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS idx_speech_style_items_confirmed
      ON speech_style_items(persona_id, category, created_at DESC)
      WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS idx_persona_item_sources_source
      ON persona_item_sources(source_id);
  `);
}

/** 如果从 Slice 2 升级上来，旧表没有 user_id 列，自动加 */
function migrateUserColumn(db: Database.Database) {
  const cols = db.pragma("table_info(personas)") as { name: string }[];
  if (!cols.some((c) => c.name === "user_id")) {
    db.exec(`ALTER TABLE personas ADD COLUMN user_id TEXT NOT NULL DEFAULT '__legacy__'`);
  }
}

export function migrateLegacyPersonaKnowledge(db: Database.Database) {
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO persona_sources
         (id, persona_id, source_type, checksum_algorithm, checksum, status, created_by, created_at)
       SELECT
         'legacy-memory-source:' || p.id,
         p.id,
         'legacy_import',
         'legacy_id',
         'legacy-memory-source:' || p.id,
         'ready',
         p.user_id,
         p.created_at
       FROM personas p
       WHERE EXISTS (
         SELECT 1 FROM memories m WHERE m.persona_id = p.id
       )`,
    ).run();

    db.prepare(
      `INSERT OR IGNORE INTO relationship_memories
         (id, persona_id, content, embedding, status, confirmed_at, created_at, updated_at)
       SELECT
         m.id,
         m.persona_id,
         m.content,
         m.embedding,
         'confirmed',
         m.created_at,
         m.created_at,
         m.created_at
       FROM memories m`,
    ).run();

    db.prepare(
      `INSERT OR IGNORE INTO persona_item_sources
         (item_kind, item_id, source_id, source_excerpt, created_at)
       SELECT
         'relationship_memory',
         m.id,
         'legacy-memory-source:' || m.persona_id,
         m.content,
         m.created_at
       FROM memories m`,
    ).run();
  })();
}

// ------- User -------
type UserRow = { id: string; email: string; phone: string; password: string; createdAt: string };

export function getUserByEmail(email: string): UserRow | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
  if (!row) return null;
  return { id: row.id, email: row.email, phone: row.phone, password: row.password, createdAt: row.created_at };
}

export function getUserByPhone(phone: string): UserRow | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as any;
  if (!row) return null;
  return { id: row.id, email: row.email, phone: row.phone, password: row.password, createdAt: row.created_at };
}

export function createUserByEmail(email: string, passwordHash?: string): UserRow {
  const db = getDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO users (id, email, password, created_at) VALUES (?, ?, ?, ?)")
    .run(id, email, passwordHash || null, createdAt);
  return { id, email, phone: "", password: passwordHash || "", createdAt };
}

export function createUserByPhone(phone: string): UserRow {
  const db = getDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO users (id, phone, created_at) VALUES (?, ?, ?)").run(id, phone, createdAt);
  return { id, email: "", phone, password: "", createdAt };
}

export function setUserPassword(email: string, hash: string) {
  const db = getDb();
  db.prepare("UPDATE users SET password = ? WHERE email = ?").run(hash, email);
}

// ------- Verification Code -------
export function createVerificationCode(
  target: { email?: string; phone?: string },
  code: string,
  ttlMinutes = 5,
) {
  const db = getDb();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO verification_codes (id, email, phone, code, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, target.email || null, target.phone || null, code, expiresAt);
}

export function verifyCode(target: { email?: string; phone?: string }, code: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  let row: any;
  if (target.email) {
    row = db.prepare(
      "SELECT * FROM verification_codes WHERE email = ? AND code = ? AND used = 0 AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
    ).get(target.email, code, now);
  } else if (target.phone) {
    row = db.prepare(
      "SELECT * FROM verification_codes WHERE phone = ? AND code = ? AND used = 0 AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
    ).get(target.phone, code, now);
  }
  if (!row) return false;
  db.prepare("UPDATE verification_codes SET used = 1 WHERE id = ?").run(row.id);
  return true;
}

// ------- Persona -------
export type Persona = {
  id: string;
  userId: string;
  name: string;
  relation: string;
  voiceId: string;
  personaDesc: string;
  createdAt: string;
};

export function createPersona(p: Omit<Persona, "createdAt">): Persona {
  const db = getDb();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO personas (id, user_id, name, relation, voice_id, persona_desc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.id, p.userId, p.name, p.relation, p.voiceId, p.personaDesc, createdAt);
  return { ...p, createdAt };
}

export function listPersonas(userId: string): Persona[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM personas WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as any[];
  return rows.map(rowToPersona);
}

export function getPersona(id: string): Persona | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id) as any;
  return row ? rowToPersona(row) : null;
}

/** 确认 persona 属于指定用户，防越权 */
export function getPersonaForUser(id: string, userId: string): Persona | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM personas WHERE id = ? AND user_id = ?`)
    .get(id, userId) as any;
  return row ? rowToPersona(row) : null;
}

export function countPersonasUsingVoice(voiceId: string, userId: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM personas WHERE voice_id = ? AND user_id = ?`)
    .get(voiceId, userId) as { count: number };
  return row.count;
}

function rowToPersona(r: any): Persona {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    relation: r.relation,
    voiceId: r.voice_id,
    personaDesc: r.persona_desc,
    createdAt: r.created_at,
  };
}

// ------- Persona Knowledge -------
const KNOWLEDGE_TABLES = {
  fact: "persona_facts",
  relationship_memory: "relationship_memories",
  speech_style: "speech_style_items",
} as const;

function parseParticipants(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function rowToPersonaSource(row: any): PersonaSource {
  return {
    id: row.id,
    personaId: row.persona_id,
    sourceType: row.source_type,
    contentText: row.content_text,
    objectPath: row.object_path,
    checksumAlgorithm: row.checksum_algorithm,
    checksum: row.checksum,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function rowToPersonaFact(row: any): PersonaFact {
  return {
    kind: "fact",
    id: row.id,
    personaId: row.persona_id,
    factType: row.fact_type,
    factKey: row.fact_key,
    content: row.content,
    normalizedValue: row.normalized_value,
    status: row.status,
    conflictGroupId: row.conflict_group_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRelationshipMemory(row: any): RelationshipMemory {
  return {
    kind: "relationship_memory",
    id: row.id,
    personaId: row.persona_id,
    content: row.content,
    occurredAt: row.occurred_at,
    location: row.location,
    participants: parseParticipants(row.participants),
    status: row.status,
    conflictGroupId: row.conflict_group_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSpeechStyleItem(row: any): SpeechStyleItem {
  return {
    kind: "speech_style",
    id: row.id,
    personaId: row.persona_id,
    category: row.category,
    content: row.content,
    example: row.example,
    status: row.status,
    conflictGroupId: row.conflict_group_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPersonaKnowledgeItem(kind: PersonaKnowledgeKind, row: any): PersonaKnowledgeItem {
  if (kind === "fact") return rowToPersonaFact(row);
  if (kind === "relationship_memory") return rowToRelationshipMemory(row);
  return rowToSpeechStyleItem(row);
}

export function listPersonaKnowledge(personaId: string): PersonaKnowledgeBundle {
  const database = getDb();
  return {
    sources: (database.prepare(
      "SELECT * FROM persona_sources WHERE persona_id = ? ORDER BY created_at, id",
    ).all(personaId) as any[]).map(rowToPersonaSource),
    facts: (database.prepare(
      "SELECT * FROM persona_facts WHERE persona_id = ? ORDER BY created_at, id",
    ).all(personaId) as any[]).map(rowToPersonaFact),
    memories: (database.prepare(
      "SELECT * FROM relationship_memories WHERE persona_id = ? ORDER BY created_at, id",
    ).all(personaId) as any[]).map(rowToRelationshipMemory),
    styles: (database.prepare(
      "SELECT * FROM speech_style_items WHERE persona_id = ? ORDER BY created_at, id",
    ).all(personaId) as any[]).map(rowToSpeechStyleItem),
  };
}

export function getPersonaKnowledgeItem(
  kind: PersonaKnowledgeKind,
  id: string,
  personaId: string,
): PersonaKnowledgeItem | null {
  const table = KNOWLEDGE_TABLES[kind];
  const row = getDb().prepare(`SELECT * FROM ${table} WHERE id = ? AND persona_id = ?`).get(
    id,
    personaId,
  ) as any;
  return row ? rowToPersonaKnowledgeItem(kind, row) : null;
}

export function findConfirmedFacts(
  personaId: string,
  factType: string,
  factKey: string,
): PersonaFact[] {
  const normalizedFactType = normalizePersonaKnowledgeText(factType);
  const normalizedFactKey = normalizePersonaKnowledgeText(factKey);
  return (getDb().prepare(
    `SELECT * FROM persona_facts
     WHERE persona_id = ? AND status = 'confirmed'
     ORDER BY created_at, id`,
  ).all(personaId) as any[])
    .map(rowToPersonaFact)
    .filter((fact) =>
      normalizePersonaKnowledgeText(fact.factType) === normalizedFactType
      && normalizePersonaKnowledgeText(fact.factKey) === normalizedFactKey);
}

export function createPersonaKnowledgeCandidates(input: {
  source: CreatePersonaSourceInput;
  candidates: CreatePersonaKnowledgeCandidateInput[];
}): PersonaKnowledgeBundle {
  const database = getDb();
  return database.transaction(() => {
    for (const candidate of input.candidates) {
      if (candidate.personaId !== input.source.personaId) throw new Error("persona_mismatch");
      if (candidate.sourceId !== input.source.id) throw new Error("source_mismatch");
    }
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO persona_sources
         (id, persona_id, source_type, content_text, object_path, checksum_algorithm,
          checksum, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.source.id,
      input.source.personaId,
      input.source.sourceType,
      input.source.contentText,
      input.source.objectPath,
      input.source.checksumAlgorithm,
      input.source.checksum,
      input.source.status,
      input.source.createdBy,
      now,
    );
    const facts: PersonaFact[] = [];
    const memories: RelationshipMemory[] = [];
    const styles: SpeechStyleItem[] = [];
    const link = database.prepare(
      `INSERT INTO persona_item_sources
         (item_kind, item_id, source_id, source_excerpt, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const candidate of input.candidates) {
      if (candidate.kind === "fact") {
        database.prepare(
          `INSERT INTO persona_facts
             (id, persona_id, fact_type, fact_key, content, normalized_value, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
          candidate.id, candidate.personaId, candidate.factType, candidate.factKey,
          candidate.content, candidate.normalizedValue, now, now,
        );
        facts.push(getPersonaKnowledgeItem("fact", candidate.id, candidate.personaId) as PersonaFact);
      } else if (candidate.kind === "relationship_memory") {
        const embedding = candidate.embedding
          ? Buffer.from(candidate.embedding.buffer, candidate.embedding.byteOffset, candidate.embedding.byteLength)
          : null;
        database.prepare(
          `INSERT INTO relationship_memories
             (id, persona_id, content, occurred_at, location, participants, embedding,
              status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
          candidate.id, candidate.personaId, candidate.content, candidate.occurredAt,
          candidate.location, JSON.stringify(candidate.participants), embedding, now, now,
        );
        memories.push(getPersonaKnowledgeItem(
          "relationship_memory",
          candidate.id,
          candidate.personaId,
        ) as RelationshipMemory);
      } else {
        database.prepare(
          `INSERT INTO speech_style_items
             (id, persona_id, category, content, example, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
          candidate.id, candidate.personaId, candidate.category, candidate.content,
          candidate.example, now, now,
        );
        styles.push(getPersonaKnowledgeItem(
          "speech_style",
          candidate.id,
          candidate.personaId,
        ) as SpeechStyleItem);
      }
      link.run(candidate.kind, candidate.id, candidate.sourceId, candidate.sourceExcerpt, now);
    }
    const source = database.prepare(
      "SELECT * FROM persona_sources WHERE id = ? AND persona_id = ?",
    ).get(input.source.id, input.source.personaId) as any;
    return { sources: [rowToPersonaSource(source)], facts, memories, styles };
  })();
}

const EDITABLE_COLUMNS = {
  fact: {
    factType: "fact_type",
    factKey: "fact_key",
    content: "content",
    normalizedValue: "normalized_value",
  },
  relationship_memory: {
    content: "content",
    occurredAt: "occurred_at",
    location: "location",
    participants: "participants",
  },
  speech_style: {
    category: "category",
    content: "content",
    example: "example",
  },
} as const;

export function updatePersonaKnowledgeCandidate(input: {
  kind: PersonaKnowledgeKind;
  id: string;
  personaId: string;
  expectedStatus: "pending" | "conflicted";
  patch: Record<string, string | string[] | null>;
}): PersonaKnowledgeItem | null {
  const allowed = EDITABLE_COLUMNS[input.kind] as Record<string, string>;
  const entries = Object.entries(input.patch).filter(([key]) => allowed[key]);
  if (entries.length === 0) {
    const table = KNOWLEDGE_TABLES[input.kind];
    const row = getDb().prepare(
      `SELECT * FROM ${table} WHERE id = ? AND persona_id = ? AND status = ?`,
    ).get(input.id, input.personaId, input.expectedStatus) as any;
    return row ? rowToPersonaKnowledgeItem(input.kind, row) : null;
  }
  const values = entries.map(([key, value]) =>
    input.kind === "relationship_memory" && key === "participants"
      ? JSON.stringify(Array.isArray(value) ? value : [])
      : value,
  );
  const assignments = entries.map(([key], index) => `${allowed[key]} = ?`).join(", ");
  const table = KNOWLEDGE_TABLES[input.kind];
  const now = new Date().toISOString();
  const result = getDb().prepare(
    `UPDATE ${table}
     SET ${assignments}, status = 'pending', conflict_group_id = NULL,
         confirmed_by = NULL, confirmed_at = NULL, revoked_at = NULL, updated_at = ?
     WHERE id = ? AND persona_id = ? AND status = ?`,
  ).run(...values, now, input.id, input.personaId, input.expectedStatus);
  if (result.changes === 0) return null;
  return getPersonaKnowledgeItem(input.kind, input.id, input.personaId);
}

export function setPersonaKnowledgeStatuses(inputs: Array<{
  kind: PersonaKnowledgeKind;
  id: string;
  personaId: string;
  expectedStatus: PersonaKnowledgeStatus;
  nextStatus: PersonaKnowledgeStatus;
  actorUserId: string;
  conflictGroupId: string | null;
}>): PersonaKnowledgeItem[] {
  const database = getDb();
  return database.transaction(() => {
    const changed: PersonaKnowledgeItem[] = [];
    for (const input of inputs) {
      const table = KNOWLEDGE_TABLES[input.kind];
      const now = new Date().toISOString();
      const confirmedBy = input.nextStatus === "confirmed" ? input.actorUserId : null;
      const confirmedAt = input.nextStatus === "confirmed" ? now : null;
      const revokedAt = input.nextStatus === "revoked" ? now : null;
      const result = database.prepare(
        `UPDATE ${table}
         SET status = ?, conflict_group_id = ?, confirmed_by = ?, confirmed_at = ?,
             revoked_at = ?, updated_at = ?
         WHERE id = ? AND persona_id = ? AND status = ?`,
      ).run(
        input.nextStatus, input.conflictGroupId, confirmedBy, confirmedAt, revokedAt, now,
        input.id, input.personaId, input.expectedStatus,
      );
      if (result.changes === 0) throw new Error("knowledge_status_changed");
      changed.push(getPersonaKnowledgeItem(input.kind, input.id, input.personaId)!);
    }
    return changed;
  })();
}

export function revokePersonaSource(
  sourceId: string,
  personaId: string,
  _actorUserId: string,
): { sourceRevoked: boolean; revokedItems: Array<{ kind: PersonaKnowledgeKind; id: string }> } {
  const database = getDb();
  return database.transaction(() => {
    const now = new Date().toISOString();
    const source = database.prepare(
      `UPDATE persona_sources SET status = 'revoked', revoked_at = ?
       WHERE id = ? AND persona_id = ? AND status <> 'revoked'
       RETURNING id`,
    ).get(now, sourceId, personaId) as { id: string } | undefined;
    if (!source) return { sourceRevoked: false, revokedItems: [] };
    const links = database.prepare(
      `SELECT links.item_kind, links.item_id
       FROM persona_item_sources links
       JOIN persona_sources source ON source.id = links.source_id
       WHERE links.source_id = ? AND source.persona_id = ?
       ORDER BY links.item_kind, links.item_id`,
    ).all(sourceId, personaId) as Array<{ item_kind: PersonaKnowledgeKind; item_id: string }>;
    const revokedItems: Array<{ kind: PersonaKnowledgeKind; id: string }> = [];
    for (const link of links) {
      const support = database.prepare(
        `SELECT COUNT(*) AS count
         FROM persona_item_sources links
         JOIN persona_sources source ON source.id = links.source_id
         WHERE links.item_kind = ? AND links.item_id = ? AND links.source_id <> ?
           AND source.persona_id = ? AND source.status = 'ready'`,
      ).get(link.item_kind, link.item_id, sourceId, personaId) as { count: number };
      if (support.count > 0) continue;
      const table = KNOWLEDGE_TABLES[link.item_kind];
      const changed = database.prepare(
        `UPDATE ${table}
         SET status = 'revoked', confirmed_by = NULL, confirmed_at = NULL,
             revoked_at = ?, updated_at = ?
         WHERE id = ? AND persona_id = ?
           AND status IN ('pending', 'confirmed', 'conflicted')`,
      ).run(now, now, link.item_id, personaId);
      if (changed.changes > 0) revokedItems.push({ kind: link.item_kind, id: link.item_id });
    }
    return { sourceRevoked: true, revokedItems };
  })();
}

// ------- Memory -------
export type MemoryRow = {
  id: string;
  personaId: string;
  content: string;
  createdAt: string;
};

export function insertMemory(m: {
  id: string;
  personaId: string;
  content: string;
  embedding: Float32Array;
}) {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const buf = Buffer.from(m.embedding.buffer, m.embedding.byteOffset, m.embedding.byteLength);
  db.prepare(
    `INSERT INTO memories (id, persona_id, content, embedding, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(m.id, m.personaId, m.content, buf, createdAt);
}

export function listMemories(personaId: string): MemoryRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, persona_id, content, created_at FROM memories WHERE persona_id = ? ORDER BY created_at`)
    .all(personaId) as any[];
  return rows.map((r) => ({
    id: r.id,
    personaId: r.persona_id,
    content: r.content,
    createdAt: r.created_at,
  }));
}

export function deleteMemory(id: string) {
  const db = getDb();
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
}

/** 根据 id 获取单条记忆（用于删除前校验归属） */
export function getMemoryById(id: string): { id: string; personaId: string; content: string } | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT id, persona_id, content FROM memories WHERE id = ?`)
    .get(id) as any;
  if (!row) return null;
  return { id: row.id, personaId: row.persona_id, content: row.content };
}

export function loadMemoriesWithEmbeddings(
  personaId: string,
): { id: string; content: string; embedding: Float32Array }[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, content, embedding FROM relationship_memories
       WHERE persona_id = ? AND status = 'confirmed' AND embedding IS NOT NULL`,
    )
    .all(personaId) as any[];
  return rows
    .filter((r) => r.embedding)
    .map((r) => ({
      id: r.id,
      content: r.content,
      embedding: bufToFloat32(r.embedding as Buffer),
    }));
}

function bufToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ------- Messages -------
export type Message = {
  id: string;
  personaId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export function insertMessage(m: Omit<Message, "createdAt">): Message {
  const db = getDb();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO messages (id, persona_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(m.id, m.personaId, m.role, m.content, createdAt);
  return { ...m, createdAt };
}

export function listMessages(personaId: string, limit = 50): Message[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(personaId, limit) as any[];
  return rows
    .map((r) => ({
      id: r.id,
      personaId: r.persona_id,
      role: r.role as "user" | "assistant",
      content: r.content,
      createdAt: r.created_at,
    }))
    .reverse();
}

// ------- Voice Authorization -------
function rowToVoiceAuthorization(row: any): VoiceAuthorization {
  return {
    id: row.id,
    voiceId: row.voice_id,
    userId: row.user_id,
    speakerStatus: row.speaker_status,
    basis: row.basis,
    status: row.status,
    reasonCode: row.reason_code,
    noticeVersion: row.notice_version,
    separateConsentConfirmed: Boolean(row.separate_consent_confirmed),
    thirdPartyProcessingConfirmed: Boolean(row.third_party_processing_confirmed),
    syntheticDisclosureConfirmed: Boolean(row.synthetic_disclosure_confirmed),
    attestedAt: row.attested_at,
    reviewedAt: row.reviewed_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export function replaceVoiceAuthorization(
  input: CreateVoiceAuthorizationInput,
): VoiceAuthorization {
  const database = getDb();
  return database.transaction(() => {
    const now = new Date().toISOString();
    database.prepare(
      `UPDATE voice_authorizations
       SET status = 'revoked', revoked_at = ?
       WHERE voice_id = ? AND user_id = ?
         AND status IN ('pending_review','approved')`,
    ).run(now, input.voiceId, input.userId);
    database.prepare(
      `INSERT INTO voice_authorizations
         (id, voice_id, user_id, speaker_status, basis, status, reason_code,
          notice_version, separate_consent_confirmed, third_party_processing_confirmed,
          synthetic_disclosure_confirmed, attested_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.voiceId,
      input.userId,
      input.speakerStatus,
      input.basis,
      input.status,
      input.reasonCode,
      input.noticeVersion,
      Number(input.separateConsentConfirmed),
      Number(input.thirdPartyProcessingConfirmed),
      Number(input.syntheticDisclosureConfirmed),
      input.attestedAt,
      now,
    );
    return getCurrentVoiceAuthorization(input.voiceId, input.userId)!;
  })();
}

export function getCurrentVoiceAuthorization(
  voiceId: string,
  userId: string,
): VoiceAuthorization | null {
  const row = getDb().prepare(
    `SELECT * FROM voice_authorizations
     WHERE voice_id = ? AND user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).get(voiceId, userId) as any;
  return row ? rowToVoiceAuthorization(row) : null;
}

export function revokeVoiceAuthorization(
  voiceId: string,
  userId: string,
): VoiceAuthorization | null {
  const database = getDb();
  const current = getCurrentVoiceAuthorization(voiceId, userId);
  if (!current) return null;
  if (current.status !== "revoked") {
    database.prepare(
      `UPDATE voice_authorizations
       SET status = 'revoked', revoked_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(new Date().toISOString(), current.id, userId);
  }
  return getCurrentVoiceAuthorization(voiceId, userId);
}
