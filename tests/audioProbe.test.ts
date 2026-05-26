/**
 * 测试 WAV 音频时长解析
 *
 * 生成最小 WAV 文件头来测试 parseWav 逻辑。
 * 注意：parseWav 是 audioProbe.ts 内部函数，只能通过 probeAudioDuration 间接测试。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeAudioDuration } from "../src/lib/audioProbe";

/**
 * 生成最小合法 WAV 文件（PCM 16bit mono，任意采样率）
 */
function makeWav(durationSec: number, sampleRate = 16000): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataSize = numSamples * 2; // 16bit = 2 bytes/sample
  const fileSize = 44 + dataSize;

  const buf = Buffer.alloc(fileSize);
  let p = 0;
  buf.write("RIFF", p); p += 4;
  buf.writeUInt32LE(fileSize - 8, p); p += 4; // 文件大小（不含 RIFF id/size）
  buf.write("WAVE", p); p += 4;
  buf.write("fmt ", p); p += 4;
  buf.writeUInt32LE(16, p); p += 4; // chunk size (PCM = 16)
  buf.writeUInt16LE(1, p); p += 2;  // audio format (1 = PCM)
  buf.writeUInt16LE(1, p); p += 2;  // channels (mono)
  buf.writeUInt32LE(sampleRate, p); p += 4;
  buf.writeUInt32LE(sampleRate * 2, p); p += 4; // byteRate = sampleRate * channels * bitsPerSample/8
  buf.writeUInt16LE(2, p); p += 2;  // blockAlign
  buf.writeUInt16LE(16, p); p += 2; // bitsPerSample
  buf.write("data", p); p += 4;
  buf.writeUInt32LE(dataSize, p); p += 4;

  return buf;
}

describe("probeAudioDuration — WAV", () => {
  it("1 秒 WAV 解析出 ~1 秒", async () => {
    const buf = makeWav(1, 16000);
    const dur = await probeAudioDuration(buf, "audio/wav");
    assert.ok(dur !== null);
    assert.ok(Math.abs(dur! - 1) < 0.1);
  });

  it("3 秒 WAV 解析出 ~3 秒", async () => {
    const buf = makeWav(3, 44100);
    const dur = await probeAudioDuration(buf, "audio/wav");
    assert.ok(dur !== null);
    assert.ok(Math.abs(dur! - 3) < 0.1);
  });

  it("0.5 秒 WAV", async () => {
    const buf = makeWav(0.5, 8000);
    const dur = await probeAudioDuration(buf, "audio/wav");
    assert.ok(dur !== null);
    assert.ok(Math.abs(dur! - 0.5) < 0.1);
  });

  it("空 buffer 返回 null", async () => {
    const buf = Buffer.alloc(0);
    const dur = await probeAudioDuration(buf, "audio/wav");
    assert.equal(dur, null);
  });

  it("不支持的格式返回 null", async () => {
    const buf = Buffer.from("not audio data at all");
    const dur = await probeAudioDuration(buf, "application/octet-stream");
    assert.equal(dur, null);
  });

  it("通过 MIME 类型识别 WAV（而非文件内容）", async () => {
    const buf = makeWav(2, 16000);
    const dur = await probeAudioDuration(buf, "audio/wav");
    assert.ok(dur !== null);
    assert.ok(Math.abs(dur! - 2) < 0.1);
  });

  it("通过 MIME 类型识别 mp4/m4a", async () => {
    // m4a 需要特定头，这里用 MIME 走 parseMp4 分支
    const buf = Buffer.alloc(100); // 不够解析 -> null
    const dur = await probeAudioDuration(buf, "audio/mp4");
    assert.equal(dur, null); // 数据不足
  });
});
