/**
 * 测试 voiceStore — 文件存储的 save/load/delete 全流程
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { saveVoice, loadVoice, deleteVoice } from "../src/lib/voiceStore";

describe("voiceStore", () => {
  const testDir = path.join(os.tmpdir(), `yusheng-test-voices-${Date.now()}`);

  beforeEach(async () => {
    // 临时修改 DATA_DIR 比较麻烦，这里测试的是文件操作本身
    // 借助 saveVoice/loadVoice/deleteVoice 的 public API
    process.env.DATA_DIR = testDir;
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it("保存后可以 load", async () => {
    const buf = Buffer.from("test audio data");
    const meta = await saveVoice(buf, "今天天气真好", "audio/wav");
    const loaded = await loadVoice(meta.voiceId);
    assert.ok(loaded !== null);
    assert.equal(loaded!.promptText, "今天天气真好");
    assert.equal(loaded!.mimeType, "audio/wav");
  });

  it("MIME 推断扩展名", async () => {
    // m4a → .m4a
    const meta = await saveVoice(Buffer.from("x"), "test", "audio/mp4");
    assert.ok(meta.audioFile.endsWith(".m4a"));

    // mp3 → .mp3
    const meta2 = await saveVoice(Buffer.from("x"), "test", "audio/mpeg");
    assert.ok(meta2.audioFile.endsWith(".mp3"));

    // wav → .wav
    const meta3 = await saveVoice(Buffer.from("x"), "test", "audio/wav");
    assert.ok(meta3.audioFile.endsWith(".wav"));
  });

  it("删除后 load 返回 null", async () => {
    const meta = await saveVoice(Buffer.from("will be deleted"), "测试", "audio/wav");
    await deleteVoice(meta.voiceId);
    const loaded = await loadVoice(meta.voiceId);
    assert.equal(loaded, null);
  });

  it("load 不存在的 id 返回 null", async () => {
    const loaded = await loadVoice("nonexistent-id");
    assert.equal(loaded, null);
  });

  it("delete 不存在的 id 不报错", async () => {
    await assert.doesNotReject(() => deleteVoice("nonexistent-id"));
  });
});
