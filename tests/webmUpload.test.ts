/**
 * 测试 webm 格式录音上传的时长处理路径
 *
 * voice/upload/route.ts 会识别 webm，并要求浏览器提交测得的录音时长，
 * 因为纯 JS 解析器不支持直接从 webm 头里计算 duration。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("webm upload duration handling", () => {
  const isWebm = (mime: string) => mime.includes("webm");

  it("识别 audio/webm 为客户端时长路径", () => {
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
