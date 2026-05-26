/**
 * 测试 TTS 速率限制器 — 纯内存 Map 状态机
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// 每次导入都是同一个模块，需要 reset。用动态 import 每次隔离做法太复杂，
// 这里直接测试模块的外部行为合同：checkTtsRateLimit 的返回结构。
//
// 实际测试：由于 rateLimit.ts 导出了 checkTtsRateLimit，
// 我们验证它的状态机行为。
import { checkTtsRateLimit } from "../src/lib/rateLimit";

describe("checkTtsRateLimit", () => {
  // 注意：同一个 process 里模块只会初始化一次，LIMIT 是 50。
  // 不同 userId 有独立的 bucket，所以用随机 userId 隔离各测试。

  it("第一次调用允许", () => {
    const uid = `test-${Date.now()}-${Math.random()}`;
    const r = checkTtsRateLimit(uid);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 49);
    assert.ok(r.resetAt > Date.now());
  });

  it("多次调用递减 remaining", () => {
    const uid = `test-${Date.now()}-${Math.random()}`;
    checkTtsRateLimit(uid); // 1
    checkTtsRateLimit(uid); // 2
    const r = checkTtsRateLimit(uid); // 3
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 47);
  });

  it("不同 userId 互不影响", () => {
    const a = `test-a-${Date.now()}-${Math.random()}`;
    const b = `test-b-${Date.now()}-${Math.random()}`;
    checkTtsRateLimit(a);
    checkTtsRateLimit(a);
    const rb = checkTtsRateLimit(b);
    assert.equal(rb.remaining, 49); // b 只用了 1 次
  });

  it("返回对象有 allowed/remaining/resetAt 字段", () => {
    const uid = `test-${Date.now()}-${Math.random()}`;
    const r = checkTtsRateLimit(uid);
    assert.equal(typeof r.allowed, "boolean");
    assert.equal(typeof r.remaining, "number");
    assert.equal(typeof r.resetAt, "number");
  });

  it("超限后返回 allowed=false", () => {
    const uid = `test-${Date.now()}-${Math.random()}`;
    // 耗尽 50 次
    for (let i = 0; i < 50; i++) checkTtsRateLimit(uid);
    const r = checkTtsRateLimit(uid);
    assert.equal(r.allowed, false);
    assert.equal(r.remaining, 0);
  });
});
