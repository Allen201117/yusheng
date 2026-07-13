import { providerHttpErrorCode } from "./providerErrors";

const API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = process.env.COSYVOICE_MODEL || "FunAudioLLM/CosyVoice2-0.5B";

export type UploadPresetVoiceInput = {
  voiceId: string;
  audio: Buffer;
  mimeType: string;
  promptText: string;
};

type VoiceClientOptions = {
  apiKey?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

export class SiliconFlowVoiceError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(`SiliconFlow voice operation failed (${code})`);
    this.name = "SiliconFlowVoiceError";
    this.code = code;
    this.status = status;
  }
}

function requireApiKey(value?: string): string {
  const apiKey = value || process.env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new SiliconFlowVoiceError("provider_not_configured");
  return apiKey;
}

async function providerError(response: Response): Promise<SiliconFlowVoiceError> {
  let providerCode = "unknown";
  try {
    const payload = await response.json() as { code?: unknown };
    providerCode = String(payload.code || "unknown");
  } catch {
    // 只保留稳定错误码，不将供应商原始响应写入应用错误。
  }
  return new SiliconFlowVoiceError(
    providerHttpErrorCode(response.status, providerCode),
    response.status,
  );
}

export function createPresetVoiceName(voiceId: string): string {
  const segment = voiceId
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!segment) throw new Error("voiceId 不能为空");
  return `yusheng-${segment}`;
}

export function createUploadVoiceBody(input: UploadPresetVoiceInput) {
  return {
    model: DEFAULT_MODEL,
    customName: createPresetVoiceName(input.voiceId),
    audio: `data:${input.mimeType || "audio/wav"};base64,${input.audio.toString("base64")}`,
    text: input.promptText,
  };
}

export async function uploadPresetVoice(
  input: UploadPresetVoiceInput,
  options: VoiceClientOptions = {},
): Promise<string> {
  const apiKey = requireApiKey(options.apiKey);
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(`${API_BASE}/uploads/audio/voice`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createUploadVoiceBody(input)),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok) throw await providerError(response);

  const payload = await response.json() as { uri?: unknown };
  const uri = typeof payload.uri === "string" ? payload.uri.trim() : "";
  if (!uri.startsWith("speech:")) {
    throw new SiliconFlowVoiceError("provider_invalid_response", response.status);
  }
  return uri;
}

export async function deletePresetVoice(
  uri: string,
  options: VoiceClientOptions = {},
): Promise<void> {
  if (!uri.startsWith("speech:")) throw new Error("无效的预置音色 URI");
  const apiKey = requireApiKey(options.apiKey);
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(`${API_BASE}/audio/voice/deletions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ uri }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (!response.ok && response.status !== 404) throw await providerError(response);
}
