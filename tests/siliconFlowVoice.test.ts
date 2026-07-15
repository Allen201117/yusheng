import { it } from "node:test";
import assert from "node:assert/strict";
import {
  createPresetVoiceName,
  createUploadVoiceBody,
  deletePresetVoice,
  listPresetVoices,
  uploadPresetVoice,
} from "../src/lib/siliconFlowVoice";

it("builds a provider-safe deterministic preset name", () => {
  assert.equal(
    createPresetVoiceName("550e8400-e29b-41d4-a716-446655440000"),
    "yusheng-550e8400-e29b-41d4-a716-4466554-a3a9e1ed9732cab2",
  );
  assert.notEqual(createPresetVoiceName("a_b"), createPresetVoiceName("a-b"));
  assert.notEqual(
    createPresetVoiceName(`${"a".repeat(60)}-one`),
    createPresetVoiceName(`${"a".repeat(60)}-two`),
  );
});

it("builds the documented base64 upload body", () => {
  assert.deepEqual(createUploadVoiceBody({
    voiceId: "voice-1",
    audio: Buffer.from("reference"),
    mimeType: "audio/mpeg",
    promptText: "今天天气很好。",
  }), {
    model: "FunAudioLLM/CosyVoice2-0.5B",
    customName: createPresetVoiceName("voice-1"),
    audio: "data:audio/mpeg;base64,cmVmZXJlbmNl",
    text: "今天天气很好。",
  });
});

it("uploads a preset and returns its provider URI", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ uri: "speech:yusheng-voice-1:provider-id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const uri = await uploadPresetVoice({
    voiceId: "voice-1",
    audio: Buffer.from("reference"),
    mimeType: "audio/wav",
    promptText: "你好",
  }, { apiKey: "secret", fetcher });

  assert.equal(uri, "speech:yusheng-voice-1:provider-id");
  assert.equal(calls[0].url, "https://api.siliconflow.cn/v1/uploads/audio/voice");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer secret");
  assert.doesNotMatch(String(calls[0].init?.body), /secret/);
});

it("deletes a preset by URI using the documented endpoint", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("", { status: 200 });
  };

  await deletePresetVoice("speech:yusheng-voice-1:provider-id", {
    apiKey: "secret",
    fetcher,
  });

  assert.equal(calls[0].url, "https://api.siliconflow.cn/v1/audio/voice/deletions");
  assert.equal(calls[0].init?.body, JSON.stringify({ uri: "speech:yusheng-voice-1:provider-id" }));
});

it("lists provider voices with only validated names and URIs", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    results: [
      { customName: "yusheng-voice-1", uri: "speech:yusheng-voice-1:provider-id" },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  assert.deepEqual(await listPresetVoices({ apiKey: "secret", fetcher }), [{
    customName: "yusheng-voice-1",
    uri: "speech:yusheng-voice-1:provider-id",
  }]);
});

it("fails closed when any provider voice-list item is malformed", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    results: [{ customName: 123, uri: "bad" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  await assert.rejects(
    listPresetVoices({ apiKey: "secret", fetcher }),
    (error: unknown) => (error as { code?: string }).code === "provider_invalid_response",
  );
});

it("surfaces a stable error code without leaking the provider response", async () => {
  const fetcher: typeof fetch = async () => new Response(
    JSON.stringify({ code: 10001, message: "provider internal details" }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    uploadPresetVoice({
      voiceId: "voice-1",
      audio: Buffer.from("reference"),
      mimeType: "audio/wav",
      promptText: "你好",
    }, { apiKey: "secret", fetcher }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "provider_http_403_10001");
      assert.doesNotMatch((error as Error).message, /internal details/);
      return true;
    },
  );
});
