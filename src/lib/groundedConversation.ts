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

const MAX_EVIDENCE = 4;
const MAX_EVIDENCE_CONTENT_CHARS = 2_000;
const MAX_STYLES = 20;
const MAX_STYLE_TEXT_CHARS = 8_000;

function normalizedTopK(topK: number): number {
  if (!Number.isFinite(topK)) return MAX_EVIDENCE;
  return Math.max(0, Math.min(MAX_EVIDENCE, Math.floor(topK)));
}

function normalizedMinScore(minScore: number): number {
  if (!Number.isFinite(minScore)) return 0.35;
  return Math.max(0, Math.min(1, minScore));
}

function selectStyles(styles: ConversationStyle[]): ConversationStyle[] {
  const selected: ConversationStyle[] = [];
  let remainingChars = MAX_STYLE_TEXT_CHARS;

  for (const style of styles) {
    if (selected.length >= MAX_STYLES || remainingChars === 0) break;

    if (!style.content && !style.example) continue;

    const fixedChars = style.id.length + style.category.length;
    if (remainingChars <= fixedChars) break;
    remainingChars -= fixedChars;

    const content = style.content.slice(0, remainingChars);
    remainingChars -= content.length;
    const example = style.example?.slice(0, remainingChars) || null;
    remainingChars -= example?.length ?? 0;

    selected.push({ ...style, content, example });
  }

  return selected;
}

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
  const safeTopK = normalizedTopK(topK);
  const safeMinScore = normalizedMinScore(minScore);

  for (const item of knowledge.evidence) {
    if (item.embedding !== null && item.embedding.length !== queryEmbedding.length) {
      throw new Error(
        `embedding_dimension_mismatch:${queryEmbedding.length}:${item.embedding.length}`,
      );
    }
  }

  const seen = new Set<string>();
  const evidence = knowledge.evidence
    .filter((item) => {
      const key = `${item.kind}\u0000${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter(
      (item): item is ConversationEvidence & { embedding: Float32Array } =>
        item.embedding !== null,
    )
    .map<SelectedEvidence>((item) => ({
      ...item,
      content: item.content.slice(0, MAX_EVIDENCE_CONTENT_CHARS),
      score: cosineSim(queryEmbedding, item.embedding),
    }))
    .filter((item) => item.score >= safeMinScore)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, safeTopK);

  return {
    mode: evidence.length > 0 ? "grounded" : "companionship",
    evidence,
    styles: selectStyles(knowledge.styles),
  };
}
