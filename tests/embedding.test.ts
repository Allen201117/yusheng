/**
 * 测试 cosineSim — 纯数学函数，不需要任何外部依赖
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cosineSim } from "../src/lib/embedding";

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

  it("不同长度向量按较短计算", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1, 1, 1]);
    // 只取前 2 维，dot = 0
    assert.equal(cosineSim(a, b), 0);
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
