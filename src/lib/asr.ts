/**
 * SiliconFlow 语音识别（ASR）客户端
 *
 * 用 SenseVoiceSmall 模型自动把音频转成文字。
 * 手动拼 multipart/form-data body，不依赖 Node.js FormData/Blob 序列化。
 */
const API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = process.env.ASR_MODEL || "FunAudioLLM/SenseVoiceSmall";

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new Error("SILICONFLOW_API_KEY 未配置");
  }

  const boundary = `YS${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();
  const rn = "\r\n";

  const parts: Uint8Array[] = [];
  parts.push(enc.encode(`--${boundary}${rn}`));
  parts.push(enc.encode(`Content-Disposition: form-data; name="file"; filename="${filename}"${rn}`));
  parts.push(enc.encode(`Content-Type: ${mimeType}${rn}${rn}`));
  parts.push(new Uint8Array(audioBuffer));
  parts.push(enc.encode(`${rn}--${boundary}${rn}`));
  parts.push(enc.encode(`Content-Disposition: form-data; name="model"${rn}${rn}`));
  parts.push(enc.encode(DEFAULT_MODEL));
  parts.push(enc.encode(`${rn}--${boundary}--${rn}`));

  const body = Buffer.concat(parts);

  const resp = await fetch(`${API_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`语音识别失败 ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const json = (await resp.json()) as { text?: string };
  return json.text?.trim() || "";
}
