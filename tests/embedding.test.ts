/**
 * 测试 cosineSim — 纯数学函数，不需要任何外部依赖
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cosineSim,
  embed,
  EMBEDDING_DIM,
} from "../src/lib/embedding";

describe("cosineSim", () => {
  it("相同向量返回 1（归一化后）", () => {
    const a = Float32Array.from([0.5, 0.5, 0.5, 0.5]);
    const dot = cosineSim(a, a);
    assert.ok(dot > 0.99);
  });

  it("正交向量返回接近 0", () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([0, 1, 0]);
    assert.ok(Math.abs(cosineSim(a, b)) < 0.001);
  });

  it("相反方向返回负数", () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([-1, 0, 0]);
    assert.ok(cosineSim(a, b) < -0.99);
  });

  it("不同长度向量拒绝计算", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1, 1, 1]);
    assert.throws(() => cosineSim(a, b), /embedding_dimension_mismatch/);
  });

  it("空向量拒绝计算", () => {
    const empty = new Float32Array();
    const nonEmpty = Float32Array.from([1, 0, 0]);
    assert.throws(
      () => cosineSim(empty, nonEmpty),
      /embedding_dimension_mismatch/,
    );
    assert.throws(
      () => cosineSim(nonEmpty, empty),
      /embedding_dimension_mismatch/,
    );
  });

  it("零向量返回 0", () => {
    const a = Float32Array.from([0, 0, 0]);
    const b = Float32Array.from([1, 0, 0]);
    assert.equal(cosineSim(a, b), 0);
  });

  it("bge-m3 归一化向量（模拟真实场景）", () => {
    // bge-m3 输出是 L2 归一化的，余弦相似度就是点积
    const a = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    const b = Float32Array.from([0.4, 0.3, 0.2, 0.1]);
    const sim = cosineSim(a, b);
    // 手动计算：0.1*0.4 + 0.2*0.3 + 0.3*0.2 + 0.4*0.1 = 0.04+0.06+0.06+0.04 = 0.20
    assert.ok(Math.abs(sim - 0.2) < 0.0001);
  });
});

type ProviderRow = { embedding: number[]; index: number };

function makeEmbedding(marker: number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, index) =>
    index === 0 ? marker : 0,
  );
}

async function withMockProviderData(
  data: ProviderRow[],
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.SILICONFLOW_API_KEY;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  process.env.SILICONFLOW_API_KEY = "test-siliconflow-api-key";

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.SILICONFLOW_API_KEY;
    } else {
      process.env.SILICONFLOW_API_KEY = originalApiKey;
    }
  }
}

describe("embed", { concurrency: false }, () => {
  const texts = ["query", "fact", "memory"];

  it("拒绝不完整或 index 非法的批量响应", async () => {
    const vector = makeEmbedding(1);
    const invalidResponses: { name: string; data: ProviderRow[] }[] = [
      {
        name: "data 少一行",
        data: [
          { index: 0, embedding: vector },
          { index: 1, embedding: vector },
        ],
      },
      {
        name: "index=1 重复",
        data: [
          { index: 0, embedding: vector },
          { index: 1, embedding: vector },
          { index: 1, embedding: vector },
        ],
      },
      {
        name: "缺失 index=1",
        data: [
          { index: 0, embedding: vector },
          { index: 2, embedding: vector },
          { index: 0.5, embedding: vector },
        ],
      },
      {
        name: "index=3 越界",
        data: [
          { index: 0, embedding: vector },
          { index: 1, embedding: vector },
          { index: 3, embedding: vector },
        ],
      },
    ];

    for (const response of invalidResponses) {
      await withMockProviderData(response.data, async () => {
        await assert.rejects(
          embed(texts),
          /embedding_response_invalid/,
          response.name,
        );
      });
    }
  });

  it("将完整但乱序的响应按输入顺序重排", async () => {
    await withMockProviderData(
      [
        { index: 2, embedding: makeEmbedding(30) },
        { index: 0, embedding: makeEmbedding(10) },
        { index: 1, embedding: makeEmbedding(20) },
      ],
      async () => {
        const result = await embed(texts);
        assert.equal(result.length, 3);
        assert.deepEqual(
          result.map((vector) => vector[0]),
          [10, 20, 30],
        );
        assert.ok(result.every((vector) => vector.length === EMBEDDING_DIM));
      },
    );
  });

  it("拒绝 provider 返回的错误维度向量", async () => {
    await withMockProviderData(
      [{ index: 0, embedding: Array(EMBEDDING_DIM - 1).fill(0) }],
      async () => {
        await assert.rejects(
          embed(["query"]),
          /embedding_dimension_mismatch/,
        );
      },
    );
  });
});
