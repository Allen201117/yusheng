import assert from "node:assert/strict";
import { it } from "node:test";
import {
  isEffectiveRestorationFeedback,
  summarizeRestorationFeedback,
} from "../src/lib/restorationMetrics";
import type { RestorationMetricRow } from "../src/lib/storage/types";

const effectiveScores = {
  voiceSimilarity: 4,
  expressionSimilarity: 4,
  emotionFit: 4,
  factTrust: 4,
  discomfort: 2,
  majorFabrication: false,
  identityImpersonation: false,
  authorizationViolation: false,
} as const;

function feedbackRow(
  sessionId: string,
  overrides: Partial<RestorationMetricRow> = {},
): RestorationMetricRow {
  return {
    sessionId,
    evaluatorUserId: `evaluator-${sessionId}`,
    cohort: "living",
    ...effectiveScores,
    ...overrides,
  };
}

function cohortRows(options: {
  cohort: "living" | "deceased";
  evaluatorCount: number;
  sessionCount: number;
  effectiveSessionCount: number;
}): RestorationMetricRow[] {
  return Array.from({ length: options.sessionCount }, (_, index) =>
    feedbackRow(`${options.cohort}-session-${index}`, {
      cohort: options.cohort,
      evaluatorUserId: `evaluator-${index % options.evaluatorCount}`,
      voiceSimilarity: index < options.effectiveSessionCount ? 4 : 3,
    }),
  );
}

it("accepts feedback exactly on every effective-restoration threshold", () => {
  assert.equal(isEffectiveRestorationFeedback(feedbackRow("qualified")), true);
});

it("rejects a score of 3 for each positive restoration dimension", () => {
  for (const score of [
    "voiceSimilarity",
    "expressionSimilarity",
    "emotionFit",
    "factTrust",
  ] as const) {
    assert.equal(
      isEffectiveRestorationFeedback(feedbackRow(score, { [score]: 3 })),
      false,
      score,
    );
  }
});

it("rejects discomfort above 2", () => {
  assert.equal(
    isEffectiveRestorationFeedback(feedbackRow("discomfort", { discomfort: 3 })),
    false,
  );
});

it("rejects every restoration red line", () => {
  for (const redLine of [
    "majorFabrication",
    "identityImpersonation",
    "authorizationViolation",
  ] as const) {
    assert.equal(
      isEffectiveRestorationFeedback(feedbackRow(redLine, { [redLine]: true })),
      false,
      redLine,
    );
  }
});

it("summarizes living and deceased sessions separately without merging an evaluator's sessions", () => {
  const summary = summarizeRestorationFeedback([
    feedbackRow("living-1", { evaluatorUserId: "same-evaluator" }),
    feedbackRow("living-2", {
      evaluatorUserId: "same-evaluator",
      voiceSimilarity: 3,
    }),
    feedbackRow("deceased-1", {
      cohort: "deceased",
      evaluatorUserId: "same-evaluator",
    }),
  ]);

  assert.deepEqual(summary.living, {
    evaluatorCount: 1,
    sessionCount: 2,
    effectiveSessionCount: 1,
    effectiveRate: 0.5,
    meetsInitialGate: false,
  });
  assert.deepEqual(summary.deceased, {
    evaluatorCount: 1,
    sessionCount: 1,
    effectiveSessionCount: 1,
    effectiveRate: 1,
    meetsInitialGate: false,
  });
  assert.equal(summary.bothCohortsMeetInitialGate, false);
});

it("reports null rates for cohorts with no feedback", () => {
  const summary = summarizeRestorationFeedback([]);

  assert.equal(summary.living.effectiveRate, null);
  assert.equal(summary.deceased.effectiveRate, null);
});

it("returns the exact effective rate without rounding non-terminating decimals", () => {
  const summary = summarizeRestorationFeedback([
    feedbackRow("exact-rate-1"),
    feedbackRow("exact-rate-2", { voiceSimilarity: 3 }),
    feedbackRow("exact-rate-3", { voiceSimilarity: 3 }),
  ]);

  assert.equal(summary.living.effectiveRate, 1 / 3);
});

it("requires 10 evaluators, 30 sessions, and a 0.6 effective rate for each cohort", () => {
  const passing = cohortRows({
    cohort: "living",
    evaluatorCount: 10,
    sessionCount: 30,
    effectiveSessionCount: 18,
  });
  assert.equal(summarizeRestorationFeedback(passing).living.meetsInitialGate, true);

  const tooFewEvaluators = cohortRows({
    cohort: "living",
    evaluatorCount: 9,
    sessionCount: 30,
    effectiveSessionCount: 18,
  });
  assert.equal(
    summarizeRestorationFeedback(tooFewEvaluators).living.meetsInitialGate,
    false,
  );

  const tooFewSessions = cohortRows({
    cohort: "living",
    evaluatorCount: 10,
    sessionCount: 29,
    effectiveSessionCount: 18,
  });
  assert.equal(summarizeRestorationFeedback(tooFewSessions).living.meetsInitialGate, false);

  const tooLowRate = cohortRows({
    cohort: "living",
    evaluatorCount: 10,
    sessionCount: 30,
    effectiveSessionCount: 17,
  });
  assert.equal(summarizeRestorationFeedback(tooLowRate).living.meetsInitialGate, false);
});

it("sets the combined gate only when living and deceased cohorts both pass", () => {
  const living = cohortRows({
    cohort: "living",
    evaluatorCount: 10,
    sessionCount: 30,
    effectiveSessionCount: 18,
  });
  const deceased = cohortRows({
    cohort: "deceased",
    evaluatorCount: 10,
    sessionCount: 30,
    effectiveSessionCount: 18,
  });

  assert.equal(
    summarizeRestorationFeedback([...living, ...deceased]).bothCohortsMeetInitialGate,
    true,
  );
  assert.equal(summarizeRestorationFeedback(living).bothCohortsMeetInitialGate, false);
});

it("throws on duplicate session IDs even when the rows are identical", () => {
  const row = feedbackRow("duplicate-session");

  assert.throws(
    () => summarizeRestorationFeedback([row, { ...row }]),
    (error: unknown) =>
      error instanceof Error && error.message === "duplicate_feedback_session",
  );
});

it("does not modify its input rows", () => {
  const rows = [
    feedbackRow("living-input"),
    feedbackRow("deceased-input", { cohort: "deceased", discomfort: 3 }),
  ];
  const before = structuredClone(rows);

  summarizeRestorationFeedback(rows);

  assert.deepEqual(rows, before);
});
