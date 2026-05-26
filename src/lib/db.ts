/**
 * SQLite 数据层（better-sqlite3，同步 API，跑在 Node.js runtime）
 *
 * Slice 3 变更：所有表新增 user_id 列，查询全部按 user_id 隔离。
 * 如果数据库里已有 Slice 2 的数据（没有 user_id 列），
 * 自动做 ALTER TABLE 迁移，旧数据归属到 "__legacy__" 用户。
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

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
  `);
}

/** 如果从 Slice 2 升级上来，旧表没有 user_id 列，自动加 */
function migrateUserColumn(db: Database.Database) {
  const cols = db.pragma("table_info(personas)") as { name: string }[];
  if (!cols.some((c) => c.name === "user_id")) {
    db.exec(`ALTER TABLE personas ADD COLUMN user_id TEXT NOT NULL DEFAULT '__legacy__'`);
  }
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
    .prepare(`SELECT id, content, embedding FROM memories WHERE persona_id = ?`)
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
