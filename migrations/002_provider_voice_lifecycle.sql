ALTER TABLE voice_profiles
  ADD COLUMN IF NOT EXISTS provider_voice_id text,
  ADD COLUMN IF NOT EXISTS provider_voice_status text NOT NULL DEFAULT 'not_created',
  ADD COLUMN IF NOT EXISTS provider_voice_error_code text,
  ADD COLUMN IF NOT EXISTS provider_voice_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'voice_profiles_provider_voice_status_check'
  ) THEN
    ALTER TABLE voice_profiles
      ADD CONSTRAINT voice_profiles_provider_voice_status_check
      CHECK (provider_voice_status IN ('not_created', 'pending', 'ready', 'failed', 'deleting'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_voice_profiles_provider_status
  ON voice_profiles (provider_voice_status, provider_voice_updated_at)
  WHERE deleted_at IS NULL;
