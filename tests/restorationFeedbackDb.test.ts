import { after, before, beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dataDir = "";
let previousDataDir: string | undefined;
let database: Database.Database;
let dbModule: typeof import("../src/lib/db");
let repository: import("../src/lib/storage/types").AppRepository;

const NOW = "2026-07-14T10:00:00.000Z";

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "yusheng-restoration-feedback-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  dbModule = await import("../src/lib/db");
  database = dbModule.getDb();
  const repositoryModule = await import("../src/lib/storage/repository");
  repository = repositoryModule.createLocalRepository();
});

after(async () => {
  database?.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  database.exec(`
    DELETE FROM playback_events;
    DELETE FROM conversation_feedback;
    DELETE FROM tts_attempts;
    DELETE FROM conversation_sentences;
    DELETE FROM conversation_turns;
    DELETE FROM conversation_sessions;
    DELETE FROM messages;
    DELETE FROM voice_authorizations;
    DELETE FROM personas;
    DELETE FROM users;

    INSERT INTO users (id, email, created_at) VALUES
      ('user-1', 'one@example.com', '${NOW}'),
      ('user-2', 'two@example.com', '${NOW}');
    INSERT INTO personas (id, user_id, name, relation, voice_id, persona_desc, created_at) VALUES
      ('persona-1', 'user-1', '妈妈', '母亲', 'voice-1', '', '${NOW}'),
      ('persona-2', 'user-2', '阿姨', '姨母', 'voice-2', '', '${NOW}');
    INSERT INTO voice_authorizations
      (id, voice_id, user_id, speaker_status, basis, status, notice_version,
       separate_consent_confirmed, third_party_processing_confirmed,
       synthetic_disclosure_confirmed, attested_at, created_at)
    VALUES
      ('auth-1', 'voice-1', 'user-1', 'living', 'self', 'approved', 'notice-v1',
       1, 1, 1, '${NOW}', '${NOW}'),
      ('auth-2', 'voice-2', 'user-2', 'deceased', 'close_relative_request', 'approved', 'notice-v1',
       1, 1, 1, '${NOW}', '${NOW}');
  `);
});

function insertSession(
  id = "session-1",
  personaId = "persona-1",
  evaluatorUserId = "user-1",
  voiceId = "voice-1",
  authorizationId = "auth-1",
  cohort = "living",
  status = "active",
) {
  database.prepare(
    `INSERT INTO conversation_sessions
       (id, persona_id, evaluator_user_id, voice_id, voice_authorization_id,
        cohort, status, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    personaId,
    evaluatorUserId,
    voiceId,
    authorizationId,
    cohort,
    status,
    NOW,
    NOW,
  );
}

function insertTurn(id = "turn-1", sessionId: string | null = "session-1", personaId = "persona-1") {
  const messageId = `message-${id}`;
  database.prepare(
    `INSERT INTO messages (id, persona_id, role, content, created_at)
     VALUES (?, ?, 'user', '你好', ?)`,
  ).run(messageId, personaId, NOW);
  database.prepare(
    `INSERT INTO conversation_turns
       (id, persona_id, user_message_id, status, session_id, created_at, updated_at)
     VALUES (?, ?, ?, 'started', ?, ?, ?)`,
  ).run(id, personaId, messageId, sessionId, NOW, NOW);
}

function insertSentence(id = "sentence-1", index = 0, sessionId = "session-1", turnId = "turn-1") {
  database.prepare(
    `INSERT INTO conversation_sentences
       (id, session_id, turn_id, persona_id, sentence_index, text, emotion,
        intensity, speed, pause_after_ms, planner_version, created_at)
     VALUES (?, ?, ?, 'persona-1', ?, '慢慢说。', 'warm', 55, 0.96, 360, 'keyword-v1', ?)`,
  ).run(id, sessionId, turnId, index, NOW);
}

function insertAttempt(id = "attempt-1", attemptNo = 1, sentenceId = "sentence-1") {
  database.prepare(
    `INSERT INTO tts_attempts
       (id, sentence_id, session_id, turn_id, persona_id, voice_id, attempt_no,
        status, voice_source, provider_voice_id, tts_model, tts_config_version,
        fell_back, storage_ms, provider_ms, total_ms, created_at, completed_at)
     VALUES (?, ?, 'session-1', 'turn-1', 'persona-1', 'voice-1', ?,
             'completed', 'dynamic', 'provider-voice-1', 'cosyvoice-v1', 'config-v1',
             0, 10, 20, 30, ?, ?)`,
  ).run(id, sentenceId, attemptNo, NOW, NOW);
}

it("creates all restoration feedback tables and legacy-safe turn columns", () => {
  const tables = database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN (?, ?, ?, ?, ?)
     ORDER BY name`,
  ).all(
    "conversation_sessions",
    "conversation_sentences",
    "tts_attempts",
    "playback_events",
    "conversation_feedback",
  ) as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name), [
    "conversation_feedback",
    "conversation_sentences",
    "conversation_sessions",
    "playback_events",
    "tts_attempts",
  ]);

  const turnColumns = database.pragma("table_info(conversation_turns)") as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const sessionId = turnColumns.find((column) => column.name === "session_id");
  assert.equal(sessionId?.notnull, 0);
  const trackingFailed = turnColumns.find((column) => column.name === "speech_tracking_failed");
  assert.equal(trackingFailed?.notnull, 1);
  assert.equal(trackingFailed?.dflt_value, "0");
});

