import {
  countPersonasUsingVoice,
  createPersona,
  createUserByEmail,
  createVerificationCode,
  deleteMemory,
  getDb,
  getMemoryById,
  getPersonaForUser,
  getUserByEmail,
  insertMemory,
  insertMessage,
  listMemories,
  listMessages,
  listPersonas,
  loadMemoriesWithEmbeddings,
  setUserPassword,
  verifyCode,
} from "../db";
import {
  deleteVoiceForUser,
  listVoicesForUser,
  loadVoiceForUser,
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
    async deleteVoiceProfile(voiceId, userId) {
      return deleteVoiceForUser(voiceId, userId);
    },
    async listMemories(personaId) { return listMemories(personaId); },
    async getMemoryById(id) { return getMemoryById(id); },
    async insertMemory(input) { insertMemory(input); },
    async deleteMemory(id) { deleteMemory(id); },
    async loadMemoriesWithEmbeddings(personaId) {
      return loadMemoriesWithEmbeddings(personaId);
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
