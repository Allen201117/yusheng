import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "./guard";
import { logger } from "./logger";
import { getRepository } from "./storage/repository";
import type { AppRepository, PlaybackEventType } from "./storage/types";

type AuthResult = Awaited<ReturnType<typeof requireAuth>>;
type StableLogFields = Record<string, string | number | null>;

export type PlaybackEventRouteDependencies = {
  requireAuth: (request: NextRequest) => Promise<AuthResult>;
  getRepository: () => AppRepository;
  logError: (event: string, data?: StableLogFields) => void;
};

const defaults: PlaybackEventRouteDependencies = {
  requireAuth,
  getRepository,
  logError: (event, data) => logger.error(event, data),
};

const BODY_KEYS = ["clientElapsedMs", "eventId", "eventType", "ttsAttemptId"] as const;
const EVENT_TYPES = new Set<PlaybackEventType>([
  "audio_ready",
  "play_started",
  "play_completed",
  "play_failed",
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_ID_LENGTH = 100;

function jsonError(error: string, code: string, status: number): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

function validId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_ID_LENGTH
    && value === value.trim()
    && !CONTROL_CHARACTERS.test(value);
}

function parseBody(body: unknown): {
  eventId: string;
  ttsAttemptId: string;
  eventType: PlaybackEventType;
  clientElapsedMs: number;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== BODY_KEYS.length || keys.some((key, index) => key !== BODY_KEYS[index])) {
    return null;
  }
  if (!validId(input.eventId) || !validId(input.ttsAttemptId)) return null;
  if (!EVENT_TYPES.has(input.eventType as PlaybackEventType)) return null;
  if (
    !Number.isInteger(input.clientElapsedMs)
    || Number(input.clientElapsedMs) < 0
    || Number(input.clientElapsedMs) > 300_000
  ) return null;
  return {
    eventId: input.eventId,
    ttsAttemptId: input.ttsAttemptId,
    eventType: input.eventType as PlaybackEventType,
    clientElapsedMs: input.clientElapsedMs as number,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export function createPlaybackEventHandlers(
  overrides: Partial<PlaybackEventRouteDependencies> = {},
) {
  const deps = { ...defaults, ...overrides };

  async function POST(request: NextRequest): Promise<NextResponse> {
    const auth = await deps.requireAuth(request);
    if ("error" in auth) return auth.error;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonError("请求体必须是 JSON", "INVALID_PLAYBACK_EVENT", 400);
    }
    const input = parseBody(rawBody);
    if (!input) return jsonError("播放事件参数无效", "INVALID_PLAYBACK_EVENT", 400);

    try {
      const result = await deps.getRepository().recordPlaybackEvent({
        ...input,
        evaluatorUserId: auth.userId,
      });
      return NextResponse.json(
        { ok: true, created: result.created },
        { status: result.created ? 201 : 200 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "playback_attempt_forbidden") {
        return jsonError(
          "无法记录该播放事件",
          "PLAYBACK_ATTEMPT_FORBIDDEN",
          403,
        );
      }
      if (message === "playback_event_conflict") {
        return jsonError(
          "eventId 已用于其他播放事件",
          "PLAYBACK_EVENT_CONFLICT",
          409,
        );
      }
      deps.logError("playback_event_persistence_failed", {
        eventId: input.eventId,
        ttsAttemptId: input.ttsAttemptId,
        eventType: input.eventType,
        clientElapsedMs: input.clientElapsedMs,
        errorName: errorName(error),
      });
      return jsonError(
        "播放事件记录失败，请稍后重试",
        "PLAYBACK_EVENT_PERSISTENCE_FAILED",
        500,
      );
    }
  }

  return { POST };
}
