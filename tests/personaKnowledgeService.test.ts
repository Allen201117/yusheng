import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPersonaKnowledgeReviewResult,
  planPersonaKnowledgeReview,
  reviewPersonaKnowledge,
} from "../src/lib/personaKnowledgeService";
import type {
  AppRepository,
  PersonaFact,
  PersonaKnowledgeItem,
  SpeechStyleItem,
} from "../src/lib/storage/types";

function fact(input: Partial<PersonaFact> & Pick<PersonaFact, "id" | "status">): PersonaFact {
  return {
    kind: "fact",
    personaId: "persona-1",
    factType: "preference",
    factKey: "favorite drink",
    content: "喜欢茶",
    normalizedValue: "茶",
    conflictGroupId: null,
    confirmedBy: null,
    confirmedAt: null,
    revokedAt: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...input,
  };
}

function style(input: Partial<SpeechStyleItem> & Pick<SpeechStyleItem, "id" | "status">): SpeechStyleItem {
  return {
    kind: "speech_style",
    personaId: "persona-1",
    category: "catchphrase",
    content: "慢慢来",
    example: null,
    conflictGroupId: null,
    confirmedBy: null,
    confirmedAt: null,
    revokedAt: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...input,
  };
}

function applyPlan(
  items: PersonaKnowledgeItem[],
  plan: ReturnType<typeof planPersonaKnowledgeReview>,
): PersonaKnowledgeItem[] {
  return plan.statusChanges.map((change) => {
    const current = items.find((item) => item.kind === change.kind && item.id === change.id)!;
    return {
      ...current,
      status: change.nextStatus,
      conflictGroupId: change.conflictGroupId,
    } as PersonaKnowledgeItem;
  });
}

test("a conflicting review groups the candidate and every same-key confirmed fact", () => {
  const candidate = fact({ id: "fact-new", status: "pending", normalizedValue: "茶" });
  const oldTea = fact({ id: "fact-tea", status: "confirmed", normalizedValue: "茶" });
  const oldCoffee = fact({ id: "fact-coffee", status: "confirmed", normalizedValue: "咖啡" });

  const plan = planPersonaKnowledgeReview({
    item: candidate,
    confirmedFacts: [oldTea, oldCoffee],
    actorUserId: "user-1",
    action: "confirm",
    conflictGroupId: "conflict-1",
  });

  assert.deepEqual(plan.statusChanges.map((change) => change.id), [
    "fact-tea",
    "fact-coffee",
    "fact-new",
  ]);
  assert.ok(plan.statusChanges.every((change) => change.nextStatus === "conflicted"));
  assert.ok(plan.statusChanges.every((change) => change.conflictGroupId === "conflict-1"));
  assert.deepEqual(plan.conflictIds, ["fact-tea", "fact-coffee"]);
});

test("all same-value facts stay confirmed and only the candidate is confirmed", () => {
  const candidate = fact({ id: "fact-new", status: "pending", normalizedValue: "  茶 " });
  const oldTea = fact({ id: "fact-tea", status: "confirmed", normalizedValue: "茶" });

  const plan = planPersonaKnowledgeReview({
    item: candidate,
    confirmedFacts: [oldTea],
    actorUserId: "user-1",
    action: "confirm",
    conflictGroupId: "unused",
  });

  assert.deepEqual(plan.statusChanges, [{
    kind: "fact",
    id: "fact-new",
    personaId: "persona-1",
    expectedStatus: "pending",
    nextStatus: "confirmed",
    actorUserId: "user-1",
    conflictGroupId: null,
  }]);
  assert.deepEqual(plan.conflictIds, []);
});

test("plans valid reject and revoke transitions and rejects terminal revival", () => {
  const rejectedPlan = planPersonaKnowledgeReview({
    item: style({ id: "style-pending", status: "pending" }),
    confirmedFacts: [],
    actorUserId: "user-1",
    action: "reject",
    conflictGroupId: "unused",
  });
  assert.equal(rejectedPlan.statusChanges[0].nextStatus, "rejected");

  const revokedPlan = planPersonaKnowledgeReview({
    item: style({ id: "style-confirmed", status: "confirmed" }),
    confirmedFacts: [],
    actorUserId: "user-1",
    action: "revoke",
    conflictGroupId: "unused",
  });
  assert.equal(revokedPlan.statusChanges[0].nextStatus, "revoked");

  assert.throws(() => planPersonaKnowledgeReview({
    item: style({ id: "style-rejected", status: "rejected" }),
    confirmedFacts: [],
    actorUserId: "user-1",
    action: "confirm",
    conflictGroupId: "unused",
  }), /invalid_transition:rejected:confirmed/);
});

test("strictly maps a complete repository status result", () => {
  const candidate = fact({ id: "fact-new", status: "pending", normalizedValue: "咖啡" });
  const old = fact({ id: "fact-old", status: "confirmed", normalizedValue: "茶" });
  const plan = planPersonaKnowledgeReview({
    item: candidate,
    confirmedFacts: [old],
    actorUserId: "user-1",
    action: "confirm",
    conflictGroupId: "conflict-1",
  });
  const changed = applyPlan([candidate, old], plan);

  const result = buildPersonaKnowledgeReviewResult(candidate, plan, changed);
  assert.equal(result.item.id, "fact-new");
  assert.deepEqual(result.conflicts.map((item) => item.id), ["fact-old"]);

  assert.throws(
    () => buildPersonaKnowledgeReviewResult(candidate, plan, changed.slice(0, 1)),
    /invalid_knowledge_review_result/,
  );
  assert.throws(
    () => buildPersonaKnowledgeReviewResult(candidate, plan, [
      ...changed,
      fact({ id: "fact-extra", status: "conflicted", conflictGroupId: "conflict-1" }),
    ]),
    /invalid_knowledge_review_result/,
  );
});

test("service delegates the whole review to one atomic repository call", async () => {
  const expected = { item: style({ id: "style-1", status: "confirmed" }), conflicts: [] };
  const calls: unknown[] = [];
  const repository = new Proxy({
    async reviewPersonaKnowledgeAtomically(input: unknown) {
      calls.push(input);
      return expected;
    },
  }, {
    get(target, property, receiver) {
      if (!(property in target)) throw new Error(`unexpected_repository_call:${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as AppRepository;

  const result = await reviewPersonaKnowledge({
    repository,
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "speech_style",
    id: "style-1",
    action: "confirm",
    edits: {},
  });

  assert.equal(result, expected);
  assert.deepEqual(calls, [{
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "speech_style",
    id: "style-1",
    action: "confirm",
    edits: {},
  }]);
});
