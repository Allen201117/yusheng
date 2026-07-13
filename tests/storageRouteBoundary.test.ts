import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const durableRoutes = [
  "auth/login/route.ts",
  "auth/reset-password/route.ts",
  "auth/send-code/route.ts",
  "chat/route.ts",
  "memory/route.ts",
  "persona/route.ts",
  "tts/route.ts",
  "voice/upload/route.ts",
];

it("routes use the async persistence boundary instead of local SQLite or files", async () => {
  for (const route of durableRoutes) {
    const source = await readFile(
      new URL(`../src/app/api/${route}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /@\/lib\/(db|voiceStore)/, route);
    assert.doesNotMatch(source, /\bgetDb\s*\(/, route);
  }
});

it("voice routes use the object store and data routes use the repository", async () => {
  const voiceRoutes = ["voice/upload/route.ts", "tts/route.ts", "persona/route.ts"];
  for (const route of voiceRoutes) {
    const source = await readFile(new URL(`../src/app/api/${route}`, import.meta.url), "utf8");
    assert.match(source, /getVoiceObjectStore/, route);
  }

  const repositoryRoutes = durableRoutes.filter((route) => route !== "voice/upload/route.ts");
  for (const route of repositoryRoutes) {
    const source = await readFile(new URL(`../src/app/api/${route}`, import.meta.url), "utf8");
    assert.match(source, /getRepository/, route);
  }
});
