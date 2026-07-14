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
  assert.match(source, /sha256Hex\(Buffer\.from\(contents\[i\],\s*["']utf8["']\)\)/);
  assert.doesNotMatch(source, /body\.(?:status|confirmedBy|sourceId|checksum)/);
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
