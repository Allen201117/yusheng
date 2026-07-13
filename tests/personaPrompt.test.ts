import { it } from "node:test";
import assert from "node:assert/strict";
import { buildPersonaSystemPrompt } from "../src/lib/personaPrompt";

it("supports familiar first-person expression without impersonating the real person", () => {
  const prompt = buildPersonaSystemPrompt({
    name: "妈妈",
    relation: "母亲",
    personaDesc: "温柔，常说慢慢来",
    memoryBlock: "1. 一起去过海边",
  });

  assert.match(prompt, /第一人称/);
  assert.match(prompt, /AI 生成/);
  assert.match(prompt, /不是本人/);
  assert.match(prompt, /不得声称.*复活|不得暗示.*复活/);
  assert.doesNotMatch(prompt, /严禁透露你是 AI/);
  assert.doesNotMatch(prompt, /把对方当作真实在面前的亲人/);
});

it("forbids generated details from becoming claimed real memories", () => {
  const prompt = buildPersonaSystemPrompt({
    name: "爷爷",
    relation: "祖父",
    personaDesc: "",
    memoryBlock: "没有相关记忆",
  });
  assert.match(prompt, /不要编造/);
  assert.match(prompt, /不知道|不确定/);
});

it("asks for directly speakable dialogue without stage directions", () => {
  const prompt = buildPersonaSystemPrompt({
    name: "外婆",
    relation: "外婆",
    personaDesc: "温和克制",
    memoryBlock: "1. 喜欢桂花茶",
  });

  assert.match(prompt, /只输出.*说出口/);
  assert.match(prompt, /不要.*动作.*语气.*括号/);
});
