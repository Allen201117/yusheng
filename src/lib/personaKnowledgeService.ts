import { randomUUID } from "node:crypto";

import { factsConflict, requireKnowledgeTransition } from "./personaKnowledge";
import type {
  AppRepository,
  PersonaFact,
  PersonaKnowledgeItem,
  PersonaKnowledgeKind,
  PersonaKnowledgeStatus,
} from "./storage/types";

type ReviewAction = "confirm" | "reject" | "revoke";

type StatusChange = Parameters<AppRepository["setPersonaKnowledgeStatuses"]>[0][number];

function statusForAction(action: ReviewAction): PersonaKnowledgeStatus {
  if (action === "confirm") return "confirmed";
  if (action === "reject") return "rejected";
  return "revoked";
}

function statusChange(
  item: PersonaKnowledgeItem,
  nextStatus: PersonaKnowledgeStatus,
  actorUserId: string,
  conflictGroupId: string | null = null,
): StatusChange {
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

export async function reviewPersonaKnowledge(input: {
  repository: AppRepository;
  personaId: string;
  actorUserId: string;
  kind: PersonaKnowledgeKind;
  id: string;
  action: ReviewAction;
  edits?: Record<string, string | string[] | null>;
}): Promise<{ item: PersonaKnowledgeItem; conflicts: PersonaFact[] }> {
  let item = await input.repository.getPersonaKnowledgeItem(
    input.kind,
    input.id,
    input.personaId,
  );
  if (!item) {
    throw new Error("knowledge_not_found");
  }

  if (input.edits !== undefined) {
    if (item.status !== "pending" && item.status !== "conflicted") {
      requireKnowledgeTransition(item.status, statusForAction(input.action));
      throw new Error(`invalid_transition:${item.status}:pending`);
    }
    const updated = await input.repository.updatePersonaKnowledgeCandidate({
      kind: item.kind,
      id: item.id,
      personaId: item.personaId,
      expectedStatus: item.status,
      patch: input.edits,
    });
    if (!updated) {
      throw new Error("knowledge_status_changed");
    }
    item = updated;
  }

  const nextStatus = statusForAction(input.action);
  if (input.action !== "confirm" || item.kind !== "fact") {
    const changed = await input.repository.setPersonaKnowledgeStatuses([
      statusChange(item, nextStatus, input.actorUserId),
    ]);
    return { item: changed[0], conflicts: [] };
  }

  requireKnowledgeTransition(item.status, "confirmed");
  const confirmedFacts = await input.repository.findConfirmedFacts(
    item.personaId,
    item.factType,
    item.factKey,
  );
  const conflicts = confirmedFacts.filter((fact) => factsConflict(item, fact));

  if (conflicts.length === 0) {
    const changed = await input.repository.setPersonaKnowledgeStatuses([
      statusChange(item, "confirmed", input.actorUserId),
    ]);
    return { item: changed[0], conflicts: [] };
  }

  const conflictGroupId = randomUUID();
  const batch = [
    ...conflicts.map((fact) => statusChange(
      fact,
      "conflicted",
      input.actorUserId,
      conflictGroupId,
    )),
    statusChange(item, "conflicted", input.actorUserId, conflictGroupId),
  ];
  const changed = await input.repository.setPersonaKnowledgeStatuses(batch);
  const changedItem = changed.find((candidate) => (
    candidate.kind === item.kind && candidate.id === item.id
  ))!;
  const changedConflicts = changed.filter((candidate): candidate is PersonaFact => (
    candidate.kind === "fact" && candidate.id !== item.id
  ));

  return { item: changedItem, conflicts: changedConflicts };
}
