import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/guard";
import { reviewPersonaKnowledge } from "@/lib/personaKnowledgeService";
import { getRepository } from "@/lib/storage/repository";
import type {
  CreatePersonaKnowledgeCandidateInput,
  PersonaKnowledgeKind,
  PersonaKnowledgeReviewInput,
  PersonaSourceType,
} from "@/lib/storage/types";

export const runtime = "nodejs";

const SERVER_OWNED_FIELDS = new Set([
  "status",
  "confirmedBy",
  "createdBy",
  "conflictGroupId",
  "userId",
  "confirmedAt",
  "revokedAt",
  "createdAt",
  "updatedAt",
]);

const CLIENT_SOURCE_TYPES = new Set<PersonaSourceType>([
  "manual_text",
  "chat_export",
  "audio_transcript",
  "text_document",
]);

type ClientSource = {
  sourceType: Exclude<PersonaSourceType, "legacy_import">;
  contentText: string | null;
  objectPath: string | null;
  checksumAlgorithm: "sha256";
  checksum: string;
};

type ClientCandidate =
  | {
      kind: "fact";
      factType: string;
      factKey: string;
      content: string;
      normalizedValue: string;
      sourceExcerpt: string;
    }
  | {
      kind: "relationship_memory";
      content: string;
      occurredAt: string | null;
      location: string | null;
      participants: string[];
      sourceExcerpt: string;
    }
  | {
      kind: "speech_style";
      category: string;
      content: string;
      example: string | null;
      sourceExcerpt: string;
    };

export type CreateKnowledgeBody = {
  personaId: string;
  source: ClientSource;
  candidates: ClientCandidate[];
};

export type ReviewKnowledgeBody = Omit<PersonaKnowledgeReviewInput, "actorUserId">;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function rejectServerOwnedFields(value: unknown, path = "body"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectServerOwnedFields(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SERVER_OWNED_FIELDS.has(key)) {
      throw new Error(`${path}.${key} 是服务端字段`);
    }
    rejectServerOwnedFields(nested, `${path}.${key}`);
  }
}

function allowOnly(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${path}.${key} 不允许`);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} 不能为空`);
  return value.trim();
}

function nullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${path} 必须是字符串或 null`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} 必须是字符串数组`);
  }
  return [...value];
}

function parseClientSource(value: unknown): ClientSource {
  const source = record(value, "source");
  allowOnly(source, [
    "sourceType", "contentText", "objectPath", "checksumAlgorithm", "checksum",
  ], "source");
  if (typeof source.sourceType !== "string" || !CLIENT_SOURCE_TYPES.has(source.sourceType as PersonaSourceType)) {
    throw new Error("source.sourceType 不合法");
  }
  if (source.checksumAlgorithm !== "sha256") {
    throw new Error("source.checksumAlgorithm 只能是 sha256");
  }
  const contentText = nullableString(source.contentText, "source.contentText");
  const objectPath = nullableString(source.objectPath, "source.objectPath");
  if (!contentText?.trim() && !objectPath?.trim()) {
    throw new Error("source.contentText 和 source.objectPath 至少一个有值");
  }
  return {
    sourceType: source.sourceType as ClientSource["sourceType"],
    contentText,
    objectPath,
    checksumAlgorithm: "sha256",
    checksum: nonEmptyString(source.checksum, "source.checksum"),
  };
}

function parseCandidate(value: unknown, index: number): ClientCandidate {
  const path = `candidates[${index}]`;
  const candidate = record(value, path);
  const kind = candidate.kind;
  if (kind === "fact") {
    allowOnly(candidate, [
      "kind", "factType", "factKey", "content", "normalizedValue", "sourceExcerpt",
    ], path);
    return {
      kind,
      factType: nonEmptyString(candidate.factType, `${path}.factType`),
      factKey: nonEmptyString(candidate.factKey, `${path}.factKey`),
      content: nonEmptyString(candidate.content, `${path}.content`),
      normalizedValue: nonEmptyString(candidate.normalizedValue, `${path}.normalizedValue`),
      sourceExcerpt: candidate.sourceExcerpt === undefined
        ? ""
        : nullableString(candidate.sourceExcerpt, `${path}.sourceExcerpt`) ?? "",
    };
  }
  if (kind === "relationship_memory") {
    allowOnly(candidate, [
      "kind", "content", "occurredAt", "location", "participants", "sourceExcerpt",
    ], path);
    return {
      kind,
      content: nonEmptyString(candidate.content, `${path}.content`),
      occurredAt: nullableString(candidate.occurredAt, `${path}.occurredAt`),
      location: nullableString(candidate.location, `${path}.location`),
      participants: stringArray(candidate.participants, `${path}.participants`),
      sourceExcerpt: candidate.sourceExcerpt === undefined
        ? ""
        : nullableString(candidate.sourceExcerpt, `${path}.sourceExcerpt`) ?? "",
    };
  }
  if (kind === "speech_style") {
    allowOnly(candidate, ["kind", "category", "content", "example", "sourceExcerpt"], path);
    return {
      kind,
      category: nonEmptyString(candidate.category, `${path}.category`),
      content: nonEmptyString(candidate.content, `${path}.content`),
      example: nullableString(candidate.example, `${path}.example`),
      sourceExcerpt: candidate.sourceExcerpt === undefined
        ? ""
        : nullableString(candidate.sourceExcerpt, `${path}.sourceExcerpt`) ?? "",
    };
  }
  throw new Error(`${path}.kind 不合法`);
}

