import { it } from "node:test";
import assert from "node:assert/strict";
import {
  canUsePersonaKnowledge,
  factsConflict,
  requireKnowledgeTransition,
} from "../src/lib/personaKnowledge";

it("only confirmed knowledge is usable by dialogue", () => {
  for (const status of ["pending", "rejected", "conflicted", "revoked"] as const) {
    assert.equal(canUsePersonaKnowledge(status), false);
  }
  assert.equal(canUsePersonaKnowledge("confirmed"), true);
});

it("enforces the exact transition matrix for all status pairs", () => {
  const statuses = ["pending", "confirmed", "rejected", "conflicted", "revoked"] as const;
  type Status = (typeof statuses)[number];
  const allowed: Record<Status, readonly Status[]> = {
    pending: ["confirmed", "rejected", "conflicted", "revoked"],
    confirmed: ["conflicted", "revoked"],
    conflicted: ["confirmed", "rejected", "revoked"],
    rejected: [],
    revoked: [],
  };

  for (const current of statuses) {
    for (const next of statuses) {
      const transition = () => requireKnowledgeTransition(current, next);
      if (allowed[current].includes(next)) {
        assert.doesNotThrow(transition, `${current} -> ${next} should be allowed`);
      } else {
        assert.throws(
          transition,
          (error: unknown) =>
            error instanceof Error
            && error.message === `invalid_transition:${current}:${next}`,
          `${current} -> ${next} should be rejected`,
        );
      }
    }
  }
});

it("detects incompatible normalized values only for the same fact key", () => {
  const base = { factType: "preference", factKey: "drink", normalizedValue: "桂花茶" };
  assert.equal(factsConflict(base, { ...base, normalizedValue: "咖啡" }), true);
  assert.equal(factsConflict(base, { ...base, normalizedValue: " 桂花茶 " }), false);
  assert.equal(
    factsConflict(base, { ...base, factKey: "dessert", normalizedValue: "桂花糕" }),
    false,
  );
});
