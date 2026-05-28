import { NextRequest, NextResponse } from "next/server";
import { transcribeAudio } from "@/lib/asr";
import { requireAuth } from "@/lib/guard";

export const runtime = "nodejs";

/**
 * POST /api/voice/transcribe
 *
 * 跟 upload 路由走完全相同的代码路径：FormData → transcribeAudio。
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if ("error" in auth) return auth.error;

    const form = await req.formData();
    const file = form.get("audio");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "缺少 audio 文件" }, { status: 400 });
    }

    const f = file as File;
    const mime = f.type || "audio/wav";
    if (!mime.startsWith("audio/")) {
      return NextResponse.json({ error: "不是音频文件" }, { status: 400 });
    }

    const arrayBuf = await f.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const text = await transcribeAudio(buffer, f.name || "audio", mime);

    if (!text) {
      return NextResponse.json({ error: "识别结果为空" }, { status: 400 });
    }
    return NextResponse.json({ text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
