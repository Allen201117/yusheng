import { randomUUID } from "node:crypto";
import { EMBEDDING_DIM } from "../embedding";
import { normalizePersonaKnowledgeText } from "../personaKnowledge";
import {
  buildPersonaKnowledgeReviewResult,
  planPersonaKnowledgeReview,
  requirePersonaKnowledgeEditsAllowed,
} from "../personaKnowledgeService";
import type { SqlExecutor } from "./postgres";
import type {
  AppRepository,
  CreatePersonaKnowledgeCandidateInput,
  CreatePersonaInput,
  CreatePersonaSourceInput,
  CreateVoiceAuthorizationInput,
  CreateVoiceProfileInput,
  InsertMemoryInput,
  InsertMessageInput,
  Memory,
  MemoryEmbedding,
  Message,
  Persona,
  PersonaFact,
  PersonaKnowledgeBundle,
  PersonaKnowledgeItem,
  PersonaKnowledgeKind,
  PersonaKnowledgeAtomicReviewInput,
  PersonaKnowledgeReviewResult,
  PersonaKnowledgeStatus,
  PersonaKnowledgeStatusChange,
  PersonaSource,
  RelationshipMemory,
  SpeechStyleItem,
  User,
  VoiceAuthorization,
  VoiceMeta,
} from "./types";

type PersonaRow = {
  id: string;
  user_id: string;
  name: string;
  relation: string;
  voice_id: string;
  persona_desc: string;
  created_at: Date | string;
};

type UserRow = {
  id: string;
  email: string | null;
  phone: string | null;
  password: string | null;
  created_at: Date | string;
};

type MemoryRow = {
  id: string;
  persona_id: string;
  content: string;
  created_at: Date | string;
};

type MemoryEmbeddingRow = {
  id: string;
  content: string;
  embedding: string | number[] | null;
};

type PersonaSourceRow = {
  id: string;
  persona_id: string;
  source_type: PersonaSource["sourceType"];
  content_text: string | null;
  object_path: string | null;
  checksum_algorithm: PersonaSource["checksumAlgorithm"];
  checksum: string;
  status: PersonaSource["status"];
  created_by: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
};

