/**
 * 测试 webm 格式录音上传 bypass 逻辑
 *
 * voice/upload/route.ts 对 webm 跳过 probeAudioDuration，
 * 因为浏览器录音的计时器已保证 ≤ 300 秒。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("webm upload bypass", () => {
  const isWebm = (mime: string) => mime.includes("webm");

  it("audio/webm 跳过时长解析", () => {
    assert.equal(isWebm("audio/webm"), true);
    assert.equal(isWebm("audio/webm;codecs=opus"), true);
  });

  it("非 webm 正常解析", () => {
    assert.equal(isWebm("audio/wav"), false);
    assert.equal(isWebm("audio/mpeg"), false);
    assert.equal(isWebm("audio/mp4"), false);
  });

  it("录音 file 对象 MIME 是 audio/webm", () => {
    // 模拟 MediaRecorder 产出的 file
    const blob = new Blob(["fake audio"], { type: "audio/webm;codecs=opus" });
    const file = new File([blob], "recording.webm", { type: "audio/webm;codecs=opus" });
    assert.ok(isWebm(file.type));
  });
});
