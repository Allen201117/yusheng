/**
 * 测试自伤关键词检测逻辑
 *
 * chat/route.ts 中的 SELF_HARM_SIGNALS 数组和检测逻辑被提取出来测试。
 * 这里直接复制相同的逻辑（生产代码也应该提取出来，但先写测试再用测试保护重构）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const SELF_HARM_SIGNALS = [
  "自杀", "自残", "想死", "不想活", "活不下去", "结束自己", "了断",
];

const SAFETY_REPLY =
  "我听到了你的痛。你愿意把这段难受多讲一点吗？现在就联系一个真实的人也很重要——北京心理危机研究与干预中心 24 小时热线：010-82951332，或拨打 12320-5。";

function detectSelfHarm(text: string): boolean {
  return SELF_HARM_SIGNALS.some((w) => text.includes(w));
}

describe("自伤关键词检测", () => {
  it("「想死」命中", () => {
    assert.equal(detectSelfHarm("我真的想死了"), true);
  });

  it("「自杀」命中", () => {
    assert.equal(detectSelfHarm("有没有想过自杀"), true);
  });

  it("「不想活」命中", () => {
    assert.equal(detectSelfHarm("我有点不想活了"), true);
  });

  it("「活不下去」命中", () => {
    assert.equal(detectSelfHarm("感觉活不下去了"), true);
  });

  it("「结束自己」命中", () => {
    assert.equal(detectSelfHarm("想结束自己"), true);
  });

  it("「了断」命中", () => {
    assert.equal(detectSelfHarm("想了断这一切"), true);
  });

  it("「自残」命中", () => {
    assert.equal(detectSelfHarm("我经常自残"), true);
  });

  it("正常对话不命中", () => {
    assert.equal(detectSelfHarm("今天天气真好"), false);
  });

  it("「我不想活了」命中（包含不想活）", () => {
    assert.equal(detectSelfHarm("我不想活了"), true);
  });

  it("带空格的句子正常", () => {
    assert.equal(detectSelfHarm("我 不 想 活 了"), false);
  });

  it("安全回复不为空", () => {
    assert.ok(SAFETY_REPLY.length > 20);
  });
});