it("upgrades legacy turns without rewriting them and is idempotent", async () => {
  const legacy = new Database(":memory:");
  legacy.pragma("foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE personas (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, voice_id TEXT NOT NULL);
    CREATE TABLE voice_authorizations (
      id TEXT PRIMARY KEY,
      voice_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      speaker_status TEXT NOT NULL
    );
    CREATE TABLE conversation_turns (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE conversation_sessions (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      evaluator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      voice_id TEXT NOT NULL,
      voice_authorization_id TEXT NOT NULL REFERENCES voice_authorizations(id),
      cohort TEXT NOT NULL CHECK (cohort IN ('living','deceased')),
      status TEXT NOT NULL CHECK (status IN ('active','rated','expired')),
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      rated_at TEXT
    );
    INSERT INTO users VALUES ('legacy-user');
    INSERT INTO personas VALUES ('legacy-persona', 'legacy-user', 'legacy-voice');
    INSERT INTO voice_authorizations VALUES ('legacy-auth', 'legacy-voice', 'legacy-user', 'living');
    INSERT INTO conversation_sessions VALUES (
      'legacy-session', 'legacy-persona', 'legacy-user', 'legacy-voice', 'legacy-auth',
      'living', 'rated', '${NOW}', '${NOW}', '${NOW}'
    );
    INSERT INTO conversation_turns VALUES ('legacy-turn', 'legacy-persona', '${NOW}');
  `);

  assert.equal(typeof dbModule.migrateRestorationFeedbackSchema, "function");
  dbModule.migrateRestorationFeedbackSchema(legacy);
  dbModule.migrateRestorationFeedbackSchema(legacy);

  assert.deepEqual(
    legacy.prepare(
      `SELECT id, persona_id, session_id, speech_tracking_failed
       FROM conversation_turns WHERE id = 'legacy-turn'`,
    ).get(),
    {
      id: "legacy-turn",
      persona_id: "legacy-persona",
      session_id: null,
      speech_tracking_failed: 0,
    },
  );
  assert.equal(
    (legacy.prepare("SELECT cohort FROM conversation_sessions WHERE id = 'legacy-session'")
      .get() as { cohort: string }).cohort,
    "living",
  );
  assert.throws(
    () => legacy.prepare(
      `INSERT INTO conversation_sessions
         (id, persona_id, evaluator_user_id, voice_id, voice_authorization_id,
          cohort, status, started_at, last_activity_at)
       VALUES ('legacy-mismatch', 'legacy-persona', 'legacy-user', 'legacy-voice',
               'legacy-auth', 'deceased', 'rated', ?, ?)`,
    ).run(NOW, NOW),
    /conversation_session_authorization_mismatch/,
  );
  assert.throws(
    () => legacy.prepare(
      "UPDATE voice_authorizations SET speaker_status = 'deceased' WHERE id = 'legacy-auth'",
    ).run(),
    /conversation_session_authorization_mismatch/,
  );
  legacy.close();
});

it("allows only one active session per persona and evaluator", () => {
  insertSession();
  assert.throws(() => insertSession("session-2"), /UNIQUE constraint failed/);
  insertSession("session-rated", "persona-1", "user-1", "voice-1", "auth-1", "living", "rated");
});

it("binds the session cohort to the authorization speaker status", () => {
  assert.throws(
    () => insertSession(
      "session-cohort-mismatch",
      "persona-1",
      "user-1",
      "voice-1",
      "auth-1",
      "deceased",
      "rated",
    ),
    /FOREIGN KEY constraint failed|conversation_session_authorization_mismatch/,
  );
  insertSession("session-cohort-match", "persona-1", "user-1", "voice-1", "auth-1", "living", "rated");
});

it("atomically reuses fresh sessions, expires stale sessions, and isolates owners", async () => {
  const first = await repository.getOrStartConversationSession({
    proposedSessionId: "session-first",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1",
    cohort: "living",
    now: "2026-07-14T10:00:00.000Z",
    staleBefore: "2026-07-14T09:30:00.000Z",
  });
  const reused = await repository.getOrStartConversationSession({
    proposedSessionId: "session-unused",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1",
    cohort: "living",
    now: "2026-07-14T10:29:00.000Z",
    staleBefore: "2026-07-14T09:59:00.000Z",
  });
  assert.equal(reused.id, first.id);
  assert.equal(reused.voiceAuthorizationId, "auth-1");
  assert.equal(reused.cohort, "living");

  const replacement = await repository.getOrStartConversationSession({
    proposedSessionId: "session-replacement",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1",
    cohort: "living",
    now: "2026-07-14T10:31:00.000Z",
    staleBefore: "2026-07-14T10:01:00.000Z",
  });
  assert.equal(replacement.id, "session-replacement");
  assert.equal(
    (database.prepare("SELECT status FROM conversation_sessions WHERE id = ?")
      .get(first.id) as { status: string }).status,
    "expired",
  );

  await assert.rejects(repository.getOrStartConversationSession({
    proposedSessionId: "session-owner-mismatch",
    personaId: "persona-1",
    evaluatorUserId: "user-2",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1",
    cohort: "living",
    now: NOW,
    staleBefore: "2026-07-14T09:30:00.000Z",
  }), /conversation_session_owner_mismatch/);

  const otherOwner = await repository.getOrStartConversationSession({
    proposedSessionId: "session-other-owner",
    personaId: "persona-2",
    evaluatorUserId: "user-2",
    voiceId: "voice-2",
    voiceAuthorizationId: "auth-2",
    cohort: "deceased",
    now: NOW,
    staleBefore: "2026-07-14T09:30:00.000Z",
  });
  assert.equal(otherOwner.id, "session-other-owner");
  assert.equal(otherOwner.cohort, "deceased");
});

it("serializes concurrent session starts to one active session", async () => {
  const input = {
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1",
    cohort: "living" as const,
    now: NOW,
    staleBefore: "2026-07-14T09:30:00.000Z",
  };
  const [first, second] = await Promise.all([
    repository.getOrStartConversationSession({ ...input, proposedSessionId: "session-concurrent-a" }),
    repository.getOrStartConversationSession({ ...input, proposedSessionId: "session-concurrent-b" }),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM conversation_sessions WHERE status = 'active'")
      .get() as { count: number }).count,
    1,
  );
});

it("rolls back a turn when its session belongs to another persona", async () => {
  insertSession();
  await assert.rejects(repository.startConversationTurn({
    turnId: "turn-mismatch",
    sessionId: "session-1",
    personaId: "persona-2",
    userMessageId: "message-mismatch",
    content: "不应保存",
  }), /conversation_turn_session_mismatch/);
  assert.equal(database.prepare("SELECT id FROM messages WHERE id = ?").get("message-mismatch"), undefined);
  assert.equal(database.prepare("SELECT id FROM conversation_turns WHERE id = ?").get("turn-mismatch"), undefined);
});

it("keeps legacy turn session links nullable", () => {
  insertTurn("turn-legacy", null);
  assert.deepEqual(
    database.prepare(
      "SELECT session_id, speech_tracking_failed FROM conversation_turns WHERE id = ?",
    ).get("turn-legacy"),
    { session_id: null, speech_tracking_failed: 0 },
  );
});

it("enforces one sentence index per turn and one attempt number per sentence", () => {
  insertSession();
  insertTurn();
  insertSentence();
  assert.throws(() => insertSentence("sentence-2", 0), /UNIQUE constraint failed/);
  insertAttempt();
  assert.throws(() => insertAttempt("attempt-2", 1), /UNIQUE constraint failed/);
});

it("deduplicates playback event ids and bounds event values", () => {
  insertSession();
  insertTurn();
  insertSentence();
  insertAttempt();
  const insert = database.prepare(
    `INSERT INTO playback_events
       (event_id, tts_attempt_id, event_type, client_elapsed_ms, received_at)
     VALUES (?, 'attempt-1', ?, ?, ?)`,
  );
  insert.run("event-1", "play_started", 20, NOW);
  assert.throws(() => insert.run("event-1", "play_started", 20, NOW), /UNIQUE constraint failed/);
  assert.throws(() => insert.run("event-2", "unknown", 20, NOW), /CHECK constraint failed/);
  assert.throws(() => insert.run("event-3", "play_completed", 300001, NOW), /CHECK constraint failed/);
});

it("accepts one attested bounded feedback row per session and evaluator", () => {
  insertSession();
  const insert = database.prepare(
    `INSERT INTO conversation_feedback
       (id, session_id, persona_id, evaluator_user_id, evaluator_relation,
        knows_voice_owner, heard_all_rounds, voice_similarity,
        expression_similarity, emotion_fit, fact_trust, discomfort,
        major_fabrication, identity_impersonation, authorization_violation,
        comment, created_at)
     VALUES (?, 'session-1', 'persona-1', 'user-1', 'family', ?, ?, ?, 4, 4, 4, 2,
             0, 0, 0, ?, ?)`,
  );
  insert.run("feedback-1", 1, 1, 4, "贴近本人", NOW);
  assert.throws(
    () => insert.run("feedback-2", 1, 1, 4, null, NOW),
    /UNIQUE constraint failed/,
  );

  database.prepare("DELETE FROM conversation_feedback").run();
  assert.throws(() => insert.run("feedback-score-low", 1, 1, 0, null, NOW), /CHECK constraint failed/);
  assert.throws(() => insert.run("feedback-score-high", 1, 1, 6, null, NOW), /CHECK constraint failed/);
  assert.throws(() => insert.run("feedback-score-float", 1, 1, 4.5, null, NOW), /CHECK constraint failed/);
  assert.throws(() => insert.run("feedback-no-owner", 0, 1, 4, null, NOW), /CHECK constraint failed/);
  assert.throws(() => insert.run("feedback-not-heard", 1, 0, 4, null, NOW), /CHECK constraint failed/);
  assert.throws(
    () => insert.run("feedback-long-comment", 1, 1, 4, "x".repeat(1001), NOW),
    /CHECK constraint failed/,
  );
});

it("rejects owner mismatches and rolls back the whole transaction", () => {
  assert.throws(
    () => insertSession("session-owner-mismatch", "persona-1", "user-2", "voice-2", "auth-2"),
    /FOREIGN KEY constraint failed|conversation_session_authorization_mismatch/,
  );

  const transaction = database.transaction(() => {
    insertSession("session-rollback");
    insertTurn("turn-rollback", "session-rollback");
    database.prepare(
      `INSERT INTO conversation_sentences
         (id, session_id, turn_id, persona_id, sentence_index, text, emotion,
          intensity, speed, pause_after_ms, planner_version, created_at)
       VALUES ('sentence-mismatch', 'session-rollback', 'turn-rollback', 'persona-2',
               0, '不该写入', 'calm', 45, 1, 320, 'keyword-v1', ?)`,
    ).run(NOW);
  });
  assert.throws(transaction, /FOREIGN KEY constraint failed/);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM conversation_sessions WHERE id = ?")
      .get("session-rollback") as { count: number }).count,
    0,
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM conversation_turns WHERE id = ?")
      .get("turn-rollback") as { count: number }).count,
    0,
  );
});
