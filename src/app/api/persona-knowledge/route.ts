import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, type AuthResult } from "@/lib/guard";
import { logger } from "@/lib/logger";
import { reviewPersonaKnowledge } from "@/lib/personaKnowledgeService";
import { sha256Hex } from "@/lib/storage/checksum";
import { getRepository } from "@/lib/storage/repository";
import type {
  AppRepository,
  CreatePersonaKnowledgeCandidateInput,
  PersonaKnowledgeKind,
  PersonaKnowledgeReviewInput,
  PersonaKnowledgeReviewResult,
} from "@/lib/storage/types";

export const runtime = "nodejs";

const MAX_ID_LENGTH = 128;
const MAX_SOURCE_TEXT_LENGTH = 200_000;
const MAX_CANDIDATE_BATCH_TEXT_LENGTH = 300_000;
const MAX_CONTENT_LENGTH = 20_000;
const MAX_KEY_LENGTH = 128;
const MAX_NORMALIZED_VALUE_LENGTH = 2_000;
const MAX_SOURCE_EXCERPT_LENGTH = 2_000;
const MAX_LOCATION_LENGTH = 500;
const MAX_EXAMPLE_LENGTH = 5_000;
const MAX_PARTICIPANTS = 50;
const MAX_PARTICIPANT_LENGTH = 200;

const UNSAFE_BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const UNSAFE_METADATA_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