type PersonaFactRow = {
  id: string;
  persona_id: string;
  fact_type: string;
  fact_key: string;
  content: string;
  normalized_value: string;
  status: PersonaKnowledgeStatus;
  conflict_group_id: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type RelationshipMemoryRow = {
  id: string;
  persona_id: string;
  content: string;
  occurred_at: Date | string | null;
  location: string | null;
  participants: unknown;
  status: PersonaKnowledgeStatus;
  conflict_group_id: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type SpeechStyleItemRow = {
  id: string;
  persona_id: string;
  category: string;
  content: string;
  example: string | null;
  status: PersonaKnowledgeStatus;
  conflict_group_id: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type MessageRow = {
  id: string;
  persona_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: Date | string;
};

type VoiceProfileRow = {
  id: string;
  user_id: string;
  object_path: string;
  checksum_sha256: string;
  prompt_text: string;
  mime_type: string;
  duration_sec: number | string | null;
  provider_voice_id?: string | null;
  provider_voice_status?: VoiceMeta["providerVoiceStatus"];
  provider_voice_error_code?: string | null;
  provider_voice_updated_at?: Date | string | null;
  created_at: Date | string;
};

type VoiceAuthorizationRow = {
  id: string;
  voice_id: string;
  user_id: string;
  speaker_status: VoiceAuthorization["speakerStatus"];
  basis: VoiceAuthorization["basis"];
  status: VoiceAuthorization["status"];
  reason_code: string | null;
  notice_version: string;
  separate_consent_confirmed: boolean;
  third_party_processing_confirmed: boolean;
  synthetic_disclosure_confirmed: boolean;
  attested_at: Date | string;
  reviewed_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
};

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIsoString(value: Date | string | null): string | null {
  return value === null ? null : toIsoString(value);
}

const KNOWLEDGE_TABLES = {
  fact: "persona_facts",
  relationship_memory: "relationship_memories",
  speech_style: "speech_style_items",
} as const;

const EMBEDDING_KNOWLEDGE_TABLES = {
  fact: "persona_facts",
  relationship_memory: "relationship_memories",
} as const;

const PERSONA_SOURCE_COLUMNS = `
  id, persona_id, source_type, content_text, object_path, checksum_algorithm,
  checksum, status, created_by, created_at, revoked_at
`;
const PERSONA_FACT_COLUMNS = `
  id, persona_id, fact_type, fact_key, content, normalized_value, status,
  conflict_group_id, confirmed_by, confirmed_at, revoked_at, created_at, updated_at
`;
const RELATIONSHIP_MEMORY_COLUMNS = `
  id, persona_id, content, occurred_at, location, participants, status,
  conflict_group_id, confirmed_by, confirmed_at, revoked_at, created_at, updated_at
`;
const SPEECH_STYLE_COLUMNS = `
  id, persona_id, category, content, example, status, conflict_group_id,
  confirmed_by, confirmed_at, revoked_at, created_at, updated_at
`;

function parseParticipants(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function mapPersonaSource(row: PersonaSourceRow): PersonaSource {
  return {
    id: row.id,
    personaId: row.persona_id,
    sourceType: row.source_type,
    contentText: row.content_text,
    objectPath: row.object_path,
    checksumAlgorithm: row.checksum_algorithm,
    checksum: row.checksum,
    status: row.status,
    createdBy: row.created_by,
    createdAt: toIsoString(row.created_at),
    revokedAt: toNullableIsoString(row.revoked_at),
  };
}

function mapPersonaFact(row: PersonaFactRow): PersonaFact {
  return {
    kind: "fact",
    id: row.id,
    personaId: row.persona_id,
    factType: row.fact_type,
    factKey: row.fact_key,
    content: row.content,
    normalizedValue: row.normalized_value,
    status: row.status,
    conflictGroupId: row.conflict_group_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: toNullableIsoString(row.confirmed_at),
    revokedAt: toNullableIsoString(row.revoked_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapRelationshipMemory(row: RelationshipMemoryRow): RelationshipMemory {
  return {
    kind: "relationship_memory",
    id: row.id,
    personaId: row.persona_id,
    content: row.content,
    occurredAt: toNullableIsoString(row.occurred_at),
    location: row.location,
    participants: parseParticipants(row.participants),
    status: row.status,
    conflictGroupId: row.conflict_group_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: toNullableIsoString(row.confirmed_at),
    revokedAt: toNullableIsoString(row.revoked_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapSpeechStyleItem(row: SpeechStyleItemRow): SpeechStyleItem {
  return {
    kind: "speech_style",
    id: row.id,
    personaId: row.persona_id,
    category: row.category,
    content: row.content,
    example: row.example,
    status: row.status,
    conflictGroupId: row.conflict_group_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: toNullableIsoString(row.confirmed_at),
    revokedAt: toNullableIsoString(row.revoked_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapKnowledgeItem(kind: PersonaKnowledgeKind, row: Record<string, unknown>): PersonaKnowledgeItem {
  if (kind === "fact") return mapPersonaFact(row as PersonaFactRow);
  if (kind === "relationship_memory") return mapRelationshipMemory(row as RelationshipMemoryRow);
  return mapSpeechStyleItem(row as SpeechStyleItemRow);
}

function columnsForKnowledgeKind(kind: PersonaKnowledgeKind): string {
  if (kind === "fact") return PERSONA_FACT_COLUMNS;
  if (kind === "relationship_memory") return RELATIONSHIP_MEMORY_COLUMNS;
  return SPEECH_STYLE_COLUMNS;
}

const EDITABLE_KNOWLEDGE_COLUMNS: Record<
  PersonaKnowledgeKind,
  Record<string, string>
> = {
  fact: {
    factType: "fact_type",
    factKey: "fact_key",
    content: "content",
    normalizedValue: "normalized_value",
  },
  relationship_memory: {
    content: "content",
    occurredAt: "occurred_at",
    location: "location",
    participants: "participants",
  },
  speech_style: { category: "category", content: "content", example: "example" },
};

async function getPersonaKnowledgeItemWith(
  executor: SqlExecutor,
  kind: PersonaKnowledgeKind,
  id: string,
  personaId: string,
  forUpdate = false,
): Promise<PersonaKnowledgeItem | null> {
  const table = KNOWLEDGE_TABLES[kind];
  const rows = await executor.query<Record<string, unknown>>(
    `SELECT ${columnsForKnowledgeKind(kind)} FROM ${table}
     WHERE id = $1 AND persona_id = $2${forUpdate ? "\n     FOR UPDATE" : ""}`,
    [id, personaId],
  );
  return rows[0] ? mapKnowledgeItem(kind, rows[0]) : null;
}

async function findConfirmedFactsWith(
  executor: SqlExecutor,
  personaId: string,
  factType: string,
  factKey: string,
): Promise<PersonaFact[]> {
  const rows = await executor.query<PersonaFactRow>(
    `SELECT ${PERSONA_FACT_COLUMNS} FROM persona_facts
     WHERE persona_id = $1 AND status = 'confirmed'
     ORDER BY created_at, id`,
    [personaId],
  );
  const normalizedFactType = normalizePersonaKnowledgeText(factType);
  const normalizedFactKey = normalizePersonaKnowledgeText(factKey);
  return rows
    .map(mapPersonaFact)
    .filter((fact) =>
      normalizePersonaKnowledgeText(fact.factType) === normalizedFactType
      && normalizePersonaKnowledgeText(fact.factKey) === normalizedFactKey);
}

async function updatePersonaKnowledgeCandidateWith(
  executor: SqlExecutor,
  input: {
    kind: PersonaKnowledgeKind;
    id: string;
    personaId: string;
    expectedStatus: "pending" | "conflicted";
    patch: Record<string, string | string[] | null>;
  },
): Promise<PersonaKnowledgeItem | null> {
  const allowed = EDITABLE_KNOWLEDGE_COLUMNS[input.kind];
  const entries = Object.entries(input.patch).filter(([key]) => allowed[key]);
  if (entries.length === 0) {
    const table = KNOWLEDGE_TABLES[input.kind];
    const rows = await executor.query<Record<string, unknown>>(
      `SELECT ${columnsForKnowledgeKind(input.kind)} FROM ${table}
       WHERE id = $1 AND persona_id = $2 AND status = $3`,
      [input.id, input.personaId, input.expectedStatus],
    );
    return rows[0] ? mapKnowledgeItem(input.kind, rows[0]) : null;
  }
  const values: unknown[] = [input.id, input.personaId, input.expectedStatus];
  const assignments = entries.map(([key, value]) => {
    values.push(
      input.kind === "relationship_memory" && key === "participants"
        ? JSON.stringify(Array.isArray(value) ? value : [])
        : value,
    );
    const cast = input.kind === "relationship_memory" && key === "participants" ? "::jsonb" : "";
    return `${allowed[key]} = $${values.length}${cast}`;
  });
  const table = KNOWLEDGE_TABLES[input.kind];
  const rows = await executor.query<Record<string, unknown>>(
    `UPDATE ${table}
     SET ${assignments.join(", ")}, status = 'pending', conflict_group_id = NULL,
         confirmed_by = NULL, confirmed_at = NULL, revoked_at = NULL, updated_at = now()
     WHERE id = $1 AND persona_id = $2 AND status = $3
     RETURNING ${columnsForKnowledgeKind(input.kind)}`,
    values,
  );
  return rows[0] ? mapKnowledgeItem(input.kind, rows[0]) : null;
}

async function setPersonaKnowledgeStatusesWith(
  executor: SqlExecutor,
  inputs: PersonaKnowledgeStatusChange[],
): Promise<PersonaKnowledgeItem[]> {
  const changed: PersonaKnowledgeItem[] = [];
  for (const input of inputs) {
    const table = KNOWLEDGE_TABLES[input.kind];
    const rows = await executor.query<Record<string, unknown>>(
      `UPDATE ${table}
       SET status = $4,
           confirmed_by = CASE WHEN $4 = 'confirmed' THEN $5 ELSE NULL END,
           confirmed_at = CASE WHEN $4 = 'confirmed' THEN now() ELSE NULL END,
           conflict_group_id = $6,
           revoked_at = CASE WHEN $4 = 'revoked' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1 AND persona_id = $2 AND status = $3
       RETURNING ${columnsForKnowledgeKind(input.kind)}`,
      [
        input.id, input.personaId, input.expectedStatus, input.nextStatus,
        input.actorUserId, input.conflictGroupId,
      ],
    );
    if (!rows[0]) throw new Error("knowledge_status_changed");
    changed.push(mapKnowledgeItem(input.kind, rows[0]));
  }
  return changed;
}

async function storeKnowledgeEmbeddingWith(
  executor: SqlExecutor,
  kind: keyof typeof EMBEDDING_KNOWLEDGE_TABLES,
  id: string,
  personaId: string,
  vector: Float32Array,
): Promise<void> {
  const table = EMBEDDING_KNOWLEDGE_TABLES[kind];
  const rows = await executor.query<{ id: string }>(
    `UPDATE ${table}
     SET embedding = $3::vector
     WHERE id = $1 AND persona_id = $2
     RETURNING id`,
    [id, personaId, serializeVector(vector)],
  );
  if (!rows[0]) throw new Error("knowledge_embedding_stale");
}

function mapPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    relation: row.relation,
    voiceId: row.voice_id,
    personaDesc: row.persona_desc,
    createdAt: toIsoString(row.created_at),
  };
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email || "",
    phone: row.phone || "",
    password: row.password || "",
    createdAt: toIsoString(row.created_at),
  };
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    personaId: row.persona_id,
    content: row.content,
    createdAt: toIsoString(row.created_at),
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    personaId: row.persona_id,
    role: row.role,
    content: row.content,
    createdAt: toIsoString(row.created_at),
  };
}

function mapVoiceProfile(row: VoiceProfileRow): VoiceMeta {
  return {
    voiceId: row.id,
    userId: row.user_id,
    objectPath: row.object_path,
    audioFile: row.object_path,
    checksumSha256: row.checksum_sha256,
    promptText: row.prompt_text,
    mimeType: row.mime_type,
    durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
    providerVoiceId: row.provider_voice_id || null,
    providerVoiceStatus: row.provider_voice_status || "not_created",
    providerVoiceErrorCode: row.provider_voice_error_code || null,
    providerVoiceUpdatedAt: row.provider_voice_updated_at
      ? toIsoString(row.provider_voice_updated_at)
      : null,
    createdAt: toIsoString(row.created_at),
  };
}

function mapVoiceAuthorization(row: VoiceAuthorizationRow): VoiceAuthorization {
  return {
    id: row.id,
    voiceId: row.voice_id,
    userId: row.user_id,
    speakerStatus: row.speaker_status,
    basis: row.basis,
    status: row.status,
    reasonCode: row.reason_code,
    noticeVersion: row.notice_version,
    separateConsentConfirmed: row.separate_consent_confirmed,
    thirdPartyProcessingConfirmed: row.third_party_processing_confirmed,
    syntheticDisclosureConfirmed: row.synthetic_disclosure_confirmed,
    attestedAt: toIsoString(row.attested_at),
    reviewedAt: row.reviewed_at ? toIsoString(row.reviewed_at) : null,
    revokedAt: row.revoked_at ? toIsoString(row.revoked_at) : null,
    createdAt: toIsoString(row.created_at),
  };
}

const VOICE_AUTHORIZATION_COLUMNS = `
  id, voice_id, user_id, speaker_status, basis, status, reason_code, notice_version,
  separate_consent_confirmed, third_party_processing_confirmed,
  synthetic_disclosure_confirmed, attested_at, reviewed_at, revoked_at, created_at
`;

function parseVector(value: string | number[]): Float32Array {
  if (Array.isArray(value)) return Float32Array.from(value);
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error("Invalid pgvector value");
  }
  if (trimmed === "[]") return new Float32Array();
  return Float32Array.from(trimmed.slice(1, -1).split(",").map(Number));
}

function serializeVector(value: Float32Array): string {
  return `[${Array.from(value).join(",")}]`;
}

async function insertMemoryWith(executor: SqlExecutor, input: InsertMemoryInput): Promise<void> {
  const sources = await executor.query<{ id: string }>(
    `INSERT INTO persona_sources
       (id, persona_id, source_type, content_text, object_path, checksum_algorithm,
        checksum, status, created_by)
     SELECT $1, $2, 'manual_text', $3, NULL, $4, $5, 'ready', $6
     FROM personas persona
     WHERE persona.id = $2 AND persona.user_id = $6
     RETURNING id`,
    [
      input.sourceId,
      input.personaId,
      input.content,
      input.checksumAlgorithm,
      input.checksum,
      input.createdBy,
    ],
  );
  if (!sources[0]) throw new Error("persona_source_insert_failed");

  const memories = await executor.query<{ id: string }>(
    `INSERT INTO relationship_memories
       (id, persona_id, content, participants, embedding, status,
        confirmed_by, confirmed_at, created_at, updated_at)
     SELECT $1, $2, $3, '[]'::jsonb, $4::vector, 'confirmed', $5, now(), now(), now()
     FROM persona_sources source
     WHERE source.id = $6 AND source.persona_id = $2
     RETURNING id`,
    [
      input.id,
      input.personaId,
      input.content,
      serializeVector(input.embedding),
      input.createdBy,
      input.sourceId,
    ],
  );
  if (!memories[0]) throw new Error("relationship_memory_insert_failed");

  const links = await executor.query<{ item_id: string }>(
    `INSERT INTO persona_item_sources
       (item_kind, item_id, source_id, source_excerpt)
     SELECT 'relationship_memory', memory.id, source.id, $2
     FROM relationship_memories memory
     JOIN persona_sources source ON source.persona_id = memory.persona_id
     WHERE memory.id = $1 AND memory.persona_id = $4 AND source.id = $3
     RETURNING item_id`,
    [input.id, input.content, input.sourceId, input.personaId],
  );
  if (!links[0]) throw new Error("persona_source_link_failed");
}

export function createPostgresRepository(sql: SqlExecutor): AppRepository {
  async function getCurrentVoiceAuthorizationForUser(
    voiceId: string,
    userId: string,
  ): Promise<VoiceAuthorization | null> {
    const rows = await sql.query<VoiceAuthorizationRow>(
      `SELECT ${VOICE_AUTHORIZATION_COLUMNS}
       FROM voice_authorizations
       WHERE voice_id = $1 AND user_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [voiceId, userId],
    );
    return rows[0] ? mapVoiceAuthorization(rows[0]) : null;
  }

  return {
    async getUserByEmail(email: string): Promise<User | null> {
      const rows = await sql.query<UserRow>(
        `SELECT id, email, phone, password, created_at FROM users WHERE email = $1`,
        [email],
      );
      return rows[0] ? mapUser(rows[0]) : null;
    },

    async createUserByEmail(email: string, passwordHash = ""): Promise<User> {
      const rows = await sql.query<UserRow>(
        `INSERT INTO users (id, email, password)
         VALUES ($1, $2, $3)
         RETURNING id, email, phone, password, created_at`,
        [randomUUID(), email, passwordHash || null],
      );
      if (!rows[0]) throw new Error("Failed to create user");
      return mapUser(rows[0]);
    },

    async setUserPassword(email: string, hash: string): Promise<void> {
      await sql.query(`UPDATE users SET password = $1 WHERE email = $2`, [hash, email]);
    },

    async createVerificationCode(target, code, ttlMinutes = 5): Promise<void> {
      await sql.query(
        `INSERT INTO verification_codes (id, email, phone, code, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 minute'))`,
        [randomUUID(), target.email || null, target.phone || null, code, ttlMinutes],
      );
    },

    async verifyCode(target, code): Promise<boolean> {
      const column = target.email ? "email" : target.phone ? "phone" : null;
      const value = target.email || target.phone;
      if (!column || !value) return false;
      return sql.transaction(async (transaction) => {
        const rows = await transaction.query<{ id: string }>(
          `UPDATE verification_codes
           SET used = true
           WHERE id = (
             SELECT id FROM verification_codes
             WHERE ${column} = $1 AND code = $2 AND used = false AND expires_at > now()
             ORDER BY expires_at DESC
             LIMIT 1
             FOR UPDATE
           )
           RETURNING id`,
          [value, code],
        );
        return Boolean(rows[0]);
      });
    },

    async listPersonas(userId: string): Promise<Persona[]> {
      const rows = await sql.query<PersonaRow>(
        `SELECT id, user_id, name, relation, voice_id, persona_desc, created_at
         FROM personas WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      );
      return rows.map(mapPersona);
    },

    async getPersonaForUser(id: string, userId: string): Promise<Persona | null> {
      const rows = await sql.query<PersonaRow>(
        `SELECT id, user_id, name, relation, voice_id, persona_desc, created_at
         FROM personas
         WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      return rows[0] ? mapPersona(rows[0]) : null;
    },

    async createPersona(input: CreatePersonaInput): Promise<Persona> {
      const rows = await sql.query<PersonaRow>(
        `INSERT INTO personas (id, user_id, name, relation, voice_id, persona_desc)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, user_id, name, relation, voice_id, persona_desc, created_at`,
        [input.id, input.userId, input.name, input.relation, input.voiceId, input.personaDesc],
      );
      if (!rows[0]) throw new Error("Failed to create persona");
      return mapPersona(rows[0]);
    },

    async deletePersona(id: string, userId: string): Promise<Persona | null> {
      return sql.transaction(async (transaction) => {
        const rows = await transaction.query<PersonaRow>(
          `DELETE FROM personas
           WHERE id = $1 AND user_id = $2
           RETURNING id, user_id, name, relation, voice_id, persona_desc, created_at`,
          [id, userId],
        );
        return rows[0] ? mapPersona(rows[0]) : null;
      });
    },

    async countPersonasUsingVoice(voiceId: string, userId: string): Promise<number> {
      const rows = await sql.query<{ count: number | string }>(
        `SELECT COUNT(*) AS count FROM personas WHERE voice_id = $1 AND user_id = $2`,
        [voiceId, userId],
      );
      return Number(rows[0]?.count || 0);
    },

    async createVoiceProfile(input: CreateVoiceProfileInput): Promise<VoiceMeta> {
      const rows = await sql.query<VoiceProfileRow>(
        `INSERT INTO voice_profiles
           (id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec,
                   provider_voice_id, provider_voice_status, provider_voice_error_code,
                   provider_voice_updated_at, created_at`,
        [input.voiceId, input.userId, input.objectPath, input.checksumSha256, input.promptText, input.mimeType, input.durationSec],
      );
      if (!rows[0]) throw new Error("Failed to create voice profile");
      return mapVoiceProfile(rows[0]);
    },

    async getVoiceProfileForUser(voiceId: string, userId: string): Promise<VoiceMeta | null> {
      const rows = await sql.query<VoiceProfileRow>(
        `SELECT id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec,
                provider_voice_id, provider_voice_status, provider_voice_error_code,
                provider_voice_updated_at, created_at
         FROM voice_profiles
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [voiceId, userId],
      );
      return rows[0] ? mapVoiceProfile(rows[0]) : null;
    },

    async listVoiceProfiles(userId: string): Promise<VoiceMeta[]> {
      const rows = await sql.query<VoiceProfileRow>(
        `SELECT id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec,
                provider_voice_id, provider_voice_status, provider_voice_error_code,
                provider_voice_updated_at, created_at
         FROM voice_profiles
         WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC`,
        [userId],
      );
      return rows.map(mapVoiceProfile);
    },

    async updateVoiceProviderState(voiceId, userId, input): Promise<VoiceMeta | null> {
      const rows = await sql.query<VoiceProfileRow>(
        `UPDATE voice_profiles
         SET provider_voice_id = $3,
             provider_voice_status = $4,
             provider_voice_error_code = $5,
             provider_voice_updated_at = now()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, user_id, object_path, checksum_sha256, prompt_text, mime_type, duration_sec,
                   provider_voice_id, provider_voice_status, provider_voice_error_code,
                   provider_voice_updated_at, created_at`,
        [voiceId, userId, input.providerVoiceId, input.status, input.errorCode],
      );
      return rows[0] ? mapVoiceProfile(rows[0]) : null;
    },

    async deleteVoiceProfile(voiceId: string, userId: string): Promise<boolean> {
      const rows = await sql.query<{ id: string }>(
        `UPDATE voice_profiles SET deleted_at = now()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [voiceId, userId],
      );
      return Boolean(rows[0]);
    },

    async replaceVoiceAuthorization(
      input: CreateVoiceAuthorizationInput,
    ): Promise<VoiceAuthorization> {
      return sql.transaction(async (transaction) => {
        await transaction.query(
          `UPDATE voice_authorizations
           SET status = 'revoked', revoked_at = now()
           WHERE voice_id = $1 AND user_id = $2
             AND status IN ('pending_review', 'approved')`,
          [input.voiceId, input.userId],
        );
        const rows = await transaction.query<VoiceAuthorizationRow>(
          `INSERT INTO voice_authorizations
             (id, voice_id, user_id, speaker_status, basis, status, reason_code,
              notice_version, separate_consent_confirmed,
              third_party_processing_confirmed, synthetic_disclosure_confirmed, attested_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING ${VOICE_AUTHORIZATION_COLUMNS}`,
          [
            input.id,
            input.voiceId,
            input.userId,
            input.speakerStatus,
            input.basis,
            input.status,
            input.reasonCode,
            input.noticeVersion,
            input.separateConsentConfirmed,
            input.thirdPartyProcessingConfirmed,
            input.syntheticDisclosureConfirmed,
            input.attestedAt,
          ],
        );
        if (!rows[0]) throw new Error("Failed to create voice authorization");
        return mapVoiceAuthorization(rows[0]);
      });
    },

    async getCurrentVoiceAuthorization(voiceId, userId): Promise<VoiceAuthorization | null> {
      return getCurrentVoiceAuthorizationForUser(voiceId, userId);
    },

    async revokeVoiceAuthorization(voiceId, userId): Promise<VoiceAuthorization | null> {
      const rows = await sql.query<VoiceAuthorizationRow>(
        `UPDATE voice_authorizations
         SET status = 'revoked', revoked_at = now()
         WHERE id = (
           SELECT id FROM voice_authorizations
           WHERE voice_id = $1 AND user_id = $2
             AND status IN ('pending_review', 'approved')
           ORDER BY created_at DESC, id DESC
           LIMIT 1
           FOR UPDATE
         )
         RETURNING ${VOICE_AUTHORIZATION_COLUMNS}`,
        [voiceId, userId],
      );
      if (rows[0]) return mapVoiceAuthorization(rows[0]);
      return getCurrentVoiceAuthorizationForUser(voiceId, userId);
    },

    async createPersonaKnowledgeCandidates(input: {
      source: CreatePersonaSourceInput;
      candidates: CreatePersonaKnowledgeCandidateInput[];
    }): Promise<PersonaKnowledgeBundle> {
      return sql.transaction(async (transaction) => {
        for (const candidate of input.candidates) {
          if (candidate.personaId !== input.source.personaId) throw new Error("persona_mismatch");
          if (candidate.sourceId !== input.source.id) throw new Error("source_mismatch");
        }
        const sourceRows = await transaction.query<PersonaSourceRow>(
          `INSERT INTO persona_sources
             (id, persona_id, source_type, content_text, object_path, checksum_algorithm,
              checksum, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${PERSONA_SOURCE_COLUMNS}`,
          [
            input.source.id,
            input.source.personaId,
            input.source.sourceType,
            input.source.contentText,
            input.source.objectPath,
            input.source.checksumAlgorithm,
            input.source.checksum,
            input.source.status,
            input.source.createdBy,
          ],
        );
        if (!sourceRows[0]) throw new Error("Failed to create persona source");
        const facts: PersonaFact[] = [];
        const memories: RelationshipMemory[] = [];
        const styles: SpeechStyleItem[] = [];
        for (const candidate of input.candidates) {
          if (candidate.kind === "fact") {
            const rows = await transaction.query<PersonaFactRow>(
              `INSERT INTO persona_facts
                 (id, persona_id, fact_type, fact_key, content, normalized_value, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'pending')
               RETURNING ${PERSONA_FACT_COLUMNS}`,
              [
                candidate.id, candidate.personaId, candidate.factType, candidate.factKey,
                candidate.content, candidate.normalizedValue,
              ],
            );
            if (!rows[0]) throw new Error("Failed to create persona fact");
            facts.push(mapPersonaFact(rows[0]));
          } else if (candidate.kind === "relationship_memory") {
            const rows = await transaction.query<RelationshipMemoryRow>(
              `INSERT INTO relationship_memories
                 (id, persona_id, content, occurred_at, location, participants, embedding, status)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::vector, 'pending')
               RETURNING ${RELATIONSHIP_MEMORY_COLUMNS}`,
              [
                candidate.id, candidate.personaId, candidate.content, candidate.occurredAt,
                candidate.location, JSON.stringify(candidate.participants),
                candidate.embedding ? serializeVector(candidate.embedding) : null,
              ],
            );
            if (!rows[0]) throw new Error("Failed to create relationship memory");
            memories.push(mapRelationshipMemory(rows[0]));
          } else {
            const rows = await transaction.query<SpeechStyleItemRow>(
              `INSERT INTO speech_style_items
                 (id, persona_id, category, content, example, status)
               VALUES ($1, $2, $3, $4, $5, 'pending')
               RETURNING ${SPEECH_STYLE_COLUMNS}`,
              [candidate.id, candidate.personaId, candidate.category, candidate.content, candidate.example],
            );
            if (!rows[0]) throw new Error("Failed to create speech style item");
            styles.push(mapSpeechStyleItem(rows[0]));
          }
          const linkRows = await transaction.query<{ item_id: string }>(
            `INSERT INTO persona_item_sources
               (item_kind, item_id, source_id, source_excerpt)
             SELECT $1, $2, source.id, $4
             FROM persona_sources source
             WHERE source.id = $3 AND source.persona_id = $5
             RETURNING item_id`,
            [
              candidate.kind, candidate.id, candidate.sourceId, candidate.sourceExcerpt,
              candidate.personaId,
            ],
          );
          if (linkRows.length !== 1) throw new Error("persona_source_link_failed");
        }
        return {
          sources: [mapPersonaSource(sourceRows[0])],
          facts,
          memories,
          styles,
        };
      });
    },

    async listPersonaKnowledge(personaId: string): Promise<PersonaKnowledgeBundle> {
      const [sources, facts, memories, styles] = await Promise.all([
        sql.query<PersonaSourceRow>(
          `SELECT ${PERSONA_SOURCE_COLUMNS} FROM persona_sources
           WHERE persona_id = $1 ORDER BY created_at, id`,
          [personaId],
        ),
        sql.query<PersonaFactRow>(
          `SELECT ${PERSONA_FACT_COLUMNS} FROM persona_facts
           WHERE persona_id = $1 ORDER BY created_at, id`,
          [personaId],
        ),
        sql.query<RelationshipMemoryRow>(
          `SELECT ${RELATIONSHIP_MEMORY_COLUMNS} FROM relationship_memories
           WHERE persona_id = $1 ORDER BY created_at, id`,
          [personaId],
        ),
        sql.query<SpeechStyleItemRow>(
          `SELECT ${SPEECH_STYLE_COLUMNS} FROM speech_style_items
           WHERE persona_id = $1 ORDER BY created_at, id`,
          [personaId],
        ),
      ]);
      return {
        sources: sources.map(mapPersonaSource),
        facts: facts.map(mapPersonaFact),
        memories: memories.map(mapRelationshipMemory),
        styles: styles.map(mapSpeechStyleItem),
      };
    },

    async getPersonaKnowledgeItem(
      kind: PersonaKnowledgeKind,
      id: string,
      personaId: string,
    ): Promise<PersonaKnowledgeItem | null> {
      return getPersonaKnowledgeItemWith(sql, kind, id, personaId);
    },

    async findConfirmedFacts(
      personaId: string,
      factType: string,
      factKey: string,
    ): Promise<PersonaFact[]> {
      return findConfirmedFactsWith(sql, personaId, factType, factKey);
    },

    async updatePersonaKnowledgeCandidate(input): Promise<PersonaKnowledgeItem | null> {
      return updatePersonaKnowledgeCandidateWith(sql, input);
    },

    async setPersonaKnowledgeStatuses(inputs): Promise<PersonaKnowledgeItem[]> {
      return sql.transaction((transaction) => setPersonaKnowledgeStatusesWith(transaction, inputs));
    },

    async reviewPersonaKnowledgeAtomically(
      input: PersonaKnowledgeAtomicReviewInput,
    ): Promise<PersonaKnowledgeReviewResult> {
      return sql.transaction(async (transaction) => {
        await transaction.query(
          "SELECT pg_advisory_xact_lock(hashtext('persona-knowledge-review'), hashtext($1))",
          [input.personaId],
        );
        let item = await getPersonaKnowledgeItemWith(
          transaction,
          input.kind,
          input.id,
          input.personaId,
          true,
        );
        if (!item) throw new Error("knowledge_not_found");

        if (input.edits !== undefined) {
          requirePersonaKnowledgeEditsAllowed(item, input.action);
          const updated = await updatePersonaKnowledgeCandidateWith(transaction, {
            kind: item.kind,
            id: item.id,
            personaId: item.personaId,
            expectedStatus: item.status as "pending" | "conflicted",
            patch: input.edits,
          });
          if (!updated) throw new Error("knowledge_status_changed");
          item = updated;
        }

        if (input.embedding !== undefined) {
          if (
            item.kind === "speech_style"
            || item.content !== input.embedding.content
            || input.embedding.vector.length !== EMBEDDING_DIM
          ) {
            throw new Error("knowledge_embedding_stale");
          }
          await storeKnowledgeEmbeddingWith(
            transaction,
            item.kind,
            item.id,
            item.personaId,
            input.embedding.vector,
          );
        }

        const confirmedFacts = input.action === "confirm" && item.kind === "fact"
          ? await findConfirmedFactsWith(
            transaction,
            item.personaId,
            item.factType,
            item.factKey,
          )
          : [];
        const plan = planPersonaKnowledgeReview({
          item,
          confirmedFacts,
          actorUserId: input.actorUserId,
          action: input.action,
          conflictGroupId: randomUUID(),
        });
        const changed = await setPersonaKnowledgeStatusesWith(transaction, plan.statusChanges);
        return buildPersonaKnowledgeReviewResult(item, plan, changed);
      });
    },

    async revokePersonaSource(sourceId, personaId, _actorUserId) {
      return sql.transaction(async (transaction) => {
        const sourceRows = await transaction.query<{ id: string }>(
          `UPDATE persona_sources SET status = 'revoked', revoked_at = now()
           WHERE id = $1 AND persona_id = $2 AND status <> 'revoked'
           RETURNING id`,
          [sourceId, personaId],
        );
        if (!sourceRows[0]) return { sourceRevoked: false, revokedItems: [] };
        const links = await transaction.query<{
          item_kind: PersonaKnowledgeKind;
          item_id: string;
        }>(
          `SELECT links.item_kind, links.item_id
           FROM persona_item_sources links
           JOIN persona_sources source ON source.id = links.source_id
           WHERE links.source_id = $1 AND source.persona_id = $2
           ORDER BY links.item_kind, links.item_id`,
          [sourceId, personaId],
        );
        const revokedItems: Array<{ kind: PersonaKnowledgeKind; id: string }> = [];
        for (const link of links) {
          const table = KNOWLEDGE_TABLES[link.item_kind];
          const lockedRows = await transaction.query<{ id: string }>(
            `SELECT id FROM ${table}
             WHERE id = $1 AND persona_id = $2
             FOR UPDATE`,
            [link.item_id, personaId],
          );
          if (!lockedRows[0]) continue;
          const supportRows = await transaction.query<{ count: number | string }>(
            `SELECT COUNT(*) AS count
             FROM persona_item_sources links
             JOIN persona_sources source ON source.id = links.source_id
             WHERE links.item_kind = $1 AND links.item_id = $2 AND links.source_id <> $3
               AND source.persona_id = $4 AND source.status = 'ready'`,
            [link.item_kind, link.item_id, sourceId, personaId],
          );
          if (Number(supportRows[0]?.count || 0) > 0) continue;
          const rows = await transaction.query<{ id: string }>(
            `UPDATE ${table}
             SET status = 'revoked', confirmed_by = NULL, confirmed_at = NULL,
                 revoked_at = now(), updated_at = now()
             WHERE id = $1 AND persona_id = $2
               AND status IN ('pending', 'confirmed', 'conflicted')
             RETURNING id`,
            [link.item_id, personaId],
          );
          if (rows[0]) revokedItems.push({ kind: link.item_kind, id: link.item_id });
        }
        return { sourceRevoked: true, revokedItems };
      });
    },

    async insertMemory(input: InsertMemoryInput): Promise<void> {
      await sql.transaction((transaction) => insertMemoryWith(transaction, input));
    },

    async insertMemories(inputs: InsertMemoryInput[]): Promise<void> {
      await sql.transaction(async (transaction) => {
        for (const input of inputs) await insertMemoryWith(transaction, input);
      });
    },

    async listMemories(personaId: string): Promise<Memory[]> {
      const rows = await sql.query<MemoryRow>(
        `SELECT id, persona_id, content, created_at
         FROM relationship_memories
         WHERE persona_id = $1 AND status = 'confirmed'
         ORDER BY created_at`,
        [personaId],
      );
      return rows.map(mapMemory);
    },

    async getMemoryById(id: string) {
      const rows = await sql.query<Pick<MemoryRow, "id" | "persona_id" | "content">>(
        `SELECT id, persona_id, content
         FROM relationship_memories
         WHERE id = $1 AND status = 'confirmed'`,
        [id],
      );
      return rows[0]
        ? { id: rows[0].id, personaId: rows[0].persona_id, content: rows[0].content }
        : null;
    },

    async deleteMemory(id: string): Promise<boolean> {
      const rows = await sql.query<{ id: string }>(
        `UPDATE relationship_memories
         SET status = 'revoked', confirmed_by = NULL, confirmed_at = NULL,
             revoked_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'confirmed'
         RETURNING id`,
        [id],
      );
      return Boolean(rows[0]);
    },

    async loadMemoriesWithEmbeddings(personaId: string): Promise<MemoryEmbedding[]> {
      const rows = await sql.query<MemoryEmbeddingRow>(
        `SELECT id, content, embedding::text AS embedding
         FROM relationship_memories
         WHERE persona_id = $1 AND status = 'confirmed' AND embedding IS NOT NULL`,
        [personaId],
      );
      return rows
        .filter((row): row is MemoryEmbeddingRow & { embedding: string | number[] } => row.embedding !== null)
        .map((row) => ({ id: row.id, content: row.content, embedding: parseVector(row.embedding) }));
    },

    async insertMessage(input: InsertMessageInput): Promise<Message> {
      const rows = await sql.query<MessageRow>(
        `INSERT INTO messages (id, persona_id, role, content)
         VALUES ($1, $2, $3, $4)
         RETURNING id, persona_id, role, content, created_at`,
        [input.id, input.personaId, input.role, input.content],
      );
      if (!rows[0]) throw new Error("Failed to insert message");
      return mapMessage(rows[0]);
    },

    async listMessages(personaId: string, limit = 50): Promise<Message[]> {
      const rows = await sql.query<MessageRow>(
        `SELECT id, persona_id, role, content, created_at
         FROM messages WHERE persona_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [personaId, limit],
      );
      return rows.map(mapMessage).reverse();
    },
  };
}
