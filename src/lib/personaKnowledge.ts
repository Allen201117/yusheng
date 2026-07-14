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

export function normalizePersonaKnowledgeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

export function factsConflict(
  left: { factType: string; factKey: string; normalizedValue: string },
  right: { factType: string; factKey: string; normalizedValue: string },
): boolean {
  return normalizePersonaKnowledgeText(left.factType) === normalizePersonaKnowledgeText(right.factType)
    && normalizePersonaKnowledgeText(left.factKey) === normalizePersonaKnowledgeText(right.factKey)
    && normalizePersonaKnowledgeText(left.normalizedValue)
      !== normalizePersonaKnowledgeText(right.normalizedValue);
}
