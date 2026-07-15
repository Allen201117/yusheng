CREATE TABLE IF NOT EXISTS voice_review_operators (
  reviewer_id text PRIMARY KEY,
  credential_sha256 text NOT NULL UNIQUE CHECK (credential_sha256 ~ '^[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((active AND revoked_at IS NULL) OR (NOT active))
);

CREATE TABLE IF NOT EXISTS deployment_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('local', 'preview', 'production')),
  target_fingerprint text NOT NULL UNIQUE CHECK (target_fingerprint ~ '^[0-9a-f]{32}$'),
  configured_at timestamptz NOT NULL DEFAULT now(),
  configured_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('operator', 'system', 'user')),
  actor_id text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  target_environment text NOT NULL CHECK (target_environment IN ('local', 'preview', 'production')),
  target_fingerprint text NOT NULL CHECK (target_fingerprint ~ '^[0-9a-f]{32}$'),
  decision text CHECK (decision IN ('approve', 'reject')),
  reason_code text,
  request_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_target
  ON audit_events(target_type, target_id, created_at);

CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event_is_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_events_no_update ON audit_events;
CREATE TRIGGER trg_audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

DROP TRIGGER IF EXISTS trg_audit_events_no_delete ON audit_events;
CREATE TRIGGER trg_audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE OR REPLACE FUNCTION preserve_terminal_voice_review_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (
    OLD.status = 'approved' AND NEW.status NOT IN ('approved', 'revoked')
  ) OR (
    OLD.status IN ('rejected', 'revoked') AND NEW.status <> OLD.status
  ) OR (
    OLD.status IN ('approved', 'rejected', 'revoked') AND (
    NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
    OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
    )
  ) THEN
    RAISE EXCEPTION 'voice_authorization_review_is_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_voice_authorizations_terminal_review_immutable ON voice_authorizations;
CREATE TRIGGER trg_voice_authorizations_terminal_review_immutable
  BEFORE UPDATE OF status, reason_code, reviewed_at, reviewed_by ON voice_authorizations
  FOR EACH ROW EXECUTE FUNCTION preserve_terminal_voice_review_fields();
