import { factsConflict, requireKnowledgeTransition } from "./personaKnowledge";
import { embedOne } from "./embedding";
import type {
  AppRepository,
  PersonaFact,
  PersonaKnowledgeItem,
  PersonaKnowledgeReviewInput,
  PersonaKnowledgeReviewResult,
  PersonaKnowledgeStatus,
  PersonaKnowledgeStatusChange,
} from "./storage/types";

export type PersonaKnowledgeReviewPlan = {
  statusChanges: PersonaKnowledgeStatusChange[];
  conflictIds: string[];
};

function statusForAction(
  action: PersonaKnowledgeReviewInput["action"],
): PersonaKnowledgeStatus {
  if (action === "confirm") return "confirmed";
  if (action === "reject") return "rejected";
  return "revoked";
}

function statusChange(
  item: PersonaKnowledgeItem,
  nextStatus: PersonaKnowledgeStatus,
  actorUserId: string,
  conflictGroupId: string | null = null,
): PersonaKnowledgeStatusChange {
  requireKnowledgeTransition(item.status, nextStatus);
  return {
    kind: item.kind,
    id: item.id,
    personaId: item.personaId,
    expectedStatus: item.status,
    nextStatus,
    actorUserId,
    conflictGroupId,
  };
}

export function requirePersonaKnowledgeEditsAllowed(
  item: PersonaKnowledgeItem,
  action: PersonaKnowledgeReviewInput["action"],
): void {
  if (item.status === "pending" || item.status === "conflicted") return;
  requireKnowledgeTransition(item.status, statusForAction(action));
  throw new Error(`invalid_transition:${item.status}:pending`);
}

export function planPersonaKnowledgeReview(input: {
  item: PersonaKnowledgeItem;
  confirmedFacts: PersonaFact[];
  actorUserId: string;
  action: PersonaKnowledgeReviewInput["action"];
  conflictGroupId: string;
}): PersonaKnowledgeReviewPlan {
  const nextStatus = statusForAction(input.action);
  if (input.action !== "confirm" || input.item.kind !== "fact") {
    return {
      statusChanges: [statusChange(input.item, nextStatus, input.actorUserId)],
      conflictIds: [],
    };
  }

  requireKnowledgeTransition(input.item.status, "confirmed");
  const factItem = input.item;
  const hasConflict = input.confirmedFacts.some((fact) => factsConflict(factItem, fact));
  if (!hasConflict) {
    return {
      statusChanges: [statusChange(input.item, "confirmed", input.actorUserId)],
      conflictIds: [],
    };
  }

  return {
    statusChanges: [
      ...input.confirmedFacts.map((fact) => statusChange(
        fact,
        "conflicted",
        input.actorUserId,
        input.conflictGroupId,
      )),
      statusChange(input.item, "conflicted", input.actorUserId, input.conflictGroupId),
    ],
    conflictIds: input.confirmedFacts.map((fact) => fact.id),
  };
}

function itemKey(item: Pick<PersonaKnowledgeItem, "kind" | "id" | "personaId">): string {
  return `${item.personaId}\u0000${item.kind}\u0000${item.id}`;
}

export function buildPersonaKnowledgeReviewResult(
  reviewedItem: PersonaKnowledgeItem,
  plan: PersonaKnowledgeReviewPlan,
  changedItems: PersonaKnowledgeItem[],
): PersonaKnowledgeReviewResult {
  if (changedItems.length !== plan.statusChanges.length) {
    throw new Error("invalid_knowledge_review_result");
  }

  const expected = new Map<string, PersonaKnowledgeStatusChange>();
  for (const change of plan.statusChanges) {
    const key = itemKey(change);
    if (expected.has(key)) throw new Error("invalid_knowledge_review_result");
    expected.set(key, change);
  }
  const actual = new Map<string, PersonaKnowledgeItem>();
  for (const item of changedItems) {
    const key = itemKey(item);
    const change = expected.get(key);
    if (
      !change
      || actual.has(key)
      || item.status !== change.nextStatus
      || item.conflictGroupId !== change.conflictGroupId
    ) {
      throw new Error("invalid_knowledge_review_result");
    }
    actual.set(key, item);
  }
  if (actual.size !== expected.size) throw new Error("invalid_knowledge_review_result");

  const item = actual.get(itemKey(reviewedItem));
  if (!item) throw new Error("invalid_knowledge_review_result");
  const conflicts = plan.conflictIds.map((id) => actual.get(itemKey({
    kind: "fact",
    id,
    personaId: reviewedItem.personaId,
  }))).filter((candidate): candidate is PersonaFact => candidate?.kind === "fact");
  if (conflicts.length !== plan.conflictIds.length) {
    throw new Error("invalid_knowledge_review_result");
  }
  return { item, conflicts };
}

export async function reviewPersonaKnowledge(
  input: PersonaKnowledgeReviewInput & {
    repository: AppRepository;
    embedText?: (text: string) => Promise<Float32Array>;
  },
): Promise<PersonaKnowledgeReviewResult> {
  const { repository, embedText = embedOne, ...review } = input;
  const item = await repository.getPersonaKnowledgeItem(
    review.kind,
    review.id,
    review.personaId,
  );
  if (!item) throw new Error("knowledge_not_found");

  if (
    review.action === "confirm"
    && (review.kind === "fact" || review.kind === "relationship_memory")
  ) {
    const finalContent = review.edits?.content ?? item.content;
    if (typeof finalContent !== "string") throw new Error("invalid_knowledge_content");
    const vector = await embedText(finalContent);
    return repository.reviewPersonaKnowledgeAtomically({
      ...review,
      embedding: { content: finalContent, vector },
    });
  }

  return repository.reviewPersonaKnowledgeAtomically(review);
}
