import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import {
  createPersonaKnowledgeHandlers,
  parseCreateKnowledgeBody,
  parseRevokeSourceBody,
  parseReviewKnowledgeBody,
} from "../src/app/api/persona-knowledge/route";
import { sha256Hex } from "../src/lib/storage/checksum";
import type { AppRepository, PersonaKnowledgeBundle } from "../src/lib/storage/types";

const validSource = {
  sourceType: "manual_text",
  contentText: "她总说要记得吃饭，最喜欢桂花糕",
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
  for (const sourceType of ["chat_export", "audio_transcript", "text_document", "legacy_import", "unknown"]) {
    expectBad(() => parseCreateKnowledgeBody({
      ...createBody(), source: { ...validSource, sourceType },
    }), /可信上传链路|sourceType/);
  }
  expectBad(() => parseCreateKnowledgeBody({
    ...createBody(), source: { ...validSource, contentText: " " },
  }), /contentText/);
  for (const field of ["objectPath", "checksum", "checksumAlgorithm"]) {
    expectBad(() => parseCreateKnowledgeBody({
      ...createBody(), source: { ...validSource, [field]: "forged" },
    }), new RegExp(field));
  }
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

it("requires source excerpts to be grounded in the submitted manual text", () => {
  assert.doesNotThrow(() => parseCreateKnowledgeBody(createBody({
    ...fact,
    sourceExcerpt: "最喜欢桂花糕",
  })));
  expectBad(() => parseCreateKnowledgeBody(createBody({
    ...fact,
    sourceExcerpt: "原文中没有这句",
  })), /sourceExcerpt/);
});

it("normalizes only real timezone-qualified RFC3339 occurredAt values", () => {
  const parsed = parseCreateKnowledgeBody(createBody({
    kind: "relationship_memory",
    content: "一起看日落",
    occurredAt: "2024-02-29T20:30:45+08:00",
    location: null,
    participants: [],
  }));
  assert.equal(parsed.candidates[0].kind, "relationship_memory");
  if (parsed.candidates[0].kind === "relationship_memory") {
    assert.equal(parsed.candidates[0].occurredAt, "2024-02-29T12:30:45.000Z");
  }
  const review = parseReviewKnowledgeBody({
    personaId: "p", kind: "relationship_memory", id: "m", action: "confirm",
    edits: { occurredAt: "2024-02-29T20:30:45+08:00" },
  });
  assert.equal(review.edits?.occurredAt, "2024-02-29T12:30:45.000Z");

  for (const occurredAt of [
    "not-a-date",
    "2024-02-29T20:30:45",
    "2024-02-30T20:30:45Z",
    "2024-01-01T25:00:00Z",
  ]) {
    expectBad(() => parseCreateKnowledgeBody(createBody({
      kind: "relationship_memory", content: "memory", occurredAt,
      location: null, participants: [],
    })), /occurredAt|RFC3339/);
    expectBad(() => parseReviewKnowledgeBody({
      personaId: "p", kind: "relationship_memory", id: "m", action: "confirm",
      edits: { occurredAt },
    }), /occurredAt|RFC3339/);
  }
});

it("enforces bounded identifiers, content, batches and participants", () => {
  expectBad(() => parseCreateKnowledgeBody({ ...createBody(), personaId: "p".repeat(129) }), /personaId/);
  expectBad(() => parseReviewKnowledgeBody({
    personaId: "p", kind: "fact", id: "i".repeat(129), action: "confirm",
  }), /id/);
  expectBad(() => parseRevokeSourceBody({ personaId: "p", sourceId: "s".repeat(129) }), /sourceId/);
  expectBad(() => parseCreateKnowledgeBody({
    ...createBody(), source: { sourceType: "manual_text", contentText: "x".repeat(200_001) },
  }), /contentText/);
  expectBad(() => parseCreateKnowledgeBody(createBody({ ...fact, content: "x".repeat(20_001) })), /content/);
  for (const key of ["factType", "factKey"] as const) {
    expectBad(() => parseCreateKnowledgeBody(createBody({ ...fact, [key]: "x".repeat(129) })), new RegExp(key));
  }
  expectBad(() => parseCreateKnowledgeBody(createBody({
    kind: "speech_style", category: "x".repeat(129), content: "warm", example: null,
  })), /category/);
  expectBad(() => parseCreateKnowledgeBody(createBody({ ...fact, normalizedValue: "x".repeat(2001) })), /normalizedValue/);
  expectBad(() => parseCreateKnowledgeBody({
    personaId: "p",
    source: { sourceType: "manual_text", contentText: "x".repeat(2001) },
    candidates: [{ ...fact, sourceExcerpt: "x".repeat(2001) }],
  }), /sourceExcerpt/);
  expectBad(() => parseCreateKnowledgeBody({
    personaId: "p",
    source: { sourceType: "manual_text", contentText: "source" },
    candidates: Array.from({ length: 16 }, () => ({
      ...fact, content: "x".repeat(20_000), sourceExcerpt: "",
    })),
  }), /总文本|300000/);
  expectBad(() => parseCreateKnowledgeBody(createBody({
    kind: "relationship_memory", content: "memory", occurredAt: null,
    location: "x".repeat(501), participants: [],
  })), /location/);
  expectBad(() => parseCreateKnowledgeBody(createBody({
    kind: "speech_style", category: "tone", content: "warm", example: "x".repeat(5001),
  })), /example/);
  expectBad(() => parseCreateKnowledgeBody(createBody({
    kind: "relationship_memory", content: "memory", occurredAt: null,
    location: null, participants: Array.from({ length: 51 }, () => "p"),
  })), /participants/);
  expectBad(() => parseCreateKnowledgeBody(createBody({
    kind: "relationship_memory", content: "memory", occurredAt: null,
    location: null, participants: ["p".repeat(201)],
  })), /participants/);
});

it("rejects NUL and unsafe control characters while preserving body newlines and tabs", () => {
  expectBad(() => parseCreateKnowledgeBody({
    ...createBody(), source: { sourceType: "manual_text", contentText: "bad\u0000text" },
  }), /control|NUL|控制/);
  expectBad(() => parseCreateKnowledgeBody(createBody({ ...fact, factType: "bad\u0001type" })), /control|NUL|控制/);
  assert.doesNotThrow(() => parseCreateKnowledgeBody({
    personaId: "p",
    source: { sourceType: "manual_text", contentText: "line 1\nline 2\tend" },
    candidates: [{ ...fact, content: "line 1\nline 2\tend", sourceExcerpt: "line 1\nline 2" }],
  }));
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

const emptyBundle: PersonaKnowledgeBundle = {
  sources: [], facts: [], memories: [], styles: [],
};

type Method = "GET" | "POST" | "PATCH" | "DELETE";

function apiRequest(method: Method, body?: unknown) {
  const url = method === "GET"
    ? "http://localhost/api/persona-knowledge?personaId=persona-1"
    : "http://localhost/api/persona-knowledge";
  return new NextRequest(url, {
    method,
    ...(body === undefined ? {} : {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  });
}

function bodyFor(method: Method): unknown {
  if (method === "POST") return createBody();
  if (method === "PATCH") {
    return { personaId: "persona-1", kind: "fact", id: "fact-1", action: "confirm" };
  }
  if (method === "DELETE") return { personaId: "persona-1", sourceId: "source-1" };
  return undefined;
}

function routeFixture(options: {
  authenticated?: boolean;
  owner?: boolean;
  ownerError?: Error;
  reviewError?: Error;
  revokeResult?: { sourceRevoked: boolean; revokedItems: Array<{ kind: "fact"; id: string }> };
} = {}) {
  const calls = {
    getRepository: 0,
    owner: 0,
    list: 0,
    create: 0,
    review: 0,
    revoke: 0,
    order: [] as string[],
    logs: [] as string[],
  };
  let createdInput: Parameters<AppRepository["createPersonaKnowledgeCandidates"]>[0] | null = null;
  let reviewInput: Record<string, unknown> | null = null;
  const repository = {
    async getPersonaForUser() {
      calls.owner += 1;
      calls.order.push("owner");
      if (options.ownerError) throw options.ownerError;
      return options.owner === false ? null : {
        id: "persona-1", userId: "user-1", name: "name", relation: "relation",
        voiceId: "voice-1", personaDesc: "", createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
    async listPersonaKnowledge() {
      calls.list += 1;
      calls.order.push("list");
      return emptyBundle;
    },
    async createPersonaKnowledgeCandidates(input: Parameters<AppRepository["createPersonaKnowledgeCandidates"]>[0]) {
      calls.create += 1;
      calls.order.push("create");
      createdInput = input;
      return emptyBundle;
    },
    async revokePersonaSource() {
      calls.revoke += 1;
      calls.order.push("revoke");
      return options.revokeResult ?? { sourceRevoked: false, revokedItems: [] };
    },
  } as unknown as AppRepository;
  let uuid = 0;
  const handlers = createPersonaKnowledgeHandlers({
    requireAuth: async () => options.authenticated === false
      ? { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) }
      : { userId: "user-1" },
    getRepository: () => {
      calls.getRepository += 1;
      return repository;
    },
    reviewPersonaKnowledge: async (input) => {
      calls.review += 1;
      calls.order.push("review");
      reviewInput = input as unknown as Record<string, unknown>;
      if (options.reviewError) throw options.reviewError;
      return { item: { id: "fact-1" }, conflicts: [] } as never;
    },
    randomUUID: () => `server-uuid-${++uuid}`,
    logError: (event) => { calls.logs.push(event); },
  });
  return {
    calls,
    handlers,
    get createdInput() { return createdInput; },
    get reviewInput() { return reviewInput; },
  };
}

it("all handlers stop at authentication without constructing a repository", async () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
    const fixture = routeFixture({ authenticated: false });
    const response = await fixture.handlers[method](apiRequest(method, bodyFor(method)));
    assert.equal(response.status, 401, method);
    assert.equal(fixture.calls.getRepository, 0, method);
    assert.deepEqual(
      [fixture.calls.owner, fixture.calls.list, fixture.calls.create, fixture.calls.review, fixture.calls.revoke],
      [0, 0, 0, 0, 0],
      method,
    );
  }
});

it("all handlers hide persona existence and perform no knowledge operation before ownership", async () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
    const fixture = routeFixture({ owner: false });
    const response = await fixture.handlers[method](apiRequest(method, bodyFor(method)));
    assert.equal(response.status, 403, method);
    assert.equal(fixture.calls.owner, 1, method);
    assert.deepEqual(
      [fixture.calls.list, fixture.calls.create, fixture.calls.review, fixture.calls.revoke],
      [0, 0, 0, 0],
      method,
    );
  }
});

it("GET lists knowledge only after the owner check", async () => {
  const fixture = routeFixture();
  const response = await fixture.handlers.GET(apiRequest("GET"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), emptyBundle);
  assert.equal(fixture.calls.owner, 1);
  assert.equal(fixture.calls.list, 1);
  assert.deepEqual(fixture.calls.order, ["owner", "list"]);
});

it("POST creates only server-owned manual sources and candidate identities", async () => {
  const fixture = routeFixture();
  const response = await fixture.handlers.POST(apiRequest("POST", createBody()));
  assert.equal(response.status, 201);
  assert.equal(fixture.calls.owner, 1);
  assert.equal(fixture.calls.create, 1);
  assert.deepEqual(fixture.calls.order, ["owner", "create"]);
  assert.deepEqual(fixture.createdInput?.source, {
    id: "server-uuid-1",
    personaId: "persona-1",
    sourceType: "manual_text",
    contentText: validSource.contentText,
    objectPath: null,
    checksumAlgorithm: "sha256",
    checksum: sha256Hex(Buffer.from(validSource.contentText, "utf8")),
    status: "ready",
    createdBy: "user-1",
  });
  assert.deepEqual(fixture.createdInput?.candidates[0], {
    ...fact,
    id: "server-uuid-2",
    personaId: "persona-1",
    sourceId: "server-uuid-1",
  });
});

it("POST rejects forged source provenance before repository construction", async () => {
  for (const forgedSource of [
    { ...validSource, sourceType: "chat_export" },
    { ...validSource, checksum: "forged" },
    { ...validSource, objectPath: "users/other/private.txt" },
  ]) {
    const fixture = routeFixture();
    const response = await fixture.handlers.POST(apiRequest("POST", {
      ...createBody(), source: forgedSource,
    }));
    assert.equal(response.status, 400);
    assert.equal(fixture.calls.getRepository, 0);
  }
});

it("PATCH maps review outcomes and passes the authenticated actor only after ownership", async () => {
  const fixture = routeFixture();
  const response = await fixture.handlers.PATCH(apiRequest("PATCH", bodyFor("PATCH")));
  assert.equal(response.status, 200);
  assert.equal(fixture.calls.owner, 1);
  assert.equal(fixture.calls.review, 1);
  assert.deepEqual(fixture.calls.order, ["owner", "review"]);
  assert.equal(fixture.reviewInput?.actorUserId, "user-1");

  for (const [message, status] of [
    ["knowledge_not_found", 404],
    ["knowledge_status_changed", 409],
    ["invalid_transition:confirmed:rejected", 409],
  ] as const) {
    const failed = routeFixture({ reviewError: new Error(message) });
    const result = await failed.handlers.PATCH(apiRequest("PATCH", bodyFor("PATCH")));
    assert.equal(result.status, status);
  }
});

it("DELETE is idempotent and returns an empty revoked item list", async () => {
  const fixture = routeFixture({ revokeResult: { sourceRevoked: false, revokedItems: [] } });
  const response = await fixture.handlers.DELETE(apiRequest("DELETE", bodyFor("DELETE")));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, revokedItems: [] });
  assert.equal(fixture.calls.owner, 1);
  assert.equal(fixture.calls.revoke, 1);
  assert.deepEqual(fixture.calls.order, ["owner", "revoke"]);
});

it("all repository failures return the same non-sensitive JSON 500 and safe event", async () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
    const fixture = routeFixture({ ownerError: new Error("postgres://user:secret@private/db") });
    const response = await fixture.handlers[method](apiRequest(method, bodyFor(method)));
    assert.equal(response.status, 500, method);
    const json = await response.json();
    assert.deepEqual(json, { error: "服务暂时不可用" }, method);
    assert.doesNotMatch(JSON.stringify(json), /secret|postgres/i, method);
    assert.equal(fixture.calls.logs.length, 1, method);
    assert.doesNotMatch(fixture.calls.logs[0], /secret|postgres/i, method);
  }
});
