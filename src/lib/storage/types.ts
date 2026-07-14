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
  setPersonaKnowledgeStatuses(inputs: Array<{
    kind: PersonaKnowledgeKind;
    id: string;
    personaId: string;
    expectedStatus: PersonaKnowledgeStatus;
    nextStatus: PersonaKnowledgeStatus;
    actorUserId: string;
    conflictGroupId: string | null;
  }>): Promise<PersonaKnowledgeItem[]>;
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
  deleteMemory(id: string): Promise<void>;
  loadMemoriesWithEmbeddings(personaId: string): Promise<MemoryEmbedding[]>;
  listMessages(personaId: string, limit?: number): Promise<Message[]>;
  insertMessage(input: InsertMessageInput): Promise<Message>;
}
