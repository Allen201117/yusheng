/**
 * SiliconFlow CosyVoice 客户端
 *
 * 文档：https://docs.siliconflow.cn/cn/api-reference/audio/create-speech
 *
 * 同时支持两种受控的声音来源：
 *   - 预置音色 URI：参考音频只上传一次，适合反复对话；
 *   - 动态参考音频：作为预置音色不可用时的回退。
 */

import { toCosyVoiceControls, type SpeechControls } from "./speechPlanning";
import { providerHttpErrorCode } from "./providerErrors";

const API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = process.env.COSYVOICE_MODEL || "FunAudioLLM/CosyVoice2-0.5B";

type CosyVoiceBaseInput = {
  /** 想让 AI 朗读的目标文本 */
  text: string;
  /** 输出格式 */
  responseFormat?: "wav" | "mp3";
  /** 经过白名单归一化的语音表达控制 */
  speech?: SpeechControls;
};

type CosyVoicePresetInput = CosyVoiceBaseInput & {
  presetVoiceId: string;
  referenceAudioBase64?: never;
  referenceMime?: never;
  referenceText?: never;
};

type CosyVoiceDynamicInput = CosyVoiceBaseInput & {
  presetVoiceId?: never;
  /** 参考音频（任意采样率的 wav/mp3），base64 字符串 */
  referenceAudioBase64: string;
  referenceMime?: string;
  /** 参考音频的文字稿，用来对齐音色 */
  referenceText: string;
};

export type CosyVoiceCloneInput = CosyVoicePresetInput | CosyVoiceDynamicInput;

export type CosyVoiceRequestBody = {
  model: string;
  input: string;
  voice: string;
  response_format: "wav" | "mp3";
  references?: Array<{ audio: string; text: string }>;
  stream: true;
  speed: number;
  gain: number;
  instruct?: never;
};

export class CosyVoiceProviderError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, providerCode: unknown) {
    const code = providerHttpErrorCode(status, providerCode);
    super(`SiliconFlow CosyVoice 调用失败 (${code})`);
    this.name = "CosyVoiceProviderError";
    this.code = code;
    this.status = status;
  }
}

export function createCosyVoiceRequestBody(input: CosyVoiceCloneInput): CosyVoiceRequestBody {
  const controls = input.speech
    ? toCosyVoiceControls(input.speech)
    : { prompt: "", speed: 1, gain: 0 };

  const presetVoiceId = "presetVoiceId" in input ? input.presetVoiceId?.trim() : "";
  const referenceAudio = "referenceAudioBase64" in input
    ? input.referenceAudioBase64?.trim()
    : "";
  if (!presetVoiceId && !referenceAudio) {
    throw new Error("缺少预置音色或参考音频");
  }

  const references = referenceAudio
    ? [{
        audio: `data:${("referenceMime" in input && input.referenceMime) || "audio/wav"};base64,${referenceAudio}`,
        text: ("referenceText" in input && input.referenceText) || "",
      }]
    : undefined;

  return {
    model: DEFAULT_MODEL,
    input: controls.prompt ? `${controls.prompt}<|endofprompt|>${input.text}` : input.text,
    voice: presetVoiceId || "",
    response_format: input.responseFormat || "mp3",
    references,
    stream: true,
    speed: controls.speed,
    gain: controls.gain,
  };
}

export async function synthesizeWithClonedVoice(input: CosyVoiceCloneInput): Promise<Buffer> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new Error("SILICONFLOW_API_KEY 未配置，请在 .env.local 中填入");
  }

  const body = createCosyVoiceRequestBody(input);

  const resp = await fetch(`${API_BASE}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    let providerCode: unknown = "unknown";
    try {
      providerCode = (JSON.parse(errorText) as { code?: unknown }).code || "unknown";
    } catch {
      // 不向上层传递供应商原始响应。
    }
    throw new CosyVoiceProviderError(resp.status, providerCode);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}
