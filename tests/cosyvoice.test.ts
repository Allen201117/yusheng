import { it } from "node:test";
import assert from "node:assert/strict";
import { createCosyVoiceRequestBody, synthesizeWithClonedVoice } from "../src/lib/cosyvoice";

it("uses SiliconFlow documented emotion prompt and streaming controls", () => {
  const body = createCosyVoiceRequestBody({
    text: "今天真是太好了！",
    referenceAudioBase64: "YWJj",
    referenceMime: "audio/wav",
    referenceText: "这是参考文字",
    responseFormat: "mp3",
    speech: { emotion: "happy", intensity: 72, speed: 1.05 },
  });

  assert.equal(body.input, "请用自然开心、带一点笑意的语气说，情绪强度较强。<|endofprompt|>今天真是太好了！");
  assert.equal(body.stream, true);
  assert.equal(body.speed, 1.05);
  assert.equal(body.gain, 0);
  assert.equal(body.instruct, undefined);
  assert.deepEqual(body.references, [{
    audio: "data:audio/wav;base64,YWJj",
    text: "这是参考文字",
  }]);
});

it("keeps plain replay natural when speech metadata is absent", () => {
  const body = createCosyVoiceRequestBody({
    text: "早点休息。",
    referenceAudioBase64: "YWJj",
    referenceText: "参考",
  });
  assert.equal(body.input, "早点休息。");
  assert.equal(body.speed, 1);
  assert.equal(body.stream, true);
});

it("uses a reusable preset voice without embedding the reference audio", () => {
  const body = createCosyVoiceRequestBody({
    text: "我一直在这里。",
    presetVoiceId: "speech:yusheng-voice-1:provider-id",
    responseFormat: "mp3",
    speech: { emotion: "warm", intensity: 60, speed: 0.98 },
  });

  assert.equal(body.voice, "speech:yusheng-voice-1:provider-id");
  assert.equal(body.references, undefined);
  assert.equal(body.input, "请用温暖、亲近但不过度煽情的语气说，情绪强度适中。<|endofprompt|>我一直在这里。");
});

it("rejects a clone request that has neither a preset nor reference audio", () => {
  assert.throws(
    () => createCosyVoiceRequestBody({ text: "你好" } as never),
    /缺少预置音色或参考音频/,
  );
});

it("returns a structured provider error without exposing raw response details", async () => {
  const previousKey = process.env.SILICONFLOW_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.SILICONFLOW_API_KEY = "secret";
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: "voice_not_found", message: "sensitive provider detail" }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
  try {
    await assert.rejects(
      synthesizeWithClonedVoice({
        text: "你好",
        presetVoiceId: "speech:yusheng-voice-1:stale",
      }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 404);
        assert.equal((error as { code?: string }).code, "provider_http_404_voice_not_found");
        assert.doesNotMatch((error as Error).message, /sensitive provider detail/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SILICONFLOW_API_KEY;
    else process.env.SILICONFLOW_API_KEY = previousKey;
  }
});
