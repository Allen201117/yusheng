import { it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import { createPlaybackEventHandlers } from "../src/lib/playbackEventRoute";
import type { AppRepository, PlaybackEvent } from "../src/lib/storage/types";

const VALID_BODY = {
  eventId: "event-1",
  ttsAttemptId: "attempt-1",
  eventType: "play_started" as const,
  clientElapsedMs: 42,
};

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/playback-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string): NextRequest {
  return new NextRequest("http://localhost/api/playback-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function event(input = VALID_BODY): PlaybackEvent {
  return { ...input, receivedAt: "2026-07-15T00:00:00.000Z" };
}

function fixture(options: {
  authError?: boolean;
  created?: boolean;
  repositoryError?: Error;
} = {}) {
  let repositoryConstructed = 0;
  const writes: Array<Record<string, unknown>> = [];
  const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const repository = {
    async recordPlaybackEvent(input: typeof VALID_BODY & { evaluatorUserId: string }) {
      writes.push(input);
      if (options.repositoryError) throw options.repositoryError;
      return { event: event(input), created: options.created !== false };
    },
  } as unknown as AppRepository;
  const handlers = createPlaybackEventHandlers({
    requireAuth: async () => options.authError
      ? { error: NextResponse.json({ error: "未登录" }, { status: 401 }) }
      : { userId: "user-1" },
    getRepository: () => {
      repositoryConstructed += 1;
      return repository;
    },
    logError: (logEvent, data) => logs.push({ event: logEvent, data }),
  });
  return { handlers, writes, logs, repositoryConstructed: () => repositoryConstructed };
}

it("authenticates before parsing JSON or constructing the repository", async () => {
  const f = fixture({ authError: true });
  const response = await f.handlers.POST(rawRequest("not-json"));
  assert.equal(response.status, 401);
  assert.equal(f.repositoryConstructed(), 0);
  assert.deepEqual(f.writes, []);
});

it("accepts the exact playback body and returns 201 for a new event", async () => {
  const f = fixture();
  const response = await f.handlers.POST(request(VALID_BODY));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, created: true });
  assert.deepEqual(f.writes, [{ ...VALID_BODY, evaluatorUserId: "user-1" }]);
  assert.equal(f.repositoryConstructed(), 1);
});

it("returns 200 only for an identical idempotent retry", async () => {
  const f = fixture({ created: false });
  const response = await f.handlers.POST(request(VALID_BODY));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, created: false });
});

it("rejects missing, extra, malformed and out-of-range fields", async () => {
  const invalid: unknown[] = [
    null,
    [],
    { ...VALID_BODY, extra: true },
    { ...VALID_BODY, eventId: "" },
    { ...VALID_BODY, eventId: `event-${"x".repeat(200)}` },
    { ...VALID_BODY, ttsAttemptId: " attempt-1" },
    { ...VALID_BODY, ttsAttemptId: "attempt\u0000-1" },
    { ...VALID_BODY, eventType: "unknown" },
    { ...VALID_BODY, clientElapsedMs: 1.5 },
    { ...VALID_BODY, clientElapsedMs: -1 },
    { ...VALID_BODY, clientElapsedMs: 300001 },
  ];
  for (const body of invalid) {
    const f = fixture();
    const response = await f.handlers.POST(request(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(f.repositoryConstructed(), 0, JSON.stringify(body));
    assert.deepEqual(f.writes, [], JSON.stringify(body));
  }
});

it("maps unknown and non-owned attempts to the same 403 response", async () => {
  for (const scenario of ["unknown", "non-owned"]) {
    const f = fixture({ repositoryError: new Error("playback_attempt_forbidden") });
    const response = await f.handlers.POST(request(VALID_BODY));
    assert.equal(response.status, 403, scenario);
    assert.deepEqual(await response.json(), {
      error: "无法记录该播放事件",
      code: "PLAYBACK_ATTEMPT_FORBIDDEN",
    });
  }
});

it("maps conflicting event ids to 409 and persistence failures to generic 500", async () => {
  const conflict = fixture({ repositoryError: new Error("playback_event_conflict") });
  const conflictResponse = await conflict.handlers.POST(request(VALID_BODY));
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual(await conflictResponse.json(), {
    error: "eventId 已用于其他播放事件",
    code: "PLAYBACK_EVENT_CONFLICT",
  });

  const failed = fixture({
    repositoryError: new Error("raw audio secret transcript free-form provider failure"),
  });
  const failedResponse = await failed.handlers.POST(request(VALID_BODY));
  assert.equal(failedResponse.status, 500);
  assert.deepEqual(await failedResponse.json(), {
    error: "播放事件记录失败，请稍后重试",
    code: "PLAYBACK_EVENT_PERSISTENCE_FAILED",
  });
  const serialized = JSON.stringify(failed.logs);
  assert.doesNotMatch(serialized, /raw audio|secret|transcript|free-form|provider failure/);
  assert.deepEqual(failed.logs, [{
    event: "playback_event_persistence_failed",
    data: {
      eventId: "event-1",
      ttsAttemptId: "attempt-1",
      eventType: "play_started",
      clientElapsedMs: 42,
      errorName: "Error",
    },
  }]);
});
