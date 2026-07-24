import { runtimeBindings, type D1Database } from "@/lib/cloudflare";

let schemaReady: Promise<void> | null = null;

async function db(): Promise<D1Database> {
  const database = runtimeBindings().DB;
  if (!schemaReady) {
    schemaReady = database.batch([
      database.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, phone TEXT UNIQUE, password TEXT, created_at TEXT NOT NULL)"),
      database.prepare("CREATE TABLE IF NOT EXISTS verification_codes (id TEXT PRIMARY KEY, email TEXT, phone TEXT, code TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)"),
      database.prepare("CREATE INDEX IF NOT EXISTS idx_vcodes_email ON verification_codes(email, used)"),
      database.prepare("CREATE INDEX IF NOT EXISTS idx_vcodes_phone ON verification_codes(phone, used)"),
      database.prepare("CREATE TABLE IF NOT EXISTS voices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, prompt_text TEXT NOT NULL, object_key TEXT NOT NULL, mime_type TEXT NOT NULL, duration_sec REAL, created_at TEXT NOT NULL)"),
      database.prepare("CREATE INDEX IF NOT EXISTS idx_voices_user ON voices(user_id, created_at)"),
      database.prepare("CREATE TABLE IF NOT EXISTS personas (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, relation TEXT NOT NULL, voice_id TEXT NOT NULL, persona_desc TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"),
      database.prepare("CREATE INDEX IF NOT EXISTS idx_personas_user ON personas(user_id, created_at)"),
      database.prepare("CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE, content TEXT NOT NULL, embedding BLOB, created_at TEXT NOT NULL)"),
      database.prepare("CREATE INDEX IF NOT EXISTS idx_memories_persona ON memories(persona_id)"),
      database.prepare("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL)"),
      database.prepare("CREATE INDEX IF NOT EXISTS idx_messages_persona ON messages(persona_id, created_at)"),
      database.prepare("CREATE TABLE IF NOT EXISTS tts_usage (user_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)"),
    ]).then(() => undefined);
  }
  try {
    await schemaReady;
  } catch (error) {
    schemaReady = null;
    throw error;
  }
  return database;
}

export async function getDatabase(): Promise<D1Database> {
  return db();
}

type UserRow = { id: string; email: string | null; phone: string | null; password: string | null; created_at: string };
export type User = { id: string; email: string; phone: string; password: string; createdAt: string };
const user = (row: UserRow): User => ({ id: row.id, email: row.email || "", phone: row.phone || "", password: row.password || "", createdAt: row.created_at });

