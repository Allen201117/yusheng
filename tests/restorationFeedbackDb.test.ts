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

function insertAudibleTurn(input: {
  turnId: string;
  sentenceId?: string;
  attemptId?: string;
  mode?: "grounded" | "companionship" | "boundary";
  status?: "completed" | "generation_failed";
  speechTrackingFailed?: boolean;
  attemptStatus?: "started" | "completed" | "failed";
  played?: boolean;
}) {
  const sentenceId = input.sentenceId || `sentence-${input.turnId}`;
  const attemptId = input.attemptId || `attempt-${input.turnId}`;
  const userMessageId = `user-${input.turnId}`;
  const assistantMessageId = `assistant-${input.turnId}`;
  database.prepare(
    `INSERT INTO messages (id, persona_id, role, content, created_at)
     VALUES (?, 'persona-1', 'user', '你好', ?)`,
  ).run(userMessageId, NOW);
  if ((input.status || "completed") === "completed") {
    database.prepare(
      `INSERT INTO messages (id, persona_id, role, content, created_at)
       VALUES (?, 'persona-1', 'assistant', '我在', ?)`,
    ).run(assistantMessageId, NOW);
  }
  database.prepare(
    `INSERT INTO conversation_turns
       (id, session_id, persona_id, user_message_id, assistant_message_id, mode,
        status, boundary_kind, total_ms, speech_tracking_failed, created_at, updated_at)
     VALUES (?, 'session-1', 'persona-1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.turnId,
    userMessageId,
    (input.status || "completed") === "completed" ? assistantMessageId : null,
    input.mode || "companionship",
    input.status || "completed",
    input.mode === "boundary" ? "identity" : null,
    (input.status || "completed") === "completed" ? 20 : null,
    input.speechTrackingFailed ? 1 : 0,
    NOW,
    NOW,
  );
  database.prepare(
    `INSERT INTO conversation_sentences
       (id, session_id, turn_id, persona_id, sentence_index, text, emotion,
        intensity, speed, pause_after_ms, planner_version, created_at)
     VALUES (?, 'session-1', ?, 'persona-1', 0, '我在', 'warm', 50, 1, 300, 'v1', ?)`,
  ).run(sentenceId, input.turnId, NOW);
  database.prepare(
    `INSERT INTO tts_attempts
       (id, sentence_id, session_id, turn_id, persona_id, voice_id, attempt_no,
        status, voice_source, tts_model, tts_config_version, created_at, completed_at)
     VALUES (?, ?, 'session-1', ?, 'persona-1', 'voice-1', 1, ?, 'dynamic', 'v1', 'v1', ?, ?)`,
  ).run(
    attemptId,
    sentenceId,
    input.turnId,
    input.attemptStatus || "completed",
    NOW,
    (input.attemptStatus || "completed") === "completed" ? NOW : null,
  );
  if (input.played !== false) {
    database.prepare(
      `INSERT INTO playback_events
         (event_id, tts_attempt_id, event_type, client_elapsed_ms, received_at)
       VALUES (?, ?, 'play_started', 10, ?)`,
    ).run(`event-${attemptId}`, attemptId, NOW);
  }
}

const VALID_FEEDBACK = {
  id: "feedback-submitted",
  sessionId: "session-1",
  evaluatorUserId: "user-1",
  evaluatorRelation: "family" as const,
  knowsVoiceOwner: true as const,
  heardAllRounds: true as const,
  scores: {
    voiceSimilarity: 5,
    expressionSimilarity: 4,
    emotionFit: 4,
    factTrust: 5,
    discomfort: 2,
    majorFabrication: false,
    identityImpersonation: false,
    authorizationViolation: false,
  },
  comment: "像本人",
};

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
  const playbackIndexes = database.pragma("index_list(playback_events)") as Array<{
    name: string;
    unique: number;
  }>;
  assert.equal(
    playbackIndexes.some((index) =>
      index.name === "idx_playback_events_one_type_per_attempt" && index.unique === 1),
    true,
  );
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
    CREATE TABLE playback_events (
      event_id TEXT PRIMARY KEY,
      tts_attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      client_elapsed_ms INTEGER NOT NULL,
      received_at TEXT NOT NULL
    );
    INSERT INTO playback_events VALUES
      ('legacy-event-1', 'legacy-attempt', 'play_started', 10, '${NOW}'),
      ('legacy-event-2', 'legacy-attempt', 'play_started', 20, '${NOW}');
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
  assert.equal(
    (legacy.prepare(
      "SELECT COUNT(*) AS count FROM playback_events WHERE tts_attempt_id = 'legacy-attempt' AND event_type = 'play_started'",
    ).get() as { count: number }).count,
    1,
  );
  assert.throws(() => legacy.prepare(
    `INSERT INTO playback_events VALUES
       ('legacy-event-3', 'legacy-attempt', 'play_started', 30, '${NOW}')`,
  ).run(), /UNIQUE constraint failed/);
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
    proposedSessionId: "session-still-unused",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1",
    cohort: "living",
    now: "2026-07-14T10:31:00.000Z",
    staleBefore: "2026-07-14T10:01:00.000Z",
  });
  assert.equal(replacement.id, first.id);
  assert.equal(replacement.lastActivityAt, "2026-07-14T10:31:00.000Z");

  const expiredReplacement = await repository.getOrStartConversationSession({
    proposedSessionId: "session-replacement",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1",
    cohort: "living",
    now: "2026-07-14T11:01:00.000Z",
    staleBefore: "2026-07-14T10:31:00.000Z",
  });
  assert.equal(expiredReplacement.id, "session-replacement");
  assert.equal(
    (database.prepare("SELECT status FROM conversation_sessions WHERE id = ?")
      .get(first.id) as { status: string }).status,
    "expired",
  );
  assert.equal(
    (database.prepare("SELECT last_activity_at FROM conversation_sessions WHERE id = ?")
      .get(first.id) as { last_activity_at: string }).last_activity_at,
    "2026-07-14T10:31:00.000Z",
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

it("rotates sessions with exact approved authorization snapshots and rejects revocation", async () => {
  const first = await repository.getOrStartConversationSession({
    proposedSessionId: "session-auth-1",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1",
    cohort: "living",
    now: "2026-07-14T10:00:00.000Z",
    staleBefore: "2026-07-14T09:30:00.000Z",
  });
  database.prepare("UPDATE voice_authorizations SET status = 'revoked' WHERE id = 'auth-1'").run();
  database.prepare(
    `INSERT INTO voice_authorizations
       (id, voice_id, user_id, speaker_status, basis, status, notice_version,
        separate_consent_confirmed, third_party_processing_confirmed,
        synthetic_disclosure_confirmed, attested_at, created_at)
     VALUES ('auth-1b', 'voice-1', 'user-1', 'living', 'self', 'approved', 'notice-v1',
             1, 1, 1, ?, ?)`,
  ).run(NOW, NOW);
  const rotated = await repository.getOrStartConversationSession({
    proposedSessionId: "session-auth-1b",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-1b",
    cohort: "living",
    now: "2026-07-14T10:05:00.000Z",
    staleBefore: "2026-07-14T09:35:00.000Z",
  });
  assert.equal(rotated.id, "session-auth-1b");
  assert.equal(rotated.voiceAuthorizationId, "auth-1b");
  assert.equal(
    (database.prepare("SELECT status FROM conversation_sessions WHERE id = ?")
      .get(first.id) as { status: string }).status,
    "expired",
  );

  database.prepare("UPDATE voice_authorizations SET status = 'revoked' WHERE id = 'auth-1b'").run();
  database.prepare(
    `INSERT INTO voice_authorizations
       (id, voice_id, user_id, speaker_status, basis, status, notice_version,
        separate_consent_confirmed, third_party_processing_confirmed,
        synthetic_disclosure_confirmed, attested_at, created_at)
     VALUES ('auth-deceased', 'voice-1', 'user-1', 'deceased', 'close_relative_request',
             'approved', 'notice-v1', 1, 1, 1, ?, ?)`,
  ).run(NOW, NOW);
  const cohortRotated = await repository.getOrStartConversationSession({
    proposedSessionId: "session-deceased",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-deceased",
    cohort: "deceased",
    now: "2026-07-14T10:10:00.000Z",
    staleBefore: "2026-07-14T09:40:00.000Z",
  });
  assert.equal(cohortRotated.id, "session-deceased");
  assert.equal(cohortRotated.cohort, "deceased");
  assert.equal(
    (database.prepare("SELECT status FROM conversation_sessions WHERE id = ?")
      .get(rotated.id) as { status: string }).status,
    "expired",
  );

  database.prepare("UPDATE voice_authorizations SET status = 'revoked' WHERE id = 'auth-deceased'").run();
  await assert.rejects(repository.getOrStartConversationSession({
    proposedSessionId: "session-revoked",
    personaId: "persona-1",
    evaluatorUserId: "user-1",
    voiceId: "voice-1",
    voiceAuthorizationId: "auth-deceased",
    cohort: "deceased",
    now: "2026-07-14T10:15:00.000Z",
    staleBefore: "2026-07-14T09:45:00.000Z",
  }), /conversation_session_authorization_denied/);
  assert.equal(
    (database.prepare("SELECT status FROM conversation_sessions WHERE id = ?")
      .get(cohortRotated.id) as { status: string }).status,
    "active",
  );
  await assert.rejects(repository.startConversationTurn({
    turnId: "turn-after-revocation",
    sessionId: cohortRotated.id,
    personaId: "persona-1",
    userMessageId: "message-after-revocation",
    content: "不应保存",
  }), /conversation_turn_session_mismatch/);
  assert.equal(
    database.prepare("SELECT id FROM messages WHERE id = ?").get("message-after-revocation"),
    undefined,
  );

  await assert.rejects(repository.getOrStartConversationSession({
    proposedSessionId: "session-wrong-cohort",
    personaId: "persona-2",
    evaluatorUserId: "user-2",
    voiceId: "voice-2",
    voiceAuthorizationId: "auth-2",
    cohort: "living",
    now: NOW,
    staleBefore: "2026-07-14T09:30:00.000Z",
  }), /conversation_session_authorization_denied/);
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

it("maps speech tracking failure independently from retrieval degradation", async () => {
  insertSession();
  insertTurn();
  const completed = await repository.completeConversationTurn({
    turnId: "turn-1",
    personaId: "persona-1",
    assistantMessageId: "assistant-1",
    content: "回复仍然完成。",
    mode: "companionship",
    boundaryKind: null,
    degradationReason: "no_relevant_evidence",
    retrievalMs: 10,
    firstSentenceMs: null,
    totalMs: 30,
    speechTrackingFailed: true,
  });
  assert.equal(completed.speechTrackingFailed, true);
  assert.equal(completed.degradationReason, "no_relevant_evidence");
  assert.deepEqual(
    database.prepare(
      "SELECT degradation_reason, speech_tracking_failed FROM conversation_turns WHERE id = ?",
    ).get("turn-1"),
    { degradation_reason: "no_relevant_evidence", speech_tracking_failed: 1 },
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

it("persists owner-scoped server sentences and compare-and-set TTS attempts", async () => {
  insertSession();
  insertTurn();
  const stored = await repository.recordConversationSentence({
    id: "sentence-tracked",
    sessionId: "session-1",
    turnId: "turn-1",
    personaId: "persona-1",
    plan: {
      index: 0,
      text: "服务端句子。",
      emotion: "warm",
      intensity: 55,
      speed: 0.96,
      pauseAfterMs: 360,
    },
    plannerVersion: "keyword-v1",
  });
  assert.equal(stored.text, "服务端句子。");
  assert.equal(stored.plannerVersion, "keyword-v1");
  assert.equal(
    (await repository.getConversationSentenceForSynthesis("sentence-tracked", "user-1"))?.voiceId,
    "voice-1",
  );
  assert.equal(
    await repository.getConversationSentenceForSynthesis("sentence-tracked", "user-2"),
    null,
  );

  const first = await repository.startTtsAttempt({
    id: "attempt-tracked-1",
    sentenceId: "sentence-tracked",
    evaluatorUserId: "user-1",
    voiceSource: "preset",
    providerVoiceId: "provider-1",
    ttsModel: "cosyvoice-v1",
    ttsConfigVersion: "config-v1",
  });
  const second = await repository.startTtsAttempt({
    id: "attempt-tracked-2",
    sentenceId: "sentence-tracked",
    evaluatorUserId: "user-1",
    voiceSource: "preset",
    providerVoiceId: "provider-1",
    ttsModel: "cosyvoice-v1",
    ttsConfigVersion: "config-v1",
  });
  assert.equal(first.attemptNo, 1);
  assert.equal(second.attemptNo, 2);

  assert.equal(await repository.failTtsAttempt({
    id: first.id,
    evaluatorUserId: "user-1",
    stableErrorCode: "provider_http_503",
    totalMs: 30,
  }), true);
  assert.equal(await repository.failTtsAttempt({
    id: first.id,
    evaluatorUserId: "user-1",
    stableErrorCode: "provider_http_503",
    totalMs: 40,
  }), false);
  assert.equal(await repository.failTtsAttempt({
    id: second.id,
    evaluatorUserId: "user-2",
    stableErrorCode: "provider_unknown",
    totalMs: 30,
  }), false);

  const completed = await repository.completeTtsAttempt({
    id: second.id,
    evaluatorUserId: "user-1",
    voiceSource: "dynamic",
    fellBack: true,
    storageMs: 10,
    providerMs: 20,
    totalMs: 30,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.voiceSource, "dynamic");
  assert.equal(completed.fellBack, true);
  await assert.rejects(repository.completeTtsAttempt({
    id: second.id,
    evaluatorUserId: "user-1",
    voiceSource: "dynamic",
    fellBack: true,
    storageMs: 10,
    providerMs: 20,
    totalMs: 30,
  }), /tts_attempt_authorization_denied|tts_attempt_status_changed/);
});

it("blocks TTS attempt completion after the exact session authorization is revoked", async () => {
  insertSession();
  insertTurn();
  insertSentence();
  const started = await repository.startTtsAttempt({
    id: "attempt-revoked",
    sentenceId: "sentence-1",
    evaluatorUserId: "user-1",
    voiceSource: "preset",
    providerVoiceId: "provider-1",
    ttsModel: "cosyvoice-v1",
    ttsConfigVersion: "config-v1",
  });
  assert.equal(started.status, "started");
  database.prepare("UPDATE voice_authorizations SET status = 'revoked' WHERE id = 'auth-1'").run();
  await assert.rejects(repository.completeTtsAttempt({
    id: started.id,
    evaluatorUserId: "user-1",
    voiceSource: "preset",
    fellBack: false,
    storageMs: 10,
    providerMs: 20,
    totalMs: 30,
  }), /tts_attempt_authorization_denied/);
  assert.equal(
    (database.prepare("SELECT status FROM tts_attempts WHERE id = ?").get(started.id) as { status: string }).status,
    "started",
  );
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

it("records completed owner-scoped playback events idempotently", async () => {
  insertSession();
  insertTurn();
  insertSentence();
  insertAttempt();
  const input = {
    eventId: "event-owned",
    ttsAttemptId: "attempt-1",
    evaluatorUserId: "user-1",
    eventType: "play_started" as const,
    clientElapsedMs: 24,
  };
  const first = await repository.recordPlaybackEvent(input);
  const retry = await repository.recordPlaybackEvent(input);
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.deepEqual(retry.event, first.event);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM playback_events").get() as { count: number }).count,
    1,
  );

  await assert.rejects(repository.recordPlaybackEvent({
    ...input,
    eventType: "play_completed",
  }), /playback_event_conflict/);
  const semanticRetry = await repository.recordPlaybackEvent({
    ...input,
    eventId: "event-owned-retry-id",
  });
  assert.equal(semanticRetry.created, false);
  assert.equal(semanticRetry.event.eventId, "event-owned");
  await assert.rejects(repository.recordPlaybackEvent({
    ...input,
    eventId: "event-owned-different-elapsed",
    clientElapsedMs: 25,
  }), /playback_event_conflict/);
  await assert.rejects(repository.recordPlaybackEvent({
    ...input,
    eventId: "event-other-owner",
    evaluatorUserId: "user-2",
  }), /playback_attempt_forbidden/);
});

it("stores at most one row for each of the four event types per attempt", async () => {
  insertSession();
  insertTurn();
  insertSentence();
  insertAttempt();
  for (const [index, eventType] of [
    "audio_ready", "play_started", "play_completed", "play_failed",
  ].entries()) {
    await repository.recordPlaybackEvent({
      eventId: `event-type-${index}`,
      ttsAttemptId: "attempt-1",
      evaluatorUserId: "user-1",
      eventType: eventType as import("../src/lib/storage/types").PlaybackEventType,
      clientElapsedMs: index,
    });
  }
  assert.equal(
    (database.prepare(
      "SELECT COUNT(*) AS count FROM playback_events WHERE tts_attempt_id = 'attempt-1'",
    ).get() as { count: number }).count,
    4,
  );
});

it("rejects playback events for non-completed and unknown attempts", async () => {
  insertSession();
  insertTurn();
  insertSentence();
  insertAttempt();
  database.prepare("UPDATE tts_attempts SET status = 'failed' WHERE id = 'attempt-1'").run();
  await assert.rejects(repository.recordPlaybackEvent({
    eventId: "event-failed",
    ttsAttemptId: "attempt-1",
    evaluatorUserId: "user-1",
    eventType: "play_failed",
    clientElapsedMs: 12,
  }), /playback_attempt_forbidden/);
  await assert.rejects(repository.recordPlaybackEvent({
    eventId: "event-unknown",
    ttsAttemptId: "attempt-unknown",
    evaluatorUserId: "user-1",
    eventType: "play_started",
    clientElapsedMs: 12,
  }), /playback_attempt_forbidden/);
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

it("counts distinct completed audible turns and excludes ineligible evidence", async () => {
  insertSession();
  insertAudibleTurn({ turnId: "turn-good-1" });
  insertAudibleTurn({ turnId: "turn-good-2", mode: "grounded" });
  insertAudibleTurn({ turnId: "turn-boundary", mode: "boundary" });
  insertAudibleTurn({ turnId: "turn-failed", status: "generation_failed" });
  insertAudibleTurn({ turnId: "turn-unplayed", played: false });
  insertAudibleTurn({ turnId: "turn-tts-failed", attemptStatus: "failed", played: false });
  insertAudibleTurn({ turnId: "turn-tracking-failed", speechTrackingFailed: true });
  const firstEligibility = await repository.getFeedbackEligibility("session-1", "user-1");
  assert.deepEqual(firstEligibility, {
    completedAudibleTurnCount: 2,
    requiredAudibleTurnCount: 3,
    eligible: false,
    sessionStatus: "active",
    alreadySubmitted: false,
  });
  await assert.rejects(repository.submitConversationFeedback(VALID_FEEDBACK), (error: unknown) => {
    assert.equal((error as Error).message, "feedback_session_not_eligible");
    assert.equal((error as { completedAudibleTurnCount: number }).completedAudibleTurnCount, 2);
    assert.equal((error as { requiredAudibleTurnCount: number }).requiredAudibleTurnCount, 3);
    return true;
  });

  insertAudibleTurn({ turnId: "turn-good-3" });
  assert.equal((await repository.getFeedbackEligibility("session-1", "user-1"))?.eligible, true);
});

it("blocks rating while a session turn is still active and allows retry after it fails", async () => {
  insertSession();
  for (const turnId of ["turn-done-1", "turn-done-2", "turn-done-3"]) {
    insertAudibleTurn({ turnId });
  }
  insertTurn("turn-in-flight");

  assert.deepEqual(await repository.getFeedbackEligibility("session-1", "user-1"), {
    completedAudibleTurnCount: 3,
    requiredAudibleTurnCount: 3,
    eligible: false,
    sessionStatus: "active",
    alreadySubmitted: false,
  });
  await assert.rejects(repository.submitConversationFeedback(VALID_FEEDBACK), (error: unknown) => {
    assert.equal((error as Error).message, "feedback_session_not_eligible");
    assert.equal((error as { completedAudibleTurnCount: number }).completedAudibleTurnCount, 3);
    return true;
  });
  assert.equal(
    (database.prepare("SELECT status FROM conversation_sessions WHERE id = 'session-1'").get() as { status: string }).status,
    "active",
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM conversation_feedback").get() as { count: number }).count,
    0,
  );

  database.prepare(
    `UPDATE conversation_turns
     SET status = 'generation_failed', degradation_reason = 'model_failed', total_ms = 10
     WHERE id = 'turn-in-flight' AND status = 'started'`,
  ).run();
  assert.equal((await repository.getFeedbackEligibility("session-1", "user-1"))?.eligible, true);
  const saved = await repository.submitConversationFeedback(VALID_FEEDBACK);
  assert.equal(saved.id, "feedback-submitted");
});

it("blocks rating during speech synthesis and allows retry after the attempt fails", async () => {
  insertSession();
  for (const turnId of ["turn-heard-1", "turn-heard-2", "turn-heard-3"]) {
    insertAudibleTurn({ turnId });
  }
  insertAudibleTurn({
    turnId: "turn-synthesizing",
    attemptStatus: "started",
    played: false,
  });

  assert.deepEqual(await repository.getFeedbackEligibility("session-1", "user-1"), {
    completedAudibleTurnCount: 3,
    requiredAudibleTurnCount: 3,
    eligible: false,
    sessionStatus: "active",
    alreadySubmitted: false,
  });
  await assert.rejects(repository.submitConversationFeedback(VALID_FEEDBACK), (error: unknown) => {
    assert.equal((error as Error).message, "feedback_session_not_eligible");
    assert.equal((error as { completedAudibleTurnCount: number }).completedAudibleTurnCount, 3);
    return true;
  });
  assert.equal(
    (database.prepare("SELECT status FROM conversation_sessions WHERE id = 'session-1'").get() as { status: string }).status,
    "active",
  );
  assert.equal(
    await repository.failTtsAttempt({
      id: "attempt-turn-synthesizing",
      evaluatorUserId: "user-1",
      stableErrorCode: "provider_timeout",
      totalMs: 100,
    }),
    true,
  );
  assert.equal((await repository.getFeedbackEligibility("session-1", "user-1"))?.eligible, true);
  assert.equal((await repository.submitConversationFeedback(VALID_FEEDBACK)).id, "feedback-submitted");
});

it("does not turn three attempts from only two turns into three audible turns", async () => {
  insertSession();
  insertAudibleTurn({ turnId: "turn-one" });
  insertAudibleTurn({ turnId: "turn-two" });
  database.prepare(
    `INSERT INTO tts_attempts
       (id, sentence_id, session_id, turn_id, persona_id, voice_id, attempt_no,
        status, voice_source, tts_model, tts_config_version, created_at, completed_at)
     VALUES ('attempt-turn-two-retry', 'sentence-turn-two', 'session-1', 'turn-two',
             'persona-1', 'voice-1', 2, 'completed', 'dynamic', 'v1', 'v1', ?, ?)`,
  ).run(NOW, NOW);
  database.prepare(
    `INSERT INTO playback_events
       (event_id, tts_attempt_id, event_type, client_elapsed_ms, received_at)
     VALUES ('event-turn-two-retry', 'attempt-turn-two-retry', 'play_started', 12, ?)`,
  ).run(NOW);
  assert.equal(
    (await repository.getFeedbackEligibility("session-1", "user-1"))?.completedAudibleTurnCount,
    2,
  );
});

it("submits immutable owner-scoped feedback and rates the server-owned session", async () => {
  insertSession();
  for (const turnId of ["turn-a", "turn-b", "turn-c"]) insertAudibleTurn({ turnId });
  assert.equal(await repository.getFeedbackEligibility("session-1", "user-2"), null);
  await assert.rejects(repository.submitConversationFeedback({
    ...VALID_FEEDBACK,
    evaluatorUserId: "user-2",
  }), /feedback_session_forbidden/);

  const saved = await repository.submitConversationFeedback(VALID_FEEDBACK);
  assert.equal(saved.personaId, "persona-1");
  assert.equal(saved.evaluatorUserId, "user-1");
  assert.equal(saved.comment, "像本人");
  assert.deepEqual(database.prepare(
    `SELECT cohort, status, rated_at IS NOT NULL AS has_rated_at
     FROM conversation_sessions WHERE id = 'session-1'`,
  ).get(), { cohort: "living", status: "rated", has_rated_at: 1 });
  assert.deepEqual(await repository.getFeedbackEligibility("session-1", "user-1"), {
    completedAudibleTurnCount: 3,
    requiredAudibleTurnCount: 3,
    eligible: false,
    sessionStatus: "rated",
    alreadySubmitted: true,
  });
  await assert.rejects(repository.submitConversationFeedback({
    ...VALID_FEEDBACK,
    id: "feedback-second",
  }), /feedback_already_submitted/);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM conversation_feedback").get() as { count: number }).count,
    1,
  );
});

it("rolls feedback insertion back when rating the session fails", async () => {
  insertSession();
  for (const turnId of ["turn-r1", "turn-r2", "turn-r3"]) insertAudibleTurn({ turnId });
  database.exec(`
    CREATE TRIGGER reject_rating_for_test
    BEFORE UPDATE OF status ON conversation_sessions
    WHEN NEW.status = 'rated'
    BEGIN
      SELECT RAISE(ABORT, 'rating rejected');
    END;
  `);
  await assert.rejects(repository.submitConversationFeedback(VALID_FEEDBACK), /rating rejected/);
  database.exec("DROP TRIGGER reject_rating_for_test");
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM conversation_feedback").get() as { count: number }).count,
    0,
  );
  assert.equal(
    (database.prepare("SELECT status FROM conversation_sessions WHERE id = 'session-1'").get() as { status: string }).status,
    "active",
  );
});

it("lists only the aggregate restoration metric whitelist", async () => {
  insertSession();
  for (const turnId of ["turn-report-1", "turn-report-2", "turn-report-3"]) {
    insertAudibleTurn({ turnId });
  }
  await repository.submitConversationFeedback({
    ...VALID_FEEDBACK,
    comment: "private evaluator comment",
  });

  const rows = await repository.listRestorationMetricRows();
  assert.deepEqual(rows, [{
    sessionId: "session-1",
    evaluatorUserId: "user-1",
    cohort: "living",
    voiceSimilarity: 5,
    expressionSimilarity: 4,
    emotionFit: 4,
    factTrust: 5,
    discomfort: 2,
    majorFabrication: false,
    identityImpersonation: false,
    authorizationViolation: false,
  }]);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "authorizationViolation",
    "cohort",
    "discomfort",
    "emotionFit",
    "evaluatorUserId",
    "expressionSimilarity",
    "factTrust",
    "identityImpersonation",
    "majorFabrication",
    "sessionId",
    "voiceSimilarity",
  ]);
  assert.doesNotMatch(
    JSON.stringify(rows),
    /private evaluator comment|persona-1|voice-1|provider-voice-1|audio-path/i,
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
