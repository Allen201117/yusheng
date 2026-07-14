CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_restoration_owner_voice
  ON personas(id, user_id, voice_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_authorizations_restoration_owner_voice
  ON voice_authorizations(id, voice_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_authorizations_restoration_owner_voice_status
  ON voice_authorizations(id, voice_id, user_id, speaker_status);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  evaluator_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voice_id text NOT NULL,
  voice_authorization_id text NOT NULL REFERENCES voice_authorizations(id),
  cohort text NOT NULL CHECK (cohort IN ('living', 'deceased')),
  status text NOT NULL CHECK (status IN ('active', 'rated', 'expired')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  rated_at timestamptz,
  FOREIGN KEY (persona_id, evaluator_user_id, voice_id)
    REFERENCES personas(id, user_id, voice_id) ON DELETE CASCADE,
  FOREIGN KEY (voice_authorization_id, voice_id, evaluator_user_id, cohort)
    REFERENCES voice_authorizations(id, voice_id, user_id, speaker_status) ON DELETE RESTRICT
);

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

ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS session_id text REFERENCES conversation_sessions(id) ON DELETE SET NULL;
ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS speech_tracking_failed boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turns_session_consistency
  ON conversation_turns(id, persona_id, session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_created
  ON conversation_turns(session_id, created_at) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_sentences (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id text NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  sentence_index integer NOT NULL CHECK (sentence_index >= 0),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  emotion text NOT NULL CHECK (emotion IN ('calm', 'warm', 'happy', 'sad', 'concerned', 'nostalgic')),
  intensity integer NOT NULL CHECK (intensity BETWEEN 0 AND 100),
  speed double precision NOT NULL CHECK (speed BETWEEN 0.75 AND 1.15),
  pause_after_ms integer NOT NULL CHECK (pause_after_ms BETWEEN 0 AND 300000),
  planner_version text NOT NULL CHECK (char_length(planner_version) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
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
  id text PRIMARY KEY,
  sentence_id text NOT NULL REFERENCES conversation_sentences(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  turn_id text NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  voice_id text NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  voice_source text CHECK (voice_source IS NULL OR voice_source IN ('preset', 'dynamic')),
  provider_voice_id text,
  tts_model text NOT NULL CHECK (char_length(tts_model) BETWEEN 1 AND 100),
  tts_config_version text NOT NULL CHECK (char_length(tts_config_version) BETWEEN 1 AND 100),
  fell_back boolean NOT NULL DEFAULT false,
  storage_ms integer CHECK (storage_ms IS NULL OR storage_ms >= 0),
  provider_ms integer CHECK (provider_ms IS NULL OR provider_ms >= 0),
  total_ms integer CHECK (total_ms IS NULL OR total_ms >= 0),
  stable_error_code text CHECK (stable_error_code IS NULL OR char_length(stable_error_code) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (sentence_id, attempt_no),
  FOREIGN KEY (sentence_id, session_id, turn_id, persona_id)
    REFERENCES conversation_sentences(id, session_id, turn_id, persona_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, persona_id, voice_id)
    REFERENCES conversation_sessions(id, persona_id, voice_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tts_attempts_session_turn
  ON tts_attempts(session_id, turn_id, created_at);

CREATE TABLE IF NOT EXISTS playback_events (
  event_id text PRIMARY KEY CHECK (char_length(event_id) BETWEEN 1 AND 100),
  tts_attempt_id text NOT NULL REFERENCES tts_attempts(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('audio_ready', 'play_started', 'play_completed', 'play_failed')),
  client_elapsed_ms integer NOT NULL CHECK (client_elapsed_ms BETWEEN 0 AND 300000),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_playback_events_attempt_received
  ON playback_events(tts_attempt_id, received_at);

CREATE TABLE IF NOT EXISTS conversation_feedback (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  evaluator_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evaluator_relation text NOT NULL CHECK (evaluator_relation IN ('self', 'family', 'friend', 'other')),
  knows_voice_owner boolean NOT NULL CHECK (knows_voice_owner = true),
  heard_all_rounds boolean NOT NULL CHECK (heard_all_rounds = true),
  voice_similarity integer NOT NULL CHECK (voice_similarity BETWEEN 1 AND 5),
  expression_similarity integer NOT NULL CHECK (expression_similarity BETWEEN 1 AND 5),
  emotion_fit integer NOT NULL CHECK (emotion_fit BETWEEN 1 AND 5),
  fact_trust integer NOT NULL CHECK (fact_trust BETWEEN 1 AND 5),
  discomfort integer NOT NULL CHECK (discomfort BETWEEN 1 AND 5),
  major_fabrication boolean NOT NULL,
  identity_impersonation boolean NOT NULL,
  authorization_violation boolean NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, evaluator_user_id),
  CHECK (comment IS NULL OR char_length(comment) <= 1000),
  FOREIGN KEY (session_id, persona_id, evaluator_user_id)
    REFERENCES conversation_sessions(id, persona_id, evaluator_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_feedback_created
  ON conversation_feedback(created_at DESC);
