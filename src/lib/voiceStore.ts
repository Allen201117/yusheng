/**
 * 用户级声音文件存储：
 *   data/voices/{voiceId}.{ext}      参考音频原文件
 *   data/voices/{voiceId}.meta.json  元信息（prompt 文本、MIME、userId）
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function voicesDir(): string {
  return path.join(process.env.DATA_DIR || "./data", "voices");
}

export async function ensureDirs() {
  await fs.mkdir(voicesDir(), { recursive: true });
}

export type VoiceMeta = {
  voiceId: string;
  promptText: string; // 参考音频里说的话（CosyVoice 零样本克隆需要文字稿对齐音色）
  createdAt: string;
  audioFile: string; // 相对项目根的路径
  mimeType: string; // 原始音频 MIME 类型（TTS 调用需要）
  userId?: string; // 新版声音所有者；旧 meta 缺失时视为 "__legacy__"
  durationSec?: number | null; // 单段参考音频时长；旧 meta 可能缺失
};

/** 根据 MIME 类型推断文件扩展名 */
function mimeToExt(mime: string): string {
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "wav";
}

export async function saveVoice(audioBuffer: Buffer, promptText: string, mimeType: string = "audio/wav"): Promise<VoiceMeta> {
  return saveVoiceInternal(audioBuffer, promptText, mimeType);
}

export async function saveVoiceForUser(
  audioBuffer: Buffer,
  promptText: string,
  mimeType: string,
  userId: string,
  durationSec?: number | null,
): Promise<VoiceMeta> {
  return saveVoiceInternal(audioBuffer, promptText, mimeType, userId, durationSec);
}

async function saveVoiceInternal(
  audioBuffer: Buffer,
  promptText: string,
  mimeType: string = "audio/wav",
  userId?: string,
  durationSec?: number | null,
): Promise<VoiceMeta> {
  await ensureDirs();
  const voiceId = randomUUID();
  const ext = mimeToExt(mimeType);
  const dir = voicesDir();
  const audioFile = path.join(dir, `${voiceId}.${ext}`);
  const metaFile = path.join(dir, `${voiceId}.meta.json`);
  const meta: VoiceMeta = {
    voiceId,
    promptText,
    createdAt: new Date().toISOString(),
    audioFile,
    mimeType,
  };
  if (userId) meta.userId = userId;
  if (durationSec !== undefined) meta.durationSec = durationSec;
  await fs.writeFile(audioFile, audioBuffer);
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));
  return meta;
}

export async function loadVoice(voiceId: string): Promise<VoiceMeta | null> {
  try {
    const metaFile = path.join(voicesDir(), `${voiceId}.meta.json`);
    const raw = await fs.readFile(metaFile, "utf-8");
    return JSON.parse(raw) as VoiceMeta;
  } catch {
    return null;
  }
}

export async function loadVoiceForUser(voiceId: string, userId: string): Promise<VoiceMeta | null> {
  const meta = await loadVoice(voiceId);
  if (!meta) return null;
  return canAccessVoice(meta, userId) ? meta : null;
}

function canAccessVoice(meta: VoiceMeta, userId: string): boolean {
  const owner = meta.userId || "__legacy__";
  if (owner === userId) return true;
  return owner === "__legacy__" && (userId === "__legacy__" || userId === "__dev__");
}

export async function readAudioBase64(voiceId: string): Promise<string | null> {
  const meta = await loadVoice(voiceId);
  if (!meta) return null;
  const buf = await fs.readFile(meta.audioFile);
  return buf.toString("base64");
}

export async function readAudioBase64ForUser(voiceId: string, userId: string): Promise<string | null> {
  const meta = await loadVoiceForUser(voiceId, userId);
  if (!meta) return null;
  const buf = await fs.readFile(meta.audioFile);
  return buf.toString("base64");
}

export async function deleteVoice(voiceId: string): Promise<void> {
  await ensureDirs();
  const metaFile = path.join(voicesDir(), `${voiceId}.meta.json`);
  let meta: VoiceMeta | null = null;
  try {
    const raw = await fs.readFile(metaFile, "utf-8");
    meta = JSON.parse(raw) as VoiceMeta;
  } catch {
    return; // meta 不存在就不清
  }
  await fs.unlink(meta.audioFile).catch(() => {});
  await fs.unlink(metaFile).catch(() => {});
}

export async function deleteVoiceForUser(voiceId: string, userId: string): Promise<boolean> {
  const meta = await loadVoiceForUser(voiceId, userId);
  if (!meta) return false;
  await deleteVoice(voiceId);
  return true;
}

export async function listVoices(): Promise<VoiceMeta[]> {
  await ensureDirs();
  const dir = voicesDir();
  const files = await fs.readdir(dir);
  const metas: VoiceMeta[] = [];
  for (const f of files) {
    if (f.endsWith(".meta.json")) {
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf-8");
        metas.push(JSON.parse(raw));
      } catch {
        // 跳过损坏的 meta 文件
      }
    }
  }
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listVoicesForUser(userId: string): Promise<VoiceMeta[]> {
  const voices = await listVoices();
  return voices.filter((v) => canAccessVoice(v, userId));
}
