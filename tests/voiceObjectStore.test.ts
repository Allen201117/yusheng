import { it } from "node:test";
import assert from "node:assert/strict";
import {
  buildVoiceObjectPath,
  createCloudVoiceObjectStore,
  type BlobClient,
} from "../src/lib/storage/voiceObjectStore";
import type { AppRepository, VoiceMeta } from "../src/lib/storage/types";

function createFixture(options: { ownerMatch?: boolean; failMetadata?: boolean } = {}) {
  const blobCalls: Array<{ operation: string; path: string; options?: Record<string, unknown> }> = [];
  const repositoryCalls: string[] = [];
  const stored = new Map<string, Buffer>();
  let meta: VoiceMeta | null = null;

  const blob: BlobClient = {
    async put(path, body, putOptions) {
      blobCalls.push({ operation: "put", path, options: putOptions });
      stored.set(path, Buffer.from(body));
      return { pathname: path };
    },
    async get(path, getOptions) {
      blobCalls.push({ operation: "get", path, options: getOptions });
      const body = stored.get(path);
      if (!body) return null;
      return {
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
      };
    },
    async del(path) {
      blobCalls.push({ operation: "del", path });
      stored.delete(path);
    },
  };

  const repository = {
    async createVoiceProfile(input) {
      repositoryCalls.push("create");
      if (options.failMetadata) throw new Error("database unavailable");
      meta = {
        ...input,
        audioFile: input.objectPath,
        createdAt: "2026-07-13T00:00:00.000Z",
      };
      return meta;
    },
    async getVoiceProfileForUser(_voiceId, userId) {
      repositoryCalls.push("get");
      if (options.ownerMatch === false || meta?.userId !== userId) return null;
      return meta;
    },
    async listVoiceProfiles(userId) {
      repositoryCalls.push("list");
      return meta?.userId === userId ? [meta] : [];
    },
    async deleteVoiceProfile(_voiceId, userId) {
      repositoryCalls.push("delete");
      if (meta?.userId !== userId) return false;
      meta = null;
      return true;
    },
  } as AppRepository;

  return {
    blob,
    repository,
    blobCalls,
    repositoryCalls,
    stored,
    get meta() { return meta; },
  };
}

it("builds an immutable owner-scoped object path", () => {
  assert.equal(
    buildVoiceObjectPath("user-a", "voice-a", "abc123", "audio/mpeg"),
    "users/user-a/voices/voice-a/abc123.mp3",
  );
});

it("uploads a private Blob and records checksum-protected metadata", async () => {
  const fixture = createFixture();
  const store = createCloudVoiceObjectStore(fixture.repository, fixture.blob, "blob-token");

  const result = await store.put({
    userId: "user-a",
    voiceId: "voice-a",
    body: Buffer.from("reference audio"),
    promptText: "今天过得怎么样？",
    mimeType: "audio/mpeg",
    durationSec: 8.2,
  });

  assert.equal(
    result.objectPath,
    `users/user-a/voices/voice-a/${result.checksumSha256}.mp3`,
  );
  assert.match(result.checksumSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(fixture.repositoryCalls, ["create"]);
  assert.equal(fixture.blobCalls[0].operation, "put");
  assert.deepEqual(fixture.blobCalls[0].options, {
    access: "private",
    addRandomSuffix: false,
    contentType: "audio/mpeg",
    token: "blob-token",
  });
});

it("checks ownership before reading bytes from Blob", async () => {
  const fixture = createFixture({ ownerMatch: false });
  const store = createCloudVoiceObjectStore(fixture.repository, fixture.blob, "blob-token");
  await store.put({
    userId: "user-a",
    voiceId: "voice-a",
    body: Buffer.from("secret"),
    promptText: "你好",
    mimeType: "audio/wav",
  });

  assert.equal(await store.get("voice-a", "user-b"), null);
  assert.deepEqual(fixture.blobCalls.map((call) => call.operation), ["put"]);
});

it("reads a private object only after metadata ownership passes", async () => {
  const fixture = createFixture();
  const store = createCloudVoiceObjectStore(fixture.repository, fixture.blob, "blob-token");
  await store.put({
    userId: "user-a",
    voiceId: "voice-a",
    body: Buffer.from("secret"),
    promptText: "你好",
    mimeType: "audio/wav",
  });

  const result = await store.get("voice-a", "user-a");
  assert.equal(result?.body.toString(), "secret");
  assert.equal(fixture.blobCalls.at(-1)?.operation, "get");
  assert.equal(fixture.blobCalls.at(-1)?.options?.access, "private");
});

it("removes an uploaded Blob when metadata creation fails", async () => {
  const fixture = createFixture({ failMetadata: true });
  const store = createCloudVoiceObjectStore(fixture.repository, fixture.blob, "blob-token");

  await assert.rejects(
    store.put({
      userId: "user-a",
      voiceId: "voice-a",
      body: Buffer.from("orphan candidate"),
      promptText: "你好",
      mimeType: "audio/wav",
    }),
    /database unavailable/,
  );
  assert.deepEqual(fixture.blobCalls.map((call) => call.operation), ["put", "del"]);
  assert.equal(fixture.stored.size, 0);
});

it("deletes the private object before soft-deleting its metadata", async () => {
  const fixture = createFixture();
  const store = createCloudVoiceObjectStore(fixture.repository, fixture.blob, "blob-token");
  await store.put({
    userId: "user-a",
    voiceId: "voice-a",
    body: Buffer.from("delete me"),
    promptText: "你好",
    mimeType: "audio/wav",
  });

  assert.equal(await store.delete("voice-a", "user-a"), true);
  assert.deepEqual(fixture.blobCalls.map((call) => call.operation), ["put", "del"]);
  assert.deepEqual(fixture.repositoryCalls, ["create", "get", "delete"]);
});
