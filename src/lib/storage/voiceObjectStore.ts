import { randomUUID } from "node:crypto";
import { del as deleteBlob, get as getBlob, put as putBlob } from "@vercel/blob";
import {
  deleteVoiceForUser,
  listVoicesForUser,
  loadVoiceForUser,
  readAudioBase64ForUser,
  saveVoiceForUser,
} from "../voiceStore";
import { sha256Hex } from "./checksum";
import { getStorageConfig, type StorageConfig } from "./config";
import { getRepository } from "./repository";
import type { AppRepository, VoiceMeta } from "./types";

type PrivateBlobOptions = {
  access: "private";
  token: string;
};

type PrivateBlobPutOptions = PrivateBlobOptions & {
  addRandomSuffix: false;
  contentType: string;
};

export interface BlobClient {
  put(
    path: string,
    body: Buffer,
    options: PrivateBlobPutOptions,
  ): Promise<{ pathname: string }>;
  get(
    path: string,
    options: PrivateBlobOptions & { useCache: false },
  ): Promise<{ statusCode: 200; stream: ReadableStream<Uint8Array> } | null>;
  del(path: string, options: { token: string }): Promise<void>;
}

export type PutVoiceObjectInput = {
  userId: string;
  body: Buffer;
  promptText: string;
  mimeType: string;
  durationSec?: number | null;
  voiceId?: string;
};

export type VoiceObject = {
  meta: VoiceMeta;
  body: Buffer;
};

export interface VoiceObjectStore {
  put(input: PutVoiceObjectInput): Promise<VoiceMeta>;
  getMeta(voiceId: string, userId: string): Promise<VoiceMeta | null>;
  get(voiceId: string, userId: string): Promise<VoiceObject | null>;
  list(userId: string): Promise<VoiceMeta[]>;
  delete(voiceId: string, userId: string): Promise<boolean>;
}

function safeSegment(value: string): string {
  if (!value) throw new Error("Voice object path segment cannot be empty");
  return encodeURIComponent(value);
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) {
    return "m4a";
  }
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("ogg")) return "ogg";
  return "wav";
}

export function buildVoiceObjectPath(
  userId: string,
  voiceId: string,
  checksumSha256: string,
  mimeType: string,
): string {
  return [
    "users",
    safeSegment(userId),
    "voices",
    safeSegment(voiceId),
    `${safeSegment(checksumSha256)}.${extensionForMime(mimeType)}`,
  ].join("/");
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

const vercelBlobClient: BlobClient = {
  async put(path, body, options) {
    const result = await putBlob(path, body, options);
    return { pathname: result.pathname };
  },
  async get(path, options) {
    const result = await getBlob(path, options);
    if (!result || result.statusCode !== 200) return null;
    return { statusCode: 200, stream: result.stream };
  },
  async del(path, options) {
    await deleteBlob(path, options);
  },
};

export function createCloudVoiceObjectStore(
  repository: AppRepository,
  blob: BlobClient,
  token: string,
): VoiceObjectStore {
  return {
    async put(input) {
      const voiceId = input.voiceId || randomUUID();
      const checksumSha256 = sha256Hex(input.body);
      const objectPath = buildVoiceObjectPath(
        input.userId,
        voiceId,
        checksumSha256,
        input.mimeType,
      );

      await blob.put(objectPath, input.body, {
        access: "private",
        addRandomSuffix: false,
        contentType: input.mimeType,
        token,
      });

      try {
        return await repository.createVoiceProfile({
          voiceId,
          userId: input.userId,
          objectPath,
          checksumSha256,
          promptText: input.promptText,
          mimeType: input.mimeType,
          durationSec: input.durationSec ?? null,
        });
      } catch (error) {
        await blob.del(objectPath, { token }).catch(() => undefined);
        throw error;
      }
    },

    async get(voiceId, userId) {
      const meta = await repository.getVoiceProfileForUser(voiceId, userId);
      if (!meta) return null;
      const result = await blob.get(meta.objectPath, {
        access: "private",
        token,
        useCache: false,
      });
      if (!result) return null;
      return { meta, body: await streamToBuffer(result.stream) };
    },

    async getMeta(voiceId, userId) {
      return repository.getVoiceProfileForUser(voiceId, userId);
    },

    async list(userId) {
      return repository.listVoiceProfiles(userId);
    },

    async delete(voiceId, userId) {
      const meta = await repository.getVoiceProfileForUser(voiceId, userId);
      if (!meta) return false;
      await blob.del(meta.objectPath, { token });
      return repository.deleteVoiceProfile(voiceId, userId);
    },
  };
}

function mapLocalVoice(
  voice: NonNullable<Awaited<ReturnType<typeof loadVoiceForUser>>>,
  checksumSha256 = "",
): VoiceMeta {
  return {
    voiceId: voice.voiceId,
    userId: voice.userId || "__legacy__",
    objectPath: voice.audioFile,
    audioFile: voice.audioFile,
    checksumSha256,
    promptText: voice.promptText,
    mimeType: voice.mimeType,
    durationSec: voice.durationSec ?? null,
    providerVoiceId: voice.providerVoiceId || null,
    providerVoiceStatus: voice.providerVoiceStatus || "not_created",
    providerVoiceErrorCode: voice.providerVoiceErrorCode || null,
    providerVoiceUpdatedAt: voice.providerVoiceUpdatedAt || null,
    createdAt: voice.createdAt,
  };
}

export function createLocalVoiceObjectStore(): VoiceObjectStore {
  return {
    async put(input) {
      const stored = await saveVoiceForUser(
        input.body,
        input.promptText,
        input.mimeType,
        input.userId,
        input.durationSec,
      );
      return mapLocalVoice(stored, sha256Hex(input.body));
    },
    async get(voiceId, userId) {
      const [meta, base64] = await Promise.all([
        loadVoiceForUser(voiceId, userId),
        readAudioBase64ForUser(voiceId, userId),
      ]);
      if (!meta || !base64) return null;
      return { meta: mapLocalVoice(meta), body: Buffer.from(base64, "base64") };
    },
    async getMeta(voiceId, userId) {
      const meta = await loadVoiceForUser(voiceId, userId);
      return meta ? mapLocalVoice(meta) : null;
    },
    async list(userId) {
      const voices = await listVoicesForUser(userId);
      return voices.map((voice) => mapLocalVoice(voice));
    },
    async delete(voiceId, userId) {
      return deleteVoiceForUser(voiceId, userId);
    },
  };
}

export function selectVoiceObjectStore(
  config: StorageConfig,
  createLocal: () => VoiceObjectStore,
  createCloud: (config: Extract<StorageConfig, { backend: "cloud" }>) => VoiceObjectStore,
): VoiceObjectStore {
  return config.backend === "local" ? createLocal() : createCloud(config);
}

let cached: VoiceObjectStore | null = null;

export function getVoiceObjectStore(): VoiceObjectStore {
  if (cached) return cached;
  const config = getStorageConfig();
  cached = selectVoiceObjectStore(
    config,
    createLocalVoiceObjectStore,
    (cloud) => createCloudVoiceObjectStore(getRepository(), vercelBlobClient, cloud.blobToken),
  );
  return cached;
}
