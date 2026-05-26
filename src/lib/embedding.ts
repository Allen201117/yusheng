/**
 * Embedding 客户端 — SiliconFlow bge-m3
 *
 * 文档：https://docs.siliconflow.cn/cn/api-reference/embeddings/create-embeddings
 * 模型：BAAI/bge-m3，输出维度 1024，中英文都行。
 */

const API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = process.env.EMBEDDING_MODEL || "BAAI/bge-m3";

export const EMBEDDING_DIM = 1024;

export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error("SILICONFLOW_API_KEY 未配置");

  const resp = await fetch(`${API_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input: texts,
      encoding_format: "float",
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Embedding 调用失败 ${resp.status}: ${err}`);
  }
  const json = (await resp.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  // 按 index 排序，确保和 input 顺序一致
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => Float32Array.from(d.embedding));
}

export async function embedOne(text: string): Promise<Float32Array> {
  const r = await embed([text]);
  return r[0];
}

/** 余弦相似度。两边都假设是 L2 归一化的（bge-m3 默认输出归一化，无需手动） */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