type ClientSource = {
  sourceType: "manual_text";
  contentText: string;
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

type RouteDependencies = {
  requireAuth: (req: NextRequest) => Promise<AuthResult>;
  getRepository: () => AppRepository;
  reviewPersonaKnowledge: (
    input: PersonaKnowledgeReviewInput & { repository: AppRepository },
  ) => Promise<PersonaKnowledgeReviewResult>;
  randomUUID: () => string;
  sha256Hex: (body: Uint8Array) => string;
  logError: (event: string) => void;
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
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

function boundedString(
  value: unknown,
  path: string,
  maxLength: number,
  options: { body?: boolean; trim?: boolean; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") throw new Error(`${path} 必须是字符串`);
  const normalized = options.trim === false ? value : value.trim();
  if (!options.allowEmpty && normalized.length === 0) throw new Error(`${path} 不能为空`);
  if (normalized.length > maxLength) throw new Error(`${path} 超过 ${maxLength} 字符`);
  const unsafeControl = options.body ? UNSAFE_BODY_CONTROL : UNSAFE_METADATA_CONTROL;
  if (unsafeControl.test(normalized)) throw new Error(`${path} 包含不允许的控制字符`);
  return normalized;
}

function nullableBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  options: { body?: boolean } = {},
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = boundedString(value, path, maxLength, {
    body: options.body,
    allowEmpty: true,
  });
  return normalized || null;
}

function idString(value: unknown, path: string): string {
  return boundedString(value, path, MAX_ID_LENGTH);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseOccurredAt(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  const input = boundedString(value, path, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) throw new Error(`${path} 必须是含时区的 RFC3339 时间`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, timezone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const timezoneParts = timezone === "Z" ? null : /[+-](\d{2}):(\d{2})/.exec(timezone);
  const timezoneValid = timezoneParts === null
    || (Number(timezoneParts[1]) <= 23 && Number(timezoneParts[2]) <= 59);
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > monthDays[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || !timezoneValid
  ) {
    throw new Error(`${path} 不是真实的 RFC3339 时间`);
  }
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) throw new Error(`${path} 不是真实的 RFC3339 时间`);
  return new Date(timestamp).toISOString();
}

function parseParticipants(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是字符串数组`);
  if (value.length > MAX_PARTICIPANTS) throw new Error(`${path} 最多 ${MAX_PARTICIPANTS} 人`);
  return value.map((item, index) => boundedString(
    item,
    `${path}[${index}]`,
    MAX_PARTICIPANT_LENGTH,
  ));
}

function parseClientSource(value: unknown): ClientSource {
  const source = record(value, "source");
  allowOnly(source, ["sourceType", "contentText"], "source");
  if (source.sourceType !== "manual_text") {
    throw new Error("source.sourceType 当前只支持 manual_text，其他来源需走后续可信上传链路");
  }
  return {
    sourceType: "manual_text",
    contentText: boundedString(
      source.contentText,
      "source.contentText",
      MAX_SOURCE_TEXT_LENGTH,
      { body: true },
    ),
  };
}

function sourceExcerpt(value: unknown, path: string): string {
  if (value === undefined) return "";
  return boundedString(value, path, MAX_SOURCE_EXCERPT_LENGTH, {
    body: true,
    allowEmpty: true,
  });
}

function parseCandidate(value: unknown, index: number): ClientCandidate {
  const path = `candidates[${index}]`;
  const candidate = record(value, path);
  if (candidate.kind === "fact") {
    allowOnly(candidate, [
      "kind", "factType", "factKey", "content", "normalizedValue", "sourceExcerpt",
    ], path);
    return {
      kind: "fact",
      factType: boundedString(candidate.factType, `${path}.factType`, MAX_KEY_LENGTH),
      factKey: boundedString(candidate.factKey, `${path}.factKey`, MAX_KEY_LENGTH),
      content: boundedString(candidate.content, `${path}.content`, MAX_CONTENT_LENGTH, { body: true }),
      normalizedValue: boundedString(
        candidate.normalizedValue,
        `${path}.normalizedValue`,
        MAX_NORMALIZED_VALUE_LENGTH,
      ),
      sourceExcerpt: sourceExcerpt(candidate.sourceExcerpt, `${path}.sourceExcerpt`),
    };
  }
  if (candidate.kind === "relationship_memory") {
    allowOnly(candidate, [
      "kind", "content", "occurredAt", "location", "participants", "sourceExcerpt",
    ], path);
    return {
      kind: "relationship_memory",
      content: boundedString(candidate.content, `${path}.content`, MAX_CONTENT_LENGTH, { body: true }),
      occurredAt: parseOccurredAt(candidate.occurredAt, `${path}.occurredAt`),
      location: nullableBoundedString(candidate.location, `${path}.location`, MAX_LOCATION_LENGTH),
      participants: parseParticipants(candidate.participants, `${path}.participants`),
      sourceExcerpt: sourceExcerpt(candidate.sourceExcerpt, `${path}.sourceExcerpt`),
    };
  }
  if (candidate.kind === "speech_style") {
    allowOnly(candidate, ["kind", "category", "content", "example", "sourceExcerpt"], path);
    return {
      kind: "speech_style",
      category: boundedString(candidate.category, `${path}.category`, MAX_KEY_LENGTH),
      content: boundedString(candidate.content, `${path}.content`, MAX_CONTENT_LENGTH, { body: true }),
      example: nullableBoundedString(candidate.example, `${path}.example`, MAX_EXAMPLE_LENGTH, { body: true }),
      sourceExcerpt: sourceExcerpt(candidate.sourceExcerpt, `${path}.sourceExcerpt`),
    };
  }
  throw new Error(`${path}.kind 不合法`);
}

function candidateTextLength(candidate: ClientCandidate): number {
  if (candidate.kind === "fact") {
    return candidate.factType.length
      + candidate.factKey.length
      + candidate.content.length
      + candidate.normalizedValue.length
      + candidate.sourceExcerpt.length;
  }
  if (candidate.kind === "relationship_memory") {
    return candidate.content.length
      + (candidate.occurredAt?.length ?? 0)
      + (candidate.location?.length ?? 0)
      + candidate.participants.reduce((total, participant) => total + participant.length, 0)
      + candidate.sourceExcerpt.length;
  }
  return candidate.category.length
    + candidate.content.length
    + (candidate.example?.length ?? 0)
    + candidate.sourceExcerpt.length;
}

export function parseCreateKnowledgeBody(raw: unknown): CreateKnowledgeBody {
  const body = record(raw, "body");
  allowOnly(body, ["personaId", "source", "candidates"], "body");
  const personaId = idString(body.personaId, "personaId");
  const source = parseClientSource(body.source);
  if (!Array.isArray(body.candidates) || body.candidates.length < 1 || body.candidates.length > 50) {
    throw new Error("candidates 数量必须在 1 到 50 之间");
  }
  const candidates = body.candidates.map(parseCandidate);
  const totalTextLength = candidates.reduce(
    (total, candidate) => total + candidateTextLength(candidate),
    0,
  );
  if (totalTextLength > MAX_CANDIDATE_BATCH_TEXT_LENGTH) {
    throw new Error(`candidates 总文本超过 ${MAX_CANDIDATE_BATCH_TEXT_LENGTH} 字符`);
  }
  for (const candidate of candidates) {
    if (candidate.sourceExcerpt && !source.contentText.includes(candidate.sourceExcerpt)) {
      throw new Error("candidate.sourceExcerpt 必须是 source.contentText 的真实子串");
    }
  }
  return { personaId, source, candidates };
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
    if (key === "participants") parsed[key] = parseParticipants(item, `edits.${key}`);
    else if (key === "occurredAt") parsed[key] = parseOccurredAt(item, `edits.${key}`);
    else if (key === "location") {
      parsed[key] = nullableBoundedString(item, `edits.${key}`, MAX_LOCATION_LENGTH);
    } else if (key === "example") {
      parsed[key] = nullableBoundedString(item, `edits.${key}`, MAX_EXAMPLE_LENGTH, { body: true });
    } else if (key === "factType" || key === "factKey" || key === "category") {
      parsed[key] = boundedString(item, `edits.${key}`, MAX_KEY_LENGTH);
    } else if (key === "normalizedValue") {
      parsed[key] = boundedString(item, `edits.${key}`, MAX_NORMALIZED_VALUE_LENGTH);
    } else {
      parsed[key] = boundedString(item, `edits.${key}`, MAX_CONTENT_LENGTH, { body: true });
    }
  }
  return parsed;
}

export function parseReviewKnowledgeBody(raw: unknown): ReviewKnowledgeBody {
  const body = record(raw, "body");
  allowOnly(body, ["personaId", "kind", "id", "action", "edits"], "body");
  const personaId = idString(body.personaId, "personaId");
  const id = idString(body.id, "id");
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
  const body = record(raw, "body");
  allowOnly(body, ["personaId", "sourceId"], "body");
  return {
    personaId: idString(body.personaId, "personaId"),
    sourceId: idString(body.sourceId, "sourceId"),
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

function internalError(deps: RouteDependencies, event: string) {
  try {
    deps.logError(event);
  } catch {
    // Logging must never alter the API response or expose the original failure.
  }
  return NextResponse.json({ error: "服务暂时不可用" }, { status: 500 });
}

const defaultDependencies: RouteDependencies = {
  requireAuth,
  getRepository,
  reviewPersonaKnowledge,
  randomUUID: () => randomUUID(),
  sha256Hex,
  logError: (event) => logger.error(event),
};

export function createPersonaKnowledgeHandlers(overrides: Partial<RouteDependencies> = {}) {
  const deps: RouteDependencies = { ...defaultDependencies, ...overrides };

  return {
    async GET(req: NextRequest) {
      const auth = await deps.requireAuth(req);
      if ("error" in auth) return auth.error;

      let personaId: string;
      try {
        personaId = idString(req.nextUrl.searchParams.get("personaId") || "", "personaId");
      } catch (error) {
        return badRequest(error);
      }
      try {
        const repository = deps.getRepository();
        const persona = await repository.getPersonaForUser(personaId, auth.userId);
        if (!persona) return forbidden();
        return NextResponse.json(await repository.listPersonaKnowledge(personaId));
      } catch {
        return internalError(deps, "persona_knowledge_get_failed");
      }
    },

    async POST(req: NextRequest) {
      const auth = await deps.requireAuth(req);
      if ("error" in auth) return auth.error;

      let body: CreateKnowledgeBody;
      try {
        body = parseCreateKnowledgeBody(await req.json());
      } catch (error) {
        return badRequest(error);
      }
      const { personaId } = body;
      try {
        const repository = deps.getRepository();
        const persona = await repository.getPersonaForUser(personaId, auth.userId);
        if (!persona) return forbidden();

        const sourceId = deps.randomUUID();
        const source = {
          id: sourceId,
          personaId,
          sourceType: "manual_text" as const,
          contentText: body.source.contentText,
          objectPath: null,
          checksumAlgorithm: "sha256" as const,
          checksum: deps.sha256Hex(Buffer.from(body.source.contentText, "utf8")),
          status: "ready" as const,
          createdBy: auth.userId,
        };
        const candidates: CreatePersonaKnowledgeCandidateInput[] = body.candidates.map((candidate) => {
          const id = deps.randomUUID();
          if (candidate.kind === "relationship_memory") {
            return { ...candidate, id, personaId, sourceId, embedding: null };
          }
          return { ...candidate, id, personaId, sourceId };
        });
        const created = await repository.createPersonaKnowledgeCandidates({ source, candidates });
        return NextResponse.json(created, { status: 201 });
      } catch {
        return internalError(deps, "persona_knowledge_create_failed");
      }
    },

    async PATCH(req: NextRequest) {
      const auth = await deps.requireAuth(req);
      if ("error" in auth) return auth.error;

      let body: ReviewKnowledgeBody;
      try {
        body = parseReviewKnowledgeBody(await req.json());
      } catch (error) {
        return badRequest(error);
      }
      const { personaId } = body;
      try {
        const repository = deps.getRepository();
        const persona = await repository.getPersonaForUser(personaId, auth.userId);
        if (!persona) return forbidden();
        const result = await deps.reviewPersonaKnowledge({
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
        return internalError(deps, "persona_knowledge_review_failed");
      }
    },

    async DELETE(req: NextRequest) {
      const auth = await deps.requireAuth(req);
      if ("error" in auth) return auth.error;

      let body: { personaId: string; sourceId: string };
      try {
        body = parseRevokeSourceBody(await req.json());
      } catch (error) {
        return badRequest(error);
      }
      const { personaId, sourceId } = body;
      try {
        const repository = deps.getRepository();
        const persona = await repository.getPersonaForUser(personaId, auth.userId);
        if (!persona) return forbidden();
        const { revokedItems } = await repository.revokePersonaSource(
          sourceId,
          personaId,
          auth.userId,
        );
        return NextResponse.json({ ok: true, revokedItems });
      } catch {
        return internalError(deps, "persona_knowledge_delete_failed");
      }
    },
  };
}

const handlers = createPersonaKnowledgeHandlers();

export async function GET(req: NextRequest) {
  return handlers.GET(req);
}

export async function POST(req: NextRequest) {
  return handlers.POST(req);
}

export async function PATCH(req: NextRequest) {
  return handlers.PATCH(req);
}

export async function DELETE(req: NextRequest) {
  return handlers.DELETE(req);
}
