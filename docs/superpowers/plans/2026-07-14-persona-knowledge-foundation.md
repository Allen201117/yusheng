# Persona Knowledge Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-form memory persistence with owner-scoped, source-backed persona facts, relationship memories and speech-style items whose confirmation state controls whether dialogue retrieval may use them.

**Architecture:** Add an additive Postgres migration and matching SQLite schema for sources and the three knowledge layers, preserving the old `memories` table only as a migration source. Extend the repository with one union-shaped knowledge contract, put status transitions and deterministic fact-conflict handling in a focused service, expose an authenticated route for listing and reviewing candidates, and keep `/api/memory` working by writing explicit manual entries as confirmed relationship memories.

**Tech Stack:** Next.js 15 route handlers, TypeScript, Node test runner, better-sqlite3, Neon Postgres with pgvector, existing async `AppRepository` boundary.

---

## Scope boundary

This plan is the first independently testable sub-project from `docs/superpowers/specs/2026-07-14-core-conversation-design.md`.

It includes:

- `persona_sources`, `persona_facts`, `relationship_memories`, `speech_style_items` and `persona_item_sources`;
- `pending`, `confirmed`, `rejected`, `conflicted` and `revoked` lifecycle rules;
- owner-scoped candidate creation, listing, confirmation, rejection and revocation;
- deterministic conflict handling for incompatible facts with the same `factType` and `factKey`;
- old `memories` data migration and `/api/memory` compatibility;
- confirmed-only relationship-memory retrieval for the existing chat route.

It deliberately excludes:

- AI extraction from uploaded material;
- `grounded` / `companionship` / `boundary` response modes and `message_evidence`;
- conversation sessions, feedback and the effective-restoration metric;
- functional review screens and visual work;
- Preview migration, which remains blocked until Neon is connected.

Those are separate plans after this foundation passes.

## File map

**Create**

- `migrations/004_persona_knowledge.sql` — durable Postgres schema and idempotent legacy-memory copy.
- `src/lib/personaKnowledge.ts` — pure lifecycle validation and conflict comparison.
- `src/lib/personaKnowledgeService.ts` — candidate creation and state-change orchestration.
- `src/app/api/persona-knowledge/route.ts` — authenticated knowledge API.
- `tests/personaKnowledge.test.ts` — pure policy tests.
- `tests/personaKnowledgeDb.test.ts` — real temporary SQLite integration tests.
- `tests/personaKnowledgeService.test.ts` — orchestration tests with an in-memory repository fake.
- `tests/personaKnowledgeRoute.test.ts` — request validation and owner-boundary source checks.

**Modify**

- `src/lib/storage/types.ts` — knowledge types and repository methods.
- `src/lib/db.ts` — SQLite schema, idempotent old-memory copy and local methods.
- `src/lib/storage/repository.ts` — local adapter mappings.
- `src/lib/storage/postgresRepository.ts` — Postgres mappings and methods.
- `src/app/api/memory/route.ts` — explicit manual entries become confirmed relationship memories.
- `scripts/migrate-local-data.ts` — cloud import targets `relationship_memories` with a legacy source.
- `tests/postgresRepository.test.ts` — migration and Postgres method evidence.
- `tests/localMigration.test.ts` — migrated target-table assertions.
- `tests/storageRouteBoundary.test.ts` — new route must use repository and authentication boundaries.
- `CLAUDE.md` and `docs/handoff.md` — current schema and rollout constraints.

---

### Task 1: Lock the knowledge lifecycle in pure types and policy

**Files:**

- Create: `src/lib/personaKnowledge.ts`
- Modify: `src/lib/storage/types.ts`
- Test: `tests/personaKnowledge.test.ts`

- [ ] **Step 1: Write the failing lifecycle tests**

Create `tests/personaKnowledge.test.ts`:

```ts
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
  assert.equal(factsConflict(base, { ...base, factKey: "dessert", normalizedValue: "桂花糕" }), false);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
node --import tsx --test tests/personaKnowledge.test.ts
```

