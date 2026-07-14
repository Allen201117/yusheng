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

it("allows review transitions but keeps terminal states terminal", () => {
  assert.doesNotThrow(() => requireKnowledgeTransition("pending", "confirmed"));
  assert.doesNotThrow(() => requireKnowledgeTransition("pending", "rejected"));
  assert.doesNotThrow(() => requireKnowledgeTransition("confirmed", "conflicted"));
  assert.doesNotThrow(() => requireKnowledgeTransition("confirmed", "revoked"));
  assert.doesNotThrow(() => requireKnowledgeTransition("conflicted", "confirmed"));
  assert.throws(() => requireKnowledgeTransition("rejected", "confirmed"), /invalid_transition/);
  assert.throws(() => requireKnowledgeTransition("revoked", "confirmed"), /invalid_transition/);
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
