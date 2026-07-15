import { it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrackedTtsRequest,
  trackedSpeechFromSseEvent,
} from "../src/lib/chatSpeechClient";

it("turns a tracked SSE sentence into a server-owned TTS request", () => {
  const plan = trackedSpeechFromSseEvent({
    sentence: {
      sentenceId: "sentence-1",
      index: 0,
      text: "服务端保存的话。",
      emotion: "warm",
      intensity: 55,
      speed: 0.96,
      pauseAfterMs: 360,
    },
  });

  assert.ok(plan);
  assert.deepEqual(buildTrackedTtsRequest(plan), { sentenceId: "sentence-1" });
});

it("rejects an SSE sentence without a usable server sentence id", () => {
  assert.equal(trackedSpeechFromSseEvent({ sentence: {
    index: 0,
    text: "没有追踪。",
    emotion: "calm",
    intensity: 45,
    speed: 1,
    pauseAfterMs: 0,
  } }), null);
  assert.equal(trackedSpeechFromSseEvent({ sentence: {
    sentenceId: " ",
    index: 0,
    text: "空 ID。",
    emotion: "calm",
    intensity: 45,
    speed: 1,
    pauseAfterMs: 0,
  } }), null);
  assert.equal(trackedSpeechFromSseEvent({
    done: true,
    reply: "保留文本，但不得自动整段无追踪合成。",
  }), null);
});
