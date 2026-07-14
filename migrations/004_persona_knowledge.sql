CREATE TABLE IF NOT EXISTS persona_sources (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN (
    'manual_text', 'chat_export', 'audio_transcript', 'text_document', 'legacy_import'
  )),
  content_text text,
  object_path text,
  checksum_algorithm text NOT NULL CHECK (checksum_algorithm IN ('sha256', 'legacy_id')),
  checksum text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'failed', 'revoked')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS persona_facts (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  fact_type text NOT NULL,
  fact_key text NOT NULL,
  content text NOT NULL,
  normalized_value text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'conflicted', 'revoked')),
  conflict_group_id text,
  confirmed_by text,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relationship_memories (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  content text NOT NULL,
  occurred_at timestamptz,
  location text,
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  embedding vector(1024),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'conflicted', 'revoked')),
  conflict_group_id text,
  confirmed_by text,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS speech_style_items (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  category text NOT NULL,
  content text NOT NULL,
  example text,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'conflicted', 'revoked')),
  conflict_group_id text,
  confirmed_by text,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS persona_item_sources (
  item_kind text NOT NULL CHECK (item_kind IN ('fact', 'relationship_memory', 'speech_style')),
  item_id text NOT NULL,
  source_id text NOT NULL REFERENCES persona_sources(id) ON DELETE CASCADE,
  source_excerpt text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_kind, item_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_persona_sources_persona
  ON persona_sources (persona_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_persona_facts_confirmed
  ON persona_facts (persona_id, fact_type, fact_key)
  WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_relationship_memories_confirmed
  ON relationship_memories (persona_id, created_at DESC)
  WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_speech_style_items_confirmed
  ON speech_style_items (persona_id, category, created_at DESC)
  WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_persona_item_sources_source
  ON persona_item_sources (source_id);

INSERT INTO persona_sources (
  id,
  persona_id,
  source_type,
  checksum_algorithm,
  checksum,
  status,
  created_by,
  created_at
)
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
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO relationship_memories (
  id,
  persona_id,
  content,
  embedding,
  status,
  confirmed_at,
  created_at,
  updated_at
)
SELECT
  m.id,
  m.persona_id,
  m.content,
  m.embedding,
  'confirmed',
  m.created_at,
  m.created_at,
  m.created_at
FROM memories m
ON CONFLICT (id) DO NOTHING;

INSERT INTO persona_item_sources (
  item_kind,
  item_id,
  source_id,
  source_excerpt
)
SELECT
  'relationship_memory',
  m.id,
  'legacy-memory-source:' || m.persona_id,
  m.content
FROM memories m
ON CONFLICT (item_kind, item_id, source_id) DO NOTHING;
