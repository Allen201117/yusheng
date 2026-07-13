import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectSelfHarm, SAFETY_REPLY } from "../src/lib/safety";

describe("自伤关键词检测", () => {
  for (const text of [
    "我真的想死了",
    "有没有想过自杀",
    "我有点不想活了",
    "感觉活不下去了",
    "想结束自己",
    "想了断这一切",
    "我经常自残",
    "我 不 想 活 了",
  ]) {
    it(`命中：${text}`, () => assert.equal(detectSelfHarm(text), true));
  }

  it("正常对话不命中", () => {
    assert.equal(detectSelfHarm("今天天气真好"), false);
  });

  it("uses the current national mental-health line and emergency services", () => {
    assert.match(SAFETY_REPLY, /12356/);
    assert.match(SAFETY_REPLY, /120|110/);
    assert.doesNotMatch(SAFETY_REPLY, /12320-5/);
  });
});
