import {
  bindConversationTurnEvidence,
  recordConversationSentence,
  getConversationSentenceForSynthesis,
  startTtsAttempt,
  completeTtsAttempt,
  failTtsAttempt,
  recordPlaybackEvent,
  getFeedbackEligibility,
  submitConversationFeedback,
  completeConversationTurn,
  countPersonasUsingVoice,
  createPersonaKnowledgeCandidates,
  createPersona,
  createUserByEmail,
  createVerificationCode,
  deleteMemory,
  failConversationTurn,
  getDb,
  getMemoryById,
  getPersonaForUser,
  getPersonaKnowledgeItem,
  getUserByEmail,
  insertMemory,
  insertMemories,
  insertMessage,
  listMemories,
  listMessageEvidence,
  listMessages,
  listPersonas,
  listPersonaKnowledge,
  loadMemoriesWithEmbeddings,
  loadConfirmedConversationKnowledge,
  findConfirmedFacts,
  getCurrentVoiceAuthorization,
  getOrStartConversationSession,
  replaceVoiceAuthorization,
  reviewPersonaKnowledgeAtomically,
  revokeVoiceAuthorization,
  revokePersonaSource,
  setPersonaKnowledgeStatuses,
  setUserPassword,
  startConversationTurn,
  storeConfirmedConversationEmbeddings,
  verifyCode,
  updatePersonaKnowledgeCandidate,
} from "../db";
import {
  deleteVoiceForUser,
  listVoicesForUser,
  loadVoiceForUser,
  updateVoiceProviderStateForUser,
} from "../voiceStore";
import { getStorageConfig, type StorageConfig } from "./config";
import { getSql } from "./postgres";
import { createPostgresRepository } from "./postgresRepository";
import type { AppRepository, VoiceMeta } from "./types";

export function selectRepository(
  config: StorageConfig,
  createLocal: () => AppRepository,
  createCloud: (config: Extract<StorageConfig, { backend: "cloud" }>) => AppRepository,
): AppRepository {
  return config.backend === "local" ? createLocal() : createCloud(config);
}

function mapLocalVoice(meta: Awaited<ReturnType<typeof loadVoiceForUser>>): VoiceMeta | null {
  if (!meta) return null;
  return {
    voiceId: meta.voiceId,
    userId: meta.userId || "__legacy__",
    objectPath: meta.audioFile,
    audioFile: meta.audioFile,
    checksumSha256: "",
    promptText: meta.promptText,
    mimeType: meta.mimeType,
    durationSec: meta.durationSec ?? null,
    providerVoiceId: meta.providerVoiceId || null,
    providerVoiceStatus: meta.providerVoiceStatus || "not_created",
    providerVoiceErrorCode: meta.providerVoiceErrorCode || null,
    providerVoiceUpdatedAt: meta.providerVoiceUpdatedAt || null,
    createdAt: meta.createdAt,
  };
}

