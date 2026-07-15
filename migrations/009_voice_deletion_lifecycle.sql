ALTER TABLE voice_profiles
  ADD COLUMN IF NOT EXISTS provider_generation bigint NOT NULL DEFAULT 0;

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE TABLE IF NOT EXISTS voice_provider_operations (
  voice_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'cleanup_pending', 'closed')),
  provider_voice_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (voice_id, user_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_voice_provider_operations_cleanup
  ON voice_provider_operations (voice_id, user_id, generation)
  WHERE status <> 'closed';

CREATE TABLE IF NOT EXISTS voice_deletion_jobs (
  id text PRIMARY KEY,
  voice_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  authorization_id text,
  provider_voice_id text,
  provider_generation bigint NOT NULL,
  delete_conversation_data boolean NOT NULL CHECK (delete_conversation_data),
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'retry_pending', 'completed')),
  current_step text NOT NULL CHECK (current_step IN ('provider', 'personas', 'source', 'completed')),
  last_error_code text,
  attempt_count integer NOT NULL DEFAULT 0,
  lease_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_deletion_jobs_active
  ON voice_deletion_jobs (voice_id, user_id)
  WHERE status <> 'completed';

CREATE INDEX IF NOT EXISTS idx_voice_deletion_jobs_retry
  ON voice_deletion_jobs (status, updated_at)
  WHERE status = 'retry_pending';

CREATE TABLE IF NOT EXISTS voice_deletion_events (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  voice_id text NOT NULL,
  user_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('started', 'step_advanced', 'retry_pending', 'completed')),
  step text NOT NULL CHECK (step IN ('provider', 'personas', 'source', 'completed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_deletion_events_job
  ON voice_deletion_events (job_id, created_at);

CREATE TABLE IF NOT EXISTS persona_deletion_tombstones (
  persona_id text PRIMARY KEY,
  user_id text NOT NULL,
  voice_id text NOT NULL,
  deletion_job_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_voice_deletion_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'voice_deletion_audit_is_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_voice_deletion_events_append_only ON voice_deletion_events;
CREATE TRIGGER trg_voice_deletion_events_append_only
  BEFORE UPDATE OR DELETE ON voice_deletion_events
  FOR EACH ROW EXECUTE FUNCTION reject_voice_deletion_audit_mutation();

DROP TRIGGER IF EXISTS trg_persona_deletion_tombstones_append_only ON persona_deletion_tombstones;
CREATE TRIGGER trg_persona_deletion_tombstones_append_only
  BEFORE UPDATE OR DELETE ON persona_deletion_tombstones
  FOR EACH ROW EXECUTE FUNCTION reject_voice_deletion_audit_mutation();

CREATE OR REPLACE FUNCTION require_active_persona_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM personas
  WHERE id = NEW.persona_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'persona_deleted';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'memories', 'messages', 'persona_sources', 'persona_facts',
    'relationship_memories', 'speech_style_items', 'conversation_turns',
    'conversation_sessions', 'conversation_turn_evidence', 'message_evidence',
    'conversation_sentences', 'tts_attempts', 'conversation_feedback'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',
      'trg_' || table_name || '_active_persona_write', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION require_active_persona_write()',
      'trg_' || table_name || '_active_persona_write', table_name
    );
  END LOOP;
END;
$$;
