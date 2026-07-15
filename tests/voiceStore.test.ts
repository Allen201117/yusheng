/**
 * 测试 voiceStore — 文件存储的 save/load/delete 全流程
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  saveVoice,
  loadVoice,
  deleteVoice,
  saveVoiceForUser,
  deleteVoiceForUser,
  loadVoiceForUser,
  listVoicesForUser,
} from "../src/lib/voiceStore";

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

  it("不会吞掉原始录音删除失败并虚报完成", async () => {
    const meta = await saveVoiceForUser(
      Buffer.from("must remain observable"),
      "测试",
      "audio/wav",
      "owner",
    );
    const metaFile = path.join(testDir, "voices", `${meta.voiceId}.meta.json`);
    await fs.writeFile(metaFile, JSON.stringify({ ...meta, audioFile: path.join(testDir, "voices") }));

    await assert.rejects(() => deleteVoiceForUser(meta.voiceId, "owner"));
    assert.ok(await loadVoiceForUser(meta.voiceId, "owner"));
  });

  it("重试删除时只忽略已经不存在的音频文件", async () => {
    const meta = await saveVoiceForUser(Buffer.from("partial"), "测试", "audio/wav", "owner");
    await fs.unlink(meta.audioFile);

    assert.equal(await deleteVoiceForUser(meta.voiceId, "owner"), true);
    assert.equal(await loadVoiceForUser(meta.voiceId, "owner"), null);
  });

  it("load 不存在的 id 返回 null", async () => {
    const loaded = await loadVoice("nonexistent-id");
    assert.equal(loaded, null);
  });

  it("delete 不存在的 id 不报错", async () => {
    await assert.doesNotReject(() => deleteVoice("nonexistent-id"));
  });

  it("按 userId 隔离声音列表", async () => {
    await saveVoiceForUser(Buffer.from("alice audio"), "alice prompt", "audio/wav", "user-alice");
    await saveVoiceForUser(Buffer.from("bob audio"), "bob prompt", "audio/wav", "user-bob");

    const aliceVoices = await listVoicesForUser("user-alice");
    const bobVoices = await listVoicesForUser("user-bob");

    assert.equal(aliceVoices.length, 1);
    assert.equal(aliceVoices[0].promptText, "alice prompt");
    assert.equal(aliceVoices[0].userId, "user-alice");
    assert.equal(bobVoices.length, 1);
    assert.equal(bobVoices[0].promptText, "bob prompt");
    assert.equal(bobVoices[0].userId, "user-bob");
  });

  it("不同 userId 不能读取对方声音", async () => {
    const meta = await saveVoiceForUser(Buffer.from("private audio"), "private prompt", "audio/wav", "owner");

    assert.ok(await loadVoiceForUser(meta.voiceId, "owner"));
    assert.equal(await loadVoiceForUser(meta.voiceId, "intruder"), null);
  });

  it("旧版无 userId 的声音只归 legacy/dev 用户", async () => {
    const legacy = await saveVoice(Buffer.from("legacy audio"), "legacy prompt", "audio/wav");

    assert.ok(await loadVoiceForUser(legacy.voiceId, "__legacy__"));
    assert.ok(await loadVoiceForUser(legacy.voiceId, "__dev__"));
    assert.equal(await loadVoiceForUser(legacy.voiceId, "new-user"), null);
  });
});
