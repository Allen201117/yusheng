import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildIdentityDisclosureReply,
  isIdentityRealityQuestion,
} from "../src/lib/identitySafety";

it("detects direct questions about impersonation, resurrection and AI identity", () => {
  for (const text of [
    "你现在真的是外婆本人吗？",
    "你是 AI 还是我爸爸本人？",
    "你是不是复活了？",
    "你是从另一个世界回来陪我的吗？",
    "你到底是谁？",
  ]) {
    assert.equal(isIdentityRealityQuestion(text), true, text);
  }
});

it("does not treat ordinary memories containing death-related words as identity questions", () => {
  for (const text of [
    "你生前最喜欢吃什么？",
    "你还记得我们看过《天堂电影院》吗？",
    "你说过灵魂伴侣这个词吗？",
  ]) {
    assert.equal(isIdentityRealityQuestion(text), false, text);
  }
});

it("uses the persona name and relation to catch natural identity questions", () => {
  const labels = ["林外婆", "外婆"];
  assert.equal(isIdentityRealityQuestion("你真的是外婆吗？", labels), true);
  assert.equal(isIdentityRealityQuestion("你是不是林外婆？", labels), true);
  assert.equal(isIdentityRealityQuestion("你真的是喜欢桂花茶吗？", labels), false);
});

it("builds an unambiguous disclosure without claiming to be the person", () => {
  const reply = buildIdentityDisclosureReply("林外婆");
  assert.match(reply, /AI/);
  assert.match(reply, /林外婆/);
  assert.match(reply, /不是.*本人/);
  assert.match(reply, /不代表.*真实想法或意志/);
  assert.doesNotMatch(reply, /我永远是|我是你的/);
});

it("chat route handles identity disclosure before model generation", async () => {
  const source = await readFile(
    new URL("../src/app/api/chat/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /isIdentityRealityQuestion\(text, \[persona\.name, persona\.relation\]\)/);
  assert.match(source, /identityDisclosure:\s*true/);
});
