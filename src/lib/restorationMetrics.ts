import type {
  RestorationCohort,
  RestorationMetricRow,
} from "./storage/types";

const INITIAL_EVALUATOR_COUNT = 10;
const INITIAL_SESSION_COUNT = 30;
const INITIAL_EFFECTIVE_RATE = 0.6;

export type CohortSummary = {
  evaluatorCount: number;
  sessionCount: number;
  effectiveSessionCount: number;
  effectiveRate: number | null;
  meetsInitialGate: boolean;
};

export function isEffectiveRestorationFeedback(row: RestorationMetricRow): boolean {
  return row.voiceSimilarity >= 4
    && row.expressionSimilarity >= 4
    && row.emotionFit >= 4
    && row.factTrust >= 4
    && row.discomfort <= 2
    && !row.majorFabrication
    && !row.identityImpersonation
    && !row.authorizationViolation;
}

function summarizeCohort(
  rows: RestorationMetricRow[],
  cohort: RestorationCohort,
): CohortSummary {
  const cohortRows = rows.filter((row) => row.cohort === cohort);
  const evaluatorCount = new Set(cohortRows.map((row) => row.evaluatorUserId)).size;
  const sessionCount = cohortRows.length;
  const effectiveSessionCount = cohortRows.filter(isEffectiveRestorationFeedback).length;
  const effectiveRate = sessionCount === 0 ? null : effectiveSessionCount / sessionCount;
  const meetsInitialGate = evaluatorCount >= INITIAL_EVALUATOR_COUNT
    && sessionCount >= INITIAL_SESSION_COUNT
    && effectiveRate !== null
    && effectiveRate >= INITIAL_EFFECTIVE_RATE;

  return {
    evaluatorCount,
    sessionCount,
    effectiveSessionCount,
    effectiveRate,
    meetsInitialGate,
  };
}

export function summarizeRestorationFeedback(rows: RestorationMetricRow[]): {
  living: CohortSummary;
  deceased: CohortSummary;
  bothCohortsMeetInitialGate: boolean;
} {
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (sessionIds.has(row.sessionId)) {
      throw new Error("duplicate_feedback_session");
    }
    sessionIds.add(row.sessionId);
  }

  const living = summarizeCohort(rows, "living");
  const deceased = summarizeCohort(rows, "deceased");

  return {
    living,
    deceased,
    bothCohortsMeetInitialGate: living.meetsInitialGate && deceased.meetsInitialGate,
  };
}
