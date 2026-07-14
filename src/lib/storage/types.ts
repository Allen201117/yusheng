import type { SpeechEmotion } from "../speechPlanning";

export type User = {
  id: string;
  email: string;
  phone: string;
  password: string;
  createdAt: string;
};

export type Persona = {
  id: string;
  userId: string;
  name: string;
  relation: string;
  voiceId: string;
  personaDesc: string;
  createdAt: string;
};

export type CreatePersonaInput = Omit<Persona, "createdAt">;

export type Memory = {
  id: string;
  personaId: string;
  content: string;
  createdAt: string;
};

export type MemoryEmbedding = {
  id: string;
  content: string;
  embedding: Float32Array;
};

export type InsertMemoryInput = {
  id: string;
  personaId: string;
  content: string;
  embedding: Float32Array;
  createdBy: string;
  sourceId: string;
  checksumAlgorithm: "sha256";
  checksum: string;
};

export type PersonaKnowledgeStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "conflicted"
  | "revoked";

export type PersonaKnowledgeKind =
  | "fact"
  | "relationship_memory"
  | "speech_style";

export type PersonaSourceType =
  | "manual_text"
  | "chat_export"
  | "audio_transcript"
  | "text_document"
  | "legacy_import";

export type PersonaSource = {
  id: string;
  personaId: string;
  sourceType: PersonaSourceType;
  contentText: string | null;
  objectPath: string | null;
  checksumAlgorithm: "sha256" | "legacy_id";
  checksum: string;
  status: "ready" | "failed" | "revoked";
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
};

