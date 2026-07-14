import assert from "node:assert/strict";
import test from "node:test";

import { reviewPersonaKnowledge } from "../src/lib/personaKnowledgeService";
import type {
  AppRepository,
  PersonaFact,
  PersonaKnowledgeItem,
  PersonaKnowledgeKind,
  PersonaKnowledgeStatus,
  SpeechStyleItem,
} from "../src/lib/storage/types";

type StatusChange = {
  kind: PersonaKnowledgeKind;
  id: string;
  personaId: string;
  expectedStatus: PersonaKnowledgeStatus;
  nextStatus: PersonaKnowledgeStatus;
  actorUserId: string;
  conflictGroupId: string | null;
};

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

function createFakeRepository(initialItems: PersonaKnowledgeItem[], options?: { failCas?: boolean }) {
  const items = new Map(initialItems.map((item) => [`${item.kind}:${item.id}`, structuredClone(item)]));
  const statusBatches: StatusChange[][] = [];

  const repository = {
    async getPersonaKnowledgeItem(kind: PersonaKnowledgeKind, id: string, personaId: string) {
      const item = items.get(`${kind}:${id}`);
      return item?.personaId === personaId ? structuredClone(item) : null;
    },
    async findConfirmedFacts(personaId: string, factType: string, factKey: string) {
      return [...items.values()]
        .filter((item): item is PersonaFact => item.kind === "fact")
        .filter((item) => item.personaId === personaId
          && item.factType === factType
          && item.factKey === factKey
          && item.status === "confirmed")
        .map((item) => structuredClone(item));
    },
    async updatePersonaKnowledgeCandidate(input: {
      kind: PersonaKnowledgeKind;
      id: string;
      personaId: string;
      expectedStatus: "pending" | "conflicted";
      patch: Record<string, string | string[] | null>;
    }) {
      const key = `${input.kind}:${input.id}`;
      const current = items.get(key);
      if (!current || current.personaId !== input.personaId || current.status !== input.expectedStatus) {
        return null;
      }
      const updated = { ...current, ...input.patch } as PersonaKnowledgeItem;
      items.set(key, updated);
      return structuredClone(updated);
    },
    async setPersonaKnowledgeStatuses(inputs: StatusChange[]) {
      statusBatches.push(structuredClone(inputs));
      if (options?.failCas) {
        throw new Error("knowledge_status_changed");
      }
      for (const input of inputs) {
        const current = items.get(`${input.kind}:${input.id}`);
        if (!current || current.personaId !== input.personaId || current.status !== input.expectedStatus) {
          throw new Error("knowledge_status_changed");
        }
      }
      return inputs.map((input) => {
        const key = `${input.kind}:${input.id}`;
        const current = items.get(key)!;
        const updated = {
          ...current,
          status: input.nextStatus,
          conflictGroupId: input.conflictGroupId,
          confirmedBy: input.nextStatus === "confirmed" ? input.actorUserId : current.confirmedBy,
        } as PersonaKnowledgeItem;
        items.set(key, updated);
        return structuredClone(updated);
      });
    },
  } as unknown as AppRepository;

  return { repository, items, statusBatches };
}

test("confirms a pending speech-style item", async () => {
  const fake = createFakeRepository([style({ id: "style-1", status: "pending" })]);

  const result = await reviewPersonaKnowledge({
    repository: fake.repository,
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "speech_style",
    id: "style-1",
    action: "confirm",
  });

  assert.equal(result.item.status, "confirmed");
  assert.deepEqual(result.conflicts, []);
  assert.equal(fake.statusBatches.length, 1);
});

test("marks a conflicting fact candidate and old confirmed facts conflicted atomically", async () => {
  const candidate = fact({ id: "fact-new", status: "pending", content: "喜欢咖啡", normalizedValue: "咖啡" });
  const old = fact({ id: "fact-old", status: "confirmed", content: "喜欢茶", normalizedValue: "茶" });
  const fake = createFakeRepository([candidate, old]);

  const result = await reviewPersonaKnowledge({
    repository: fake.repository,
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "fact",
    id: "fact-new",
    action: "confirm",
  });

  assert.equal(fake.statusBatches.length, 1);
  assert.equal(fake.statusBatches[0].length, 2);
  assert.equal(result.item.id, "fact-new");
  assert.equal(result.item.status, "conflicted");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].id, "fact-old");
  assert.equal(result.conflicts[0].status, "conflicted");
  assert.ok(result.item.conflictGroupId);
  assert.equal(result.conflicts[0].conflictGroupId, result.item.conflictGroupId);
});

test("edits a fact to the same value before confirming without disturbing the old fact", async () => {
  const candidate = fact({ id: "fact-new", status: "pending", content: "喜欢咖啡", normalizedValue: "咖啡" });
  const old = fact({ id: "fact-old", status: "confirmed", content: "喜欢茶", normalizedValue: "茶" });
  const fake = createFakeRepository([candidate, old]);

  const result = await reviewPersonaKnowledge({
    repository: fake.repository,
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "fact",
    id: "fact-new",
    action: "confirm",
    edits: { content: "喜欢茶", normalizedValue: "  茶 " },
  });

  assert.equal(result.item.status, "confirmed");
  assert.deepEqual(result.conflicts, []);
  assert.equal(fake.items.get("fact:fact-old")?.status, "confirmed");
  assert.equal(fake.statusBatches[0].length, 1);
});

