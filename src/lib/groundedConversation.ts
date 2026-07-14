import { cosineSim } from "./embedding";
import type {
  ConfirmedConversationKnowledge,
  ConversationEvidence,
  ConversationStyle,
} from "./storage/types";

export type SelectedEvidence = ConversationEvidence & { score: number };

export type GroundedContext = {
  mode: "grounded" | "companionship";
  evidence: SelectedEvidence[];
  styles: ConversationStyle[];
};

export function selectGroundedContext({
  queryEmbedding,
  knowledge,
  minScore = 0.35,
  topK = 4,
}: {
  queryEmbedding: Float32Array;
  knowledge: ConfirmedConversationKnowledge;
  minScore?: number;
  topK?: number;
}): GroundedContext {
  const evidence = knowledge.evidence
    .filter(
      (item): item is ConversationEvidence & { embedding: Float32Array } =>
        item.embedding !== null,
    )
    .map<SelectedEvidence>((item) => ({
      ...item,
      score: cosineSim(queryEmbedding, item.embedding),
    }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, topK);

  return {
    mode: evidence.length > 0 ? "grounded" : "companionship",
    evidence,
    styles: knowledge.styles.slice(0, 20),
  };
}
