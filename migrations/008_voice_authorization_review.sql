ALTER TABLE voice_authorizations
  ADD COLUMN IF NOT EXISTS reviewed_by text;

UPDATE voice_authorizations
SET reviewed_at = COALESCE(reviewed_at, attested_at),
    reviewed_by = COALESCE(
      NULLIF(btrim(reviewed_by), ''),
      CASE WHEN status = 'approved' AND speaker_status = 'living' AND basis = 'self'
        THEN 'policy:self'
        ELSE 'policy:legacy'
      END
    )
WHERE (
    status IN ('approved', 'rejected')
    OR (status = 'revoked' AND speaker_status = 'living' AND basis = 'self')
  )
  AND (reviewed_at IS NULL OR reviewed_by IS NULL OR btrim(reviewed_by) = '');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'voice_authorizations_review_audit'
      AND conrelid = 'voice_authorizations'::regclass
  ) THEN
    ALTER TABLE voice_authorizations
      ADD CONSTRAINT voice_authorizations_review_audit CHECK (
        status NOT IN ('approved', 'rejected')
        OR (
          reviewed_at IS NOT NULL
          AND reviewed_by IS NOT NULL
          AND btrim(reviewed_by) <> ''
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_voice_authorizations_pending_review
  ON voice_authorizations (created_at, id)
  WHERE status = 'pending_review';
