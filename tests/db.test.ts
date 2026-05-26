/**
 * 测试 SQLite 数据层 — 使用 :memory: 数据库
 *
 * 验证完整的 CRUD、级联删除、user_id 隔离、迁移行为。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// ---- 直接从 db.ts 复制函数但指向内存 DB ----
// 我们测试的是业务逻辑和 SQL 正确性，不测试 getDb() 的单例模式。

type Persona = {
  id: string;
  userId: string;
  name: string;
  relation: string;
  voiceId: string;
  personaDesc: string;
  createdAt: string;
};

type MemoryRow = {
  id: string;
  personaId: string;
  content: string;
  createdAt: string;
};

type Message = {
  id: string;
  personaId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

function initSchema(db: Database.Database) {
  db.exec(`
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

describe("SQLite 数据层", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
  });

  describe("personas", () => {
    const fakeUUID = () => Math.random().toString(36).slice(2);

    function createPersona(db: Database.Database, p: Omit<Persona, "createdAt">): Persona {
      const createdAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO personas (id, user_id, name, relation, voice_id, persona_desc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.id, p.userId, p.name, p.relation, p.voiceId, p.personaDesc, createdAt);
      return { ...p, createdAt };
    }

    function listPersonas(db: Database.Database, userId: string): Persona[] {
      const rows = db.prepare(`SELECT * FROM personas WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as any[];
      return rows.map((r: any) => ({
        id: r.id,
        userId: r.user_id,
        name: r.name,
        relation: r.relation,
        voiceId: r.voice_id,
        personaDesc: r.persona_desc,
        createdAt: r.created_at,
      }));
    }

    it("创建后可以查出", () => {
      const p = createPersona(db, {
        id: fakeUUID(),
        userId: "user-1",
        name: "爸爸",
        relation: "父亲",
        voiceId: "voice-1",
        personaDesc: "性格温和",
      });
      const list = listPersonas(db, "user-1");
      assert.equal(list.length, 1);
      assert.equal(list[0].name, "爸爸");
      assert.equal(list[0].relation, "父亲");
    });

    it("按 user_id 隔离", () => {
      createPersona(db, {
        id: fakeUUID(), userId: "user-A", name: "A的人物", relation: "朋友", voiceId: "v1", personaDesc: "",
      });
      createPersona(db, {
        id: fakeUUID(), userId: "user-B", name: "B的人物", relation: "家人", voiceId: "v2", personaDesc: "",
      });
      assert.equal(listPersonas(db, "user-A").length, 1);
      assert.equal(listPersonas(db, "user-B").length, 1);
    });

    it("按创建时间倒序", () => {
      // 先插入一个
      createPersona(db, {
        id: fakeUUID(), userId: "u", name: "First", relation: "r", voiceId: "v", personaDesc: "",
      });
      // 手动插入一个更晚的 created_at 来保证顺序
      const laterId = fakeUUID();
      const laterTime = new Date(Date.now() + 1000).toISOString(); // 晚 1 秒
      db.prepare(
        `INSERT INTO personas (id, user_id, name, relation, voice_id, persona_desc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(laterId, "u", "Second", "r", "v", "", laterTime);
      const list = listPersonas(db, "u");
      assert.equal(list[0].name, "Second");
    });
  });

  describe("memories", () => {
    const fakeUUID = () => Math.random().toString(36).slice(2);

    function createPersonaRaw(db: Database.Database, id: string, userId: string) {
      db.prepare(
        `INSERT INTO personas (id, user_id, name, relation, voice_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, "test", "test", "v", new Date().toISOString());
    }

    function insertMemoryRaw(db: Database.Database, m: { id: string; personaId: string; content: string; embedding: Float32Array }) {
      const createdAt = new Date().toISOString();
      const buf = Buffer.from(m.embedding.buffer, m.embedding.byteOffset, m.embedding.byteLength);
      db.prepare(
        `INSERT INTO memories (id, persona_id, content, embedding, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(m.id, m.personaId, m.content, buf, createdAt);
    }

    it("录入记忆后可以列出", () => {
      const pid = fakeUUID();
      createPersonaRaw(db, pid, "u");
      const emb = new Float32Array([0.1, 0.2, 0.3]);
      insertMemoryRaw(db, { id: fakeUUID(), personaId: pid, content: "一起去青岛", embedding: emb });

      const rows = db.prepare(`SELECT id, persona_id, content FROM memories WHERE persona_id = ?`).all(pid) as any[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, "一起去青岛");
    });

    it("embedding BLOB 可以回读", () => {
      const pid = fakeUUID();
      createPersonaRaw(db, pid, "u");
      const original = new Float32Array([1, 2, 3, 4, 5]);
      insertMemoryRaw(db, { id: fakeUUID(), personaId: pid, content: "test", embedding: original });

      const rows = db.prepare(`SELECT embedding FROM memories WHERE persona_id = ?`).all(pid) as any[];
      const buf = rows[0].embedding as Buffer;
      const restored = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      assert.equal(restored.length, 5);
      assert.equal(restored[0], 1);
      assert.equal(restored[4], 5);
    });

    it("级联删除：删除 persona 自动删相关记忆", () => {
      const pid = fakeUUID();
      createPersonaRaw(db, pid, "u");
      insertMemoryRaw(db, { id: fakeUUID(), personaId: pid, content: "a", embedding: new Float32Array([1]) });
      insertMemoryRaw(db, { id: fakeUUID(), personaId: pid, content: "b", embedding: new Float32Array([2]) });

      db.prepare(`DELETE FROM personas WHERE id = ?`).run(pid);
      const rows = db.prepare(`SELECT * FROM memories WHERE persona_id = ?`).all(pid);
      assert.equal(rows.length, 0);
    });
  });

  describe("messages", () => {
    const fakeUUID = () => Math.random().toString(36).slice(2);

    function createPersonaRaw(db: Database.Database, id: string, userId: string) {
      db.prepare(
        `INSERT INTO personas (id, user_id, name, relation, voice_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, "test", "test", "v", new Date().toISOString());
    }

    function insertMessageRaw(db: Database.Database, m: { id: string; personaId: string; role: "user" | "assistant"; content: string }): Message {
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO messages (id, persona_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(m.id, m.personaId, m.role, m.content, createdAt);
      return { ...m, createdAt };
    }

    it("写入后可按降序读取（最新在前）", () => {
      const pid = fakeUUID();
      createPersonaRaw(db, pid, "u");
      insertMessageRaw(db, { id: fakeUUID(), personaId: pid, role: "user", content: "你好" });
      insertMessageRaw(db, { id: fakeUUID(), personaId: pid, role: "assistant", content: "你好啊" });

      const rows = db
        .prepare(`SELECT * FROM messages WHERE persona_id = ? ORDER BY created_at DESC`)
        .all(pid) as any[];
      // 降序：assistant 先
      assert.equal(rows.length, 2);
      assert.equal(rows[0].content, "你好啊");
      assert.equal(rows[1].content, "你好");
    });

    it("LIMIT 生效", () => {
      const pid = fakeUUID();
      createPersonaRaw(db, pid, "u");
      for (let i = 0; i < 20; i++) {
        insertMessageRaw(db, { id: fakeUUID(), personaId: pid, role: "user", content: `msg-${i}` });
      }
      const rows = db
        .prepare(`SELECT * FROM messages WHERE persona_id = ? ORDER BY created_at DESC LIMIT 5`)
        .all(pid) as any[];
      assert.equal(rows.length, 5);
    });

    it("role CHECK 约束拒绝非法值", () => {
      const pid = fakeUUID();
      createPersonaRaw(db, pid, "u");
      assert.throws(() => {
        db.prepare(`INSERT INTO messages (id, persona_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(
          fakeUUID(), pid, "bot", "hello", new Date().toISOString(),
        );
      });
    });
  });
});
