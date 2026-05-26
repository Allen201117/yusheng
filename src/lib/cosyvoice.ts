/**
 * SiliconFlow CosyVoice 客户端
 *
 * 文档：https://docs.siliconflow.cn/cn/api-reference/audio/create-speech
 *
 * Slice 1 用 CosyVoice2-0.5B 的"零样本声音克隆"模式：
 *   - 上传一段参考音频（推荐 10-30 秒清晰人声）
 *   - 提供这段音频的文字稿（reference text）
 *   - 提供想让它读出的目标文本
 *   - 返回克隆出的音频
 *
 * 注意：SiliconFlow 提供两种方式：
 *   方案 A (本文件采用)：每次推理都把参考音频随请求传上去（base64）。简单，无需上传步骤。
 *   方案 B：先调 /uploads/audio/voice 上传得到 voice id，再用 voice 字段引用。适合多人复用。
 * Slice 1 选 A，省一个 API 调用，等多用户化时再升级到 B。
 */

const API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = process.env.COSYVOICE_MODEL || "FunAudioLLM/CosyVoice2-0.5B";

export type CosyVoiceCloneInput = {
  /** 想让 AI 朗读的目标文本 */
  text: string;
  /** 参考音频（任意采样率的 wav/mp3），base64 字符串 */
  referenceAudioBase64: string;
  referenceMime?: string; // 默认 audio/wav
  /** 参考音频的文字稿，用来对齐音色 */
  referenceText: string;
  /** 输出格式 */
  responseFormat?: "wav" | "mp3";
  /** 语调控制（CosyVoice2 instruct 模式），如 "语速慢一点，语气温柔" */
  instruct?: string;
};

export async function synthesizeWithClonedVoice(input: CosyVoiceCloneInput): Promise<Buffer> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new Error("SILICONFLOW_API_KEY 未配置，请在 .env.local 中填入");
  }

  const referenceMime = input.referenceMime || "audio/wav";

  const body: Record<string, unknown> = {
    model: DEFAULT_MODEL,
    input: input.text,
    voice: "", // 留空表示用 references 中的零样本克隆
    response_format: input.responseFormat || "mp3",
    references: [
      {
        audio: `data:${referenceMime};base64,${input.referenceAudioBase64}`,
        text: input.referenceText,
      },
    ],
  };

  // CosyVoice2 instruct 模式：用自然语言控制语速、语气、情感
  if (input.instruct) {
    body.instruct = input.instruct;
  }

  const resp = await fetch(`${API_BASE}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`SiliconFlow CosyVoice 调用失败 ${resp.status}: ${errText}`);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}
