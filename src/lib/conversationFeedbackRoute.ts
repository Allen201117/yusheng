import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "./guard";
import { logger } from "./logger";
import { isEffectiveRestorationFeedback } from "./restorationMetrics";
import { getRepository } from "./storage/repository";
import type {
  AppRepository,
  EvaluatorRelation,
  RestorationScores,
} from "./storage/types";

type AuthResult = Awaited<ReturnType<typeof requireAuth>>;
type StableLogFields = Record<string, string | number | null>;

export type ConversationFeedbackRouteDependencies = {
  requireAuth: (request: NextRequest) => Promise<AuthResult>;
  getRepository: () => AppRepository;
  createId: () => string;
  logError: (event: string, data?: StableLogFields) => void;
};

const defaults: ConversationFeedbackRouteDependencies = {
  requireAuth,
  getRepository,
  createId: randomUUID,
  logError: (event, data) => logger.error(event, data),
};

const REQUIRED_BODY_KEYS = [
  "authorizationViolation",
  "discomfort",
  "emotionFit",
  "evaluatorRelation",
  "expressionSimilarity",
  "factTrust",
  "heardAllRounds",
  "identityImpersonation",
  "knowsVoiceOwner",
  "majorFabrication",
  "sessionId",
  "voiceSimilarity",
] as const;
const BODY_KEYS_WITH_COMMENT = [...REQUIRED_BODY_KEYS, "comment"].sort();
const RELATIONS = new Set<EvaluatorRelation>(["self", "family", "friend", "other"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_ID_LENGTH = 100;
const MAX_COMMENT_LENGTH = 1000;

function jsonError(error: string, code: string, status: number, extra?: Record<string, number>) {
  return NextResponse.json({ error, code, ...extra }, { status });
}

function validId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_ID_LENGTH
    && value === value.trim()
    && !CONTROL_CHARACTERS.test(value);
}

function validScore(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5;
}

type ParsedFeedback = {
  sessionId: string;
  evaluatorRelation: EvaluatorRelation;
  knowsVoiceOwner: true;
  heardAllRounds: true;
  scores: RestorationScores;
  comment: string | null;
};

function parseBody(body: unknown): ParsedFeedback | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const allowed = keys.includes("comment") ? BODY_KEYS_WITH_COMMENT : [...REQUIRED_BODY_KEYS].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) return null;
  if (!validId(input.sessionId)) return null;
  if (!RELATIONS.has(input.evaluatorRelation as EvaluatorRelation)) return null;
  if (input.knowsVoiceOwner !== true || input.heardAllRounds !== true) return null;
  for (const key of [
    "voiceSimilarity",
    "expressionSimilarity",
    "emotionFit",
    "factTrust",
    "discomfort",
  ] as const) {
    if (!validScore(input[key])) return null;
  }
  for (const key of [
    "majorFabrication",
    "identityImpersonation",
    "authorizationViolation",
  ] as const) {
    if (typeof input[key] !== "boolean") return null;
  }
  if (input.comment !== undefined && input.comment !== null && typeof input.comment !== "string") {
    return null;
  }
  const comment = typeof input.comment === "string" ? input.comment.trim() : null;
  if (comment !== null && (comment.length > MAX_COMMENT_LENGTH || CONTROL_CHARACTERS.test(comment))) {
    return null;
  }
  return {
    sessionId: input.sessionId,
    evaluatorRelation: input.evaluatorRelation as EvaluatorRelation,
    knowsVoiceOwner: true,
    heardAllRounds: true,
    scores: {
      voiceSimilarity: input.voiceSimilarity as number,
      expressionSimilarity: input.expressionSimilarity as number,
      emotionFit: input.emotionFit as number,
      factTrust: input.factTrust as number,
      discomfort: input.discomfort as number,
      majorFabrication: input.majorFabrication as boolean,
      identityImpersonation: input.identityImpersonation as boolean,
      authorizationViolation: input.authorizationViolation as boolean,
    },
    comment: comment || null,
  };
}

function parseSessionQuery(request: NextRequest): string | null {
  const entries = Array.from(request.nextUrl.searchParams.entries());
  if (entries.length !== 1 || entries[0][0] !== "sessionId") return null;
  return validId(entries[0][1]) ? entries[0][1] : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function notEligibleCounts(error: unknown): { current: number; required: number } | null {
  if (!(error instanceof Error) || error.message !== "feedback_session_not_eligible") return null;
  const value = error as Error & {
    completedAudibleTurnCount?: unknown;
    requiredAudibleTurnCount?: unknown;
  };
  if (!Number.isInteger(value.completedAudibleTurnCount) || value.requiredAudibleTurnCount !== 3) {
    return null;
  }
  return { current: Number(value.completedAudibleTurnCount), required: 3 };
}

export function createConversationFeedbackHandlers(
  overrides: Partial<ConversationFeedbackRouteDependencies> = {},
) {
  const deps = { ...defaults, ...overrides };

  async function GET(request: NextRequest): Promise<NextResponse> {
    const auth = await deps.requireAuth(request);
    if ("error" in auth) return auth.error;
    const sessionId = parseSessionQuery(request);
    if (!sessionId) return jsonError("会话参数无效", "INVALID_FEEDBACK_SESSION", 400);
    try {
      const eligibility = await deps.getRepository().getFeedbackEligibility(sessionId, auth.userId);
      if (!eligibility) {
        return jsonError("无法访问该会话反馈", "FEEDBACK_SESSION_FORBIDDEN", 403);
      }
      return NextResponse.json(eligibility, { status: 200 });
    } catch (error) {
      deps.logError("conversation_feedback_eligibility_failed", {
        sessionId,
        errorName: errorName(error),
      });
      return jsonError("反馈状态读取失败，请稍后重试", "FEEDBACK_ELIGIBILITY_FAILED", 500);
    }
  }

  async function POST(request: NextRequest): Promise<NextResponse> {
    const auth = await deps.requireAuth(request);
    if ("error" in auth) return auth.error;
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonError("请求体必须是 JSON", "INVALID_CONVERSATION_FEEDBACK", 400);
    }
    const input = parseBody(rawBody);
    if (!input) return jsonError("反馈参数无效", "INVALID_CONVERSATION_FEEDBACK", 400);

    try {
      const saved = await deps.getRepository().submitConversationFeedback({
        id: deps.createId(),
        ...input,
        evaluatorUserId: auth.userId,
      });
      const effective = isEffectiveRestorationFeedback({
        ...saved,
        cohort: "living",
      });
      return NextResponse.json({ feedbackId: saved.id, sessionId: saved.sessionId, effective }, {
        status: 201,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "feedback_session_forbidden") {
        return jsonError("无法访问该会话反馈", "FEEDBACK_SESSION_FORBIDDEN", 403);
      }
      if (message === "feedback_already_submitted") {
        return jsonError("该会话已提交过反馈", "FEEDBACK_ALREADY_SUBMITTED", 409);
      }
      const counts = notEligibleCounts(error);
      if (counts) {
        return jsonError("该会话还不满足评价条件", "FEEDBACK_SESSION_NOT_ELIGIBLE", 422, {
          completedAudibleTurnCount: counts.current,
          requiredAudibleTurnCount: counts.required,
        });
      }
      deps.logError("conversation_feedback_persistence_failed", {
        sessionId: input.sessionId,
        errorName: errorName(error),
      });
      return jsonError("反馈保存失败，请稍后重试", "FEEDBACK_PERSISTENCE_FAILED", 500);
    }
  }

  return { GET, POST };
}
