/**
 * LLM 客户端 — SiliconFlow DeepSeek-V3
 *
 * 用 OpenAI 兼容的 chat/completions 端点。
 */

const API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = process.env.LLM_MODEL || "deepseek-ai/DeepSeek-V3";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function chatComplete(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error("SILICONFLOW_API_KEY 未配置");

  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 400, // 朗读体验：回复别太长，2-4 句最佳
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`LLM 调用失败 ${resp.status}: ${err}`);
  }
  const json = (await resp.json()) as {
    choices: { message: { content: string } }[];
  };
  return json.choices[0]?.message?.content?.trim() || "";
}

/** 流式版本 — 返回 AsyncGenerator，逐 token 产出 */
export async function* chatCompleteStream(
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error("SILICONFLOW_API_KEY 未配置");

  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 400,
      stream: true,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`LLM 调用失败 ${resp.status}: ${err}`);
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const content = json.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // 解析失败跳过这一帧
      }
    }
  }
}
