import { NextRequest, NextResponse } from "next/server";
import { saveVoiceForUser, listVoicesForUser } from "@/lib/voiceStore";
import { probeAudioDuration } from "@/lib/audioProbe";
import { transcribeAudio } from "@/lib/asr";
import { requireAuth } from "@/lib/guard";
import {
  MAX_REFERENCE_AUDIO_DURATION_SEC,
  MAX_VOICE_MATERIAL_TOTAL_DURATION_SEC,
} from "@/lib/voiceLimits";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if ("error" in auth) return auth.error;
    const voices = await listVoicesForUser(auth.userId);
    return NextResponse.json({ voices });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `获取列表失败：${message}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if ("error" in auth) return auth.error;

    const form = await req.formData();
    const files = form.getAll("audio").filter((item): item is File => item instanceof File);
    const promptText = (form.get("promptText") as string | null)?.trim() || "";
    const durationFields = form.getAll("durationSec");

    if (files.length === 0) {
      return NextResponse.json({ error: "缺少 audio 文件字段" }, { status: 400 });
    }
    const existing = await listVoicesForUser(auth.userId);
    const existingDuration = existing.reduce((sum, voice) => sum + (voice.durationSec || 0), 0);
    let batchDuration = 0;
    const prepared: Array<{
      file: File;
      buffer: Buffer;
      mimeType: string;
      duration: number | null;
    }> = [];

    for (const [index, file] of files.entries()) {
      if (!file.type.startsWith("audio/")) {
        return NextResponse.json({ error: "audio 字段必须是音频文件" }, { status: 400 });
      }

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.byteLength > 20 * 1024 * 1024) {
        return NextResponse.json({ error: "单个音频文件不得超过 20MB" }, { status: 400 });
      }

      const mimeType = file.type || "audio/wav";
      const isWebm = mimeType.includes("webm");
      let duration: number | null = null;
      if (isWebm) {
        const durationFromClient = Number(durationFields[index] || "");
        duration = Number.isFinite(durationFromClient) && durationFromClient > 0 ? durationFromClient : null;
        if (duration === null) {
          return NextResponse.json(
            { error: `无法确认 ${file.name || "webm 音频"} 的时长，请重新录制或改用 wav/mp3/m4a 格式` },
            { status: 400 },
          );
        }
      } else {
        duration = await probeAudioDuration(buffer, mimeType);
        if (duration === null) {
          return NextResponse.json(
            { error: `无法解析 ${file.name || "音频"} 的时长，请改用 wav/mp3/m4a 格式` },
            { status: 400 },
          );
        }
      }

      if (duration !== null && duration > MAX_REFERENCE_AUDIO_DURATION_SEC) {
        return NextResponse.json(
          {
            error: `参考音频「${file.name || "未命名"}」时长 ${duration.toFixed(1)} 秒，单段上限 ${MAX_REFERENCE_AUDIO_DURATION_SEC} 秒。请切成多段上传。`,
          },
          { status: 400 },
        );
      }

      batchDuration += duration || 0;
      prepared.push({ file, buffer, mimeType, duration });
    }

    if (existingDuration + batchDuration > MAX_VOICE_MATERIAL_TOTAL_DURATION_SEC) {
      return NextResponse.json(
        {
          error: `参考声音素材总量不能超过 ${MAX_VOICE_MATERIAL_TOTAL_DURATION_SEC} 秒。当前已有 ${existingDuration.toFixed(1)} 秒，本次约 ${batchDuration.toFixed(1)} 秒。`,
        },
        { status: 400 },
      );
    }

    const saved = [];
    for (const item of prepared) {
      const { file, buffer, mimeType, duration } = item;

      let finalPromptText = promptText;
      if (!finalPromptText) {
        try {
          finalPromptText = await transcribeAudio(buffer, file.name || "audio.wav", mimeType);
        } catch (err) {
          return NextResponse.json(
            { error: "自动识别文字失败，请手动填写文字稿。" + (err instanceof Error ? `原因：${err.message}` : "") },
            { status: 400 },
          );
        }
        if (!finalPromptText) {
          return NextResponse.json(
            { error: "自动识别结果为空，请手动填写文字稿。" },
            { status: 400 },
          );
        }
      }

      const meta = await saveVoiceForUser(buffer, finalPromptText, mimeType, auth.userId, duration);
      saved.push({ ...meta, durationSec: duration, autoTranscribed: !promptText });
    }

    return NextResponse.json({ ok: true, voice: saved[0], voices: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `保存失败：${message}` }, { status: 500 });
  }
}
