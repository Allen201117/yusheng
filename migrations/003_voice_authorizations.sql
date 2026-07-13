CREATE TABLE IF NOT EXISTS voice_authorizations (
  id text PRIMARY KEY,
  voice_id text NOT NULL REFERENCES voice_profiles(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  speaker_status text NOT NULL CHECK (speaker_status IN ('living', 'deceased')),
  basis text NOT NULL CHECK (basis IN ('self', 'speaker_separate_consent', 'legal_representative', 'close_relative_request')),
  status text NOT NULL CHECK (status IN ('pending_review', 'approved', 'rejected', 'revoked')),
  reason_code text,
  notice_version text NOT NULL,
  separate_consent_confirmed boolean NOT NULL,
  third_party_processing_confirmed boolean NOT NULL,
  synthetic_disclosure_confirmed boolean NOT NULL,
  attested_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_authorizations_one_active
  ON voice_authorizations (voice_id, user_id)
  WHERE status IN ('pending_review', 'approved');

CREATE INDEX IF NOT EXISTS idx_voice_authorizations_owner_created
  ON voice_authorizations (user_id, voice_id, created_at DESC);
