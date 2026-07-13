CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE,
  phone text UNIQUE,
  password text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id text PRIMARY KEY,
  email text,
  phone text,
  code text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_verification_codes_email
  ON verification_codes (email, used, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_verification_codes_phone
  ON verification_codes (phone, used, expires_at DESC);

CREATE TABLE IF NOT EXISTS voice_profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_path text NOT NULL UNIQUE,
  checksum_sha256 text NOT NULL,
  prompt_text text NOT NULL,
  mime_type text NOT NULL,
  duration_sec double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_voice_profiles_user
  ON voice_profiles (user_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_voice_profiles_checksum
  ON voice_profiles (user_id, checksum_sha256)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS personas (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  relation text NOT NULL,
  voice_id text NOT NULL REFERENCES voice_profiles(id) ON DELETE RESTRICT,
  persona_desc text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_personas_user
  ON personas (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_personas_voice
  ON personas (user_id, voice_id);

CREATE TABLE IF NOT EXISTS memories (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  content text NOT NULL,
  embedding vector(1024),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_persona
  ON memories (persona_id, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_persona
  ON messages (persona_id, created_at DESC);
