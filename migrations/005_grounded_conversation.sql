ALTER TABLE persona_facts ADD COLUMN IF NOT EXISTS embedding vector(1024);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  user_message_id text NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id text UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  mode text CHECK (mode IN ('grounded', 'companionship', 'boundary')),
  status text NOT NULL CHECK (status IN ('started', 'completed', 'generation_failed', 'assistant_persistence_failed')),
  boundary_kind text CHECK (boundary_kind IN ('self_harm', 'real_world_danger', 'voice_authorization_denied', 'identity', 'real_will', 'commitment', 'major_decision')),
  degradation_reason text CHECK (degradation_reason IN ('no_relevant_evidence', 'retrieval_failed', 'embedding_backfill_partial', 'model_failed', 'assistant_persistence_failed')),
  retrieval_ms integer CHECK (retrieval_ms IS NULL OR retrieval_ms >= 0),
  first_sentence_ms integer CHECK (first_sentence_ms IS NULL OR first_sentence_ms >= 0),
  total_ms integer CHECK (total_ms IS NULL OR total_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'started' AND assistant_message_id IS NULL AND mode IS NULL AND boundary_kind IS NULL)
    OR (status = 'completed' AND assistant_message_id IS NOT NULL AND mode IS NOT NULL AND total_ms IS NOT NULL)
    OR (status IN ('generation_failed', 'assistant_persistence_failed') AND assistant_message_id IS NULL)
  ),
  CHECK (
    status <> 'completed'
    OR (mode = 'boundary' AND boundary_kind IS NOT NULL)
    OR (mode IN ('grounded', 'companionship') AND boundary_kind IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS conversation_turn_evidence (
  turn_id text NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('fact', 'relationship_memory')),
  item_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, item_kind, item_id)
);

CREATE TABLE IF NOT EXISTS message_evidence (
  assistant_message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  item_kind text NOT NULL CHECK (item_kind IN ('fact', 'relationship_memory')),
  item_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assistant_message_id, item_kind, item_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_persona_created
  ON conversation_turns(persona_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_turn_evidence_persona_turn
  ON conversation_turn_evidence(persona_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_message_evidence_persona_message
  ON message_evidence(persona_id, assistant_message_id);