export async function getUserByEmail(email: string): Promise<User | null> { const row = await (await db()).prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>(); return row ? user(row) : null; }
export async function getUserByPhone(phone: string): Promise<User | null> { const row = await (await db()).prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<UserRow>(); return row ? user(row) : null; }
export async function createUserByEmail(email: string, passwordHash?: string): Promise<User> { const id = crypto.randomUUID(); const createdAt = new Date().toISOString(); await (await db()).prepare("INSERT INTO users (id, email, password, created_at) VALUES (?, ?, ?, ?)").bind(id, email, passwordHash || null, createdAt).run(); return { id, email, phone: "", password: passwordHash || "", createdAt }; }
export async function createUserByPhone(phone: string): Promise<User> { const id = crypto.randomUUID(); const createdAt = new Date().toISOString(); await (await db()).prepare("INSERT INTO users (id, phone, created_at) VALUES (?, ?, ?)").bind(id, phone, createdAt).run(); return { id, email: "", phone, password: "", createdAt }; }
export async function setUserPassword(email: string, hash: string) { await (await db()).prepare("UPDATE users SET password = ? WHERE email = ?").bind(hash, email).run(); }
export async function createVerificationCode(target: { email?: string; phone?: string }, code: string, ttlMinutes = 5) { await (await db()).prepare("INSERT INTO verification_codes (id, email, phone, code, expires_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), target.email || null, target.phone || null, code, new Date(Date.now() + ttlMinutes * 60_000).toISOString()).run(); }
export async function verifyCode(target: { email?: string; phone?: string }, code: string): Promise<boolean> { const database = await db(); const column = target.email ? "email" : "phone"; const value = target.email || target.phone; const row = await database.prepare(`SELECT id FROM verification_codes WHERE ${column} = ? AND code = ? AND used = 0 AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`).bind(value, code, new Date().toISOString()).first<{ id: string }>(); if (!row) return false; await database.prepare("UPDATE verification_codes SET used = 1 WHERE id = ?").bind(row.id).run(); return true; }

export type Persona = { id: string; userId: string; name: string; relation: string; voiceId: string; personaDesc: string; createdAt: string };
type PersonaRow = { id: string; user_id: string; name: string; relation: string; voice_id: string; persona_desc: string; created_at: string };
const persona = (row: PersonaRow): Persona => ({ id: row.id, userId: row.user_id, name: row.name, relation: row.relation, voiceId: row.voice_id, personaDesc: row.persona_desc, createdAt: row.created_at });
export async function createPersona(input: Omit<Persona, "createdAt">): Promise<Persona> { const createdAt = new Date().toISOString(); await (await db()).prepare("INSERT INTO personas (id, user_id, name, relation, voice_id, persona_desc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(input.id, input.userId, input.name, input.relation, input.voiceId, input.personaDesc, createdAt).run(); return { ...input, createdAt }; }
export async function listPersonas(userId: string): Promise<Persona[]> { const { results } = await (await db()).prepare("SELECT * FROM personas WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all<PersonaRow>(); return results.map(persona); }
export async function getPersonaForUser(id: string, userId: string): Promise<Persona | null> { const row = await (await db()).prepare("SELECT * FROM personas WHERE id = ? AND user_id = ?").bind(id, userId).first<PersonaRow>(); return row ? persona(row) : null; }
export async function deletePersona(id: string) { await (await db()).prepare("DELETE FROM personas WHERE id = ?").bind(id).run(); }
export async function countPersonasUsingVoice(voiceId: string, userId: string): Promise<number> { const row = await (await db()).prepare("SELECT COUNT(*) AS count FROM personas WHERE voice_id = ? AND user_id = ?").bind(voiceId, userId).first<{ count: number }>(); return row?.count || 0; }

export type MemoryRow = { id: string; personaId: string; content: string; createdAt: string };
export async function insertMemory(input: { id: string; personaId: string; content: string; embedding: Float32Array }) { const bytes = new Uint8Array(input.embedding.buffer.slice(input.embedding.byteOffset, input.embedding.byteOffset + input.embedding.byteLength)); await (await db()).prepare("INSERT INTO memories (id, persona_id, content, embedding, created_at) VALUES (?, ?, ?, ?, ?)").bind(input.id, input.personaId, input.content, bytes, new Date().toISOString()).run(); }
export async function listMemories(personaId: string): Promise<MemoryRow[]> { const { results } = await (await db()).prepare("SELECT id, persona_id, content, created_at FROM memories WHERE persona_id = ? ORDER BY created_at").bind(personaId).all<{ id: string; persona_id: string; content: string; created_at: string }>(); return results.map((row) => ({ id: row.id, personaId: row.persona_id, content: row.content, createdAt: row.created_at })); }
export async function deleteMemory(id: string) { await (await db()).prepare("DELETE FROM memories WHERE id = ?").bind(id).run(); }
export async function getMemoryById(id: string): Promise<{ id: string; personaId: string; content: string } | null> { const row = await (await db()).prepare("SELECT id, persona_id, content FROM memories WHERE id = ?").bind(id).first<{ id: string; persona_id: string; content: string }>(); return row ? { id: row.id, personaId: row.persona_id, content: row.content } : null; }
export async function loadMemoriesWithEmbeddings(personaId: string): Promise<{ id: string; content: string; embedding: Float32Array }[]> { const { results } = await (await db()).prepare("SELECT id, content, embedding FROM memories WHERE persona_id = ?").bind(personaId).all<{ id: string; content: string; embedding: ArrayBuffer | null }>(); return results.filter((row) => row.embedding).map((row) => ({ id: row.id, content: row.content, embedding: new Float32Array(row.embedding!) })); }

export type Message = { id: string; personaId: string; role: "user" | "assistant"; content: string; createdAt: string };
export async function insertMessage(input: Omit<Message, "createdAt">): Promise<Message> { const createdAt = new Date().toISOString(); await (await db()).prepare("INSERT INTO messages (id, persona_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").bind(input.id, input.personaId, input.role, input.content, createdAt).run(); return { ...input, createdAt }; }
export async function listMessages(personaId: string, limit = 50): Promise<Message[]> { const { results } = await (await db()).prepare("SELECT * FROM messages WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?").bind(personaId, limit).all<{ id: string; persona_id: string; role: "user" | "assistant"; content: string; created_at: string }>(); return results.map((row) => ({ id: row.id, personaId: row.persona_id, role: row.role, content: row.content, createdAt: row.created_at })).reverse(); }

export async function checkTtsUsage(userId: string, limit: number): Promise<{ allowed: boolean; remaining: number; resetAt: number }> { const database = await db(); const now = Date.now(); const row = await database.prepare("SELECT window_start, count FROM tts_usage WHERE user_id = ?").bind(userId).first<{ window_start: number; count: number }>(); const windowStart = !row || now - row.window_start >= 86_400_000 ? now : row.window_start; const count = !row || windowStart === now ? 0 : row.count; if (count >= limit) return { allowed: false, remaining: 0, resetAt: windowStart + 86_400_000 }; const next = count + 1; await database.prepare("INSERT INTO tts_usage (user_id, window_start, count) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET window_start = excluded.window_start, count = excluded.count").bind(userId, windowStart, next).run(); return { allowed: true, remaining: limit - next, resetAt: windowStart + 86_400_000 }; }
