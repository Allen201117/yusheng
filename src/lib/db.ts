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
import { EMBEDDING_DIM } from "./embedding";
import { normalizePersonaKnowledgeText } from "./personaKnowledge";
import {
  buildPersonaKnowledgeReviewResult,
  planPersonaKnowledgeReview,
  requirePersonaKnowledgeEditsAllowed,
} from "./personaKnowledgeService";
import type {
  ConfirmedConversationKnowledge,
  ConversationEmbeddingUpdate,
  ConversationSession,
  ConversationFeedback,
  ConversationSentence,
  EvaluatorRelation,
  FeedbackEligibility,
  PlaybackEvent,
  RestorationScores,
  TtsAttempt,
  ConversationTurn,
  ConversationTurnEvidence,
  CreatePersonaKnowledgeCandidateInput,
  CreatePersonaSourceInput,
  PersonaFact,
  PersonaKnowledgeBundle,
  PersonaKnowledgeItem,
  PersonaKnowledgeKind,
  PersonaKnowledgeAtomicReviewInput,
  PersonaKnowledgeReviewResult,
  PersonaKnowledgeStatusChange,
  PersonaSource,
  RelationshipMemory,
  SpeechStyleItem,
  CreateVoiceAuthorizationInput,
  VoiceAuthorization,
  InsertMemoryInput,
  GroundingEvidenceKind,
  MessageEvidence,
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
  migratePersonaFactEmbedding(_db);
  migrateRestorationFeedbackSchema(_db);
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
      embedding         BLOB,
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

    CREATE TABLE IF NOT EXISTS conversation_turns (
      id                   TEXT PRIMARY KEY,
      persona_id           TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      user_message_id      TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      mode                 TEXT CHECK (mode IN ('grounded','companionship','boundary')),
      status               TEXT NOT NULL CHECK (status IN ('started','completed','generation_failed','assistant_persistence_failed')),
      boundary_kind        TEXT CHECK (boundary_kind IN ('self_harm','real_world_danger','voice_authorization_denied','identity','real_will','commitment','major_decision')),
      degradation_reason   TEXT CHECK (degradation_reason IN ('no_relevant_evidence','retrieval_failed','embedding_backfill_partial','model_failed','assistant_persistence_failed')),
      retrieval_ms         INTEGER CHECK (retrieval_ms IS NULL OR retrieval_ms >= 0),
      first_sentence_ms    INTEGER CHECK (first_sentence_ms IS NULL OR first_sentence_ms >= 0),
      total_ms             INTEGER CHECK (total_ms IS NULL OR total_ms >= 0),
      created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (status = 'started' AND assistant_message_id IS NULL AND mode IS NULL AND boundary_kind IS NULL)
        OR (status = 'completed' AND assistant_message_id IS NOT NULL AND mode IS NOT NULL AND total_ms IS NOT NULL)
        OR (status IN ('generation_failed','assistant_persistence_failed') AND assistant_message_id IS NULL)
      ),
      CHECK (
        status <> 'completed'
        OR (mode = 'boundary' AND boundary_kind IS NOT NULL)
        OR (mode IN ('grounded','companionship') AND boundary_kind IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS conversation_turn_evidence (
      turn_id    TEXT NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
      persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      item_kind  TEXT NOT NULL CHECK (item_kind IN ('fact','relationship_memory')),
      item_id    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (turn_id, item_kind, item_id)
    );

    CREATE TABLE IF NOT EXISTS message_evidence (
      assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      persona_id            TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      item_kind             TEXT NOT NULL CHECK (item_kind IN ('fact','relationship_memory')),
      item_id               TEXT NOT NULL,
      created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (assistant_message_id, item_kind, item_id)
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
    CREATE INDEX IF NOT EXISTS idx_conversation_turns_persona_created
      ON conversation_turns(persona_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversation_turn_evidence_persona_turn
      ON conversation_turn_evidence(persona_id, turn_id);
    CREATE INDEX IF NOT EXISTS idx_message_evidence_persona_message
      ON message_evidence(persona_id, assistant_message_id);
  `);
}

/** 如果从 Slice 2 升级上来，旧表没有 user_id 列，自动加 */
function migrateUserColumn(db: Database.Database) {
  const cols = db.pragma("table_info(personas)") as { name: string }[];
  if (!cols.some((c) => c.name === "user_id")) {
    db.exec(`ALTER TABLE personas ADD COLUMN user_id TEXT NOT NULL DEFAULT '__legacy__'`);
  }
}

function migratePersonaFactEmbedding(db: Database.Database) {
  const columns = db.pragma("table_info(persona_facts)") as { name: string }[];
  if (!columns.some((column) => column.name === "embedding")) {
    db.exec("ALTER TABLE persona_facts ADD COLUMN embedding BLOB");
  }
}

/** Add the restoration-feedback schema without rewriting legacy conversation turns. */
export function migrateRestorationFeedbackSchema(db: Database.Database) {
  db.transaction(() => {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_restoration_owner_voice
        ON personas(id, user_id, voice_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_authorizations_restoration_owner_voice
        ON voice_authorizations(id, voice_id, user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_authorizations_restoration_owner_voice_status
        ON voice_authorizations(id, voice_id, user_id, speaker_status);

      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id                     TEXT PRIMARY KEY,
        persona_id             TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        evaluator_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        voice_id               TEXT NOT NULL,
        voice_authorization_id TEXT NOT NULL REFERENCES voice_authorizations(id),
        cohort                 TEXT NOT NULL CHECK (cohort IN ('living','deceased')),
        status                 TEXT NOT NULL CHECK (status IN ('active','rated','expired')),
        started_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_activity_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        rated_at               TEXT,
        FOREIGN KEY (persona_id, evaluator_user_id, voice_id)
          REFERENCES personas(id, user_id, voice_id) ON DELETE CASCADE,
        FOREIGN KEY (voice_authorization_id, voice_id, evaluator_user_id, cohort)
          REFERENCES voice_authorizations(id, voice_id, user_id, speaker_status) ON DELETE RESTRICT
      );

      CREATE TRIGGER IF NOT EXISTS trg_conversation_sessions_authorization_cohort_insert
      BEFORE INSERT ON conversation_sessions
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM voice_authorizations authorization
        WHERE authorization.id = NEW.voice_authorization_id
          AND authorization.voice_id = NEW.voice_id
          AND authorization.user_id = NEW.evaluator_user_id
          AND authorization.speaker_status = NEW.cohort
      )
      BEGIN
        SELECT RAISE(ABORT, 'conversation_session_authorization_mismatch');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_conversation_sessions_authorization_cohort_update
      BEFORE UPDATE OF voice_authorization_id, voice_id, evaluator_user_id, cohort
      ON conversation_sessions
      FOR EACH ROW
      WHEN NOT EXISTS (
        SELECT 1
        FROM voice_authorizations authorization
        WHERE authorization.id = NEW.voice_authorization_id
          AND authorization.voice_id = NEW.voice_id
          AND authorization.user_id = NEW.evaluator_user_id
          AND authorization.speaker_status = NEW.cohort
      )
      BEGIN
        SELECT RAISE(ABORT, 'conversation_session_authorization_mismatch');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_voice_authorizations_session_cohort_update
      BEFORE UPDATE OF id, voice_id, user_id, speaker_status
      ON voice_authorizations
      FOR EACH ROW
      WHEN EXISTS (
        SELECT 1
        FROM conversation_sessions sessions
        WHERE sessions.voice_authorization_id = OLD.id
          AND (
            sessions.voice_authorization_id <> NEW.id
            OR sessions.voice_id <> NEW.voice_id
            OR sessions.evaluator_user_id <> NEW.user_id
            OR sessions.cohort <> NEW.speaker_status
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'conversation_session_authorization_mismatch');
      END;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sessions_one_active
        ON conversation_sessions(persona_id, evaluator_user_id) WHERE status = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sessions_id_persona
        ON conversation_sessions(id, persona_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sessions_id_persona_voice
        ON conversation_sessions(id, persona_id, voice_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sessions_id_persona_evaluator
        ON conversation_sessions(id, persona_id, evaluator_user_id);
      CREATE INDEX IF NOT EXISTS idx_conversation_sessions_evaluator_activity
        ON conversation_sessions(evaluator_user_id, last_activity_at DESC);
    `);

    const mismatchedSession = db.prepare(
      `SELECT sessions.id
       FROM conversation_sessions sessions
       LEFT JOIN voice_authorizations authorization
         ON authorization.id = sessions.voice_authorization_id
        AND authorization.voice_id = sessions.voice_id
        AND authorization.user_id = sessions.evaluator_user_id
        AND authorization.speaker_status = sessions.cohort
       WHERE authorization.id IS NULL
       LIMIT 1`,
    ).get();
    if (mismatchedSession) {
      throw new Error("conversation_session_authorization_mismatch");
    }

    const turnColumns = db.pragma("table_info(conversation_turns)") as { name: string }[];
    if (!turnColumns.some((column) => column.name === "session_id")) {
      db.exec(
        "ALTER TABLE conversation_turns ADD COLUMN session_id TEXT REFERENCES conversation_sessions(id) ON DELETE SET NULL",
      );
    }
    if (!turnColumns.some((column) => column.name === "speech_tracking_failed")) {
      db.exec(
        "ALTER TABLE conversation_turns ADD COLUMN speech_tracking_failed INTEGER NOT NULL DEFAULT 0 CHECK (speech_tracking_failed IN (0,1))",
      );
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turns_session_consistency
        ON conversation_turns(id, persona_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_created
        ON conversation_turns(session_id, created_at) WHERE session_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS conversation_sentences (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        turn_id         TEXT NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
        persona_id      TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        sentence_index  INTEGER NOT NULL CHECK (typeof(sentence_index) = 'integer' AND sentence_index >= 0),
        text            TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
        emotion         TEXT NOT NULL CHECK (emotion IN ('calm','warm','happy','sad','concerned','nostalgic')),
        intensity       INTEGER NOT NULL CHECK (typeof(intensity) = 'integer' AND intensity BETWEEN 0 AND 100),
        speed           REAL NOT NULL CHECK (speed BETWEEN 0.75 AND 1.15),
        pause_after_ms  INTEGER NOT NULL CHECK (typeof(pause_after_ms) = 'integer' AND pause_after_ms BETWEEN 0 AND 300000),
        planner_version TEXT NOT NULL CHECK (length(planner_version) BETWEEN 1 AND 100),
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (turn_id, sentence_index),
        UNIQUE (id, session_id, turn_id, persona_id),
        FOREIGN KEY (session_id, persona_id)
          REFERENCES conversation_sessions(id, persona_id) ON DELETE CASCADE,
        FOREIGN KEY (turn_id, persona_id, session_id)
          REFERENCES conversation_turns(id, persona_id, session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_sentences_session_turn
        ON conversation_sentences(session_id, turn_id, sentence_index);

      CREATE TABLE IF NOT EXISTS tts_attempts (
        id                 TEXT PRIMARY KEY,
        sentence_id        TEXT NOT NULL REFERENCES conversation_sentences(id) ON DELETE CASCADE,
        session_id         TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        turn_id            TEXT NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
        persona_id         TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        voice_id           TEXT NOT NULL,
        attempt_no         INTEGER NOT NULL CHECK (typeof(attempt_no) = 'integer' AND attempt_no >= 1),
        status             TEXT NOT NULL CHECK (status IN ('started','completed','failed')),
        voice_source       TEXT CHECK (voice_source IS NULL OR voice_source IN ('preset','dynamic')),
        provider_voice_id  TEXT,
        tts_model          TEXT NOT NULL CHECK (length(tts_model) BETWEEN 1 AND 100),
        tts_config_version TEXT NOT NULL CHECK (length(tts_config_version) BETWEEN 1 AND 100),
        fell_back          INTEGER NOT NULL DEFAULT 0 CHECK (fell_back IN (0,1)),
        storage_ms         INTEGER CHECK (storage_ms IS NULL OR (typeof(storage_ms) = 'integer' AND storage_ms >= 0)),
        provider_ms        INTEGER CHECK (provider_ms IS NULL OR (typeof(provider_ms) = 'integer' AND provider_ms >= 0)),
        total_ms           INTEGER CHECK (total_ms IS NULL OR (typeof(total_ms) = 'integer' AND total_ms >= 0)),
        stable_error_code  TEXT CHECK (stable_error_code IS NULL OR length(stable_error_code) <= 100),
        created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at       TEXT,
        UNIQUE (sentence_id, attempt_no),
        FOREIGN KEY (sentence_id, session_id, turn_id, persona_id)
          REFERENCES conversation_sentences(id, session_id, turn_id, persona_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id, persona_id, voice_id)
          REFERENCES conversation_sessions(id, persona_id, voice_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tts_attempts_session_turn
        ON tts_attempts(session_id, turn_id, created_at);

      CREATE TABLE IF NOT EXISTS playback_events (
        event_id          TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 100),
        tts_attempt_id    TEXT NOT NULL REFERENCES tts_attempts(id) ON DELETE CASCADE,
        event_type        TEXT NOT NULL CHECK (event_type IN ('audio_ready','play_started','play_completed','play_failed')),
        client_elapsed_ms INTEGER NOT NULL CHECK (typeof(client_elapsed_ms) = 'integer' AND client_elapsed_ms BETWEEN 0 AND 300000),
        received_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_playback_events_attempt_received
        ON playback_events(tts_attempt_id, received_at);

      CREATE TABLE IF NOT EXISTS conversation_feedback (
        id                          TEXT PRIMARY KEY,
        session_id                  TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        persona_id                  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        evaluator_user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        evaluator_relation          TEXT NOT NULL CHECK (evaluator_relation IN ('self','family','friend','other')),
        knows_voice_owner           INTEGER NOT NULL CHECK (knows_voice_owner = 1),
        heard_all_rounds            INTEGER NOT NULL CHECK (heard_all_rounds = 1),
        voice_similarity            INTEGER NOT NULL CHECK (typeof(voice_similarity) = 'integer' AND voice_similarity BETWEEN 1 AND 5),
        expression_similarity       INTEGER NOT NULL CHECK (typeof(expression_similarity) = 'integer' AND expression_similarity BETWEEN 1 AND 5),
        emotion_fit                 INTEGER NOT NULL CHECK (typeof(emotion_fit) = 'integer' AND emotion_fit BETWEEN 1 AND 5),
        fact_trust                  INTEGER NOT NULL CHECK (typeof(fact_trust) = 'integer' AND fact_trust BETWEEN 1 AND 5),
        discomfort                  INTEGER NOT NULL CHECK (typeof(discomfort) = 'integer' AND discomfort BETWEEN 1 AND 5),
        major_fabrication           INTEGER NOT NULL CHECK (major_fabrication IN (0,1)),
        identity_impersonation      INTEGER NOT NULL CHECK (identity_impersonation IN (0,1)),
        authorization_violation     INTEGER NOT NULL CHECK (authorization_violation IN (0,1)),
        comment                     TEXT,
        created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, evaluator_user_id),
        CHECK (comment IS NULL OR length(comment) <= 1000),
        FOREIGN KEY (session_id, persona_id, evaluator_user_id)
          REFERENCES conversation_sessions(id, persona_id, evaluator_user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_feedback_created
        ON conversation_feedback(created_at DESC);
    `);

    db.exec(`
      DELETE FROM playback_events
      WHERE event_id IN (
        SELECT event_id
        FROM (
          SELECT event_id,
                 row_number() OVER (
                   PARTITION BY tts_attempt_id, event_type
                   ORDER BY received_at, event_id
                 ) AS duplicate_rank
          FROM playback_events
        ) ranked
        WHERE duplicate_rank > 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_events_one_type_per_attempt
        ON playback_events(tts_attempt_id, event_type);
    `);
  })();
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

const EVIDENCE_TABLES = {
  fact: "persona_facts",
  relationship_memory: "relationship_memories",
} as const;

const EVIDENCE_KIND_ORDER: Record<GroundingEvidenceKind, number> = {
  fact: 0,
  relationship_memory: 1,
};

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeEvidenceLocks<T extends { kind: GroundingEvidenceKind }>(
  items: T[],
  getId: (item: T) => string,
): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const key = `${EVIDENCE_KIND_ORDER[item.kind]}\0${getId(item)}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return Array.from(unique.values()).sort((left, right) =>
    EVIDENCE_KIND_ORDER[left.kind] - EVIDENCE_KIND_ORDER[right.kind]
    || compareAscii(getId(left), getId(right)));
}

function float32ToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

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

function getPersonaKnowledgeItemWithDb(
  database: Database.Database,
  kind: PersonaKnowledgeKind,
  id: string,
  personaId: string,
): PersonaKnowledgeItem | null {
  const table = KNOWLEDGE_TABLES[kind];
  const row = database.prepare(`SELECT * FROM ${table} WHERE id = ? AND persona_id = ?`).get(
    id,
    personaId,
  ) as any;
  return row ? rowToPersonaKnowledgeItem(kind, row) : null;
}

export function getPersonaKnowledgeItem(
  kind: PersonaKnowledgeKind,
  id: string,
  personaId: string,
): PersonaKnowledgeItem | null {
  return getPersonaKnowledgeItemWithDb(getDb(), kind, id, personaId);
}

function findConfirmedFactsWithDb(
  database: Database.Database,
  personaId: string,
  factType: string,
  factKey: string,
): PersonaFact[] {
  const normalizedFactType = normalizePersonaKnowledgeText(factType);
  const normalizedFactKey = normalizePersonaKnowledgeText(factKey);
  return (database.prepare(
    `SELECT * FROM persona_facts
     WHERE persona_id = ? AND status = 'confirmed'
     ORDER BY created_at, id`,
  ).all(personaId) as any[])
    .map(rowToPersonaFact)
    .filter((fact) =>
      normalizePersonaKnowledgeText(fact.factType) === normalizedFactType
      && normalizePersonaKnowledgeText(fact.factKey) === normalizedFactKey);
}

export function findConfirmedFacts(
  personaId: string,
  factType: string,
  factKey: string,
): PersonaFact[] {
  return findConfirmedFactsWithDb(getDb(), personaId, factType, factKey);
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
        const embedding = candidate.embedding ? float32ToBuffer(candidate.embedding) : null;
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

function updatePersonaKnowledgeCandidateWithDb(
  database: Database.Database,
  input: {
    kind: PersonaKnowledgeKind;
    id: string;
    personaId: string;
    expectedStatus: "pending" | "conflicted";
    patch: Record<string, string | string[] | null>;
  },
): PersonaKnowledgeItem | null {
  const allowed = EDITABLE_COLUMNS[input.kind] as Record<string, string>;
  const entries = Object.entries(input.patch).filter(([key]) => allowed[key]);
  if (entries.length === 0) {
    const table = KNOWLEDGE_TABLES[input.kind];
    const row = database.prepare(
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
  const result = database.prepare(
    `UPDATE ${table}
     SET ${assignments}, status = 'pending', conflict_group_id = NULL,
         confirmed_by = NULL, confirmed_at = NULL, revoked_at = NULL, updated_at = ?
     WHERE id = ? AND persona_id = ? AND status = ?`,
  ).run(...values, now, input.id, input.personaId, input.expectedStatus);
  if (result.changes === 0) return null;
  return getPersonaKnowledgeItemWithDb(database, input.kind, input.id, input.personaId);
}

export function updatePersonaKnowledgeCandidate(input: {
  kind: PersonaKnowledgeKind;
  id: string;
  personaId: string;
  expectedStatus: "pending" | "conflicted";
  patch: Record<string, string | string[] | null>;
}): PersonaKnowledgeItem | null {
  return updatePersonaKnowledgeCandidateWithDb(getDb(), input);
}

function setPersonaKnowledgeStatusesWithDb(
  database: Database.Database,
  inputs: PersonaKnowledgeStatusChange[],
): PersonaKnowledgeItem[] {
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
    const item = getPersonaKnowledgeItemWithDb(database, input.kind, input.id, input.personaId);
    if (!item) throw new Error("invalid_knowledge_review_result");
    changed.push(item);
  }
  return changed;
}

export function setPersonaKnowledgeStatuses(
  inputs: PersonaKnowledgeStatusChange[],
): PersonaKnowledgeItem[] {
  const database = getDb();
  return database.transaction(() => setPersonaKnowledgeStatusesWithDb(database, inputs))();
}

function storeKnowledgeEmbeddingWithDb(
  database: Database.Database,
  kind: keyof typeof EVIDENCE_TABLES,
  id: string,
  personaId: string,
  vector: Float32Array,
): void {
  const table = EVIDENCE_TABLES[kind];
  const result = database.prepare(
    `UPDATE ${table} SET embedding = ? WHERE id = ? AND persona_id = ?`,
  ).run(float32ToBuffer(vector), id, personaId);
  if (result.changes !== 1) throw new Error("knowledge_embedding_stale");
}

export function reviewPersonaKnowledgeAtomically(
  input: PersonaKnowledgeAtomicReviewInput,
): PersonaKnowledgeReviewResult {
  const database = getDb();
  const review = database.transaction(() => {
    let item = getPersonaKnowledgeItemWithDb(database, input.kind, input.id, input.personaId);
    if (!item) throw new Error("knowledge_not_found");

    if (input.edits !== undefined) {
      requirePersonaKnowledgeEditsAllowed(item, input.action);
      const updated = updatePersonaKnowledgeCandidateWithDb(database, {
        kind: item.kind,
        id: item.id,
        personaId: item.personaId,
        expectedStatus: item.status as "pending" | "conflicted",
        patch: input.edits,
      });
      if (!updated) throw new Error("knowledge_status_changed");
      item = updated;
    }

    if (input.embedding !== undefined) {
      if (
        item.kind === "speech_style"
        || item.content !== input.embedding.content
        || input.embedding.vector.length !== EMBEDDING_DIM
      ) {
        throw new Error("knowledge_embedding_stale");
      }
      storeKnowledgeEmbeddingWithDb(
        database,
        item.kind,
        item.id,
        item.personaId,
        input.embedding.vector,
      );
    }

    const confirmedFacts = input.action === "confirm" && item.kind === "fact"
      ? findConfirmedFactsWithDb(database, item.personaId, item.factType, item.factKey)
      : [];
    const plan = planPersonaKnowledgeReview({
      item,
      confirmedFacts,
      actorUserId: input.actorUserId,
      action: input.action,
      conflictGroupId: randomUUID(),
    });
    const changed = setPersonaKnowledgeStatusesWithDb(database, plan.statusChanges);
    return buildPersonaKnowledgeReviewResult(item, plan, changed);
  });
  return review.immediate();
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
       ORDER BY links.item_kind COLLATE BINARY, links.item_id COLLATE BINARY`,
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

function insertMemoryWithDb(database: Database.Database, m: InsertMemoryInput) {
  const createdAt = new Date().toISOString();
  const buf = float32ToBuffer(m.embedding);
  const source = database.prepare(
    `INSERT INTO persona_sources
       (id, persona_id, source_type, content_text, object_path, checksum_algorithm,
        checksum, status, created_by, created_at)
     SELECT ?, ?, 'manual_text', ?, NULL, ?, ?, 'ready', ?, ?
     FROM personas
     WHERE id = ? AND user_id = ?`,
  ).run(
    m.sourceId, m.personaId, m.content, m.checksumAlgorithm, m.checksum,
    m.createdBy, createdAt, m.personaId, m.createdBy,
  );
  if (source.changes !== 1) throw new Error("persona_source_insert_failed");

  const memory = database.prepare(
    `INSERT INTO relationship_memories
       (id, persona_id, content, participants, embedding, status, confirmed_by,
        confirmed_at, created_at, updated_at)
     SELECT ?, ?, ?, '[]', ?, 'confirmed', ?, ?, ?, ?
     FROM persona_sources
     WHERE id = ? AND persona_id = ?`,
  ).run(
    m.id, m.personaId, m.content, buf, m.createdBy, createdAt, createdAt, createdAt,
    m.sourceId, m.personaId,
  );
  if (memory.changes !== 1) throw new Error("relationship_memory_insert_failed");

  const link = database.prepare(
    `INSERT INTO persona_item_sources
       (item_kind, item_id, source_id, source_excerpt, created_at)
     SELECT 'relationship_memory', memory.id, source.id, ?, ?
     FROM relationship_memories memory
     JOIN persona_sources source ON source.persona_id = memory.persona_id
     WHERE memory.id = ? AND memory.persona_id = ? AND source.id = ?`,
  ).run(m.content, createdAt, m.id, m.personaId, m.sourceId);
  if (link.changes !== 1) throw new Error("persona_source_link_failed");
}

export function insertMemory(m: InsertMemoryInput) {
  const database = getDb();
  database.transaction(() => insertMemoryWithDb(database, m))();
}

export function insertMemories(inputs: InsertMemoryInput[]) {
  const database = getDb();
  database.transaction(() => {
    for (const input of inputs) insertMemoryWithDb(database, input);
  })();
}

export function listMemories(personaId: string): MemoryRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, persona_id, content, created_at
       FROM relationship_memories
       WHERE persona_id = ? AND status = 'confirmed'
       ORDER BY created_at`,
    )
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
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE relationship_memories
     SET status = 'revoked', confirmed_by = NULL, confirmed_at = NULL,
         revoked_at = ?, updated_at = ?
     WHERE id = ? AND status = 'confirmed'`,
  ).run(now, now, id);
  return result.changes === 1;
}

/** 根据 id 获取单条记忆（用于删除前校验归属） */
export function getMemoryById(id: string): { id: string; personaId: string; content: string } | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, persona_id, content
       FROM relationship_memories
       WHERE id = ? AND status = 'confirmed'`,
    )
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

function parseConversationEmbedding(value: unknown): Float32Array | null {
  if (!Buffer.isBuffer(value) || value.byteLength !== EMBEDDING_DIM * 4) return null;
  const parsed = new Float32Array(EMBEDDING_DIM);
  for (let index = 0; index < EMBEDDING_DIM; index += 1) {
    const number = value.readFloatLE(index * 4);
    if (!Number.isFinite(number)) return null;
    parsed[index] = number;
  }
  return parsed;
}

function isValidConversationEmbedding(value: Float32Array): boolean {
  return value.length === EMBEDDING_DIM && Array.from(value).every(Number.isFinite);
}

function sqliteIso(value: string): string {
  return new Date(value.endsWith("Z") ? value : `${value}Z`).toISOString();
}

function rowToConversationTurn(row: any): ConversationTurn {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    personaId: row.persona_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    mode: row.mode,
    status: row.status,
    boundaryKind: row.boundary_kind,
    degradationReason: row.degradation_reason,
    retrievalMs: row.retrieval_ms,
    firstSentenceMs: row.first_sentence_ms,
    totalMs: row.total_ms,
    speechTrackingFailed: Boolean(row.speech_tracking_failed),
    createdAt: sqliteIso(row.created_at),
    updatedAt: sqliteIso(row.updated_at),
  };
}

function rowToConversationSession(row: any): ConversationSession {
  return {
    id: row.id,
    personaId: row.persona_id,
    evaluatorUserId: row.evaluator_user_id,
    voiceId: row.voice_id,
    voiceAuthorizationId: row.voice_authorization_id,
    cohort: row.cohort,
    status: row.status,
    startedAt: sqliteIso(row.started_at),
    lastActivityAt: sqliteIso(row.last_activity_at),
    ratedAt: row.rated_at === null ? null : sqliteIso(row.rated_at),
  };
}

export function loadConfirmedConversationKnowledge(
  personaId: string,
): ConfirmedConversationKnowledge {
  const database = getDb();
  const facts = database.prepare(
    `SELECT id, content, embedding, fact_type, fact_key
     FROM persona_facts
     WHERE persona_id = ? AND status = 'confirmed'
     ORDER BY created_at, id`,
  ).all(personaId) as any[];
  const memories = database.prepare(
    `SELECT id, content, embedding, occurred_at, location, participants
     FROM relationship_memories
     WHERE persona_id = ? AND status = 'confirmed'
     ORDER BY created_at, id`,
  ).all(personaId) as any[];
  const styles = database.prepare(
    `SELECT id, category, content, example
     FROM speech_style_items
     WHERE persona_id = ? AND status = 'confirmed'
     ORDER BY created_at, id`,
  ).all(personaId) as any[];
  return {
    evidence: [
      ...facts.map((row) => ({
        kind: "fact" as const,
        id: row.id,
        content: row.content,
        embedding: parseConversationEmbedding(row.embedding),
        factType: row.fact_type,
        factKey: row.fact_key,
      })),
      ...memories.map((row) => ({
        kind: "relationship_memory" as const,
        id: row.id,
        content: row.content,
        embedding: parseConversationEmbedding(row.embedding),
        occurredAt: row.occurred_at,
        location: row.location,
        participants: parseParticipants(row.participants),
      })),
    ],
    styles: styles.map((row) => ({
      id: row.id,
      category: row.category,
      content: row.content,
      example: row.example,
    })),
  };
}

export function storeConfirmedConversationEmbeddings(
  personaId: string,
  updates: ConversationEmbeddingUpdate[],
): void {
  if (updates.some((update) => !isValidConversationEmbedding(update.embedding))) {
    throw new Error("conversation_embedding_status_changed");
  }
  const orderedUpdates = canonicalizeEvidenceLocks(updates, (update) => update.id);
  const database = getDb();
  database.transaction(() => {
    for (const update of orderedUpdates) {
      const table = EVIDENCE_TABLES[update.kind];
      const changed = database.prepare(
        `UPDATE ${table}
         SET embedding = ?
         WHERE id = ? AND persona_id = ? AND status = 'confirmed' AND embedding IS NULL`,
      ).run(float32ToBuffer(update.embedding), update.id, personaId);
      if (changed.changes === 1) continue;
      const current = database.prepare(
        `SELECT status, embedding FROM ${table} WHERE id = ? AND persona_id = ?`,
      ).get(update.id, personaId) as { status: string; embedding: unknown } | undefined;
      if (
        current?.status !== "confirmed"
        || parseConversationEmbedding(current.embedding) === null
      ) {
        throw new Error("conversation_embedding_status_changed");
      }
    }
  })();
}

export function getOrStartConversationSession(input: {
  proposedSessionId: string;
  personaId: string;
  evaluatorUserId: string;
  voiceId: string;
  voiceAuthorizationId: string;
  cohort: "living" | "deceased";
  now: string;
  staleBefore: string;
}): ConversationSession {
  const database = getDb();
  return database.transaction(() => {
    const persona = database.prepare(
      `SELECT id FROM personas
       WHERE id = ? AND user_id = ? AND voice_id = ?`,
    ).get(input.personaId, input.evaluatorUserId, input.voiceId);
    if (!persona) throw new Error("conversation_session_owner_mismatch");

    const authorization = database.prepare(
      `SELECT id FROM voice_authorizations
       WHERE id = ? AND voice_id = ? AND user_id = ?
         AND speaker_status = ? AND status = 'approved'`,
    ).get(
      input.voiceAuthorizationId,
      input.voiceId,
      input.evaluatorUserId,
      input.cohort,
    );
    if (!authorization) throw new Error("conversation_session_authorization_denied");

    database.prepare(
      `UPDATE conversation_sessions
       SET status = 'expired'
       WHERE persona_id = ? AND evaluator_user_id = ?
         AND status = 'active'
         AND (
           last_activity_at <= ? OR voice_id <> ?
           OR voice_authorization_id <> ? OR cohort <> ?
         )`,
    ).run(
      input.personaId,
      input.evaluatorUserId,
      input.staleBefore,
      input.voiceId,
      input.voiceAuthorizationId,
      input.cohort,
    );

    const active = database.prepare(
      `SELECT * FROM conversation_sessions
       WHERE persona_id = ? AND evaluator_user_id = ?
         AND voice_id = ? AND voice_authorization_id = ? AND cohort = ?
         AND status = 'active'
       LIMIT 1`,
    ).get(
      input.personaId,
      input.evaluatorUserId,
      input.voiceId,
      input.voiceAuthorizationId,
      input.cohort,
    ) as { id: string } | undefined;
    if (active) {
      const touched = database.prepare(
        `UPDATE conversation_sessions
         SET last_activity_at = ?
         WHERE id = ? AND persona_id = ? AND evaluator_user_id = ?
           AND voice_id = ? AND voice_authorization_id = ? AND cohort = ?
           AND status = 'active'
         RETURNING *`,
      ).get(
        input.now,
        active.id,
        input.personaId,
        input.evaluatorUserId,
        input.voiceId,
        input.voiceAuthorizationId,
        input.cohort,
      );
      if (!touched) throw new Error("conversation_session_status_changed");
      return rowToConversationSession(touched);
    }

    const created = database.prepare(
      `INSERT INTO conversation_sessions
         (id, persona_id, evaluator_user_id, voice_id, voice_authorization_id,
          cohort, status, started_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
       RETURNING *`,
    ).get(
      input.proposedSessionId,
      input.personaId,
      input.evaluatorUserId,
      input.voiceId,
      input.voiceAuthorizationId,
      input.cohort,
      input.now,
      input.now,
    );
    if (!created) throw new Error("conversation_session_start_failed");
    return rowToConversationSession(created);
  }).immediate();
}

export function startConversationTurn(input: {
  turnId: string;
  sessionId: string | null;
  personaId: string;
  userMessageId: string;
  content: string;
}): ConversationTurn {
  const database = getDb();
  return database.transaction(() => {
    const now = new Date().toISOString();
    if (input.sessionId !== null) {
      const session = database.prepare(
        `UPDATE conversation_sessions
         SET last_activity_at = ?
         WHERE id = ? AND persona_id = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM voice_authorizations authorization
             WHERE authorization.id = conversation_sessions.voice_authorization_id
               AND authorization.voice_id = conversation_sessions.voice_id
               AND authorization.user_id = conversation_sessions.evaluator_user_id
               AND authorization.speaker_status = conversation_sessions.cohort
               AND authorization.status = 'approved'
           )
         RETURNING id`,
      ).get(now, input.sessionId, input.personaId);
      if (!session) throw new Error("conversation_turn_session_mismatch");
    }
    database.prepare(
      `INSERT INTO messages (id, persona_id, role, content, created_at)
       VALUES (?, ?, 'user', ?, ?)`,
    ).run(input.userMessageId, input.personaId, input.content, now);
    const row = database.prepare(
      `INSERT INTO conversation_turns
         (id, persona_id, user_message_id, session_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'started', ?, ?)
       RETURNING *`,
    ).get(input.turnId, input.personaId, input.userMessageId, input.sessionId, now, now);
    if (!row) throw new Error("conversation_turn_start_failed");
    return rowToConversationTurn(row);
  }).immediate();
}

export function bindConversationTurnEvidence(input: {
  turnId: string;
  personaId: string;
  evidence: Array<{ kind: "fact" | "relationship_memory"; itemId: string }>;
}): ConversationTurnEvidence[] {
  const database = getDb();
  return database.transaction(() => {
    const turn = database.prepare(
      `SELECT id FROM conversation_turns
       WHERE id = ? AND persona_id = ? AND status = 'started'`,
    ).get(input.turnId, input.personaId);
    if (!turn) throw new Error("conversation_turn_status_changed");
    const evidence = canonicalizeEvidenceLocks(input.evidence, (item) => item.itemId);

    for (const item of evidence) {
      const source = database.prepare(
        `SELECT source.id
         FROM persona_item_sources links
         JOIN persona_sources source ON source.id = links.source_id
         WHERE links.item_kind = ? AND links.item_id = ?
           AND source.persona_id = ? AND source.status = 'ready'
         ORDER BY source.id COLLATE BINARY
         LIMIT 1`,
      ).get(item.kind, item.itemId, input.personaId);
      if (!source) throw new Error("conversation_evidence_unavailable");
    }
    for (const item of evidence) {
      const table = EVIDENCE_TABLES[item.kind];
      const knowledge = database.prepare(
        `SELECT id FROM ${table}
         WHERE id = ? AND persona_id = ? AND status = 'confirmed'`,
      ).get(item.itemId, input.personaId);
      if (!knowledge) throw new Error("conversation_evidence_unavailable");
    }

    const now = new Date().toISOString();
    const insert = database.prepare(
      `INSERT INTO conversation_turn_evidence
         (turn_id, persona_id, item_kind, item_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING turn_id, persona_id, item_kind, item_id, created_at`,
    );
    return evidence.map((item) => {
      const row = insert.get(input.turnId, input.personaId, item.kind, item.itemId, now) as any;
      return {
        turnId: row.turn_id,
        personaId: row.persona_id,
        kind: row.item_kind,
        itemId: row.item_id,
        createdAt: sqliteIso(row.created_at),
      };
    });
  })();
}

export function completeConversationTurn(input: {
  turnId: string;
  personaId: string;
  assistantMessageId: string;
  content: string;
  mode: "grounded" | "companionship" | "boundary";
  boundaryKind: ConversationTurn["boundaryKind"];
  degradationReason: ConversationTurn["degradationReason"];
  retrievalMs: number;
  firstSentenceMs: number | null;
  totalMs: number;
  speechTrackingFailed: boolean;
}): ConversationTurn {
  const database = getDb();
  return database.transaction(() => {
    const turn = database.prepare(
      `SELECT id FROM conversation_turns
       WHERE id = ? AND persona_id = ? AND status = 'started'`,
    ).get(input.turnId, input.personaId);
    if (!turn) throw new Error("conversation_turn_status_changed");
    const evidence = database.prepare(
      `SELECT item_kind, item_id FROM conversation_turn_evidence
       WHERE turn_id = ? AND persona_id = ?
       ORDER BY item_kind, item_id`,
    ).all(input.turnId, input.personaId);
    if (
      (input.mode === "grounded" && evidence.length === 0)
      || (input.mode !== "grounded" && evidence.length !== 0)
    ) {
      throw new Error("conversation_turn_evidence_mismatch");
    }

    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO messages (id, persona_id, role, content, created_at)
       VALUES (?, ?, 'assistant', ?, ?)`,
    ).run(input.assistantMessageId, input.personaId, input.content, now);
    const copied = database.prepare(
      `INSERT INTO message_evidence
         (assistant_message_id, persona_id, item_kind, item_id, created_at)
       SELECT ?, persona_id, item_kind, item_id, created_at
       FROM conversation_turn_evidence
       WHERE turn_id = ? AND persona_id = ?`,
    ).run(input.assistantMessageId, input.turnId, input.personaId);
    if (copied.changes !== evidence.length) throw new Error("conversation_evidence_persistence_failed");
    const changed = database.prepare(
      `UPDATE conversation_turns
       SET assistant_message_id = ?, mode = ?, status = 'completed', boundary_kind = ?,
           degradation_reason = ?, retrieval_ms = ?, first_sentence_ms = ?, total_ms = ?,
           speech_tracking_failed = ?,
           updated_at = ?
       WHERE id = ? AND persona_id = ? AND status = 'started'`,
    ).run(
      input.assistantMessageId,
      input.mode,
      input.boundaryKind,
      input.degradationReason,
      input.retrievalMs,
      input.firstSentenceMs,
      input.totalMs,
      input.speechTrackingFailed ? 1 : 0,
      now,
      input.turnId,
      input.personaId,
    );
    if (changed.changes !== 1) throw new Error("conversation_turn_status_changed");
    const row = database.prepare(
      "SELECT * FROM conversation_turns WHERE id = ? AND persona_id = ?",
    ).get(input.turnId, input.personaId);
    if (!row) throw new Error("conversation_turn_status_changed");
    return rowToConversationTurn(row);
  })();
}

function rowToConversationSentence(row: any): ConversationSentence {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    personaId: row.persona_id,
    sentenceIndex: Number(row.sentence_index),
    text: row.text,
    emotion: row.emotion,
    intensity: Number(row.intensity),
    speed: Number(row.speed),
    pauseAfterMs: Number(row.pause_after_ms),
    plannerVersion: row.planner_version,
    createdAt: sqliteIso(row.created_at),
  };
}

function rowToTtsAttempt(row: any): TtsAttempt {
  return {
    id: row.id,
    sentenceId: row.sentence_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    personaId: row.persona_id,
    voiceId: row.voice_id,
    attemptNo: Number(row.attempt_no),
    status: row.status,
    voiceSource: row.voice_source,
    providerVoiceId: row.provider_voice_id,
    ttsModel: row.tts_model,
    ttsConfigVersion: row.tts_config_version,
    fellBack: Boolean(row.fell_back),
    storageMs: row.storage_ms === null ? null : Number(row.storage_ms),
    providerMs: row.provider_ms === null ? null : Number(row.provider_ms),
    totalMs: row.total_ms === null ? null : Number(row.total_ms),
    stableErrorCode: row.stable_error_code,
    createdAt: sqliteIso(row.created_at),
    completedAt: row.completed_at === null ? null : sqliteIso(row.completed_at),
  };
}

export function recordConversationSentence(input: {
  id: string;
  sessionId: string;
  turnId: string;
  personaId: string;
  plan: import("./speechPlanning").SpeechPlan;
  plannerVersion: string;
}): ConversationSentence {
  const database = getDb();
  return database.transaction(() => {
    const turn = database.prepare(
      `SELECT id FROM conversation_turns
       WHERE id = ? AND session_id = ? AND persona_id = ? AND status = 'started'`,
    ).get(input.turnId, input.sessionId, input.personaId);
    if (!turn) throw new Error("conversation_sentence_turn_mismatch");
    const row = database.prepare(
      `INSERT INTO conversation_sentences
         (id, session_id, turn_id, persona_id, sentence_index, text, emotion,
          intensity, speed, pause_after_ms, planner_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).get(
      input.id,
      input.sessionId,
      input.turnId,
      input.personaId,
      input.plan.index,
      input.plan.text,
      input.plan.emotion,
      input.plan.intensity,
      input.plan.speed,
      input.plan.pauseAfterMs,
      input.plannerVersion,
    );
    if (!row) throw new Error("conversation_sentence_persistence_failed");
    return rowToConversationSentence(row);
  }).immediate();
}

export function getConversationSentenceForSynthesis(
  sentenceId: string,
  evaluatorUserId: string,
): (ConversationSentence & { voiceId: string }) | null {
  const row = getDb().prepare(
    `SELECT sentence.*, sessions.voice_id
     FROM conversation_sentences sentence
     JOIN conversation_sessions sessions
       ON sessions.id = sentence.session_id AND sessions.persona_id = sentence.persona_id
     JOIN personas persona
       ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
     WHERE sentence.id = ? AND sessions.evaluator_user_id = ?`,
  ).get(sentenceId, evaluatorUserId) as any;
  return row ? { ...rowToConversationSentence(row), voiceId: row.voice_id } : null;
}

export function startTtsAttempt(input: {
  id: string;
  sentenceId: string;
  evaluatorUserId: string;
  voiceSource: "preset" | "dynamic";
  providerVoiceId: string | null;
  ttsModel: string;
  ttsConfigVersion: string;
}): TtsAttempt {
  const database = getDb();
  return database.transaction(() => {
    const sentence = database.prepare(
      `SELECT sentence.session_id, sentence.turn_id, sentence.persona_id, sessions.voice_id
       FROM conversation_sentences sentence
       JOIN conversation_sessions sessions
         ON sessions.id = sentence.session_id AND sessions.persona_id = sentence.persona_id
       JOIN personas persona
         ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
       JOIN voice_authorizations authorization
         ON authorization.id = sessions.voice_authorization_id
        AND authorization.voice_id = sessions.voice_id
        AND authorization.user_id = sessions.evaluator_user_id
        AND authorization.status = 'approved'
       WHERE sentence.id = ? AND sessions.evaluator_user_id = ? AND sessions.status = 'active'`,
    ).get(input.sentenceId, input.evaluatorUserId) as any;
    if (!sentence) throw new Error("tts_attempt_sentence_unavailable");
    const next = database.prepare(
      "SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no FROM tts_attempts WHERE sentence_id = ?",
    ).get(input.sentenceId) as { attempt_no: number };
    const row = database.prepare(
      `INSERT INTO tts_attempts
         (id, sentence_id, session_id, turn_id, persona_id, voice_id, attempt_no,
          status, voice_source, provider_voice_id, tts_model, tts_config_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?)
       RETURNING *`,
    ).get(
      input.id,
      input.sentenceId,
      sentence.session_id,
      sentence.turn_id,
      sentence.persona_id,
      sentence.voice_id,
      next.attempt_no,
      input.voiceSource,
      input.providerVoiceId,
      input.ttsModel,
      input.ttsConfigVersion,
    );
    if (!row) throw new Error("tts_attempt_start_failed");
    return rowToTtsAttempt(row);
  }).immediate();
}

export function completeTtsAttempt(input: {
  id: string;
  evaluatorUserId: string;
  voiceSource: "preset" | "dynamic";
  fellBack: boolean;
  storageMs: number;
  providerMs: number;
  totalMs: number;
}): TtsAttempt {
  const database = getDb();
  return database.transaction(() => {
    const eligible = database.prepare(
      `SELECT attempt.id
       FROM tts_attempts attempt
       JOIN conversation_sessions sessions
         ON sessions.id = attempt.session_id AND sessions.persona_id = attempt.persona_id
       JOIN personas persona
         ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
       JOIN voice_authorizations authorization
         ON authorization.id = sessions.voice_authorization_id
        AND authorization.voice_id = attempt.voice_id
        AND authorization.user_id = sessions.evaluator_user_id
        AND authorization.status = 'approved'
       WHERE attempt.id = ? AND attempt.status = 'started'
         AND sessions.evaluator_user_id = ? AND sessions.status = 'active'`,
    ).get(input.id, input.evaluatorUserId);
    if (!eligible) throw new Error("tts_attempt_authorization_denied");
    const row = database.prepare(
      `UPDATE tts_attempts
       SET status = 'completed', voice_source = ?, fell_back = ?, storage_ms = ?,
           provider_ms = ?, total_ms = ?, stable_error_code = NULL, completed_at = ?
       WHERE id = ? AND status = 'started'
       RETURNING *`,
    ).get(
      input.voiceSource,
      input.fellBack ? 1 : 0,
      input.storageMs,
      input.providerMs,
      input.totalMs,
      new Date().toISOString(),
      input.id,
    );
    if (!row) throw new Error("tts_attempt_status_changed");
    return rowToTtsAttempt(row);
  }).immediate();
}

export function failTtsAttempt(input: {
  id: string;
  evaluatorUserId: string;
  stableErrorCode: string;
  totalMs: number;
}): boolean {
  const changed = getDb().prepare(
    `UPDATE tts_attempts
     SET status = 'failed', stable_error_code = ?, total_ms = ?, completed_at = ?
     WHERE id = ? AND status = 'started'
       AND EXISTS (
         SELECT 1 FROM conversation_sessions sessions
         JOIN personas persona
           ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
         WHERE sessions.id = tts_attempts.session_id
           AND sessions.persona_id = tts_attempts.persona_id
           AND sessions.evaluator_user_id = ?
       )`,
  ).run(
    input.stableErrorCode,
    input.totalMs,
    new Date().toISOString(),
    input.id,
    input.evaluatorUserId,
  );
  return changed.changes === 1;
}

function rowToPlaybackEvent(row: any): PlaybackEvent {
  return {
    eventId: row.event_id,
    ttsAttemptId: row.tts_attempt_id,
    eventType: row.event_type,
    clientElapsedMs: Number(row.client_elapsed_ms),
    receivedAt: sqliteIso(row.received_at),
  };
}

export function recordPlaybackEvent(input: {
  eventId: string;
  ttsAttemptId: string;
  evaluatorUserId: string;
  eventType: PlaybackEvent["eventType"];
  clientElapsedMs: number;
}): { event: PlaybackEvent; created: boolean } {
  const database = getDb();
  return database.transaction(() => {
    const attempt = database.prepare(
      `SELECT attempt.id
       FROM tts_attempts attempt
       JOIN conversation_sessions sessions
         ON sessions.id = attempt.session_id AND sessions.persona_id = attempt.persona_id
       JOIN personas persona
         ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
       WHERE attempt.id = ? AND attempt.status = 'completed'
         AND sessions.evaluator_user_id = ?`,
    ).get(input.ttsAttemptId, input.evaluatorUserId);
    if (!attempt) throw new Error("playback_attempt_forbidden");

    const inserted = database.prepare(
      `INSERT INTO playback_events
         (event_id, tts_attempt_id, event_type, client_elapsed_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING *`,
    ).get(
      input.eventId,
      input.ttsAttemptId,
      input.eventType,
      input.clientElapsedMs,
    );
    if (inserted) return { event: rowToPlaybackEvent(inserted), created: true };

    const existing = database.prepare(
      `SELECT * FROM playback_events
       WHERE event_id = ? OR (tts_attempt_id = ? AND event_type = ?)`,
    ).all(input.eventId, input.ttsAttemptId, input.eventType) as any[];
    const byEventId = existing.find((row) => row.event_id === input.eventId);
    if (byEventId && (
      byEventId.tts_attempt_id !== input.ttsAttemptId
      || byEventId.event_type !== input.eventType
      || Number(byEventId.client_elapsed_ms) !== input.clientElapsedMs
    )) throw new Error("playback_event_conflict");
    const byAttemptType = existing.find((row) =>
      row.tts_attempt_id === input.ttsAttemptId && row.event_type === input.eventType);
    if (byAttemptType && Number(byAttemptType.client_elapsed_ms) === input.clientElapsedMs) {
      return { event: rowToPlaybackEvent(byAttemptType), created: false };
    }
    throw new Error("playback_event_conflict");
  }).immediate();
}

function feedbackEvidenceSummary(
  database: Database.Database,
  sessionId: string,
  evaluatorUserId: string,
): { count: number; hasStartedTurn: boolean } {
  const row = database.prepare(
    `SELECT (
       SELECT COUNT(DISTINCT turn.id)
       FROM conversation_turns turn
       JOIN conversation_sessions sessions
         ON sessions.id = turn.session_id AND sessions.persona_id = turn.persona_id
       WHERE turn.session_id = ? AND sessions.evaluator_user_id = ?
         AND turn.status = 'completed'
         AND turn.mode IN ('grounded', 'companionship')
         AND turn.speech_tracking_failed = 0
         AND EXISTS (
           SELECT 1
           FROM tts_attempts attempt
           JOIN playback_events playback
             ON playback.tts_attempt_id = attempt.id AND playback.event_type = 'play_started'
           WHERE attempt.session_id = turn.session_id
             AND attempt.turn_id = turn.id
             AND attempt.persona_id = turn.persona_id
             AND attempt.status = 'completed'
         )
     ) AS count,
     EXISTS (
       SELECT 1
       FROM conversation_turns started
       JOIN conversation_sessions sessions
         ON sessions.id = started.session_id AND sessions.persona_id = started.persona_id
       WHERE started.session_id = ? AND sessions.evaluator_user_id = ?
         AND started.status = 'started'
     ) AS has_started_turn`,
  ).get(sessionId, evaluatorUserId, sessionId, evaluatorUserId) as {
    count: number;
    has_started_turn: number;
  };
  return { count: Number(row.count), hasStartedTurn: Boolean(row.has_started_turn) };
}

function feedbackNotEligibleError(completedAudibleTurnCount: number): Error {
  return Object.assign(new Error("feedback_session_not_eligible"), {
    completedAudibleTurnCount,
    requiredAudibleTurnCount: 3,
  });
}

function rowToConversationFeedback(row: any): ConversationFeedback {
  return {
    id: row.id,
    sessionId: row.session_id,
    personaId: row.persona_id,
    evaluatorUserId: row.evaluator_user_id,
    evaluatorRelation: row.evaluator_relation,
    knowsVoiceOwner: true,
    heardAllRounds: true,
    voiceSimilarity: Number(row.voice_similarity),
    expressionSimilarity: Number(row.expression_similarity),
    emotionFit: Number(row.emotion_fit),
    factTrust: Number(row.fact_trust),
    discomfort: Number(row.discomfort),
    majorFabrication: Boolean(row.major_fabrication),
    identityImpersonation: Boolean(row.identity_impersonation),
    authorizationViolation: Boolean(row.authorization_violation),
    comment: row.comment,
    createdAt: sqliteIso(row.created_at),
  };
}

export function getFeedbackEligibility(
  sessionId: string,
  evaluatorUserId: string,
): FeedbackEligibility | null {
  const database = getDb();
  const row = database.prepare(
    `WITH owned_session AS (
       SELECT id, persona_id, evaluator_user_id, status
       FROM conversation_sessions
       WHERE id = ? AND evaluator_user_id = ?
     )
     SELECT owned.status,
            EXISTS (
              SELECT 1 FROM conversation_feedback feedback
              WHERE feedback.session_id = owned.id
                AND feedback.evaluator_user_id = owned.evaluator_user_id
            ) AS already_submitted,
            (
              SELECT COUNT(DISTINCT turn.id)
              FROM conversation_turns turn
              WHERE turn.session_id = owned.id AND turn.persona_id = owned.persona_id
                AND turn.status = 'completed'
                AND turn.mode IN ('grounded', 'companionship')
                AND turn.speech_tracking_failed = 0
                AND EXISTS (
                  SELECT 1
                  FROM tts_attempts attempt
                  JOIN playback_events playback
                    ON playback.tts_attempt_id = attempt.id
                   AND playback.event_type = 'play_started'
                  WHERE attempt.session_id = turn.session_id
                    AND attempt.turn_id = turn.id
                    AND attempt.persona_id = turn.persona_id
                    AND attempt.status = 'completed'
                )
            ) AS completed_audible_turn_count,
            NOT EXISTS (
              SELECT 1 FROM conversation_turns started
              WHERE started.session_id = owned.id AND started.persona_id = owned.persona_id
                AND started.status = 'started'
            ) AS has_no_started_turn
     FROM owned_session owned`,
  ).get(sessionId, evaluatorUserId) as {
    status: FeedbackEligibility["sessionStatus"];
    already_submitted: number;
    completed_audible_turn_count: number;
    has_no_started_turn: number;
  } | undefined;
  if (!row) return null;
  const alreadySubmitted = Boolean(row.already_submitted);
  const count = Number(row.completed_audible_turn_count);
  return {
    completedAudibleTurnCount: count,
    requiredAudibleTurnCount: 3,
    eligible: row.status === "active"
      && !alreadySubmitted
      && Boolean(row.has_no_started_turn)
      && count >= 3,
    sessionStatus: row.status,
    alreadySubmitted,
  };
}

export function submitConversationFeedback(input: {
  id: string;
  sessionId: string;
  evaluatorUserId: string;
  evaluatorRelation: EvaluatorRelation;
  knowsVoiceOwner: true;
  heardAllRounds: true;
  scores: RestorationScores;
  comment: string | null;
}): ConversationFeedback {
  const database = getDb();
  return database.transaction(() => {
    const session = database.prepare(
      `SELECT id, persona_id, evaluator_user_id, cohort, status
       FROM conversation_sessions
       WHERE id = ? AND evaluator_user_id = ?`,
    ).get(input.sessionId, input.evaluatorUserId) as {
      id: string;
      persona_id: string;
      evaluator_user_id: string;
      cohort: "living" | "deceased";
      status: "active" | "rated" | "expired";
    } | undefined;
    if (!session) throw new Error("feedback_session_forbidden");

    const existing = database.prepare(
      `SELECT 1 FROM conversation_feedback
       WHERE session_id = ? AND evaluator_user_id = ?`,
    ).get(input.sessionId, input.evaluatorUserId);
    if (existing) throw new Error("feedback_already_submitted");

    const evidence = feedbackEvidenceSummary(database, input.sessionId, input.evaluatorUserId);
    if (session.status !== "active" || evidence.count < 3 || evidence.hasStartedTurn) {
      throw feedbackNotEligibleError(evidence.count);
    }

    const row = database.prepare(
      `INSERT INTO conversation_feedback
         (id, session_id, persona_id, evaluator_user_id, evaluator_relation,
          knows_voice_owner, heard_all_rounds, voice_similarity,
          expression_similarity, emotion_fit, fact_trust, discomfort,
          major_fabrication, identity_impersonation, authorization_violation, comment)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).get(
      input.id,
      session.id,
      session.persona_id,
      session.evaluator_user_id,
      input.evaluatorRelation,
      input.scores.voiceSimilarity,
      input.scores.expressionSimilarity,
      input.scores.emotionFit,
      input.scores.factTrust,
      input.scores.discomfort,
      input.scores.majorFabrication ? 1 : 0,
      input.scores.identityImpersonation ? 1 : 0,
      input.scores.authorizationViolation ? 1 : 0,
      input.comment,
    );
    if (!row) throw new Error("feedback_persistence_failed");
    const rated = database.prepare(
      `UPDATE conversation_sessions
       SET status = 'rated', rated_at = ?
       WHERE id = ? AND evaluator_user_id = ? AND status = 'active'`,
    ).run(new Date().toISOString(), session.id, session.evaluator_user_id);
    if (rated.changes !== 1) throw new Error("feedback_session_status_changed");
    return rowToConversationFeedback(row);
  }).immediate();
}

export function failConversationTurn(input: {
  turnId: string;
  personaId: string;
  status: "generation_failed" | "assistant_persistence_failed";
  degradationReason: "model_failed" | "assistant_persistence_failed";
  totalMs: number;
}): boolean {
  const now = new Date().toISOString();
  const changed = getDb().prepare(
    `UPDATE conversation_turns
     SET status = ?, degradation_reason = ?, total_ms = ?, updated_at = ?
     WHERE id = ? AND persona_id = ? AND status = 'started'`,
  ).run(
    input.status,
    input.degradationReason,
    input.totalMs,
    now,
    input.turnId,
    input.personaId,
  );
  return changed.changes === 1;
}

export function listMessageEvidence(
  assistantMessageId: string,
  personaId: string,
): MessageEvidence[] {
  return (getDb().prepare(
    `SELECT assistant_message_id, persona_id, item_kind, item_id, created_at
     FROM message_evidence
     WHERE assistant_message_id = ? AND persona_id = ?
     ORDER BY item_kind, item_id`,
  ).all(assistantMessageId, personaId) as any[]).map((row) => ({
    assistantMessageId: row.assistant_message_id,
    personaId: row.persona_id,
    kind: row.item_kind,
    itemId: row.item_id,
    createdAt: sqliteIso(row.created_at),
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
