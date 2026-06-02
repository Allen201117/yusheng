import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runUploadProbe(durationSecs: number | number[]) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yusheng-voice-limit-"));
  const durations = Array.isArray(durationSecs) ? durationSecs : [durationSecs];
  const code = `
    import { POST } from "./src/app/api/voice/upload/route.ts";
    import { listVoicesForUser } from "./src/lib/voiceStore.ts";
    import { NextRequest } from "next/server";

    function makeWav(durationSec) {
      const sampleRate = 16000;
      const numSamples = Math.floor(durationSec * sampleRate);
      const dataSize = numSamples * 2;
      const buf = Buffer.alloc(44 + dataSize);
      let p = 0;
      buf.write("RIFF", p); p += 4;
      buf.writeUInt32LE(36 + dataSize, p); p += 4;
      buf.write("WAVE", p); p += 4;
      buf.write("fmt ", p); p += 4;
      buf.writeUInt32LE(16, p); p += 4;
      buf.writeUInt16LE(1, p); p += 2;
      buf.writeUInt16LE(1, p); p += 2;
      buf.writeUInt32LE(sampleRate, p); p += 4;
      buf.writeUInt32LE(sampleRate * 2, p); p += 4;
      buf.writeUInt16LE(2, p); p += 2;
      buf.writeUInt16LE(16, p); p += 2;
      buf.write("data", p); p += 4;
      buf.writeUInt32LE(dataSize, p);
      return buf;
    }

    const form = new FormData();
    const durations = ${JSON.stringify(durations)};
    durations.forEach((duration, index) => {
      const wav = makeWav(duration);
      form.append("audio", new File([new Uint8Array(wav)], "reference-" + index + ".wav", { type: "audio/wav" }));
    });
    form.append("promptText", "这是一段用于测试的参考声音。");
    const req = new NextRequest("http://localhost/api/voice/upload", { method: "POST", body: form });
    const res = await POST(req);
    const json = await res.json().catch(() => ({}));
    const saved = await listVoicesForUser("__dev__");
    console.log(JSON.stringify({ status: res.status, json, savedCount: saved.length }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTH_MODE: "disabled",
      DATA_DIR: dataDir,
    },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as { status: number; json: { error?: string }; savedCount: number };
}

function runWebmProbe(includeDuration: boolean) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yusheng-voice-webm-limit-"));
  const code = `
    import { POST } from "./src/app/api/voice/upload/route.ts";
    import { listVoicesForUser } from "./src/lib/voiceStore.ts";
    import { NextRequest } from "next/server";

    const form = new FormData();
    form.append("audio", new File([new Uint8Array([1, 2, 3, 4])], "reference.webm", { type: "audio/webm" }));
    if (${JSON.stringify(includeDuration)}) form.append("durationSec", "12");
    form.append("promptText", "这是一段用于测试的参考声音。");
    const req = new NextRequest("http://localhost/api/voice/upload", { method: "POST", body: form });
    const res = await POST(req);
    const json = await res.json().catch(() => ({}));
    const saved = await listVoicesForUser("__dev__");
    console.log(JSON.stringify({ status: res.status, json, savedCount: saved.length }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTH_MODE: "disabled",
      DATA_DIR: dataDir,
    },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as { status: number; json: { error?: string }; savedCount: number };
}

describe("voice upload reference duration limit", () => {
  it("rejects reference audio over 30 seconds before it can be used by CosyVoice", () => {
    const result = runUploadProbe(31);
    assert.equal(result.status, 400);
    assert.match(result.json.error || "", /30/);
  });

  it("accepts multiple reference clips while each clip stays within CosyVoice limit", () => {
    const result = runUploadProbe([30, 30]);
    assert.equal(result.status, 200);
    assert.equal((result.json as any).voices.length, 2);
    assert.equal(result.savedCount, 2);
  });

  it("rejects a batch over 5 minutes without partially saving earlier clips", () => {
    const result = runUploadProbe(Array.from({ length: 11 }, () => 30));
    assert.equal(result.status, 400);
    assert.match(result.json.error || "", /300|5 分钟/);
    assert.equal(result.savedCount, 0);
  });

  it("rejects webm references when the client cannot provide duration", () => {
    const result = runWebmProbe(false);
    assert.equal(result.status, 400);
    assert.match(result.json.error || "", /时长/);
    assert.equal(result.savedCount, 0);
  });

  it("accepts a webm recording when the browser sends its measured duration", () => {
    const result = runWebmProbe(true);
    assert.equal(result.status, 200);
    assert.equal(result.savedCount, 1);
  });
});
