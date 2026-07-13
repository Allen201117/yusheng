import { it } from "node:test";
import assert from "node:assert/strict";
import { createCosyVoiceRequestBody } from "../src/lib/cosyvoice";

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