export type PersonaFact = {
  kind: "fact";
  id: string;
  personaId: string;
  factType: string;
  factKey: string;
  content: string;
  normalizedValue: string;
  status: PersonaKnowledgeStatus;
  conflictGroupId: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RelationshipMemory = {
  kind: "relationship_memory";
  id: string;
  personaId: string;
  content: string;
  occurredAt: string | null;
  location: string | null;
  participants: string[];
  status: PersonaKnowledgeStatus;
  conflictGroupId: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SpeechStyleItem = {
  kind: "speech_style";
  id: string;
  personaId: string;
  category: string;
  content: string;
  example: string | null;
  status: PersonaKnowledgeStatus;
  conflictGroupId: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PersonaKnowledgeItem = PersonaFact | RelationshipMemory | SpeechStyleItem;

export type PersonaKnowledgeReviewInput = {
  personaId: string;
  actorUserId: string;
  kind: PersonaKnowledgeKind;
  id: string;
  action: "confirm" | "reject" | "revoke";
  edits?: Record<string, string | string[] | null>;
};

export type PersonaKnowledgeAtomicReviewInput = PersonaKnowledgeReviewInput & {
  embedding?: {
    content: string;
    vector: Float32Array;
  };
};

export type PersonaKnowledgeStatusChange = {
  kind: PersonaKnowledgeKind;
  id: string;
  personaId: string;
  expectedStatus: PersonaKnowledgeStatus;
  nextStatus: PersonaKnowledgeStatus;
  actorUserId: string;
  conflictGroupId: string | null;
};

export type PersonaKnowledgeReviewResult = {
  item: PersonaKnowledgeItem;
  conflicts: PersonaFact[];
};

export type PersonaKnowledgeBundle = {
  sources: PersonaSource[];
  facts: PersonaFact[];
  memories: RelationshipMemory[];
  styles: SpeechStyleItem[];
};

export type CreatePersonaSourceInput = Omit<PersonaSource, "createdAt" | "revokedAt">;

export type CreatePersonaKnowledgeCandidateInput =
  | {
      kind: "fact";
      id: string;
      personaId: string;
      factType: string;
      factKey: string;
      content: string;
      normalizedValue: string;
      sourceId: string;
      sourceExcerpt: string;
    }
  | {
      kind: "relationship_memory";
      id: string;
      personaId: string;
      content: string;
      occurredAt: string | null;
      location: string | null;
      participants: string[];
      embedding: Float32Array | null;
      sourceId: string;
      sourceExcerpt: string;
    }
  | {
      kind: "speech_style";
      id: string;
      personaId: string;
      category: string;
      content: string;
      example: string | null;
      sourceId: string;
      sourceExcerpt: string;
    };

export type Message = {
  id: string;
  personaId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type InsertMessageInput = Omit<Message, "createdAt">;

export type ConversationMode = "grounded" | "companionship" | "boundary";

export type ConversationBoundaryKind =
  | "self_harm"
  | "real_world_danger"
  | "voice_authorization_denied"
  | "identity"
  | "real_will"
  | "commitment"
  | "major_decision";

export type ConversationDegradationReason =
  | "no_relevant_evidence"
  | "retrieval_failed"
  | "embedding_backfill_partial"
  | "model_failed"
  | "assistant_persistence_failed";

export type ConversationTurnStatus =
  | "started"
  | "completed"
  | "generation_failed"
  | "assistant_persistence_failed";

export type GroundingEvidenceKind = "fact" | "relationship_memory";

export type ConversationEvidence =
  | {
      kind: "fact";
      id: string;
      content: string;
      embedding: Float32Array | null;
      factType: string;
      factKey: string;
    }
  | {
      kind: "relationship_memory";
      id: string;
      content: string;
      embedding: Float32Array | null;
      occurredAt: string | null;
      location: string | null;
      participants: string[];
    };

export type ConversationStyle = {
  id: string;
  category: string;
  content: string;
  example: string | null;
};

export type ConfirmedConversationKnowledge = {
  evidence: ConversationEvidence[];
  styles: ConversationStyle[];
};

export type ConversationEmbeddingUpdate = {
  kind: GroundingEvidenceKind;
  id: string;
  embedding: Float32Array;
};

export type MessageEvidence = {
  assistantMessageId: string;
  personaId: string;
  kind: GroundingEvidenceKind;
  itemId: string;
  createdAt: string;
};

export type ConversationTurnEvidence = {
  turnId: string;
  personaId: string;
  kind: GroundingEvidenceKind;
  itemId: string;
  createdAt: string;
};

export type ConversationTurn = {
  id: string;
  sessionId: string | null;
  personaId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  mode: ConversationMode | null;
  status: ConversationTurnStatus;
  boundaryKind: ConversationBoundaryKind | null;
  degradationReason: ConversationDegradationReason | null;
  retrievalMs: number | null;
  firstSentenceMs: number | null;
  totalMs: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderVoiceStatus =
  | "not_created"
  | "pending"
  | "ready"
  | "failed"
  | "deleting";

export type VoiceMeta = {
  voiceId: string;
  userId: string;
  objectPath: string;
  audioFile: string;
  checksumSha256: string;
  promptText: string;
  mimeType: string;
  durationSec: number | null;
  providerVoiceId: string | null;
  providerVoiceStatus: ProviderVoiceStatus;
  providerVoiceErrorCode: string | null;
  providerVoiceUpdatedAt: string | null;
  createdAt: string;
};

export type CreateVoiceProfileInput = Omit<
  VoiceMeta,
  | "audioFile"
  | "createdAt"
  | "providerVoiceId"
  | "providerVoiceStatus"
  | "providerVoiceErrorCode"
  | "providerVoiceUpdatedAt"
>;

export type UpdateVoiceProviderStateInput = {
  status: ProviderVoiceStatus;
  providerVoiceId: string | null;
  errorCode: string | null;
};

export type VoiceSpeakerStatus = "living" | "deceased";

export type VoiceAuthorizationBasis =
  | "self"
  | "speaker_separate_consent"
  | "legal_representative"
  | "close_relative_request";

export type VoiceAuthorizationStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "revoked";

export type VoiceAuthorizationAttestation = {
  speakerStatus: VoiceSpeakerStatus;
  basis: VoiceAuthorizationBasis;
  separateConsentConfirmed: boolean;
  thirdPartyProcessingConfirmed: boolean;
  syntheticDisclosureConfirmed: boolean;
};

export type VoiceAuthorization = VoiceAuthorizationAttestation & {
  id: string;
  voiceId: string;
  userId: string;
  status: VoiceAuthorizationStatus;
  reasonCode: string | null;
  noticeVersion: string;
  attestedAt: string;
  reviewedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type CreateVoiceAuthorizationInput = Omit<
  VoiceAuthorization,
  "reviewedAt" | "revokedAt" | "createdAt"
>;

export type RestorationCohort = "living" | "deceased";

export type ConversationSessionStatus = "active" | "rated" | "expired";

export type TtsAttemptStatus = "started" | "completed" | "failed";

export type VoiceSource = "preset" | "dynamic";

export type PlaybackEventType =
  | "audio_ready"
  | "play_started"
  | "play_completed"
  | "play_failed";

export type EvaluatorRelation = "self" | "family" | "friend" | "other";

export type RestorationScores = {
  voiceSimilarity: number;
  expressionSimilarity: number;
  emotionFit: number;
  factTrust: number;
  discomfort: number;
  majorFabrication: boolean;
  identityImpersonation: boolean;
  authorizationViolation: boolean;
};

export type RestorationMetricRow = RestorationScores & {
  sessionId: string;
  evaluatorUserId: string;
  cohort: RestorationCohort;
};

export type ConversationSession = {
  id: string;
  personaId: string;
  evaluatorUserId: string;
  voiceId: string;
  voiceAuthorizationId: string;
  cohort: RestorationCohort;
  status: ConversationSessionStatus;
  startedAt: string;
  lastActivityAt: string;
  ratedAt: string | null;
};

export type ConversationSentence = {
  id: string;
  sessionId: string;
  turnId: string;
  personaId: string;
  sentenceIndex: number;
  text: string;
  emotion: SpeechEmotion;
  intensity: number;
  speed: number;
  pauseAfterMs: number;
  plannerVersion: string;
  createdAt: string;
};

export type TtsAttempt = {
  id: string;
  sentenceId: string;
  sessionId: string;
  turnId: string;
  personaId: string;
  voiceId: string;
  attemptNo: number;
  status: TtsAttemptStatus;
  voiceSource: VoiceSource | null;
  providerVoiceId: string | null;
  ttsModel: string;
  ttsConfigVersion: string;
  fellBack: boolean;
  storageMs: number | null;
  providerMs: number | null;
  totalMs: number | null;
  stableErrorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type PlaybackEvent = {
  eventId: string;
  ttsAttemptId: string;
  eventType: PlaybackEventType;
  clientElapsedMs: number;
  receivedAt: string;
};

export type ConversationFeedback = RestorationScores & {
  id: string;
  sessionId: string;
  personaId: string;
  evaluatorUserId: string;
  evaluatorRelation: EvaluatorRelation;
  knowsVoiceOwner: true;
  heardAllRounds: true;
  comment: string | null;
  createdAt: string;
};

export type FeedbackEligibility = {
  completedAudibleTurnCount: number;
  requiredAudibleTurnCount: 3;
  eligible: boolean;
  sessionStatus: ConversationSessionStatus;
  alreadySubmitted: boolean;
};

export interface AppRepository {
  getUserByEmail(email: string): Promise<User | null>;
  createUserByEmail(email: string, passwordHash?: string): Promise<User>;
  setUserPassword(email: string, hash: string): Promise<void>;
  createVerificationCode(
    target: { email?: string; phone?: string },
    code: string,
    ttlMinutes?: number,
  ): Promise<void>;
  verifyCode(target: { email?: string; phone?: string }, code: string): Promise<boolean>;
  listPersonas(userId: string): Promise<Persona[]>;
  getPersonaForUser(id: string, userId: string): Promise<Persona | null>;
  createPersona(input: CreatePersonaInput): Promise<Persona>;
  deletePersona(id: string, userId: string): Promise<Persona | null>;
  countPersonasUsingVoice(voiceId: string, userId: string): Promise<number>;
  createVoiceProfile(input: CreateVoiceProfileInput): Promise<VoiceMeta>;
  getVoiceProfileForUser(voiceId: string, userId: string): Promise<VoiceMeta | null>;
  listVoiceProfiles(userId: string): Promise<VoiceMeta[]>;
  updateVoiceProviderState(
    voiceId: string,
    userId: string,
    input: UpdateVoiceProviderStateInput,
  ): Promise<VoiceMeta | null>;
  deleteVoiceProfile(voiceId: string, userId: string): Promise<boolean>;
  replaceVoiceAuthorization(input: CreateVoiceAuthorizationInput): Promise<VoiceAuthorization>;
  getCurrentVoiceAuthorization(
    voiceId: string,
    userId: string,
  ): Promise<VoiceAuthorization | null>;
  revokeVoiceAuthorization(
    voiceId: string,
    userId: string,
  ): Promise<VoiceAuthorization | null>;
  createPersonaKnowledgeCandidates(input: {
    source: CreatePersonaSourceInput;
    candidates: CreatePersonaKnowledgeCandidateInput[];
  }): Promise<PersonaKnowledgeBundle>;
  listPersonaKnowledge(personaId: string): Promise<PersonaKnowledgeBundle>;
  getPersonaKnowledgeItem(
    kind: PersonaKnowledgeKind,
    id: string,
    personaId: string,
  ): Promise<PersonaKnowledgeItem | null>;
  findConfirmedFacts(
    personaId: string,
    factType: string,
    factKey: string,
  ): Promise<PersonaFact[]>;
  updatePersonaKnowledgeCandidate(input: {
    kind: PersonaKnowledgeKind;
    id: string;
    personaId: string;
    expectedStatus: "pending" | "conflicted";
    patch: Record<string, string | string[] | null>;
  }): Promise<PersonaKnowledgeItem | null>;
  setPersonaKnowledgeStatuses(
    inputs: PersonaKnowledgeStatusChange[],
  ): Promise<PersonaKnowledgeItem[]>;
  reviewPersonaKnowledgeAtomically(
    input: PersonaKnowledgeAtomicReviewInput,
  ): Promise<PersonaKnowledgeReviewResult>;
  revokePersonaSource(
    sourceId: string,
    personaId: string,
    actorUserId: string,
  ): Promise<{
    sourceRevoked: boolean;
    revokedItems: Array<{ kind: PersonaKnowledgeKind; id: string }>;
  }>;
  listMemories(personaId: string): Promise<Memory[]>;
  getMemoryById(id: string): Promise<Pick<Memory, "id" | "personaId" | "content"> | null>;
  insertMemory(input: InsertMemoryInput): Promise<void>;
  insertMemories(inputs: InsertMemoryInput[]): Promise<void>;
  deleteMemory(id: string): Promise<boolean>;
  loadMemoriesWithEmbeddings(personaId: string): Promise<MemoryEmbedding[]>;
  loadConfirmedConversationKnowledge(personaId: string): Promise<ConfirmedConversationKnowledge>;
  storeConfirmedConversationEmbeddings(
    personaId: string,
    updates: ConversationEmbeddingUpdate[],
  ): Promise<void>;
  getOrStartConversationSession(input: {
    proposedSessionId: string;
    personaId: string;
    evaluatorUserId: string;
    voiceId: string;
    voiceAuthorizationId: string;
    cohort: RestorationCohort;
    now: string;
    staleBefore: string;
  }): Promise<ConversationSession>;
  startConversationTurn(input: {
    turnId: string;
    sessionId: string | null;
    personaId: string;
    userMessageId: string;
    content: string;
  }): Promise<ConversationTurn>;
  bindConversationTurnEvidence(input: {
    turnId: string;
    personaId: string;
    evidence: Array<{ kind: GroundingEvidenceKind; itemId: string }>;
  }): Promise<ConversationTurnEvidence[]>;
  completeConversationTurn(input: {
    turnId: string;
    personaId: string;
    assistantMessageId: string;
    content: string;
    mode: ConversationMode;
    boundaryKind: ConversationBoundaryKind | null;
    degradationReason: ConversationDegradationReason | null;
    retrievalMs: number;
    firstSentenceMs: number | null;
    totalMs: number;
  }): Promise<ConversationTurn>;
  failConversationTurn(input: {
    turnId: string;
    personaId: string;
    status: Extract<
      ConversationTurnStatus,
      "generation_failed" | "assistant_persistence_failed"
    >;
    degradationReason: Extract<
      ConversationDegradationReason,
      "model_failed" | "assistant_persistence_failed"
    >;
    totalMs: number;
  }): Promise<boolean>;
  listMessageEvidence(
    assistantMessageId: string,
    personaId: string,
  ): Promise<MessageEvidence[]>;
  listMessages(personaId: string, limit?: number): Promise<Message[]>;
  insertMessage(input: InsertMessageInput): Promise<Message>;
}
