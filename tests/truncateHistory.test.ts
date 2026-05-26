/**
 * 测试 token 估算截断逻辑 — 从 chat/route.ts 提取的核心算法
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

function truncateHistory(messages: { content: string }[], maxTokens: number, minKeep: number) {
  // 从尾向前累计 token 数，超出预算时截掉前面的旧消息
  let estTokens = 0;
  let keepFrom = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    estTokens += Math.ceil(messages[i].content.length / 2);
    if (estTokens > maxTokens && messages.length - i >= minKeep) {
      keepFrom = i;
      break;
    }
  }
  return messages.slice(keepFrom);
}

describe("truncateHistory", () => {
  it("总量在预算内，保留全部", () => {
    const msgs = [
      { content: "你好" },     // 2 chars → 1 token
      { content: "你好啊" },   // 3 chars → 2 token
      { content: "今天天气真好" }, // 6 chars → 3 token
    ];
    const r = truncateHistory(msgs, 10, 2);
    assert.equal(r.length, 3);
  });

  it("超过预算后截断旧消息", () => {
    const msgs = [
      { content: "旧消息".repeat(50) },  // 150 chars → 75 tokens
      { content: "旧消息".repeat(50) },  // 150 chars → 75 tokens
      { content: "旧消息".repeat(50) },  // 150 chars → 75 tokens
      { content: "你好" },                 // 2 chars → 1 token
      { content: "你好啊" },               // 3 chars → 2 tokens
    ];
    const r = truncateHistory(msgs, 10, 2);
    // 从后往前：你好啊(2) + 你好(1) = 3 tokens(budget内)
    // + 旧消息(75) = 78 > 10 → break at i=2 → keepFrom=2 → 3条
    assert.equal(r.length, 3);
    assert.equal(r[r.length - 1].content, "你好啊");
  });

  it("预算极低时保留 minKeep 条", () => {
    const msgs = [
      { content: "x".repeat(500) },
      { content: "x".repeat(500) },
      { content: "x".repeat(500) },
      { content: "你好" },
      { content: "你好啊" },
    ];
    const r = truncateHistory(msgs, 5, 3);
    assert.equal(r.length, 3);
  });

  it("最少保留 minKeep 条", () => {
    const msgs = [
      { content: "x".repeat(1000) },  // 1000 chars → 500 tokens
      { content: "x".repeat(1000) },  // 1000 chars → 500 tokens
      { content: "你好" },
      { content: "你好啊" },
    ];
    const r = truncateHistory(msgs, 10, 3);
    assert.ok(r.length >= 3);
  });

  it("空数组返回空", () => {
    const r = truncateHistory([], 100, 2);
    assert.equal(r.length, 0);
  });
});
