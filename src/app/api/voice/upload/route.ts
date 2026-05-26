import { NextRequest, NextResponse } from "next/server";
import { saveVoice, listVoices } from "@/lib/voiceStore";
import { probeAudioDuration } from "@/lib/audioProbe";
import { transcribeAudio } from "@/lib/asr";
import { requireAuth } from "@/lib/guard";

export const runtime = "nodejs";

const MAX_DURATION_SEC = 300; // 5 分钟

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const voices = await listVoices();
  return NextResponse.json({ voices });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const form = await req.formData();
  const file = form.get("audio");
  const promptText = (form.get("promptText") as string | null)?.trim() || "";

  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "缺少 audio 文件字段" }, { status: 400 });
  }
  if (!(file as File).type.startsWith("audio/")) {
    return NextResponse.json({ error: "audio 字段必须是音频文件" }, { status: 400 });
  }

  const arrayBuffer = await (file as File).arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "音频文件不得超过 20MB" }, { status: 400 });
  }

  const mimeType = (file as File).type || "audio/wav";

  // webm 来自浏览器录音，录音计时器已保证 ≤ 300 秒，无需解析时长
  const isWebm = mimeType.includes("webm");
  let duration: number | null = null;
  if (!isWebm) {
    duration = await probeAudioDuration(buffer, mimeType);
    if (duration === null) {
      return NextResponse.json(
        { error: "无法解析音频时长，请改用 wav/mp3/m4a 格式" },
        { status: 400 },
      );
    }
    if (duration > MAX_DURATION_SEC) {
      return NextResponse.json(
        {
          error: `参考音频时长 ${duration.toFixed(1)} 秒，超过上限 ${MAX_DURATION_SEC} 秒。请重新录一段更短的。`,
        },
        { status: 400 },
      );
    }
  }

  // 如果用户没填文字稿，自动识别
  let finalPromptText = promptText;
  if (!finalPromptText) {
    try {
      const filename = (file as File).name || "audio.wav";
      finalPromptText = await transcribeAudio(buffer, filename, mimeType);
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

  const meta = await saveVoice(buffer, finalPromptText, mimeType);
  return NextResponse.json({ ok: true, voice: { ...meta, durationSec: duration, autoTranscribed: !promptText } });
}
