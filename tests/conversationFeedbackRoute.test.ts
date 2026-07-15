import { it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import { createConversationFeedbackHandlers } from "../src/lib/conversationFeedbackRoute";
import type {
  AppRepository,
  ConversationFeedback,
  FeedbackEligibility,
} from "../src/lib/storage/types";

const VALID_BODY = {
  sessionId: "session-1",
  evaluatorRelation: "family" as const,
  knowsVoiceOwner: true as const,
  heardAllRounds: true as const,
  voiceSimilarity: 5,
  expressionSimilarity: 4,
  emotionFit: 4,
  factTrust: 5,
  discomfort: 2,
  majorFabrication: false,
  identityImpersonation: false,
  authorizationViolation: false,
  comment: "  像她平时说话  ",
};

const ELIGIBLE: FeedbackEligibility = {
  completedAudibleTurnCount: 3,
  requiredAudibleTurnCount: 3,
  eligible: true,
  sessionStatus: "active",
  alreadySubmitted: false,
};

function request(method: "GET" | "POST", body?: unknown, query = "sessionId=session-1") {
  return new NextRequest(`http://localhost/api/conversation-feedback?${query}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawRequest(body: string) {
  return new NextRequest("http://localhost/api/conversation-feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function feedback(input: Record<string, unknown>): ConversationFeedback {
  return {
    id: String(input.id),
    sessionId: String(input.sessionId),
    personaId: "persona-1",
    evaluatorUserId: String(input.evaluatorUserId),
    evaluatorRelation: input.evaluatorRelation as ConversationFeedback["evaluatorRelation"],
    knowsVoiceOwner: true,
    heardAllRounds: true,
    voiceSimilarity: Number((input.scores as Record<string, unknown>).voiceSimilarity),
    expressionSimilarity: Number((input.scores as Record<string, unknown>).expressionSimilarity),
    emotionFit: Number((input.scores as Record<string, unknown>).emotionFit),
    factTrust: Number((input.scores as Record<string, unknown>).factTrust),
    discomfort: Number((input.scores as Record<string, unknown>).discomfort),
    majorFabrication: Boolean((input.scores as Record<string, unknown>).majorFabrication),
    identityImpersonation: Boolean((input.scores as Record<string, unknown>).identityImpersonation),
    authorizationViolation: Boolean((input.scores as Record<string, unknown>).authorizationViolation),
    comment: input.comment as string | null,
    createdAt: "2026-07-15T00:00:00.000Z",
  };
}

function fixture(options: {
  authError?: boolean;
  repositoryError?: Error;
  eligibility?: FeedbackEligibility | null;
} = {}) {
  let repositoryConstructed = 0;
  const submissions: Array<Record<string, unknown>> = [];
  const eligibilityReads: Array<Record<string, unknown>> = [];
  const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const repository = {
    async getFeedbackEligibility(sessionId: string, evaluatorUserId: string) {
      eligibilityReads.push({ sessionId, evaluatorUserId });
      if (options.repositoryError) throw options.repositoryError;
      return options.eligibility === undefined ? ELIGIBLE : options.eligibility;
    },
    async submitConversationFeedback(input: Record<string, unknown>) {
      submissions.push(input);
      if (options.repositoryError) throw options.repositoryError;
      return feedback(input);
    },
  } as unknown as AppRepository;
  const handlers = createConversationFeedbackHandlers({
    requireAuth: async () => options.authError
      ? { error: NextResponse.json({ error: "未登录" }, { status: 401 }) }
      : { userId: "user-1" },
    getRepository: () => {
      repositoryConstructed += 1;
      return repository;
    },
    createId: () => "feedback-1",
    logError: (event, data) => logs.push({ event, data }),
  });
  return {
    handlers,
    submissions,
    eligibilityReads,
    logs,
    repositoryConstructed: () => repositoryConstructed,
  };
}

it("authenticates before parsing either feedback request", async () => {
  const post = fixture({ authError: true });
  const postResponse = await post.handlers.POST(rawRequest("not-json"));
  assert.equal(postResponse.status, 401);
  assert.equal(postResponse.headers.get("cache-control"), "no-store");
  assert.equal(post.repositoryConstructed(), 0);
  const get = fixture({ authError: true });
  const getResponse = await get.handlers.GET(request("GET", undefined, "sessionId=%00"));
  assert.equal(getResponse.status, 401);
  assert.equal(getResponse.headers.get("cache-control"), "no-store");
  assert.equal(get.repositoryConstructed(), 0);
});

it("accepts the exact complete body, normalizes comment, and returns effective", async () => {
  const f = fixture();
  const response = await f.handlers.POST(request("POST", VALID_BODY));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    feedbackId: "feedback-1",
    sessionId: "session-1",
    effective: true,
  });
  assert.deepEqual(f.submissions, [{
    id: "feedback-1",
    sessionId: "session-1",
    evaluatorUserId: "user-1",
    evaluatorRelation: "family",
    knowsVoiceOwner: true,
    heardAllRounds: true,
    scores: {
      voiceSimilarity: 5,
      expressionSimilarity: 4,
      emotionFit: 4,
      factTrust: 5,
      discomfort: 2,
      majorFabrication: false,
      identityImpersonation: false,
      authorizationViolation: false,
    },
    comment: "像她平时说话",
  }]);
});

it("rejects missing, extra, noninteger, unattested and unsafe inputs", async () => {
  const { comment: _comment, ...withoutOptionalComment } = VALID_BODY;
  const invalid: unknown[] = [
    null,
    [],
    { ...VALID_BODY, sessionId: undefined },
    { ...VALID_BODY, extra: "forged" },
    { ...VALID_BODY, evaluatorRelation: "owner" },
    { ...VALID_BODY, knowsVoiceOwner: false },
    { ...VALID_BODY, heardAllRounds: 1 },
    { ...VALID_BODY, voiceSimilarity: 4.5 },
    { ...VALID_BODY, expressionSimilarity: 0 },
    { ...VALID_BODY, discomfort: 6 },
    { ...VALID_BODY, majorFabrication: "false" },
    { ...VALID_BODY, comment: "bad\u0000comment" },
    { ...VALID_BODY, comment: "x".repeat(1001) },
  ];
  for (const body of invalid) {
    const f = fixture();
    const response = await f.handlers.POST(request("POST", body));
    assert.equal(response.status, 400, JSON.stringify(body)?.slice(0, 100));
    assert.equal(f.repositoryConstructed(), 0);
  }
  const optional = fixture();
  assert.equal((await optional.handlers.POST(request("POST", withoutOptionalComment))).status, 201);
  assert.equal(optional.submissions[0].comment, null);
});

it("GET returns only the current user's minimal eligibility", async () => {
  const f = fixture();
  const response = await f.handlers.GET(request("GET"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.deepEqual(payload, ELIGIBLE);
  assert.deepEqual(f.eligibilityReads, [{ sessionId: "session-1", evaluatorUserId: "user-1" }]);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /comment|sentence|voice|provider|persona|evaluator/i);
});

it("maps unknown and non-owned sessions to the same 403", async () => {
  for (const eligibility of [null, null]) {
    const f = fixture({ eligibility });
    const response = await f.handlers.GET(request("GET"));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "无法访问该会话反馈",
      code: "FEEDBACK_SESSION_FORBIDDEN",
    });
  }
  const post = fixture({ repositoryError: new Error("feedback_session_forbidden") });
  assert.equal((await post.handlers.POST(request("POST", VALID_BODY))).status, 403);
});

it("maps duplicate and insufficient evidence to stable narrow errors", async () => {
  const duplicate = fixture({ repositoryError: new Error("feedback_already_submitted") });
  const duplicateResponse = await duplicate.handlers.POST(request("POST", VALID_BODY));
  assert.equal(duplicateResponse.status, 409);
  assert.equal((await duplicateResponse.json()).code, "FEEDBACK_ALREADY_SUBMITTED");

  const error = Object.assign(new Error("feedback_session_not_eligible"), {
    completedAudibleTurnCount: 2,
    requiredAudibleTurnCount: 3,
  });
  const insufficient = fixture({ repositoryError: error });
  const response = await insufficient.handlers.POST(request("POST", VALID_BODY));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "该会话还不满足评价条件",
    code: "FEEDBACK_SESSION_NOT_ELIGIBLE",
    completedAudibleTurnCount: 2,
    requiredAudibleTurnCount: 3,
  });
});

it("red lines override high scores and generic failures never leak feedback", async () => {
  const redLine = fixture();
  const response = await redLine.handlers.POST(request("POST", {
    ...VALID_BODY,
    majorFabrication: true,
  }));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).effective, false);
  const routeSource = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("../src/lib/conversationFeedbackRoute.ts", import.meta.url),
    "utf8",
  ));
  assert.doesNotMatch(routeSource, /cohort:\s*["']living["']/);

  const failed = fixture({
    repositoryError: new Error("raw comment 5 4 4 5 provider transcript secret"),
  });
  const failedResponse = await failed.handlers.POST(request("POST", VALID_BODY));
  assert.equal(failedResponse.status, 500);
  assert.deepEqual(await failedResponse.json(), {
    error: "反馈保存失败，请稍后重试",
    code: "FEEDBACK_PERSISTENCE_FAILED",
  });
  const logs = JSON.stringify(failed.logs);
  assert.doesNotMatch(logs, /像她|raw comment|5|4|provider|transcript|secret/);
  assert.deepEqual(failed.logs, [{
    event: "conversation_feedback_persistence_failed",
    data: { sessionId: "session-1", errorName: "Error" },
  }]);
});

it("rejects malformed GET query without repository access", async () => {
  for (const query of ["", "sessionId=", "sessionId=a&extra=1", `sessionId=${"x".repeat(101)}`]) {
    const f = fixture();
    const response = await f.handlers.GET(request("GET", undefined, query));
    assert.equal(response.status, 400, query);
    assert.equal(f.repositoryConstructed(), 0, query);
  }
});
