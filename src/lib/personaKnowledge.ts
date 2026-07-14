import type { PersonaKnowledgeStatus } from "./storage/types";

const ALLOWED: Record<PersonaKnowledgeStatus, PersonaKnowledgeStatus[]> = {
  pending: ["confirmed", "rejected", "conflicted", "revoked"],
  confirmed: ["conflicted", "revoked"],
  conflicted: ["confirmed", "rejected", "revoked"],
  rejected: [],
  revoked: [],
};

export function canUsePersonaKnowledge(status: PersonaKnowledgeStatus): boolean {
  return status === "confirmed";
}

export function requireKnowledgeTransition(
  current: PersonaKnowledgeStatus,
  next: PersonaKnowledgeStatus,
): void {
  if (!ALLOWED[current].includes(next)) {
    throw new Error(`invalid_transition:${current}:${next}`);
  }
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

export function factsConflict(
  left: { factType: string; factKey: string; normalizedValue: string },
  right: { factType: string; factKey: string; normalizedValue: string },
): boolean {
  return normalize(left.factType) === normalize(right.factType)
    && normalize(left.factKey) === normalize(right.factKey)
    && normalize(left.normalizedValue) !== normalize(right.normalizedValue);
}
