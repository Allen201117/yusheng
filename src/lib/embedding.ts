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
    throw new Error(`embedding_provider_error:${resp.status}`);
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    throw new Error("embedding_response_invalid:json");
  }
  if (
    typeof json !== "object" ||
    json === null ||
    !Array.isArray((json as { data?: unknown }).data)
  ) {
    throw new Error("embedding_response_invalid:structure");
  }

  const data = (json as { data: unknown[] }).data;
  if (data.length !== texts.length) {
    throw new Error("embedding_response_invalid:count");
  }

  const result: Array<Float32Array | undefined> = Array.from(
    { length: texts.length },
    () => undefined,
  );
  for (const item of data) {
    if (typeof item !== "object" || item === null) {
      throw new Error("embedding_response_invalid:structure");
    }

    const { embedding, index } = item as {
      embedding?: unknown;
      index?: unknown;
    };
    if (
      !Number.isInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= texts.length ||
      result[index as number] !== undefined
    ) {
      throw new Error("embedding_response_invalid:index");
    }
    if (!Array.isArray(embedding)) {
      throw new Error("embedding_response_invalid:structure");
    }
    if (embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `embedding_dimension_mismatch:${embedding.length}:${EMBEDDING_DIM}`,
      );
    }
    for (let i = 0; i < embedding.length; i++) {
      const value = embedding[i];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("embedding_response_invalid:vector_values");
      }
    }

    const vector = Float32Array.from(embedding);
    for (const value of vector) {
      if (!Number.isFinite(value)) {
        throw new Error("embedding_response_invalid:vector_values");
      }
    }
    result[index as number] = vector;
  }

  if (result.some((embedding) => embedding === undefined)) {
    throw new Error("embedding_response_invalid:incomplete");
  }
  return result as Float32Array[];
}

export async function embedOne(text: string): Promise<Float32Array> {
  const r = await embed([text]);
  return r[0];
}

/** 余弦相似度。两边都假设是 L2 归一化的（bge-m3 默认输出归一化，无需手动） */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    throw new Error(`embedding_dimension_mismatch:${a.length}:${b.length}`);
  }

  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