export function createLocalRepository(): AppRepository {
  return {
    async getUserByEmail(email) { return getUserByEmail(email); },
    async createUserByEmail(email, passwordHash) { return createUserByEmail(email, passwordHash); },
    async setUserPassword(email, hash) { setUserPassword(email, hash); },
    async createVerificationCode(target, code, ttlMinutes) {
      createVerificationCode(target, code, ttlMinutes);
    },
    async verifyCode(target, code) { return verifyCode(target, code); },
    async listPersonas(userId) { return listPersonas(userId); },
    async getPersonaForUser(id, userId) { return getPersonaForUser(id, userId); },
    async createPersona(input) { return createPersona(input); },
    async deletePersona(id, userId) {
      return getDb().transaction(() => {
        const persona = getPersonaForUser(id, userId);
        if (!persona) return null;
        getDb().prepare("DELETE FROM personas WHERE id = ? AND user_id = ?").run(id, userId);
        return persona;
      })();
    },
    async countPersonasUsingVoice(voiceId, userId) {
      return countPersonasUsingVoice(voiceId, userId);
    },
    async createVoiceProfile() {
      throw new Error("Local voice metadata is created by the local voice object store");
    },
    async getVoiceProfileForUser(voiceId, userId) {
      return mapLocalVoice(await loadVoiceForUser(voiceId, userId));
    },
    async listVoiceProfiles(userId) {
      const voices = await listVoicesForUser(userId);
      return voices.map((voice) => mapLocalVoice(voice)).filter((voice): voice is VoiceMeta => Boolean(voice));
    },
    async updateVoiceProviderState(voiceId, userId, input) {
      return mapLocalVoice(await updateVoiceProviderStateForUser(voiceId, userId, input));
    },
    async deleteVoiceProfile(voiceId, userId) {
      return deleteVoiceForUser(voiceId, userId);
    },
    async replaceVoiceAuthorization(input) {
      return replaceVoiceAuthorization(input);
    },
    async getCurrentVoiceAuthorization(voiceId, userId) {
      return getCurrentVoiceAuthorization(voiceId, userId);
    },
    async revokeVoiceAuthorization(voiceId, userId) {
      return revokeVoiceAuthorization(voiceId, userId);
    },
    async createPersonaKnowledgeCandidates(input) {
      return createPersonaKnowledgeCandidates(input);
    },
    async listPersonaKnowledge(personaId) { return listPersonaKnowledge(personaId); },
    async getPersonaKnowledgeItem(kind, id, personaId) {
      return getPersonaKnowledgeItem(kind, id, personaId);
    },
    async findConfirmedFacts(personaId, factType, factKey) {
      return findConfirmedFacts(personaId, factType, factKey);
    },
    async updatePersonaKnowledgeCandidate(input) {
      return updatePersonaKnowledgeCandidate(input);
    },
    async setPersonaKnowledgeStatuses(inputs) { return setPersonaKnowledgeStatuses(inputs); },
    async reviewPersonaKnowledgeAtomically(input) {
      return reviewPersonaKnowledgeAtomically(input);
    },
    async revokePersonaSource(sourceId, personaId, actorUserId) {
      return revokePersonaSource(sourceId, personaId, actorUserId);
    },
    async listMemories(personaId) { return listMemories(personaId); },
    async getMemoryById(id) { return getMemoryById(id); },
    async insertMemory(input) { insertMemory(input); },
    async insertMemories(inputs) { insertMemories(inputs); },
    async deleteMemory(id) { return deleteMemory(id); },
    async loadMemoriesWithEmbeddings(personaId) {
      return loadMemoriesWithEmbeddings(personaId);
    },
    async loadConfirmedConversationKnowledge(personaId) {
      return loadConfirmedConversationKnowledge(personaId);
    },
    async storeConfirmedConversationEmbeddings(personaId, updates) {
      storeConfirmedConversationEmbeddings(personaId, updates);
    },
    async getOrStartConversationSession(input) {
      return getOrStartConversationSession(input);
    },
    async startConversationTurn(input) { return startConversationTurn(input); },
    async bindConversationTurnEvidence(input) {
      return bindConversationTurnEvidence(input);
    },
    async completeConversationTurn(input) { return completeConversationTurn(input); },
    async recordConversationSentence(input) { return recordConversationSentence(input); },
    async getConversationSentenceForSynthesis(sentenceId, evaluatorUserId) {
      return getConversationSentenceForSynthesis(sentenceId, evaluatorUserId);
    },
    async startTtsAttempt(input) { return startTtsAttempt(input); },
    async completeTtsAttempt(input) { return completeTtsAttempt(input); },
    async failTtsAttempt(input) { return failTtsAttempt(input); },
    async recordPlaybackEvent(input) { return recordPlaybackEvent(input); },
    async getFeedbackEligibility(sessionId, evaluatorUserId) {
      return getFeedbackEligibility(sessionId, evaluatorUserId);
    },
    async submitConversationFeedback(input) {
      return submitConversationFeedback(input);
    },
    async failConversationTurn(input) { return failConversationTurn(input); },
    async listMessageEvidence(assistantMessageId, personaId) {
      return listMessageEvidence(assistantMessageId, personaId);
    },
    async listMessages(personaId, limit) { return listMessages(personaId, limit); },
    async insertMessage(input) { return insertMessage(input); },
  };
}

let cached: AppRepository | null = null;

export function getRepository(): AppRepository {
  if (cached) return cached;
  const config = getStorageConfig();
  cached = selectRepository(
    config,
    createLocalRepository,
    (cloud) => createPostgresRepository(getSql(cloud.databaseUrl)),
  );
  return cached;
}
