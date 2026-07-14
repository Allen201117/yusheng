import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const durableRoutes = [
  "auth/login/route.ts",
  "auth/reset-password/route.ts",
  "auth/send-code/route.ts",
  "chat/route.ts",
  "memory/route.ts",
  "persona-knowledge/route.ts",
  "persona/route.ts",
  "tts/route.ts",
  "voice/upload/route.ts",
  "voice/authorization/route.ts",
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
  const voiceRoutes = [
    "voice/upload/route.ts",
    "voice/authorization/route.ts",
    "tts/route.ts",
    "persona/route.ts",
  ];
  for (const route of voiceRoutes) {
    const source = await readFile(new URL(`../src/app/api/${route}`, import.meta.url), "utf8");
    assert.match(source, /getVoiceObjectStore/, route);
  }

  const repositoryRoutes = durableRoutes.filter(
    (route) => route !== "voice/upload/route.ts" && route !== "persona-knowledge/route.ts",
  );
  for (const route of repositoryRoutes) {
    const source = await readFile(new URL(`../src/app/api/${route}`, import.meta.url), "utf8");
    assert.match(source, /getRepository/, route);
  }

  const personaKnowledgeRoute = await readFile(
    new URL("../src/app/api/persona-knowledge/route.ts", import.meta.url),
    "utf8",
  );
  const personaKnowledgeImplementation = await readFile(
    new URL("../src/lib/personaKnowledgeRoute.ts", import.meta.url),
    "utf8",
  );
  assert.match(personaKnowledgeRoute, /createPersonaKnowledgeHandlers/);
  assert.doesNotMatch(personaKnowledgeRoute, /@\/lib\/(db|voiceStore)/);
  assert.match(personaKnowledgeImplementation, /getRepository/);
  assert.doesNotMatch(personaKnowledgeImplementation, /@\/lib\/(db|voiceStore)/);
  assert.doesNotMatch(personaKnowledgeImplementation, /\bgetDb\s*\(/);
});

it("manual memory ingestion creates server-owned confirmation audit fields", async () => {
  const source = await readFile(
    new URL("../src/app/api/memory/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /sourceId\s*=\s*randomUUID\(\)/);
  assert.match(source, /createdBy:\s*auth\.userId/);
  assert.match(source, /checksumAlgorithm:\s*["']sha256["']/);
  assert.match(source, /sha256Hex\(Buffer\.from\(content,\s*["']utf8["']\)\)/);
  assert.doesNotMatch(source, /body\.(?:status|confirmedBy|sourceId|checksum)/);
  assert.match(source, /vectors\.length\s*!==\s*contents\.length/);
  assert.match(source, /repository\.insertMemories\(inputs\)/);
  assert.doesNotMatch(source, /repository\.insertMemory\(/);
  assert.match(source, /@\/lib\/memoryRoute/);
  assert.match(source, /status:\s*409/);
});

it("manual memory input trims strings and rejects non-string values before embedding", async () => {
  const { parseMemoryContents } = await import("../src/lib/memoryRoute");
  assert.deepEqual(parseMemoryContents({ content: "  一起吃饭  ", contents: ["  ", " 去海边 "] }), {
    contents: ["一起吃饭", "去海边"],
  });
  assert.deepEqual(parseMemoryContents({ content: 42 }), { error: "content 必须是字符串" });
  assert.deepEqual(parseMemoryContents({ contents: ["正常", { forged: true }] }), {
    error: "contents 每一项都必须是字符串",
  });
  assert.deepEqual(parseMemoryContents(null), { error: "请求体必须是 JSON 对象" });
  assert.deepEqual(parseMemoryContents({ content: "x".repeat(20_001) }), { error: "content 过长" });
  assert.deepEqual(parseMemoryContents({ content: "正常\u0000伪造" }), {
    error: "content 包含不允许的控制字符",
  });
});

it("routes use the provider preset fast path and provider-aware deletion lifecycle", async () => {
  const tts = await readFile(
    new URL("../src/app/api/tts/route.ts", import.meta.url),
    "utf8",
  );
  const persona = await readFile(
    new URL("../src/app/api/persona/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(tts, /resolveVoiceSynthesisSource/);
  assert.match(tts, /synthesizeResolvedVoice/);
  assert.match(tts, /getCurrentVoiceAuthorization/);
  assert.match(tts, /canSynthesizeVoice/);
  assert.match(tts, /isVoiceAuthorizationEnforced/);
  assert.match(tts, /sanitizeSpeechText/);
  assert.match(tts, /text:\s*spokenText/);
  assert.match(persona, /deleteVoiceEverywhere/);
  assert.match(persona, /\.getMeta\(voiceId, auth\.userId\)/);
  assert.match(persona, /cleanupPending/);

  const voiceUpload = await readFile(
    new URL("../src/app/api/voice/upload/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(voiceUpload, /export async function DELETE/);
  assert.match(voiceUpload, /countPersonasUsingVoice/);
  assert.match(voiceUpload, /deleteVoiceEverywhere/);

  const authorization = await readFile(
    new URL("../src/app/api/voice/authorization/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(authorization, /requireAuth/);
  assert.match(authorization, /submitVoiceAuthorization/);
  assert.match(authorization, /revokeStoredVoiceAuthorization/);
});
