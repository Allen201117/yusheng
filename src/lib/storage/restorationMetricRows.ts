import type { RestorationMetricRow } from "./types";

export type RestorationMetricDbRow = {
  session_id: string;
  evaluator_user_id: string;
  cohort: RestorationMetricRow["cohort"];
  voice_similarity: number | string;
  expression_similarity: number | string;
  emotion_fit: number | string;
  fact_trust: number | string;
  discomfort: number | string;
  major_fabrication: boolean | number;
  identity_impersonation: boolean | number;
  authorization_violation: boolean | number;
};

export const RESTORATION_METRIC_SELECT_SQL = `SELECT feedback.session_id,
       feedback.evaluator_user_id,
       sessions.cohort,
       feedback.voice_similarity,
       feedback.expression_similarity,
       feedback.emotion_fit,
       feedback.fact_trust,
       feedback.discomfort,
       feedback.major_fabrication,
       feedback.identity_impersonation,
       feedback.authorization_violation
FROM conversation_feedback feedback
JOIN conversation_sessions sessions
  ON sessions.id = feedback.session_id
 AND sessions.evaluator_user_id = feedback.evaluator_user_id
ORDER BY feedback.session_id`;

export function mapRestorationMetricRow(row: RestorationMetricDbRow): RestorationMetricRow {
  return {
    sessionId: row.session_id,
    evaluatorUserId: row.evaluator_user_id,
    cohort: row.cohort,
    voiceSimilarity: Number(row.voice_similarity),
    expressionSimilarity: Number(row.expression_similarity),
    emotionFit: Number(row.emotion_fit),
    factTrust: Number(row.fact_trust),
    discomfort: Number(row.discomfort),
    majorFabrication: Boolean(row.major_fabrication),
    identityImpersonation: Boolean(row.identity_impersonation),
    authorizationViolation: Boolean(row.authorization_violation),
  };
}
