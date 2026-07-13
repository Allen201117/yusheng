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
  listMemories(personaId: string): Promise<Memory[]>;
  getMemoryById(id: string): Promise<Pick<Memory, "id" | "personaId" | "content"> | null>;
  insertMemory(input: InsertMemoryInput): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  loadMemoriesWithEmbeddings(personaId: string): Promise<MemoryEmbedding[]>;
  listMessages(personaId: string, limit?: number): Promise<Message[]>;
  insertMessage(input: InsertMessageInput): Promise<Message>;
}
