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
  ]) assert.equal(isIdentityRealityQuestion(text), true, text);
});

it("does not treat ordinary memories containing death-related words as identity questions", () => {
  for (const text of ["你生前最喜欢吃什么？", "你还记得我们看过《天堂电影院》吗？", "你说过灵魂伴侣这个词吗？"])
    assert.equal(isIdentityRealityQuestion(text), false, text);
});

it("uses persona labels and builds an unambiguous disclosure", () => {
  assert.equal(isIdentityRealityQuestion("你真的是外婆吗？", ["林外婆", "外婆"]), true);
  const reply = buildIdentityDisclosureReply("林外婆");
  assert.match(reply, /AI/);
  assert.match(reply, /林外婆/);
  assert.match(reply, /不是.*本人/);
  assert.match(reply, /不代表.*真实想法或意志/);
});

it("thin chat route delegates identity and other boundaries to the injected pipeline", async () => {
  const route = await readFile(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");
  const implementation = await readFile(new URL("../src/lib/chatRoute.ts", import.meta.url), "utf8");
  assert.match(route, /createChatHandlers/);
  assert.doesNotMatch(route, /isIdentityRealityQuestion|detectConversationBoundary/);
  assert.match(implementation, /detectConversationBoundary/);
});
