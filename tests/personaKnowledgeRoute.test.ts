import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseCreateKnowledgeBody,
  parseReviewKnowledgeBody,
} from "../src/app/api/persona-knowledge/route";

const validSource = {
  sourceType: "manual_text",
  contentText: "她总说要记得吃饭",
  objectPath: null,
  checksumAlgorithm: "sha256",
  checksum: "abc123",
};

const fact = {
  kind: "fact",
  factType: "preference",
  factKey: "favorite_food",
  content: "她喜欢桂花糕",
  normalizedValue: "桂花糕",
  sourceExcerpt: "最喜欢桂花糕",
};

function createBody(candidate: Record<string, unknown> = fact) {
  return { personaId: "persona-1", source: validSource, candidates: [candidate] };
}

function expectBad(fn: () => unknown, pattern?: RegExp) {
  if (pattern) assert.throws(fn, pattern);
  else assert.throws(fn);
}

it("declares all handlers and uses only the authenticated repository boundary", async () => {
  const source = await readFile(
    new URL("../src/app/api/persona-knowledge/route.ts", import.meta.url),
    "utf8",
  );
  for (const handler of ["GET", "POST", "PATCH", "DELETE"]) {
    assert.match(source, new RegExp(`export async function ${handler}\\b`));
  }
  assert.match(source, /requireAuth/);
  assert.match(source, /getRepository/);
  assert.match(source, /getPersonaForUser\(personaId, auth\.userId\)/);
  assert.match(source, /createPersonaKnowledgeCandidates/);
  assert.match(source, /reviewPersonaKnowledge/);
  assert.doesNotMatch(source, /@\/lib\/(db|voiceStore)/);
  assert.doesNotMatch(source, /\bgetDb\s*\(/);
});

it("parses all three candidate kinds and supplies safe client defaults", () => {
  const parsedFact = parseCreateKnowledgeBody(createBody());
  assert.equal(parsedFact.personaId, "persona-1");
  assert.deepEqual(parsedFact.candidates[0], fact);

  const memory = parseCreateKnowledgeBody(createBody({
    kind: "relationship_memory",
    content: "我们一起看过日落",
    occurredAt: null,
    location: "海边",
    participants: ["我", "她"],
  })).candidates[0];
  assert.deepEqual(memory, {
    kind: "relationship_memory",
    content: "我们一起看过日落",
    occurredAt: null,
    location: "海边",
    participants: ["我", "她"],
    sourceExcerpt: "",
  });

  const style = parseCreateKnowledgeBody(createBody({
    kind: "speech_style",
    category: "closing",
    content: "句尾常说慢点",
    example: null,
  })).candidates[0];
  assert.deepEqual(style, {
    kind: "speech_style",
    category: "closing",
    content: "句尾常说慢点",
    example: null,
    sourceExcerpt: "",
  });
});

it("rejects invalid create payloads and source policy violations", () => {
  expectBad(() => parseCreateKnowledgeBody({ ...createBody(), personaId: " " }), /personaId/);
  expectBad(() => parseCreateKnowledgeBody({ ...createBody(), candidates: [] }), /candidates/);
  expectBad(() => parseCreateKnowledgeBody({
    ...createBody(), candidates: Array.from({ length: 51 }, () => fact),
  }), /candidates/);
  expectBad(() => parseCreateKnowledgeBody({
    ...createBody(), source: { ...validSource, sourceType: "legacy_import" },
  }), /sourceType/);
  expectBad(() => parseCreateKnowledgeBody({
    ...createBody(), source: { ...validSource, sourceType: "unknown" },
  }), /sourceType/);
  expectBad(() => parseCreateKnowledgeBody({
    ...createBody(), source: { ...validSource, contentText: null, objectPath: null },
  }), /contentText|objectPath/);
  expectBad(() => parseCreateKnowledgeBody({
    ...createBody(), source: { ...validSource, checksumAlgorithm: "legacy_id" },
  }), /checksumAlgorithm/);
});

it("rejects server-owned fields and client-controlled identifiers at every create layer", () => {
  for (const field of [
    "status", "confirmedBy", "createdBy", "conflictGroupId", "userId",
    "confirmedAt", "revokedAt", "createdAt", "updatedAt",
  ]) {
    expectBad(() => parseCreateKnowledgeBody({ ...createBody(), [field]: "forged" }), new RegExp(field));
    expectBad(() => parseCreateKnowledgeBody({
      ...createBody(), source: { ...validSource, [field]: "forged" },
    }), new RegExp(field));
    expectBad(() => parseCreateKnowledgeBody(createBody({ ...fact, [field]: "forged" })), new RegExp(field));
  }
  for (const field of ["id", "personaId", "sourceId"]) {
    expectBad(() => parseCreateKnowledgeBody(createBody({ ...fact, [field]: "forged" })), new RegExp(field));
  }
});

it("validates candidate fields instead of accepting ambiguous values", () => {
  expectBad(() => parseCreateKnowledgeBody(createBody({ ...fact, normalizedValue: " " })), /normalizedValue/);
  expectBad(() => parseCreateKnowledgeBody(createBody({
    kind: "relationship_memory", content: "memory", occurredAt: null,
    location: null, participants: ["me", 2],
  })), /participants/);
  expectBad(() => parseCreateKnowledgeBody(createBody({
    kind: "relationship_memory", content: "memory", occurredAt: null,
    location: null, participants: [], embedding: [1, 2],
  })), /embedding/);
  expectBad(() => parseCreateKnowledgeBody(createBody({
    kind: "speech_style", category: "tone", content: "warm", example: null,
    extra: "not allowed",
  })), /extra/);
});

it("parses review actions, preserves edits, and applies per-kind edit whitelists", () => {
  const parsed = parseReviewKnowledgeBody({
    personaId: "persona-1", kind: "fact", id: "fact-1", action: "confirm",
    edits: { content: "更正后的内容", factType: "preference" },
  });
  assert.deepEqual(parsed, {
    personaId: "persona-1", kind: "fact", id: "fact-1", action: "confirm",
    edits: { content: "更正后的内容", factType: "preference" },
  });

  const memory = parseReviewKnowledgeBody({
    personaId: "persona-1", kind: "relationship_memory", id: "memory-1",
    action: "reject", edits: { participants: ["我", "她"], location: null },
  });
  assert.deepEqual(memory.edits, { participants: ["我", "她"], location: null });

  expectBad(() => parseReviewKnowledgeBody({
    personaId: "persona-1", kind: "fact", id: "fact-1", action: "confirm",
    edits: { example: "wrong kind" },
  }), /example/);
  expectBad(() => parseReviewKnowledgeBody({
    personaId: "persona-1", kind: "relationship_memory", id: "memory-1", action: "confirm",
    edits: { participants: ["me", 1] },
  }), /participants/);
});

it("rejects invalid review identity, enum, transition shape, and server fields", () => {
  expectBad(() => parseReviewKnowledgeBody({ personaId: "", kind: "fact", id: "1", action: "confirm" }), /personaId/);
  expectBad(() => parseReviewKnowledgeBody({ personaId: "p", kind: "unknown", id: "1", action: "confirm" }), /kind/);
  expectBad(() => parseReviewKnowledgeBody({ personaId: "p", kind: "fact", id: "1", action: "publish" }), /action/);
  expectBad(() => parseReviewKnowledgeBody({
    personaId: "p", kind: "fact", id: "1", action: "revoke", edits: { content: "x" },
  }), /edits/);
  expectBad(() => parseReviewKnowledgeBody({
    personaId: "p", kind: "speech_style", id: "1", action: "confirm",
    edits: { status: "confirmed" },
  }), /status/);
});

it("route source shows server-generated ownership and audit fields", async () => {
  const source = await readFile(
    new URL("../src/app/api/persona-knowledge/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /randomUUID\(\)/);
  assert.match(source, /createdBy:\s*auth\.userId/);
  assert.match(source, /status:\s*["']ready["']/);
  assert.match(source, /personaId,\s*sourceId/);
  assert.match(source, /embedding:\s*null/);
});