test("returns knowledge_not_found when the persona does not own the item", async () => {
  const fake = createFakeRepository([style({ id: "style-1", status: "pending" })]);

  await assert.rejects(
    reviewPersonaKnowledge({
      repository: fake.repository,
      personaId: "persona-wrong",
      actorUserId: "user-1",
      kind: "speech_style",
      id: "style-1",
      action: "confirm",
    }),
    /knowledge_not_found/,
  );
});

test("rejects pending items and revokes confirmed items through valid transitions", async () => {
  const rejectedFake = createFakeRepository([style({ id: "style-reject", status: "pending" })]);
  const rejected = await reviewPersonaKnowledge({
    repository: rejectedFake.repository,
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "speech_style",
    id: "style-reject",
    action: "reject",
  });
  assert.equal(rejected.item.status, "rejected");
  assert.deepEqual(rejected.conflicts, []);

  const revokedFake = createFakeRepository([style({ id: "style-revoke", status: "confirmed" })]);
  const revoked = await reviewPersonaKnowledge({
    repository: revokedFake.repository,
    personaId: "persona-1",
    actorUserId: "user-1",
    kind: "speech_style",
    id: "style-revoke",
    action: "revoke",
  });
  assert.equal(revoked.item.status, "revoked");
  assert.deepEqual(revoked.conflicts, []);
});

test("terminal rejected and revoked items cannot be confirmed or revived with edits", async () => {
  for (const status of ["rejected", "revoked"] as const) {
    const fake = createFakeRepository([style({ id: `style-${status}`, status })]);
    await assert.rejects(
      reviewPersonaKnowledge({
        repository: fake.repository,
        personaId: "persona-1",
        actorUserId: "user-1",
        kind: "speech_style",
        id: `style-${status}`,
        action: "confirm",
      }),
      new RegExp(`invalid_transition:${status}:confirmed`),
    );
    await assert.rejects(
      reviewPersonaKnowledge({
        repository: fake.repository,
        personaId: "persona-1",
        actorUserId: "user-1",
        kind: "speech_style",
        id: `style-${status}`,
        action: "confirm",
        edits: {},
      }),
      new RegExp(`invalid_transition:${status}:confirmed`),
    );
  }
});

test("propagates an atomic CAS failure without returning a partial result", async () => {
  const fake = createFakeRepository([
    fact({ id: "fact-new", status: "pending", normalizedValue: "咖啡" }),
    fact({ id: "fact-old", status: "confirmed", normalizedValue: "茶" }),
  ], { failCas: true });

  await assert.rejects(
    reviewPersonaKnowledge({
      repository: fake.repository,
      personaId: "persona-1",
      actorUserId: "user-1",
      kind: "fact",
      id: "fact-new",
      action: "confirm",
    }),
    /knowledge_status_changed/,
  );
  assert.equal(fake.statusBatches.length, 1);
  assert.equal(fake.items.get("fact:fact-new")?.status, "pending");
  assert.equal(fake.items.get("fact:fact-old")?.status, "confirmed");
});

test("does not flag facts with a different key or the same normalized value", async () => {
  const cases: Array<{ candidate: PersonaFact; old: PersonaFact }> = [
    {
      candidate: fact({ id: "new-key", status: "pending", factKey: "favorite food", normalizedValue: "咖啡" }),
      old: fact({ id: "old-key", status: "confirmed", normalizedValue: "茶" }),
    },
    {
      candidate: fact({ id: "new-same", status: "pending", normalizedValue: " 茶 " }),
      old: fact({ id: "old-same", status: "confirmed", normalizedValue: "茶" }),
    },
  ];

  for (const { candidate, old } of cases) {
    const fake = createFakeRepository([candidate, old]);
    const result = await reviewPersonaKnowledge({
      repository: fake.repository,
      personaId: "persona-1",
      actorUserId: "user-1",
      kind: "fact",
      id: candidate.id,
      action: "confirm",
    });
    assert.equal(result.item.status, "confirmed");
    assert.deepEqual(result.conflicts, []);
    assert.equal(fake.items.get(`fact:${old.id}`)?.status, "confirmed");
  }
});

test("turns an edit CAS miss into knowledge_status_changed", async () => {
  const item = style({ id: "style-1", status: "pending" });
  const repository = {
    async getPersonaKnowledgeItem() { return item; },
    async updatePersonaKnowledgeCandidate() { return null; },
  } as unknown as AppRepository;

  await assert.rejects(
    reviewPersonaKnowledge({
      repository,
      personaId: "persona-1",
      actorUserId: "user-1",
      kind: "speech_style",
      id: "style-1",
      action: "confirm",
      edits: { content: "别急" },
    }),
    /knowledge_status_changed/,
  );
});