export function parseCreateKnowledgeBody(raw: unknown): CreateKnowledgeBody {
  rejectServerOwnedFields(raw);
  const body = record(raw, "body");
  allowOnly(body, ["personaId", "source", "candidates"], "body");
  const personaId = nonEmptyString(body.personaId, "personaId");
  if (!Array.isArray(body.candidates) || body.candidates.length < 1 || body.candidates.length > 50) {
    throw new Error("candidates 数量必须在 1 到 50 之间");
  }
  return {
    personaId,
    source: parseClientSource(body.source),
    candidates: body.candidates.map(parseCandidate),
  };
}

const REVIEW_FIELDS: Record<PersonaKnowledgeKind, readonly string[]> = {
  fact: ["factType", "factKey", "content", "normalizedValue"],
  relationship_memory: ["content", "occurredAt", "location", "participants"],
  speech_style: ["category", "content", "example"],
};

function parseEdits(
  kind: PersonaKnowledgeKind,
  value: unknown,
): Record<string, string | string[] | null> {
  const edits = record(value, "edits");
  allowOnly(edits, REVIEW_FIELDS[kind], "edits");
  const parsed: Record<string, string | string[] | null> = {};
  for (const [key, item] of Object.entries(edits)) {
    if (key === "participants") parsed[key] = stringArray(item, `edits.${key}`);
    else if (key === "occurredAt" || key === "location" || key === "example") {
      parsed[key] = nullableString(item, `edits.${key}`);
    } else {
      parsed[key] = nonEmptyString(item, `edits.${key}`);
    }
  }
  return parsed;
}

export function parseReviewKnowledgeBody(raw: unknown): ReviewKnowledgeBody {
  rejectServerOwnedFields(raw);
  const body = record(raw, "body");
  allowOnly(body, ["personaId", "kind", "id", "action", "edits"], "body");
  const personaId = nonEmptyString(body.personaId, "personaId");
  const id = nonEmptyString(body.id, "id");
  if (body.kind !== "fact" && body.kind !== "relationship_memory" && body.kind !== "speech_style") {
    throw new Error("kind 不合法");
  }
  if (body.action !== "confirm" && body.action !== "reject" && body.action !== "revoke") {
    throw new Error("action 不合法");
  }
  if (body.action === "revoke" && body.edits !== undefined) {
    throw new Error("revoke 不允许携带 edits");
  }
  return {
    personaId,
    kind: body.kind,
    id,
    action: body.action,
    ...(body.edits === undefined ? {} : { edits: parseEdits(body.kind, body.edits) }),
  };
}

export function parseRevokeSourceBody(raw: unknown): { personaId: string; sourceId: string } {
  rejectServerOwnedFields(raw);
  const body = record(raw, "body");
  allowOnly(body, ["personaId", "sourceId"], "body");
  return {
    personaId: nonEmptyString(body.personaId, "personaId"),
    sourceId: nonEmptyString(body.sourceId, "sourceId"),
  };
}

function badRequest(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "请求参数不合法" },
    { status: 400 },
  );
}

function forbidden() {
  return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const personaId = (req.nextUrl.searchParams.get("personaId") || "").trim();
  if (!personaId) return NextResponse.json({ error: "缺少 personaId" }, { status: 400 });
  const repository = getRepository();
  const persona = await repository.getPersonaForUser(personaId, auth.userId);
  if (!persona) return forbidden();
  return NextResponse.json(await repository.listPersonaKnowledge(personaId));
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  let body: CreateKnowledgeBody;
  try {
    body = parseCreateKnowledgeBody(await req.json());
  } catch (error) {
    return badRequest(error);
  }
  const { personaId } = body;
  const repository = getRepository();
  const persona = await repository.getPersonaForUser(personaId, auth.userId);
  if (!persona) return forbidden();

  const sourceId = randomUUID();
  const source = {
    id: sourceId,
    personaId,
    ...body.source,
    status: "ready" as const,
    createdBy: auth.userId,
  };
  const candidates: CreatePersonaKnowledgeCandidateInput[] = body.candidates.map((candidate) => {
    const id = randomUUID();
    if (candidate.kind === "fact") {
      return { ...candidate, id, personaId, sourceId };
    }
    if (candidate.kind === "relationship_memory") {
      return { ...candidate, id, personaId, sourceId, embedding: null };
    }
    return { ...candidate, id, personaId, sourceId };
  });
  const created = await repository.createPersonaKnowledgeCandidates({ source, candidates });
  return NextResponse.json(created, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  let body: ReviewKnowledgeBody;
  try {
    body = parseReviewKnowledgeBody(await req.json());
  } catch (error) {
    return badRequest(error);
  }
  const { personaId } = body;
  const repository = getRepository();
  const persona = await repository.getPersonaForUser(personaId, auth.userId);
  if (!persona) return forbidden();

  try {
    const result = await reviewPersonaKnowledge({
      repository,
      ...body,
      actorUserId: auth.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "knowledge_not_found") {
      return NextResponse.json({ error: "knowledge_not_found" }, { status: 404 });
    }
    if (message.startsWith("invalid_transition:") || message === "knowledge_status_changed") {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    console.error("persona_knowledge_review_failed");
    return NextResponse.json({ error: "知识审核失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  let body: { personaId: string; sourceId: string };
  try {
    body = parseRevokeSourceBody(await req.json());
  } catch (error) {
    return badRequest(error);
  }
  const { personaId, sourceId } = body;
  const repository = getRepository();
  const persona = await repository.getPersonaForUser(personaId, auth.userId);
  if (!persona) return forbidden();
  const { revokedItems } = await repository.revokePersonaSource(sourceId, personaId, auth.userId);
  return NextResponse.json({ ok: true, revokedItems });
}