Expected: FAIL with `Cannot find module '../src/lib/personaKnowledge'`.

- [ ] **Step 3: Add the exact domain types**

Add to `src/lib/storage/types.ts`:

```ts
export type PersonaKnowledgeStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "conflicted"
  | "revoked";

export type PersonaKnowledgeKind =
  | "fact"
  | "relationship_memory"
  | "speech_style";

export type PersonaSourceType =
  | "manual_text"
  | "chat_export"
  | "audio_transcript"
  | "text_document"
  | "legacy_import";

export type PersonaSource = {
  id: string;
  personaId: string;
  sourceType: PersonaSourceType;
  contentText: string | null;
  objectPath: string | null;
  checksumAlgorithm: "sha256" | "legacy_id";
  checksum: string;
  status: "ready" | "failed" | "revoked";
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
};

export type PersonaFact = {
  kind: "fact";
  id: string;
  personaId: string;
  factType: string;
  factKey: string;
  content: string;
  normalizedValue: string;
  status: PersonaKnowledgeStatus;
  conflictGroupId: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RelationshipMemory = {
  kind: "relationship_memory";
  id: string;
  personaId: string;
  content: string;
  occurredAt: string | null;
  location: string | null;
  participants: string[];
  status: PersonaKnowledgeStatus;
  conflictGroupId: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SpeechStyleItem = {
  kind: "speech_style";
  id: string;
  personaId: string;
  category: string;
  content: string;
  example: string | null;
  status: PersonaKnowledgeStatus;
  conflictGroupId: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PersonaKnowledgeItem = PersonaFact | RelationshipMemory | SpeechStyleItem;

export type PersonaKnowledgeBundle = {
  sources: PersonaSource[];
  facts: PersonaFact[];
  memories: RelationshipMemory[];
  styles: SpeechStyleItem[];
};
```

Inputs added in the same file must be explicit rather than `Partial`:

```ts
export type CreatePersonaSourceInput = Omit<PersonaSource, "createdAt" | "revokedAt">;

export type CreatePersonaKnowledgeCandidateInput =
  | { kind: "fact"; id: string; personaId: string; factType: string; factKey: string; content: string; normalizedValue: string; sourceId: string; sourceExcerpt: string }
  | { kind: "relationship_memory"; id: string; personaId: string; content: string; occurredAt: string | null; location: string | null; participants: string[]; embedding: Float32Array | null; sourceId: string; sourceExcerpt: string }
  | { kind: "speech_style"; id: string; personaId: string; category: string; content: string; example: string | null; sourceId: string; sourceExcerpt: string };
```

- [ ] **Step 4: Implement the pure policy**

Create `src/lib/personaKnowledge.ts`:

```ts
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
```

- [ ] **Step 5: Run targeted tests and typecheck**

Run:

```bash
node --import tsx --test tests/personaKnowledge.test.ts
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/personaKnowledge.ts src/lib/storage/types.ts tests/personaKnowledge.test.ts
git commit -m "feat: define persona knowledge lifecycle"
```

---

### Task 2: Add durable Postgres and SQLite schemas with idempotent legacy copy

**Files:**

- Create: `migrations/004_persona_knowledge.sql`
- Modify: `src/lib/db.ts`
- Modify: `tests/postgresRepository.test.ts`
- Create: `tests/personaKnowledgeDb.test.ts`

- [ ] **Step 1: Write failing migration and SQLite tests**

Add to `tests/postgresRepository.test.ts`:

```ts
it("adds source-backed three-layer persona knowledge and copies legacy memories", async () => {
  const sql = await readFile(
    new URL("../migrations/004_persona_knowledge.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "persona_sources",
    "persona_facts",
    "relationship_memories",
    "speech_style_items",
    "persona_item_sources",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /status IN \('pending', 'confirmed', 'rejected', 'conflicted', 'revoked'\)/);
  assert.match(sql, /INSERT INTO relationship_memories[\s\S]*SELECT[\s\S]*FROM memories/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(sql, /WHERE status = 'confirmed'/);
});
```

