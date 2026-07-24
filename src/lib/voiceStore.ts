import { runtimeBindings } from "@/lib/cloudflare";
import { getDatabase } from "@/lib/db";

export type VoiceMeta = {
  voiceId: string;
  promptText: string;
  createdAt: string;
  audioFile: string;
  mimeType: string;
  userId?: string;
  durationSec?: number | null;
};

type VoiceRow = { id: string; user_id: string; prompt_text: string; object_key: string; mime_type: string; duration_sec: number | null; created_at: string };
const toMeta = (row: VoiceRow): VoiceMeta => ({ voiceId: row.id, promptText: row.prompt_text, createdAt: row.created_at, audioFile: row.object_key, mimeType: row.mime_type, userId: row.user_id, durationSec: row.duration_sec });
const extension = (mime: string) => mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac") ? "m4a" : mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("webm") ? "webm" : "wav";

function canAccess(meta: VoiceMeta, userId: string) { return meta.userId === userId; }

export async function saveVoiceForUser(audio: Buffer, promptText: string, mimeType: string, userId: string, durationSec?: number | null): Promise<VoiceMeta> {
  const { VOICE_FILES } = runtimeBindings();
  const DB = await getDatabase();
  const voiceId = crypto.randomUUID();
  const objectKey = `voices/${userId}/${voiceId}.${extension(mimeType)}`;
  const createdAt = new Date().toISOString();
  await VOICE_FILES.put(objectKey, new Uint8Array(audio), { httpMetadata: { contentType: mimeType } });
  try {
    await DB.prepare("INSERT INTO voices (id, user_id, prompt_text, object_key, mime_type, duration_sec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(voiceId, userId, promptText, objectKey, mimeType, durationSec ?? null, createdAt).run();
  } catch (error) {
    await VOICE_FILES.delete(objectKey);
    throw error;
  }
  return { voiceId, promptText, createdAt, audioFile: objectKey, mimeType, userId, durationSec };
}

export async function loadVoiceForUser(voiceId: string, userId: string): Promise<VoiceMeta | null> {
  const DB = await getDatabase();
  const row = await DB.prepare("SELECT * FROM voices WHERE id = ? AND user_id = ?").bind(voiceId, userId).first<VoiceRow>();
  return row ? toMeta(row) : null;
}

export async function readAudioBase64ForUser(voiceId: string, userId: string): Promise<string | null> {
  const meta = await loadVoiceForUser(voiceId, userId);
  if (!meta || !canAccess(meta, userId)) return null;
  const object = await runtimeBindings().VOICE_FILES.get(meta.audioFile);
  if (!object) return null;
  return Buffer.from(await object.arrayBuffer()).toString("base64");
}

export async function deleteVoiceForUser(voiceId: string, userId: string): Promise<boolean> {
  const meta = await loadVoiceForUser(voiceId, userId);
  if (!meta) return false;
  const { VOICE_FILES } = runtimeBindings();
  const DB = await getDatabase();
  await Promise.all([DB.prepare("DELETE FROM voices WHERE id = ? AND user_id = ?").bind(voiceId, userId).run(), VOICE_FILES.delete(meta.audioFile)]);
  return true;
}

export async function listVoicesForUser(userId: string): Promise<VoiceMeta[]> {
  const DB = await getDatabase();
  const { results } = await DB.prepare("SELECT * FROM voices WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all<VoiceRow>();
  return results.map(toMeta);
}
