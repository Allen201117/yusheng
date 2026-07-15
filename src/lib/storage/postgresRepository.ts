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
  ConfirmedConversationKnowledge,
  ConversationEmbeddingUpdate,
  ConversationSession,
  ConversationFeedback,
  ConversationSentence,
  PlaybackEvent,
  TtsAttempt,
  ConversationTurn,
  ConversationTurnEvidence,
  CreatePersonaKnowledgeCandidateInput,
  CreatePersonaInput,
  CreatePersonaSourceInput,
  CreateVoiceAuthorizationInput,
  CreateVoiceProfileInput,
  InsertMemoryInput,
  InsertMessageInput,
  GroundingEvidenceKind,
  EvaluatorRelation,
  FeedbackEligibility,
  Memory,
  MemoryEmbedding,
  Message,
  MessageEvidence,
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
  RestorationCohort,
  RestorationScores,
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

type ConversationTurnRow = {
  id: string;
  session_id: string | null;
  persona_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  mode: ConversationTurn["mode"];
  status: ConversationTurn["status"];
  boundary_kind: ConversationTurn["boundaryKind"];
  degradation_reason: ConversationTurn["degradationReason"];
  retrieval_ms: number | string | null;
  first_sentence_ms: number | string | null;
  total_ms: number | string | null;
  speech_tracking_failed: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type ConversationSentenceRow = {
  id: string;
  session_id: string;
  turn_id: string;
  persona_id: string;
  sentence_index: number | string;
  text: string;
  emotion: ConversationSentence["emotion"];
  intensity: number | string;
  speed: number | string;
  pause_after_ms: number | string;
  planner_version: string;
  created_at: Date | string;
  voice_id?: string;
};

type TtsAttemptRow = {
  id: string;
  sentence_id: string;
  session_id: string;
  turn_id: string;
  persona_id: string;
  voice_id: string;
  attempt_no: number | string;
  status: TtsAttempt["status"];
  voice_source: TtsAttempt["voiceSource"];
  provider_voice_id: string | null;
  tts_model: string;
  tts_config_version: string;
  fell_back: boolean;
  storage_ms: number | string | null;
  provider_ms: number | string | null;
  total_ms: number | string | null;
  stable_error_code: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
};

type PlaybackEventRow = {
  event_id: string;
  tts_attempt_id: string;
  event_type: PlaybackEvent["eventType"];
  client_elapsed_ms: number | string;
  received_at: Date | string;
};

type ConversationSessionRow = {
  id: string;
  persona_id: string;
  evaluator_user_id: string;
  voice_id: string;
  voice_authorization_id: string;
  cohort: ConversationSession["cohort"];
  status: ConversationSession["status"];
  started_at: Date | string;
  last_activity_at: Date | string;
  rated_at: Date | string | null;
};

type ConversationFeedbackRow = {
  id: string;
  session_id: string;
  persona_id: string;
  evaluator_user_id: string;
  evaluator_relation: EvaluatorRelation;
  knows_voice_owner: boolean;
  heard_all_rounds: boolean;
  voice_similarity: number | string;
  expression_similarity: number | string;
  emotion_fit: number | string;
  fact_trust: number | string;
  discomfort: number | string;
  major_fabrication: boolean;
  identity_impersonation: boolean;
  authorization_violation: boolean;
  comment: string | null;
  created_at: Date | string;
};

type ConversationTurnEvidenceRow = {
  turn_id: string;
  persona_id: string;
  item_kind: ConversationTurnEvidence["kind"];
  item_id: string;
  created_at: Date | string;
};

type MessageEvidenceRow = {
  assistant_message_id: string;
  persona_id: string;
  item_kind: MessageEvidence["kind"];
  item_id: string;
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

const EVIDENCE_TABLES = {
  fact: "persona_facts",
  relationship_memory: "relationship_memories",
} as const;

const EVIDENCE_KIND_ORDER: Record<GroundingEvidenceKind, number> = {
  fact: 0,
  relationship_memory: 1,
};

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeEvidenceLocks<T extends { kind: GroundingEvidenceKind }>(
  items: T[],
  getId: (item: T) => string,
): T[] {
  const unique = new Map<string, T>();
  for (const item of items) {
    const key = `${EVIDENCE_KIND_ORDER[item.kind]}\0${getId(item)}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return Array.from(unique.values()).sort((left, right) =>
    EVIDENCE_KIND_ORDER[left.kind] - EVIDENCE_KIND_ORDER[right.kind]
    || compareAscii(getId(left), getId(right)));
}

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
  kind: keyof typeof EVIDENCE_TABLES,
  id: string,
  personaId: string,
  vector: Float32Array,
): Promise<void> {
  const table = EVIDENCE_TABLES[kind];
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

function parseConversationVector(value: string | number[] | null): Float32Array | null {
  if (value === null) return null;
  try {
    const parsed = parseVector(value);
    return parsed.length === EMBEDDING_DIM && Array.from(parsed).every(Number.isFinite)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isValidConversationVector(value: Float32Array): boolean {
  return value.length === EMBEDDING_DIM && Array.from(value).every(Number.isFinite);
}

const CONVERSATION_TURN_COLUMNS = `
  id, session_id, persona_id, user_message_id, assistant_message_id, mode, status,
  boundary_kind, degradation_reason, retrieval_ms, first_sentence_ms, total_ms,
  speech_tracking_failed, created_at, updated_at
`;

function mapConversationTurn(row: ConversationTurnRow): ConversationTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    personaId: row.persona_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    mode: row.mode,
    status: row.status,
    boundaryKind: row.boundary_kind,
    degradationReason: row.degradation_reason,
    retrievalMs: row.retrieval_ms === null ? null : Number(row.retrieval_ms),
    firstSentenceMs: row.first_sentence_ms === null ? null : Number(row.first_sentence_ms),
    totalMs: row.total_ms === null ? null : Number(row.total_ms),
    speechTrackingFailed: Boolean(row.speech_tracking_failed),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapConversationSentence(row: ConversationSentenceRow): ConversationSentence {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    personaId: row.persona_id,
    sentenceIndex: Number(row.sentence_index),
    text: row.text,
    emotion: row.emotion,
    intensity: Number(row.intensity),
    speed: Number(row.speed),
    pauseAfterMs: Number(row.pause_after_ms),
    plannerVersion: row.planner_version,
    createdAt: toIsoString(row.created_at),
  };
}

function mapTtsAttempt(row: TtsAttemptRow): TtsAttempt {
  return {
    id: row.id,
    sentenceId: row.sentence_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    personaId: row.persona_id,
    voiceId: row.voice_id,
    attemptNo: Number(row.attempt_no),
    status: row.status,
    voiceSource: row.voice_source,
    providerVoiceId: row.provider_voice_id,
    ttsModel: row.tts_model,
    ttsConfigVersion: row.tts_config_version,
    fellBack: Boolean(row.fell_back),
    storageMs: row.storage_ms === null ? null : Number(row.storage_ms),
    providerMs: row.provider_ms === null ? null : Number(row.provider_ms),
    totalMs: row.total_ms === null ? null : Number(row.total_ms),
    stableErrorCode: row.stable_error_code,
    createdAt: toIsoString(row.created_at),
    completedAt: row.completed_at === null ? null : toIsoString(row.completed_at),
  };
}

function mapPlaybackEvent(row: PlaybackEventRow): PlaybackEvent {
  return {
    eventId: row.event_id,
    ttsAttemptId: row.tts_attempt_id,
    eventType: row.event_type,
    clientElapsedMs: Number(row.client_elapsed_ms),
    receivedAt: toIsoString(row.received_at),
  };
}

function mapConversationSession(row: ConversationSessionRow): ConversationSession {
  return {
    id: row.id,
    personaId: row.persona_id,
    evaluatorUserId: row.evaluator_user_id,
    voiceId: row.voice_id,
    voiceAuthorizationId: row.voice_authorization_id,
    cohort: row.cohort,
    status: row.status,
    startedAt: toIsoString(row.started_at),
    lastActivityAt: toIsoString(row.last_activity_at),
    ratedAt: row.rated_at === null ? null : toIsoString(row.rated_at),
  };
}

function mapConversationFeedback(row: ConversationFeedbackRow): ConversationFeedback {
  return {
    id: row.id,
    sessionId: row.session_id,
    personaId: row.persona_id,
    evaluatorUserId: row.evaluator_user_id,
    evaluatorRelation: row.evaluator_relation,
    knowsVoiceOwner: true,
    heardAllRounds: true,
    voiceSimilarity: Number(row.voice_similarity),
    expressionSimilarity: Number(row.expression_similarity),
    emotionFit: Number(row.emotion_fit),
    factTrust: Number(row.fact_trust),
    discomfort: Number(row.discomfort),
    majorFabrication: Boolean(row.major_fabrication),
    identityImpersonation: Boolean(row.identity_impersonation),
    authorizationViolation: Boolean(row.authorization_violation),
    comment: row.comment,
    createdAt: toIsoString(row.created_at),
  };
}

function mapConversationTurnEvidence(row: ConversationTurnEvidenceRow): ConversationTurnEvidence {
  return {
    turnId: row.turn_id,
    personaId: row.persona_id,
    kind: row.item_kind,
    itemId: row.item_id,
    createdAt: toIsoString(row.created_at),
  };
}

function mapMessageEvidence(row: MessageEvidenceRow): MessageEvidence {
  return {
    assistantMessageId: row.assistant_message_id,
    personaId: row.persona_id,
    kind: row.item_kind,
    itemId: row.item_id,
    createdAt: toIsoString(row.created_at),
  };
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
           ORDER BY links.item_kind COLLATE "C", links.item_id COLLATE "C"`,
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

    async loadConfirmedConversationKnowledge(
      personaId: string,
    ): Promise<ConfirmedConversationKnowledge> {
      const [facts, memories, styles] = await Promise.all([
        sql.query<{
          id: string;
          content: string;
          embedding: string | number[] | null;
          fact_type: string;
          fact_key: string;
        }>(
          `SELECT id, content, embedding::text AS embedding, fact_type, fact_key
           FROM persona_facts
           WHERE persona_id = $1 AND status = 'confirmed'
           ORDER BY created_at, id`,
          [personaId],
        ),
        sql.query<{
          id: string;
          content: string;
          embedding: string | number[] | null;
          occurred_at: Date | string | null;
          location: string | null;
          participants: unknown;
        }>(
          `SELECT id, content, embedding::text AS embedding, occurred_at, location, participants
           FROM relationship_memories
           WHERE persona_id = $1 AND status = 'confirmed'
           ORDER BY created_at, id`,
          [personaId],
        ),
        sql.query<{
          id: string;
          category: string;
          content: string;
          example: string | null;
        }>(
          `SELECT id, category, content, example
           FROM speech_style_items
           WHERE persona_id = $1 AND status = 'confirmed'
           ORDER BY created_at, id`,
          [personaId],
        ),
      ]);
      return {
        evidence: [
          ...facts.map((row) => ({
            kind: "fact" as const,
            id: row.id,
            content: row.content,
            embedding: parseConversationVector(row.embedding),
            factType: row.fact_type,
            factKey: row.fact_key,
          })),
          ...memories.map((row) => ({
            kind: "relationship_memory" as const,
            id: row.id,
            content: row.content,
            embedding: parseConversationVector(row.embedding),
            occurredAt: toNullableIsoString(row.occurred_at),
            location: row.location,
            participants: parseParticipants(row.participants),
          })),
        ],
        styles: styles.map((row) => ({
          id: row.id,
          category: row.category,
          content: row.content,
          example: row.example,
        })),
      };
    },

    async storeConfirmedConversationEmbeddings(
      personaId: string,
      updates: ConversationEmbeddingUpdate[],
    ): Promise<void> {
      if (updates.some((update) => !isValidConversationVector(update.embedding))) {
        throw new Error("conversation_embedding_status_changed");
      }
      const orderedUpdates = canonicalizeEvidenceLocks(updates, (update) => update.id);
      await sql.transaction(async (transaction) => {
        for (const update of orderedUpdates) {
          const table = EVIDENCE_TABLES[update.kind];
          const changed = await transaction.query<{ id: string }>(
            `UPDATE ${table}
             SET embedding = $3::vector
             WHERE id = $1 AND persona_id = $2
               AND status = 'confirmed' AND embedding IS NULL
             RETURNING id`,
            [update.id, personaId, serializeVector(update.embedding)],
          );
          if (changed.length === 1) continue;
          const current = await transaction.query<{
            status: PersonaKnowledgeStatus;
            embedding: string | number[] | null;
          }>(
            `SELECT status, embedding::text AS embedding
             FROM ${table}
             WHERE id = $1 AND persona_id = $2
             FOR UPDATE`,
            [update.id, personaId],
          );
          if (
            current[0]?.status !== "confirmed"
            || parseConversationVector(current[0].embedding) === null
          ) {
            throw new Error("conversation_embedding_status_changed");
          }
        }
      });
    },

    async getOrStartConversationSession(input): Promise<ConversationSession> {
      return sql.transaction(async (transaction) => {
        const personas = await transaction.query<{ id: string }>(
          `SELECT id FROM personas
           WHERE id = $1 AND user_id = $2 AND voice_id = $3
           FOR UPDATE`,
          [input.personaId, input.evaluatorUserId, input.voiceId],
        );
        if (personas.length !== 1) throw new Error("conversation_session_owner_mismatch");

        const authorizations = await transaction.query<{ id: string }>(
          `SELECT id FROM voice_authorizations
           WHERE id = $1 AND voice_id = $2 AND user_id = $3
             AND speaker_status = $4 AND status = 'approved'
           FOR UPDATE`,
          [
            input.voiceAuthorizationId,
            input.voiceId,
            input.evaluatorUserId,
            input.cohort,
          ],
        );
        if (authorizations.length !== 1) {
          throw new Error("conversation_session_authorization_denied");
        }

        await transaction.query<{ id: string }>(
          `UPDATE conversation_sessions
           SET status = 'expired'
           WHERE persona_id = $1 AND evaluator_user_id = $2
             AND status = 'active'
             AND (
               last_activity_at <= $3 OR voice_id <> $4
               OR voice_authorization_id <> $5 OR cohort <> $6
             )
           RETURNING id`,
          [
            input.personaId,
            input.evaluatorUserId,
            input.staleBefore,
            input.voiceId,
            input.voiceAuthorizationId,
            input.cohort,
          ],
        );

        const active = await transaction.query<ConversationSessionRow>(
          `SELECT id, persona_id, evaluator_user_id, voice_id, voice_authorization_id,
                  cohort, status, started_at, last_activity_at, rated_at
           FROM conversation_sessions
           WHERE persona_id = $1 AND evaluator_user_id = $2
             AND voice_id = $3 AND voice_authorization_id = $4 AND cohort = $5
             AND status = 'active'
           LIMIT 1
           FOR UPDATE`,
          [
            input.personaId,
            input.evaluatorUserId,
            input.voiceId,
            input.voiceAuthorizationId,
            input.cohort,
          ],
        );
        if (active[0]) {
          const touched = await transaction.query<ConversationSessionRow>(
            `UPDATE conversation_sessions
             SET last_activity_at = $7
             WHERE id = $1 AND persona_id = $2 AND evaluator_user_id = $3
               AND voice_id = $4 AND voice_authorization_id = $5 AND cohort = $6
               AND status = 'active'
             RETURNING id, persona_id, evaluator_user_id, voice_id, voice_authorization_id,
                       cohort, status, started_at, last_activity_at, rated_at`,
            [
              active[0].id,
              input.personaId,
              input.evaluatorUserId,
              input.voiceId,
              input.voiceAuthorizationId,
              input.cohort,
              input.now,
            ],
          );
          if (touched.length !== 1) throw new Error("conversation_session_status_changed");
          return mapConversationSession(touched[0]);
        }

        const created = await transaction.query<ConversationSessionRow>(
          `INSERT INTO conversation_sessions
             (id, persona_id, evaluator_user_id, voice_id, voice_authorization_id,
              cohort, status, started_at, last_activity_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)
           RETURNING id, persona_id, evaluator_user_id, voice_id, voice_authorization_id,
                     cohort, status, started_at, last_activity_at, rated_at`,
          [
            input.proposedSessionId,
            input.personaId,
            input.evaluatorUserId,
            input.voiceId,
            input.voiceAuthorizationId,
            input.cohort,
            input.now,
          ],
        );
        if (created.length !== 1) throw new Error("conversation_session_start_failed");
        return mapConversationSession(created[0]);
      });
    },

    async startConversationTurn(input): Promise<ConversationTurn> {
      return sql.transaction(async (transaction) => {
        const personas = await transaction.query<{ id: string }>(
          `SELECT id FROM personas
           WHERE id = $1
           FOR UPDATE`,
          [input.personaId],
        );
        if (personas.length !== 1) throw new Error("conversation_turn_persona_mismatch");

        if (input.sessionId !== null) {
          const sessions = await transaction.query<{ id: string }>(
            `SELECT sessions.id FROM conversation_sessions sessions
             JOIN voice_authorizations authorization
               ON authorization.id = sessions.voice_authorization_id
              AND authorization.voice_id = sessions.voice_id
              AND authorization.user_id = sessions.evaluator_user_id
              AND authorization.speaker_status = sessions.cohort
              AND authorization.status = 'approved'
             WHERE sessions.id = $1 AND sessions.persona_id = $2 AND sessions.status = 'active'
             FOR UPDATE OF authorization`,
            [input.sessionId, input.personaId],
          );
          if (sessions.length !== 1) throw new Error("conversation_turn_session_mismatch");
          const touched = await transaction.query<{ id: string }>(
            `UPDATE conversation_sessions
             SET last_activity_at = now()
             WHERE id = $1 AND persona_id = $2 AND status = 'active'
             RETURNING id`,
            [input.sessionId, input.personaId],
          );
          if (touched.length !== 1) throw new Error("conversation_turn_session_mismatch");
        }
        const messages = await transaction.query<{ id: string }>(
          `INSERT INTO messages (id, persona_id, role, content)
           VALUES ($1, $2, 'user', $3)
           RETURNING id`,
          [input.userMessageId, input.personaId, input.content],
        );
        if (messages.length !== 1) throw new Error("conversation_user_message_persistence_failed");
        const turns = await transaction.query<ConversationTurnRow>(
          `INSERT INTO conversation_turns (id, persona_id, user_message_id, session_id, status)
           VALUES ($1, $2, $3, $4, 'started')
           RETURNING ${CONVERSATION_TURN_COLUMNS}`,
          [input.turnId, input.personaId, input.userMessageId, input.sessionId],
        );
        if (turns.length !== 1) throw new Error("conversation_turn_start_failed");
        return mapConversationTurn(turns[0]);
      });
    },

    async bindConversationTurnEvidence(input): Promise<ConversationTurnEvidence[]> {
      return sql.transaction(async (transaction) => {
        const turns = await transaction.query<ConversationTurnRow>(
          `SELECT ${CONVERSATION_TURN_COLUMNS}
           FROM conversation_turns
           WHERE id = $1 AND persona_id = $2 AND status = 'started'
           FOR UPDATE`,
          [input.turnId, input.personaId],
        );
        if (turns.length !== 1) throw new Error("conversation_turn_status_changed");
        const evidence = canonicalizeEvidenceLocks(input.evidence, (item) => item.itemId);
        const sourceIdsByItem = new Map<string, string[]>();
        for (const item of evidence) {
          const rows = await transaction.query<{
            item_kind: ConversationTurnEvidence["kind"];
            item_id: string;
            source_id: string;
          }>(
            `SELECT links.item_kind, links.item_id, source.id AS source_id
             FROM persona_item_sources links
             JOIN persona_sources source ON source.id = links.source_id
             WHERE links.item_kind = $1 AND links.item_id = $2
               AND source.persona_id = $3 AND source.status = 'ready'
             ORDER BY source.id COLLATE "C"`,
            [item.kind, item.itemId, input.personaId],
          );
          if (rows.length === 0) throw new Error("conversation_evidence_unavailable");
          sourceIdsByItem.set(
            `${item.kind}:${item.itemId}`,
            rows.map((row) => row.source_id),
          );
        }

        const sourceIds = Array.from(new Set(Array.from(sourceIdsByItem.values()).flat()))
          .sort(compareAscii);
        if (sourceIds.length > 0) {
          const lockedSources = await transaction.query<{ id: string }>(
            `SELECT id FROM persona_sources
             WHERE persona_id = $1 AND status = 'ready' AND id = ANY($2::text[])
             ORDER BY id COLLATE "C"
             FOR UPDATE`,
            [input.personaId, sourceIds],
          );
          const lockedIds = new Set(lockedSources.map((row) => row.id));
          for (const item of evidence) {
            const supports = sourceIdsByItem.get(`${item.kind}:${item.itemId}`) || [];
            if (!supports.some((sourceId) => lockedIds.has(sourceId))) {
              throw new Error("conversation_evidence_unavailable");
            }
          }
        }

        for (const item of evidence) {
          const table = EVIDENCE_TABLES[item.kind];
          const rows = await transaction.query<{ id: string }>(
            `SELECT id FROM ${table}
             WHERE id = $1 AND persona_id = $2 AND status = 'confirmed'
             FOR UPDATE`,
            [item.itemId, input.personaId],
          );
          if (rows.length !== 1) throw new Error("conversation_evidence_unavailable");
        }

        const bound: ConversationTurnEvidence[] = [];
        for (const item of evidence) {
          const rows = await transaction.query<ConversationTurnEvidenceRow>(
            `INSERT INTO conversation_turn_evidence
               (turn_id, persona_id, item_kind, item_id)
             VALUES ($1, $2, $3, $4)
             RETURNING turn_id, persona_id, item_kind, item_id, created_at`,
            [input.turnId, input.personaId, item.kind, item.itemId],
          );
          if (rows.length !== 1) throw new Error("conversation_evidence_persistence_failed");
          bound.push(mapConversationTurnEvidence(rows[0]));
        }
        return bound;
      });
    },

    async completeConversationTurn(input): Promise<ConversationTurn> {
      return sql.transaction(async (transaction) => {
        const turns = await transaction.query<ConversationTurnRow>(
          `SELECT ${CONVERSATION_TURN_COLUMNS}
           FROM conversation_turns
           WHERE id = $1 AND persona_id = $2 AND status = 'started'
           FOR UPDATE`,
          [input.turnId, input.personaId],
        );
        if (turns.length !== 1) throw new Error("conversation_turn_status_changed");
        const evidence = await transaction.query<ConversationTurnEvidenceRow>(
          `SELECT turn_id, persona_id, item_kind, item_id, created_at
           FROM conversation_turn_evidence
           WHERE turn_id = $1 AND persona_id = $2
           ORDER BY item_kind, item_id`,
          [input.turnId, input.personaId],
        );
        if (
          (input.mode === "grounded" && evidence.length === 0)
          || (input.mode !== "grounded" && evidence.length !== 0)
        ) {
          throw new Error("conversation_turn_evidence_mismatch");
        }
        const messages = await transaction.query<{ id: string }>(
          `INSERT INTO messages (id, persona_id, role, content)
           VALUES ($1, $2, 'assistant', $3)
           RETURNING id`,
          [input.assistantMessageId, input.personaId, input.content],
        );
        if (messages.length !== 1) throw new Error("conversation_assistant_message_persistence_failed");
        const copied = await transaction.query<MessageEvidenceRow>(
          `INSERT INTO message_evidence
             (assistant_message_id, persona_id, item_kind, item_id, created_at)
           SELECT $1, persona_id, item_kind, item_id, created_at
           FROM conversation_turn_evidence
           WHERE turn_id = $2 AND persona_id = $3
           RETURNING assistant_message_id, persona_id, item_kind, item_id, created_at`,
          [input.assistantMessageId, input.turnId, input.personaId],
        );
        if (copied.length !== evidence.length) {
          throw new Error("conversation_evidence_persistence_failed");
        }
        const completed = await transaction.query<ConversationTurnRow>(
          `UPDATE conversation_turns
           SET assistant_message_id = $3, mode = $4, status = 'completed',
               boundary_kind = $5, degradation_reason = $6, retrieval_ms = $7,
               first_sentence_ms = $8, total_ms = $9, speech_tracking_failed = $10,
               updated_at = now()
           WHERE id = $1 AND persona_id = $2 AND status = 'started'
           RETURNING ${CONVERSATION_TURN_COLUMNS}`,
          [
            input.turnId,
            input.personaId,
            input.assistantMessageId,
            input.mode,
            input.boundaryKind,
            input.degradationReason,
            input.retrievalMs,
            input.firstSentenceMs,
            input.totalMs,
            input.speechTrackingFailed,
          ],
        );
        if (completed.length !== 1) throw new Error("conversation_turn_status_changed");
        return mapConversationTurn(completed[0]);
      });
    },

    async recordConversationSentence(input): Promise<ConversationSentence> {
      return sql.transaction(async (transaction) => {
        const turns = await transaction.query<{ id: string }>(
          `SELECT id FROM conversation_turns
           WHERE id = $1 AND session_id = $2 AND persona_id = $3 AND status = 'started'
           FOR UPDATE`,
          [input.turnId, input.sessionId, input.personaId],
        );
        if (turns.length !== 1) throw new Error("conversation_sentence_turn_mismatch");
        const rows = await transaction.query<ConversationSentenceRow>(
          `INSERT INTO conversation_sentences
             (id, session_id, turn_id, persona_id, sentence_index, text, emotion,
              intensity, speed, pause_after_ms, planner_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id, session_id, turn_id, persona_id, sentence_index, text,
                     emotion, intensity, speed, pause_after_ms, planner_version, created_at`,
          [
            input.id,
            input.sessionId,
            input.turnId,
            input.personaId,
            input.plan.index,
            input.plan.text,
            input.plan.emotion,
            input.plan.intensity,
            input.plan.speed,
            input.plan.pauseAfterMs,
            input.plannerVersion,
          ],
        );
        if (rows.length !== 1) throw new Error("conversation_sentence_persistence_failed");
        return mapConversationSentence(rows[0]);
      });
    },

    async getConversationSentenceForSynthesis(sentenceId, evaluatorUserId) {
      const rows = await sql.query<ConversationSentenceRow>(
        `SELECT sentence.id, sentence.session_id, sentence.turn_id, sentence.persona_id,
                sentence.sentence_index, sentence.text, sentence.emotion, sentence.intensity,
                sentence.speed, sentence.pause_after_ms, sentence.planner_version,
                sentence.created_at, sessions.voice_id
         FROM conversation_sentences sentence
         JOIN conversation_sessions sessions
           ON sessions.id = sentence.session_id AND sessions.persona_id = sentence.persona_id
         JOIN personas persona
           ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
         WHERE sentence.id = $1 AND sessions.evaluator_user_id = $2`,
        [sentenceId, evaluatorUserId],
      );
      if (rows.length !== 1 || !rows[0].voice_id) return null;
      return { ...mapConversationSentence(rows[0]), voiceId: rows[0].voice_id };
    },

    async startTtsAttempt(input): Promise<TtsAttempt> {
      return sql.transaction(async (transaction) => {
        const owners = await transaction.query<{
          persona_id: string;
          session_id: string;
          voice_id: string;
          voice_authorization_id: string;
          cohort: RestorationCohort;
        }>(
          `SELECT persona.id AS persona_id, sessions.id AS session_id, sessions.voice_id,
                  sessions.voice_authorization_id, sessions.cohort
           FROM conversation_sentences sentence
           JOIN conversation_sessions sessions
             ON sessions.id = sentence.session_id AND sessions.persona_id = sentence.persona_id
           JOIN personas persona
             ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
           WHERE sentence.id = $1 AND sessions.evaluator_user_id = $2
           FOR UPDATE OF persona`,
          [input.sentenceId, input.evaluatorUserId],
        );
        if (owners.length !== 1) throw new Error("tts_attempt_sentence_unavailable");
        const owner = owners[0];

        const authorizations = await transaction.query<{ id: string }>(
          `SELECT id FROM voice_authorizations
           WHERE id = $1 AND voice_id = $2 AND user_id = $3
             AND speaker_status = $4 AND status = 'approved'
           FOR UPDATE`,
          [
            owner.voice_authorization_id,
            owner.voice_id,
            input.evaluatorUserId,
            owner.cohort,
          ],
        );
        if (authorizations.length !== 1) throw new Error("tts_attempt_authorization_denied");

        const sessions = await transaction.query<{ id: string }>(
          `SELECT id FROM conversation_sessions
           WHERE id = $1 AND persona_id = $2 AND evaluator_user_id = $3
             AND voice_id = $4 AND voice_authorization_id = $5 AND cohort = $6
             AND status = 'active'
           FOR UPDATE`,
          [
            owner.session_id,
            owner.persona_id,
            input.evaluatorUserId,
            owner.voice_id,
            owner.voice_authorization_id,
            owner.cohort,
          ],
        );
        if (sessions.length !== 1) throw new Error("tts_attempt_session_unavailable");

        const sentences = await transaction.query<ConversationSentenceRow & { voice_id: string }>(
          `SELECT sentence.id, sentence.session_id, sentence.turn_id, sentence.persona_id,
                  sentence.sentence_index, sentence.text, sentence.emotion, sentence.intensity,
                  sentence.speed, sentence.pause_after_ms, sentence.planner_version,
                  sentence.created_at, sessions.voice_id
           FROM conversation_sentences sentence
           JOIN conversation_sessions sessions
             ON sessions.id = sentence.session_id AND sessions.persona_id = sentence.persona_id
           WHERE sentence.id = $1 AND sentence.session_id = $2 AND sentence.persona_id = $3
             AND sessions.evaluator_user_id = $4 AND sessions.status = 'active'
           FOR UPDATE OF sentence`,
          [input.sentenceId, owner.session_id, owner.persona_id, input.evaluatorUserId],
        );
        if (sentences.length !== 1) throw new Error("tts_attempt_sentence_unavailable");
        const rows = await transaction.query<TtsAttemptRow>(
          `INSERT INTO tts_attempts
             (id, sentence_id, session_id, turn_id, persona_id, voice_id, attempt_no,
              status, voice_source, provider_voice_id, tts_model, tts_config_version)
           SELECT $1, $2, $3, $4, $5, $6,
                  COALESCE(MAX(attempt_no), 0) + 1,
                  'started', $7, $8, $9, $10
           FROM tts_attempts WHERE sentence_id = $2
           RETURNING id, sentence_id, session_id, turn_id, persona_id, voice_id,
                     attempt_no, status, voice_source, provider_voice_id, tts_model,
                     tts_config_version, fell_back, storage_ms, provider_ms, total_ms,
                     stable_error_code, created_at, completed_at`,
          [
            input.id,
            input.sentenceId,
            sentences[0].session_id,
            sentences[0].turn_id,
            sentences[0].persona_id,
            sentences[0].voice_id,
            input.voiceSource,
            input.providerVoiceId,
            input.ttsModel,
            input.ttsConfigVersion,
          ],
        );
        if (rows.length !== 1) throw new Error("tts_attempt_start_failed");
        return mapTtsAttempt(rows[0]);
      });
    },

    async completeTtsAttempt(input): Promise<TtsAttempt> {
      return sql.transaction(async (transaction) => {
        const eligible = await transaction.query<{ id: string }>(
          `SELECT attempt.id
           FROM tts_attempts attempt
           JOIN conversation_sessions sessions
             ON sessions.id = attempt.session_id AND sessions.persona_id = attempt.persona_id
           JOIN personas persona
             ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
           JOIN voice_authorizations authorization
             ON authorization.id = sessions.voice_authorization_id
            AND authorization.voice_id = attempt.voice_id
            AND authorization.user_id = sessions.evaluator_user_id
            AND authorization.status = 'approved'
           WHERE attempt.id = $1 AND attempt.status = 'started'
             AND sessions.evaluator_user_id = $2 AND sessions.status = 'active'
           FOR UPDATE OF attempt, authorization`,
          [input.id, input.evaluatorUserId],
        );
        if (eligible.length !== 1) throw new Error("tts_attempt_authorization_denied");
        const rows = await transaction.query<TtsAttemptRow>(
          `UPDATE tts_attempts
           SET status = 'completed', voice_source = $2, fell_back = $3,
               storage_ms = $4, provider_ms = $5, total_ms = $6,
               stable_error_code = NULL, completed_at = now()
           WHERE id = $1 AND status = 'started'
           RETURNING id, sentence_id, session_id, turn_id, persona_id, voice_id,
                     attempt_no, status, voice_source, provider_voice_id, tts_model,
                     tts_config_version, fell_back, storage_ms, provider_ms, total_ms,
                     stable_error_code, created_at, completed_at`,
          [
            input.id,
            input.voiceSource,
            input.fellBack,
            input.storageMs,
            input.providerMs,
            input.totalMs,
          ],
        );
        if (rows.length !== 1) throw new Error("tts_attempt_status_changed");
        return mapTtsAttempt(rows[0]);
      });
    },

    async failTtsAttempt(input): Promise<boolean> {
      const rows = await sql.query<{ id: string }>(
        `UPDATE tts_attempts attempt
         SET status = 'failed', stable_error_code = $3, total_ms = $4, completed_at = now()
         FROM conversation_sessions sessions
         JOIN personas persona
           ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
         WHERE attempt.id = $1 AND attempt.status = 'started'
           AND sessions.id = attempt.session_id AND sessions.persona_id = attempt.persona_id
           AND sessions.evaluator_user_id = $2
         RETURNING attempt.id`,
        [input.id, input.evaluatorUserId, input.stableErrorCode, input.totalMs],
      );
      return rows.length === 1;
    },

    async recordPlaybackEvent(input): Promise<{ event: PlaybackEvent; created: boolean }> {
      return sql.transaction(async (transaction) => {
        const attempts = await transaction.query<{ id: string }>(
          `SELECT attempt.id
           FROM tts_attempts attempt
           JOIN conversation_sessions sessions
             ON sessions.id = attempt.session_id AND sessions.persona_id = attempt.persona_id
           JOIN personas persona
             ON persona.id = sessions.persona_id AND persona.user_id = sessions.evaluator_user_id
           WHERE attempt.id = $1 AND attempt.status = 'completed'
             AND sessions.evaluator_user_id = $2
           FOR UPDATE OF attempt`,
          [input.ttsAttemptId, input.evaluatorUserId],
        );
        if (attempts.length !== 1) throw new Error("playback_attempt_forbidden");

        const inserted = await transaction.query<PlaybackEventRow>(
          `INSERT INTO playback_events
             (event_id, tts_attempt_id, event_type, client_elapsed_ms)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING
           RETURNING event_id, tts_attempt_id, event_type, client_elapsed_ms, received_at`,
          [input.eventId, input.ttsAttemptId, input.eventType, input.clientElapsedMs],
        );
        if (inserted.length === 1) {
          return { event: mapPlaybackEvent(inserted[0]), created: true };
        }

        const existing = await transaction.query<PlaybackEventRow>(
          `SELECT event_id, tts_attempt_id, event_type, client_elapsed_ms, received_at
           FROM playback_events WHERE event_id = $1
              OR (tts_attempt_id = $2 AND event_type = $3)`,
          [input.eventId, input.ttsAttemptId, input.eventType],
        );
        const byEventId = existing.find((row) => row.event_id === input.eventId);
        if (byEventId && (
          byEventId.tts_attempt_id !== input.ttsAttemptId
          || byEventId.event_type !== input.eventType
          || Number(byEventId.client_elapsed_ms) !== input.clientElapsedMs
        )) throw new Error("playback_event_conflict");
        const byAttemptType = existing.find((row) =>
          row.tts_attempt_id === input.ttsAttemptId && row.event_type === input.eventType);
        if (byAttemptType && Number(byAttemptType.client_elapsed_ms) === input.clientElapsedMs) {
          return { event: mapPlaybackEvent(byAttemptType), created: false };
        }
        throw new Error("playback_event_conflict");
      });
    },

    async getFeedbackEligibility(
      sessionId: string,
      evaluatorUserId: string,
    ): Promise<FeedbackEligibility | null> {
      const rows = await sql.query<{
        status: FeedbackEligibility["sessionStatus"];
        already_submitted: boolean;
        completed_audible_turn_count: number | string;
      }>(
        `WITH owned_session AS (
           SELECT id, persona_id, evaluator_user_id, status
           FROM conversation_sessions
           WHERE id = $1 AND evaluator_user_id = $2
         )
         SELECT owned.status,
                EXISTS (
                  SELECT 1 FROM conversation_feedback feedback
                  WHERE feedback.session_id = owned.id
                    AND feedback.evaluator_user_id = owned.evaluator_user_id
                ) AS already_submitted,
                (
                  SELECT COUNT(DISTINCT turn.id)
                  FROM conversation_turns turn
                  WHERE turn.session_id = owned.id AND turn.persona_id = owned.persona_id
                    AND turn.status = 'completed'
                    AND turn.mode IN ('grounded', 'companionship')
                    AND turn.speech_tracking_failed = false
                    AND EXISTS (
                      SELECT 1
                      FROM tts_attempts attempt
                      JOIN playback_events playback
                        ON playback.tts_attempt_id = attempt.id
                       AND playback.event_type = 'play_started'
                      WHERE attempt.session_id = turn.session_id
                        AND attempt.turn_id = turn.id
                        AND attempt.persona_id = turn.persona_id
                        AND attempt.status = 'completed'
                    )
                ) AS completed_audible_turn_count
         FROM owned_session owned`,
        [sessionId, evaluatorUserId],
      );
      if (rows.length !== 1) return null;
      const count = Number(rows[0].completed_audible_turn_count || 0);
      const alreadySubmitted = Boolean(rows[0].already_submitted);
      return {
        completedAudibleTurnCount: count,
        requiredAudibleTurnCount: 3,
        eligible: rows[0].status === "active" && !alreadySubmitted && count >= 3,
        sessionStatus: rows[0].status,
        alreadySubmitted,
      };
    },

    async submitConversationFeedback(input: {
      id: string;
      sessionId: string;
      evaluatorUserId: string;
      evaluatorRelation: EvaluatorRelation;
      knowsVoiceOwner: true;
      heardAllRounds: true;
      scores: RestorationScores;
      comment: string | null;
    }): Promise<ConversationFeedback> {
      return sql.transaction(async (transaction) => {
        const identities = await transaction.query<ConversationSessionRow>(
          `SELECT id, persona_id, evaluator_user_id, voice_id, voice_authorization_id,
                  cohort, status, started_at, last_activity_at, rated_at
           FROM conversation_sessions
           WHERE id = $1 AND evaluator_user_id = $2`,
          [input.sessionId, input.evaluatorUserId],
        );
        if (identities.length !== 1) throw new Error("feedback_session_forbidden");
        const identity = identities[0];

        const personas = await transaction.query<{ id: string }>(
          `SELECT id FROM personas
           WHERE id = $1 AND user_id = $2
           FOR UPDATE`,
          [identity.persona_id, identity.evaluator_user_id],
        );
        if (personas.length !== 1) throw new Error("feedback_session_forbidden");

        const sessions = await transaction.query<ConversationSessionRow>(
          `SELECT id, persona_id, evaluator_user_id, voice_id, voice_authorization_id,
                  cohort, status, started_at, last_activity_at, rated_at
           FROM conversation_sessions
           WHERE id = $1 AND persona_id = $2 AND evaluator_user_id = $3
             AND voice_id = $4 AND voice_authorization_id = $5
             AND cohort = $6 AND status = $7
           FOR UPDATE`,
          [
            identity.id,
            identity.persona_id,
            identity.evaluator_user_id,
            identity.voice_id,
            identity.voice_authorization_id,
            identity.cohort,
            identity.status,
          ],
        );
        if (sessions.length !== 1) {
          const concurrentFeedback = await transaction.query<{ id: string }>(
            `SELECT id FROM conversation_feedback
             WHERE session_id = $1 AND evaluator_user_id = $2`,
            [identity.id, identity.evaluator_user_id],
          );
          if (concurrentFeedback.length > 0) throw new Error("feedback_already_submitted");
          throw new Error("feedback_session_status_changed");
        }
        const session = sessions[0];

        const existing = await transaction.query<{ id: string }>(
          `SELECT id FROM conversation_feedback
           WHERE session_id = $1 AND evaluator_user_id = $2`,
          [session.id, session.evaluator_user_id],
        );
        if (existing.length > 0) throw new Error("feedback_already_submitted");

        const counts = await transaction.query<{ count: number | string }>(
          `SELECT COUNT(DISTINCT turn.id) AS count
           FROM conversation_turns turn
           WHERE turn.session_id = $1 AND turn.persona_id = $2
             AND turn.status = 'completed'
             AND turn.mode IN ('grounded', 'companionship')
             AND turn.speech_tracking_failed = false
             AND EXISTS (
               SELECT 1
               FROM tts_attempts attempt
               JOIN playback_events playback
                 ON playback.tts_attempt_id = attempt.id AND playback.event_type = 'play_started'
               WHERE attempt.session_id = turn.session_id
                 AND attempt.turn_id = turn.id
                 AND attempt.persona_id = turn.persona_id
                 AND attempt.status = 'completed'
             )`,
          [session.id, session.persona_id],
        );
        const count = Number(counts[0]?.count || 0);
        if (session.status !== "active" || count < 3) {
          throw Object.assign(new Error("feedback_session_not_eligible"), {
            completedAudibleTurnCount: count,
            requiredAudibleTurnCount: 3,
          });
        }

        const rows = await transaction.query<ConversationFeedbackRow>(
          `INSERT INTO conversation_feedback
             (id, session_id, persona_id, evaluator_user_id, evaluator_relation,
              knows_voice_owner, heard_all_rounds, voice_similarity,
              expression_similarity, emotion_fit, fact_trust, discomfort,
              major_fabrication, identity_impersonation, authorization_violation, comment)
           VALUES ($1, $2, $3, $4, $5, true, true, $6, $7, $8, $9, $10,
                   $11, $12, $13, $14)
           RETURNING id, session_id, persona_id, evaluator_user_id, evaluator_relation,
                     knows_voice_owner, heard_all_rounds, voice_similarity,
                     expression_similarity, emotion_fit, fact_trust, discomfort,
                     major_fabrication, identity_impersonation, authorization_violation,
                     comment, created_at`,
          [
            input.id,
            session.id,
            session.persona_id,
            session.evaluator_user_id,
            input.evaluatorRelation,
            input.scores.voiceSimilarity,
            input.scores.expressionSimilarity,
            input.scores.emotionFit,
            input.scores.factTrust,
            input.scores.discomfort,
            input.scores.majorFabrication,
            input.scores.identityImpersonation,
            input.scores.authorizationViolation,
            input.comment,
          ],
        );
        if (rows.length !== 1) throw new Error("feedback_persistence_failed");
        const rated = await transaction.query<{ id: string }>(
          `UPDATE conversation_sessions
           SET status = 'rated', rated_at = now()
           WHERE id = $1 AND evaluator_user_id = $2 AND status = 'active'
           RETURNING id`,
          [session.id, session.evaluator_user_id],
        );
        if (rated.length !== 1) throw new Error("feedback_session_status_changed");
        return mapConversationFeedback(rows[0]);
      });
    },

    async failConversationTurn(input): Promise<boolean> {
      const rows = await sql.query<{ id: string }>(
        `UPDATE conversation_turns
         SET status = $3, degradation_reason = $4, total_ms = $5, updated_at = now()
         WHERE id = $1 AND persona_id = $2 AND status = 'started'
         RETURNING id`,
        [
          input.turnId,
          input.personaId,
          input.status,
          input.degradationReason,
          input.totalMs,
        ],
      );
      return rows.length === 1;
    },

    async listMessageEvidence(
      assistantMessageId: string,
      personaId: string,
    ): Promise<MessageEvidence[]> {
      const rows = await sql.query<MessageEvidenceRow>(
        `SELECT assistant_message_id, persona_id, item_kind, item_id, created_at
         FROM message_evidence
         WHERE assistant_message_id = $1 AND persona_id = $2
         ORDER BY item_kind, item_id`,
        [assistantMessageId, personaId],
      );
      return rows.map(mapMessageEvidence);
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