Create `tests/personaKnowledgeDb.test.ts` using a fresh temporary `DATA_DIR`, dynamically importing `src/lib/db.ts` after the environment is set. The test must create one persona and one old `memories` row with `getDb()`, call the exported `migrateLegacyPersonaKnowledge(db)` twice, and assert:

```ts
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM relationship_memories WHERE id = 'legacy-memory'").get().count, 1);
assert.equal(db.prepare("SELECT status FROM relationship_memories WHERE id = 'legacy-memory'").get().status, "confirmed");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM persona_item_sources WHERE item_id = 'legacy-memory'").get().count, 1);
```

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
node --import tsx --test tests/postgresRepository.test.ts tests/personaKnowledgeDb.test.ts
```

Expected: FAIL because migration `004` and SQLite tables do not exist.

- [ ] **Step 3: Create the Postgres migration**

Start `migrations/004_persona_knowledge.sql` with the complete schema below. `created_by` and `confirmed_by` remain audit strings instead of user foreign keys so local `__legacy__` and `__dev__` identities continue to work.

```sql
CREATE TABLE IF NOT EXISTS persona_sources (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('manual_text', 'chat_export', 'audio_transcript', 'text_document', 'legacy_import')),
  content_text text,
  object_path text,
  checksum_algorithm text NOT NULL CHECK (checksum_algorithm IN ('sha256', 'legacy_id')),
  checksum text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'failed', 'revoked')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS persona_facts (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  fact_type text NOT NULL,
  fact_key text NOT NULL,
  content text NOT NULL,
  normalized_value text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'conflicted', 'revoked')),
  conflict_group_id text,
  confirmed_by text,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relationship_memories (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  content text NOT NULL,
  occurred_at timestamptz,
  location text,
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  embedding vector(1024),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'conflicted', 'revoked')),
  conflict_group_id text,
  confirmed_by text,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS speech_style_items (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  category text NOT NULL,
  content text NOT NULL,
  example text,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'conflicted', 'revoked')),
  conflict_group_id text,
  confirmed_by text,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS persona_item_sources (
  item_kind text NOT NULL CHECK (item_kind IN ('fact', 'relationship_memory', 'speech_style')),
  item_id text NOT NULL,
  source_id text NOT NULL REFERENCES persona_sources(id) ON DELETE CASCADE,
  source_excerpt text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_kind, item_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_persona_sources_persona ON persona_sources (persona_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_persona_facts_confirmed ON persona_facts (persona_id, fact_type, fact_key) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_relationship_memories_confirmed ON relationship_memories (persona_id, created_at DESC) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_speech_style_confirmed ON speech_style_items (persona_id, category, created_at DESC) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_persona_item_sources_source ON persona_item_sources (source_id);
```

The legacy copy order must be:

```sql
INSERT INTO persona_sources
  (id, persona_id, source_type, checksum_algorithm, checksum, status, created_by, created_at)
SELECT
  'legacy-memory-source:' || p.id,
  p.id,
  'legacy_import',
  'legacy_id',
  'legacy-memory-source:' || p.id,
  'ready',
  p.user_id,
  p.created_at
FROM personas p
WHERE EXISTS (SELECT 1 FROM memories m WHERE m.persona_id = p.id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO relationship_memories
  (id, persona_id, content, embedding, status, confirmed_at, created_at, updated_at)
SELECT id, persona_id, content, embedding, 'confirmed', created_at, created_at, created_at
FROM memories
ON CONFLICT (id) DO NOTHING;

INSERT INTO persona_item_sources (item_kind, item_id, source_id, source_excerpt)
SELECT 'relationship_memory', m.id, 'legacy-memory-source:' || m.persona_id, m.content
FROM memories m
ON CONFLICT (item_kind, item_id, source_id) DO NOTHING;
```

Do not drop `memories`; it remains rollback and migration input only.

- [ ] **Step 4: Add matching SQLite schema and migration**

In `src/lib/db.ts`:

- create matching tables in `initSchema`, using `BLOB` for embeddings, `TEXT` JSON for participants and integer/ISO-text equivalents where needed;
- export `migrateLegacyPersonaKnowledge(db: Database.Database)`;
- call it after `migrateUserColumn(_db)` in `getDb()`;
- use one SQLite transaction with `INSERT OR IGNORE` for the same source, memory and source-link sequence;
- keep old `memories` untouched.

The call order becomes:

```ts
initSchema(_db);
migrateUserColumn(_db);
migrateLegacyPersonaKnowledge(_db);
```

- [ ] **Step 5: Run targeted tests twice**

Run:

```bash
node --import tsx --test tests/postgresRepository.test.ts tests/personaKnowledgeDb.test.ts
node --import tsx --test tests/personaKnowledgeDb.test.ts
```

Expected: PASS both times; the second command proves test isolation and idempotent local initialization.

- [ ] **Step 6: Commit**

```bash
git add migrations/004_persona_knowledge.sql src/lib/db.ts tests/postgresRepository.test.ts tests/personaKnowledgeDb.test.ts
git commit -m "feat: add persona knowledge storage schema"
```

---

### Task 3: Extend the repository contract and both adapters

**Files:**

- Modify: `src/lib/storage/types.ts`
- Modify: `src/lib/storage/postgresRepository.ts`
- Modify: `src/lib/storage/repository.ts`
- Modify: `src/lib/db.ts`
- Modify: `tests/postgresRepository.test.ts`
- Modify: `tests/personaKnowledgeDb.test.ts`

- [ ] **Step 1: Write failing repository parity tests**

Postgres fake-executor tests must prove:

```ts
const created = await repo.createPersonaKnowledgeCandidates({ source, candidates });
assert.equal(created.facts[0].status, "pending");
assert.ok(fake.calls.every(call => !/persona_(facts|sources)|relationship_memories|speech_style_items/.test(call.text) || call.params.includes("persona-1")));

const usable = await repo.loadMemoriesWithEmbeddings("persona-1");
assert.match(fake.calls.at(-1)!.text, /status = 'confirmed'/);

await repo.setPersonaKnowledgeStatuses([{
  kind: "fact",
  id: "fact-1",
  personaId: "persona-1",
  expectedStatus: "pending",
  nextStatus: "confirmed",
  actorUserId: "user-1",
  conflictGroupId: null,
}]);
assert.match(fake.calls.at(-1)!.text, /UPDATE persona_facts/);
assert.match(fake.calls.at(-1)!.text, /AND status =/);

const sourceResult = await repo.revokePersonaSource("source-1", "persona-1", "user-1");
assert.equal(sourceResult.sourceRevoked, true);
assert.deepEqual(sourceResult.revokedItems, [{ kind: "fact", id: "fact-1" }]);
```

SQLite integration tests must perform the same create/list/status behavior against a temporary database, verify another persona cannot be selected by the same `personaId`-scoped calls, and prove a linked item remains confirmed when another `ready` source exists but becomes revoked after its last source is revoked.

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
node --import tsx --test tests/postgresRepository.test.ts tests/personaKnowledgeDb.test.ts
```

Expected: TypeScript compilation FAIL because repository methods are missing.

- [ ] **Step 3: Add exact repository methods**

Add to `AppRepository`:

```ts
createPersonaKnowledgeCandidates(input: {
  source: CreatePersonaSourceInput;
  candidates: CreatePersonaKnowledgeCandidateInput[];
}): Promise<PersonaKnowledgeBundle>;
listPersonaKnowledge(personaId: string): Promise<PersonaKnowledgeBundle>;
getPersonaKnowledgeItem(
  kind: PersonaKnowledgeKind,
  id: string,
  personaId: string,
): Promise<PersonaKnowledgeItem | null>;
findConfirmedFacts(
  personaId: string,
  factType: string,
  factKey: string,
): Promise<PersonaFact[]>;
updatePersonaKnowledgeCandidate(input: {
  kind: PersonaKnowledgeKind;
  id: string;
  personaId: string;
  expectedStatus: "pending" | "conflicted";
  patch: Record<string, string | string[] | null>;
}): Promise<PersonaKnowledgeItem | null>;
setPersonaKnowledgeStatuses(inputs: Array<{
  kind: PersonaKnowledgeKind;
  id: string;
  personaId: string;
  expectedStatus: PersonaKnowledgeStatus;
  nextStatus: PersonaKnowledgeStatus;
  actorUserId: string;
  conflictGroupId: string | null;
}>): Promise<PersonaKnowledgeItem[]>;
revokePersonaSource(
  sourceId: string,
  personaId: string,
  actorUserId: string,
): Promise<{ sourceRevoked: boolean; revokedItems: Array<{ kind: PersonaKnowledgeKind; id: string }> }>;
```

`createPersonaKnowledgeCandidates` must run in one transaction and verify every candidate uses the same `personaId` as the source. It inserts the source, inserts each `pending` item, and inserts one `persona_item_sources` row for each candidate. If any insert fails, nothing persists.

- [ ] **Step 4: Implement Postgres mappings and whitelisted table selection**

In `src/lib/storage/postgresRepository.ts`, define a non-user-controlled map:

```ts
const KNOWLEDGE_TABLES = {
  fact: "persona_facts",
  relationship_memory: "relationship_memories",
  speech_style: "speech_style_items",
} as const;
```

Never interpolate an arbitrary request string into SQL. Map rows into the union using dedicated `mapPersonaFact`, `mapRelationshipMemory` and `mapSpeechStyleItem` functions. Every query must carry `persona_id = $n`; status changes also require the expected current status so concurrent reviews do not overwrite each other. `setPersonaKnowledgeStatuses` must wrap the whole batch in one transaction and throw `knowledge_status_changed` if any compare-and-set update returns no row, rolling the entire batch back.

`updatePersonaKnowledgeCandidate` must whitelist editable fields per kind. It may edit `pending` or `conflicted` content, but it must clear `conflict_group_id`, set the item back to `pending`, clear prior confirmation fields and never accept raw SQL column names from the caller.

`revokePersonaSource` must run in one transaction: revoke the source, find every linked item, count each item's other `ready` sources, and change items with zero remaining sources to `revoked`. The returned `revokedItems` list is the exact audit result; the method must be idempotent.

`loadMemoriesWithEmbeddings` must switch from `memories` to:

```sql
SELECT id, content, embedding::text AS embedding
FROM relationship_memories
WHERE persona_id = $1 AND status = 'confirmed' AND embedding IS NOT NULL
```

Keep the existing method name until the grounded-dialogue plan changes its callers.

- [ ] **Step 5: Implement matching SQLite functions and adapter methods**

Use the same whitelist and transaction semantics in `src/lib/db.ts`. `repository.ts` may adapt synchronous local functions into promises, but must not duplicate status policy. Store participants with `JSON.stringify` and parse them defensively to `[]` on malformed legacy data.

- [ ] **Step 6: Run targeted verification**

Run:

```bash
node --import tsx --test tests/postgresRepository.test.ts tests/personaKnowledgeDb.test.ts
npm run typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/storage/types.ts src/lib/storage/postgresRepository.ts src/lib/storage/repository.ts src/lib/db.ts tests/postgresRepository.test.ts tests/personaKnowledgeDb.test.ts
git commit -m "feat: add persona knowledge repositories"
```

---

### Task 4: Add one service for candidate review and deterministic conflicts

**Files:**

- Create: `src/lib/personaKnowledgeService.ts`
- Test: `tests/personaKnowledgeService.test.ts`

- [ ] **Step 1: Write failing service tests**

Use a small in-memory fake implementing only the knowledge methods. Cover:

```ts
const confirmed = await reviewPersonaKnowledge({
  repository,
  personaId: "persona-1",
  actorUserId: "user-1",
  kind: "speech_style",
  id: "style-1",
  action: "confirm",
});
assert.equal(confirmed.item.status, "confirmed");

const conflict = await reviewPersonaKnowledge({
  repository,
  personaId: "persona-1",
  actorUserId: "user-1",
  kind: "fact",
  id: "fact-coffee",
  action: "confirm",
});
assert.equal(conflict.item.status, "conflicted");
assert.equal(conflict.conflicts[0].status, "conflicted");
assert.equal(conflict.item.conflictGroupId, conflict.conflicts[0].conflictGroupId);

const edited = await reviewPersonaKnowledge({
  repository,
  personaId: "persona-1",
  actorUserId: "user-1",
  kind: "fact",
  id: "fact-coffee",
  action: "confirm",
  edits: { normalizedValue: "桂花茶", content: "她喜欢桂花茶" },
});
assert.equal(edited.item.status, "confirmed");

await assert.rejects(() => reviewPersonaKnowledge({
  repository,
  personaId: "persona-other",
  actorUserId: "user-1",
  kind: "fact",
  id: "fact-coffee",
  action: "confirm",
}), /knowledge_not_found/);
```

Also prove `reject` and `revoke` use valid transitions and that a terminal item cannot be revived.

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
node --import tsx --test tests/personaKnowledgeService.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement review orchestration**

Export:

```ts
export async function reviewPersonaKnowledge(input: {
  repository: AppRepository;
  personaId: string;
  actorUserId: string;
  kind: PersonaKnowledgeKind;
  id: string;
  action: "confirm" | "reject" | "revoke";
  edits?: Record<string, string | string[] | null>;
}): Promise<{ item: PersonaKnowledgeItem; conflicts: PersonaFact[] }>;
```

Algorithm:

1. Read the item with `kind`, `id` and `personaId`; missing means `knowledge_not_found`.
2. If `edits` exists, call `updatePersonaKnowledgeCandidate`, then reload the item. Editing a terminal item fails.
3. For reject/revoke, validate with `requireKnowledgeTransition` and submit one compare-and-set operation through `setPersonaKnowledgeStatuses`.
4. For a non-fact confirmation, submit one transition to `confirmed`.
5. For a fact confirmation, load confirmed facts with the same type/key and call `factsConflict`.
6. If none conflict, transition the candidate to `confirmed`.
7. If conflicts exist, create one `randomUUID()` group and submit one atomic batch that marks every current confirmed fact and the candidate `conflicted`.
8. If the repository reports `knowledge_status_changed`, return no partial result; the caller retries from fresh state.

Do not call an LLM in this service. It handles only deterministic same-key conflicts.

- [ ] **Step 4: Run and confirm GREEN**

Run:

```bash
node --import tsx --test tests/personaKnowledge.test.ts tests/personaKnowledgeService.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/personaKnowledgeService.ts tests/personaKnowledgeService.test.ts
git commit -m "feat: review persona knowledge safely"
```

---

### Task 5: Expose an authenticated candidate and review API

**Files:**

- Create: `src/app/api/persona-knowledge/route.ts`
- Create: `tests/personaKnowledgeRoute.test.ts`
- Modify: `tests/storageRouteBoundary.test.ts`

- [ ] **Step 1: Write failing route contract tests**

`tests/personaKnowledgeRoute.test.ts` should read the route source, matching the existing route-boundary style, and assert:

```ts
assert.match(source, /requireAuth/);
assert.match(source, /getPersonaForUser\(personaId, auth\.userId\)/);
assert.match(source, /createPersonaKnowledgeCandidates/);
assert.match(source, /reviewPersonaKnowledge/);
assert.doesNotMatch(source, /@\/lib\/db/);
```

Add `persona-knowledge/route.ts` to `durableRoutes` in `tests/storageRouteBoundary.test.ts`.

Add pure exported parsers in the route module and test them without provider calls:

```ts
assert.throws(() => parseCreateKnowledgeBody({ personaId: "", source: {}, candidates: [] }), /personaId/);
assert.throws(() => parseCreateKnowledgeBody({ personaId: "p", source: validSource, candidates: [] }), /candidates/);
assert.throws(() => parseCreateKnowledgeBody({ personaId: "p", source: validSource, candidates: Array(51).fill(validFact) }), /50/);
assert.deepEqual(parseReviewKnowledgeBody(validReview).action, "confirm");
assert.equal(parseReviewKnowledgeBody({ ...validReview, edits: { content: "改后的内容" } }).edits.content, "改后的内容");
```

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
node --import tsx --test tests/personaKnowledgeRoute.test.ts tests/storageRouteBoundary.test.ts
```

Expected: FAIL because the route is missing.

- [ ] **Step 3: Implement GET, POST, PATCH and DELETE**

All handlers must call `requireAuth`, then `repository.getPersonaForUser(personaId, auth.userId)` before touching knowledge data.

- GET `?personaId=` returns `listPersonaKnowledge(personaId)`.
- POST accepts one source plus 1–50 already-structured candidates, assigns server UUIDs, forces every candidate to `pending`, and calls `createPersonaKnowledgeCandidates` once.
- PATCH accepts `{ personaId, kind, id, action, edits? }`, calls `reviewPersonaKnowledge`, and maps `knowledge_not_found` to 404, invalid transitions/status changes to 409. Edits are allowed only before confirm/reject and are filtered by the server-side kind whitelist.
- DELETE accepts `{ personaId, sourceId }`, revokes only the source owned through that persona and returns `{ ok: true, revokedItems }`. Items with no other ready source must already be revoked before the response is sent.

Never accept `status`, `confirmedBy`, `createdBy`, `conflictGroupId` or `userId` from the client. Those values are server-owned.

- [ ] **Step 4: Run route tests and typecheck**

Run:

```bash
node --import tsx --test tests/personaKnowledgeRoute.test.ts tests/storageRouteBoundary.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/persona-knowledge/route.ts tests/personaKnowledgeRoute.test.ts tests/storageRouteBoundary.test.ts
git commit -m "feat: add persona knowledge review API"
```

---

### Task 6: Preserve `/api/memory` and local-data migration without bypassing confirmation state

**Files:**

- Modify: `src/app/api/memory/route.ts`
- Modify: `scripts/migrate-local-data.ts`
- Modify: `tests/postgresRepository.test.ts`
- Modify: `tests/localMigration.test.ts`
- Modify: `tests/storageRouteBoundary.test.ts`

- [ ] **Step 1: Write failing compatibility tests**

Add tests proving:

- the Postgres repository's existing `insertMemory` writes `relationship_memories` with `status = 'confirmed'`;
- `listMemories`, `getMemoryById` and `loadMemoriesWithEmbeddings` read only `confirmed` relationship memories;
- `deleteMemory` updates a relationship memory to `revoked` instead of physically deleting it;
- `scripts/migrate-local-data.ts` inserts a `legacy_import` source, a confirmed relationship memory and a `persona_item_sources` link;
- rerunning the migration produces `skipped`, not duplicate rows.

The SQL-source assertions include:

```ts
assert.match(memoryInsertCall.text, /INSERT INTO relationship_memories/);
assert.match(memoryInsertCall.text, /'confirmed'/);
assert.match(deleteCall.text, /UPDATE relationship_memories SET status = 'revoked'/);
assert.doesNotMatch(deleteCall.text, /DELETE FROM relationship_memories/);
```

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
node --import tsx --test tests/postgresRepository.test.ts tests/localMigration.test.ts tests/storageRouteBoundary.test.ts
```

Expected: FAIL because compatibility paths still use `memories`.

- [ ] **Step 3: Redirect the existing repository methods**

Keep the public method names so current pages and `/api/chat` continue to work. Change their implementation as follows:

- `insertMemory`: create a deterministic/manual source and confirmed relationship memory in one transaction, including source link and embedding;
- `listMemories`: select confirmed relationship memories only;
- `getMemoryById`: return non-revoked relationship memory metadata for ownership verification;
- `deleteMemory`: compare-and-set to `revoked`, setting `revoked_at` and `updated_at`;
- `loadMemoriesWithEmbeddings`: confirmed-only query from Task 3.

Update `InsertMemoryInput` with server-owned audit fields:

```ts
export type InsertMemoryInput = {
  id: string;
  personaId: string;
  content: string;
  embedding: Float32Array;
  createdBy: string;
  sourceId: string;
  checksumAlgorithm: "sha256";
  checksum: string;
};
```

In `/api/memory`, set `checksumAlgorithm: "sha256"`, compute `checksum` from UTF-8 content with `createHash("sha256")`, use `auth.userId` as `createdBy`, and assign one server UUID source per submitted memory. Explicit manual submission counts as user confirmation; AI-extracted items must continue to use `/api/persona-knowledge` and remain pending.

- [ ] **Step 4: Update the offline migration script**

For each legacy memory, write the same three records as migration `004` using deterministic IDs. Preserve the existing report entity name `memory` so historical report consumers do not break. `ON CONFLICT DO NOTHING RETURNING id` remains the success/skip signal.

- [ ] **Step 5: Run compatibility and chat regression tests**

Run:

```bash
node --import tsx --test tests/postgresRepository.test.ts tests/personaKnowledgeDb.test.ts tests/localMigration.test.ts tests/embedding.test.ts tests/storageRouteBoundary.test.ts
npm run typecheck
```

Expected: PASS; existing chat compiles without changing its retrieval call.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/memory/route.ts src/lib/storage/types.ts src/lib/storage/postgresRepository.ts src/lib/storage/repository.ts src/lib/db.ts scripts/migrate-local-data.ts tests/postgresRepository.test.ts tests/personaKnowledgeDb.test.ts tests/localMigration.test.ts tests/storageRouteBoundary.test.ts
git commit -m "feat: preserve confirmed legacy memories"
```

---

### Task 7: Document the new truth boundary and run full verification

**Files:**

- Modify: `CLAUDE.md`
- Modify: `docs/handoff.md`
- Modify: `docs/verification/production-foundation.md`

- [ ] **Step 1: Update operational documentation**

Record these exact facts:

- three knowledge layers exist and only `confirmed` items are retrievable;
- old memory rows are copied idempotently and the old table is not dropped in this phase;
- manual `/api/memory` entry is explicit user confirmation, while AI candidates remain pending;
- source deletion immediately revokes derived items that have no other ready source and returns the affected item references;
- grounded/companionship modes, message evidence, feedback metrics and real user validation are still not complete;
- Preview remains unusable until Neon supplies `DATABASE_URL` and `STORAGE_BACKEND=cloud`.

- [ ] **Step 2: Run the complete local verification bundle**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected:

- all Node tests pass;
- TypeScript exits 0;
- Next.js build exits 0;
- diff check prints no errors.

Do not claim Preview or Production readiness from local results.

- [ ] **Step 3: Review the changed-file boundary**

Run:

```bash
git status --short
git diff --stat HEAD~6
```

Expected: only files named in this plan are changed. Do not stage unrelated user work.

- [ ] **Step 4: Commit documentation**

```bash
git add CLAUDE.md docs/handoff.md docs/verification/production-foundation.md
git commit -m "docs: record persona knowledge foundation"
```

- [ ] **Step 5: Stop before push**

Report the local commit IDs and verification results. Do not run `git push`; the user must explicitly authorize push because it triggers Vercel deployment.

---

## Follow-on plans after this one

1. **AI candidate extraction** — private source ingestion, structured extraction, source excerpts and non-authoritative conflict suggestions.
2. **Grounded conversation pipeline** — fact/style separation, response modes, confirmed-only hybrid retrieval, `message_evidence`, safe retrieval degradation and latency breakdown.
3. **Restoration feedback and validation** — conversation sessions, five scores, red-line flags, metric computation and the two-cohort test protocol.
4. **Preview production gate** — Neon migration, two-account isolation, redeploy readback, real voice preset, 20-turn latency and Production decision.
