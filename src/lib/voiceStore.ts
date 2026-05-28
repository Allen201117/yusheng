/**
 * 文件存储工具
 * Slice 1 不引入数据库，直接用文件系统：
 *   data/voices/{voiceId}.wav        参考音频原文件
 *   data/voices/{voiceId}.meta.json  元信息（用户输入的 prompt 文本，CosyVoice 零样本需要）
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || "./data";
const VOICES_DIR = path.join(DATA_DIR, "voices");

export async function ensureDirs() {
  await fs.mkdir(VOICES_DIR, { recursive: true });
}

export type VoiceMeta = {
  voiceId: string;
  promptText: string; // 参考音频里说的话（CosyVoice 零样本克隆需要文字稿对齐音色）
  createdAt: string;
  audioFile: string; // 相对项目根的路径
  mimeType: string; // 原始音频 MIME 类型（TTS 调用需要）
};

/** 根据 MIME 类型推断文件扩展名 */
function mimeToExt(mime: string): string {
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "wav";
}

export async function saveVoice(audioBuffer: Buffer, promptText: string, mimeType: string = "audio/wav"): Promise<VoiceMeta> {
  await ensureDirs();
  const voiceId = randomUUID();
  const ext = mimeToExt(mimeType);
  const audioFile = path.join(VOICES_DIR, `${voiceId}.${ext}`);
  const metaFile = path.join(VOICES_DIR, `${voiceId}.meta.json`);
  const meta: VoiceMeta = {
    voiceId,
    promptText,
    createdAt: new Date().toISOString(),
    audioFile,
    mimeType,
  };
  await fs.writeFile(audioFile, audioBuffer);
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));
  return meta;
}

export async function loadVoice(voiceId: string): Promise<VoiceMeta | null> {
  try {
    const metaFile = path.join(VOICES_DIR, `${voiceId}.meta.json`);
    const raw = await fs.readFile(metaFile, "utf-8");
    return JSON.parse(raw) as VoiceMeta;
  } catch {
    return null;
  }
}

export async function readAudioBase64(voiceId: string): Promise<string | null> {
  const meta = await loadVoice(voiceId);
  if (!meta) return null;
  const buf = await fs.readFile(meta.audioFile);
  return buf.toString("base64");
}

export async function deleteVoice(voiceId: string): Promise<void> {
  await ensureDirs();
  const metaFile = path.join(VOICES_DIR, `${voiceId}.meta.json`);
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

export async function listVoices(): Promise<VoiceMeta[]> {
  await ensureDirs();
  const files = await fs.readdir(VOICES_DIR);
  const metas: VoiceMeta[] = [];
  for (const f of files) {
    if (f.endsWith(".meta.json")) {
      try {
        const raw = await fs.readFile(path.join(VOICES_DIR, f), "utf-8");
        metas.push(JSON.parse(raw));
      } catch {
        // 跳过损坏的 meta 文件
      }
    }
  }
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
