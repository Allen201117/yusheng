# Production Persistence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace production SQLite and local voice files with durable Neon Postgres and Vercel Private Blob storage while preserving the current application behavior, user isolation, existing local development, and a verifiable migration path.

**Architecture:** Introduce async repository and voice-object-store boundaries. Local adapters retain SQLite/files for development and migration; cloud adapters use Neon and Private Blob, and production refuses to start without cloud storage. Existing API routes migrate to the boundaries before cloud storage is enabled, so behavior can be tested independently from provisioning.

**Tech Stack:** Next.js 15 App Router, TypeScript, Node.js test runner, `@neondatabase/serverless`, `@vercel/blob`, `better-sqlite3` for local migration only.

---

## Scope and file map

This plan implements only the persistence foundation from the approved design. Authentication hardening, consent workflows, streaming voice, structured persona and production rollout each receive their own follow-up plan after this foundation is verified.

New files:

- `src/lib/storage/config.ts`: validates backend selection and production requirements.
- `src/lib/storage/types.ts`: shared persistence types and interfaces.
- `src/lib/storage/postgres.ts`: Neon query client and transaction boundary.
- `src/lib/storage/postgresRepository.ts`: Postgres implementation for users, personas, memories and messages.
- `src/lib/storage/repository.ts`: selects local or cloud repository.
- `src/lib/storage/voiceObjectStore.ts`: local/private-Blob object store implementations and selector.
- `src/lib/storage/checksum.ts`: SHA-256 helpers for immutable voice objects.
- `migrations/001_production_foundation.sql`: versioned Postgres schema.
- `scripts/apply-migrations.ts`: idempotent migration runner.
- `scripts/migrate-local-data.ts`: dry-run/import/report tool for SQLite and local voices.
- `tests/storageConfig.test.ts`: production guard tests.
- `tests/postgresRepository.test.ts`: repository contract using an injected SQL executor.
- `tests/voiceObjectStore.test.ts`: path, ownership and cleanup behavior.
- `tests/localMigration.test.ts`: migration planning, checksums and idempotency.

Modified files:

- `package.json`, `package-lock.json`: cloud storage dependencies and scripts.
- `src/lib/db.ts`: export the local adapter surface; no longer selected directly by routes.
- `src/lib/voiceStore.ts`: remain as local implementation used through the adapter.
- `src/app/api/auth/login/route.ts`
- `src/app/api/auth/reset-password/route.ts`
- `src/app/api/auth/send-code/route.ts`
- `src/app/api/persona/route.ts`
- `src/app/api/memory/route.ts`
- `src/app/api/chat/route.ts`
- `src/app/api/tts/route.ts`
- `src/app/api/voice/upload/route.ts`
- `docs/handoff.md`, `.env.example`: production contract and operator instructions.

### Task 1: Backend configuration and production guard

**Files:**
- Create: `src/lib/storage/config.ts`
- Create: `tests/storageConfig.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing backend-selection tests**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStorageConfig } from "../src/lib/storage/config";

describe("resolveStorageConfig", () => {
  it("uses local storage outside production", () => {
    assert.deepEqual(resolveStorageConfig({ NODE_ENV: "test" }), { backend: "local" });
  });

  it("rejects local storage in production", () => {
    assert.throws(
      () => resolveStorageConfig({ NODE_ENV: "production", STORAGE_BACKEND: "local" }),
      /Production requires STORAGE_BACKEND=cloud/,
    );
  });

  it("requires database and private Blob credentials in production", () => {
    assert.throws(
      () => resolveStorageConfig({ NODE_ENV: "production", STORAGE_BACKEND: "cloud" }),
      /DATABASE_URL/,
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- tests/storageConfig.test.ts`
Expected: FAIL because `src/lib/storage/config.ts` does not exist.

- [ ] **Step 3: Implement strict configuration parsing**

```ts
export type StorageEnvironment = Record<string, string | undefined>;
export type StorageConfig =
  | { backend: "local" }
  | { backend: "cloud"; databaseUrl: string; blobToken: string };

export function resolveStorageConfig(env: StorageEnvironment): StorageConfig {
  const production = env.NODE_ENV === "production";
  const backend = env.STORAGE_BACKEND || (production ? "" : "local");
  if (backend === "local") {
    if (production) throw new Error("Production requires STORAGE_BACKEND=cloud");
    return { backend: "local" };
  }
  if (backend !== "cloud") throw new Error("STORAGE_BACKEND must be local or cloud");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for cloud storage");
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is required for cloud storage");
  return { backend: "cloud", databaseUrl: env.DATABASE_URL, blobToken: env.BLOB_READ_WRITE_TOKEN };
}

export function getStorageConfig(): StorageConfig {
  return resolveStorageConfig(process.env);
}
```

- [ ] **Step 4: Install cloud dependencies without changing the pinned Next version**

Run: `npm install @neondatabase/serverless @vercel/blob`
Expected: dependencies are added; `next` remains `15.5.20`.

- [ ] **Step 5: Run tests and type checking**

Run: `npm test -- tests/storageConfig.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the configuration boundary**

```bash
git add package.json package-lock.json src/lib/storage/config.ts tests/storageConfig.test.ts
git commit -m "feat: enforce durable production storage"
```

### Task 2: Versioned Postgres schema and migration runner

**Files:**
- Create: `migrations/001_production_foundation.sql`
- Create: `src/lib/storage/postgres.ts`
- Create: `scripts/apply-migrations.ts`
- Modify: `package.json`
- Test: `tests/postgresRepository.test.ts`

- [ ] **Step 1: Write the SQL executor contract test**

```ts
import { it } from "node:test";
import assert from "node:assert/strict";
import { createMigrationPlan } from "../scripts/apply-migrations";

it("applies only migrations missing from schema_migrations", () => {
  const plan = createMigrationPlan(["001_production_foundation.sql"], new Set());
  assert.deepEqual(plan, ["001_production_foundation.sql"]);
  assert.deepEqual(createMigrationPlan(plan, new Set(plan)), []);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- tests/postgresRepository.test.ts`
Expected: FAIL because the migration planner does not exist.

- [ ] **Step 3: Add the production schema**

The SQL file must create `schema_migrations`, `users`, `verification_codes`, `voice_profiles`, `personas`, `memories`, `messages`, and indexes. Existing camelCase TypeScript fields map to snake_case columns. Include `CREATE EXTENSION IF NOT EXISTS vector;` and define `memories.embedding vector(1024)`. Foreign keys use `ON DELETE CASCADE` for persona memories/messages and `ON DELETE RESTRICT` for persona voice references.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE,
  phone text UNIQUE,
  password text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voice_profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_path text NOT NULL UNIQUE,
  checksum_sha256 text NOT NULL,
  prompt_text text NOT NULL,
  mime_type text NOT NULL,
  duration_sec double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
```

All imported identifiers use `text`, not `uuid`, because the current application contains reserved owners such as `__legacy__` and `__dev__`. The remaining tables preserve the current application fields and add explicit timestamps. `verification_codes` stores the current code temporarily; hashing is introduced in the authentication-hardening plan, not hidden inside this migration.

- [ ] **Step 4: Implement an injectable Neon executor**

```ts
import { Pool } from "@neondatabase/serverless";

export interface SqlExecutor {
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T>;
}

let cached: SqlExecutor | null = null;
export function getSql(databaseUrl = process.env.DATABASE_URL): SqlExecutor {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (cached) return cached;
  const pool = new Pool({ connectionString: databaseUrl });
  cached = createPoolExecutor(pool);
  return cached;
}
```

- [ ] **Step 5: Implement the idempotent migration runner**

`createMigrationPlan(files, applied)` sorts migration filenames and returns only missing versions. The CLI reads `migrations/*.sql`, ensures `schema_migrations`, runs each file in a transaction, then inserts its filename. It accepts `--dry-run` and prints JSON without executing SQL.

- [ ] **Step 6: Add scripts and verify dry-run**

```json
"db:migrate": "node --import tsx scripts/apply-migrations.ts",
"db:migrate:dry": "node --import tsx scripts/apply-migrations.ts --dry-run"
```

Run: `npm run db:migrate:dry`
Expected: JSON lists `001_production_foundation.sql` without requiring a database connection.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm test -- tests/postgresRepository.test.ts`
Expected: PASS.

```bash
git add migrations/001_production_foundation.sql src/lib/storage/postgres.ts scripts/apply-migrations.ts tests/postgresRepository.test.ts package.json
git commit -m "feat: add versioned production schema"
```

### Task 3: Async repository boundary and Postgres implementation

**Files:**
- Create: `src/lib/storage/types.ts`
- Create: `src/lib/storage/postgresRepository.ts`
- Create: `src/lib/storage/repository.ts`
- Modify: `src/lib/db.ts`
- Test: `tests/postgresRepository.test.ts`

- [ ] **Step 1: Add a failing repository ownership test**

```ts
it("queries personas with both persona id and owner id", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const sql: SqlExecutor = {
    async query(text, params = []) { calls.push({ text, params }); return []; },
    async transaction(work) { return work(sql); },
  };
  const repo = createPostgresRepository(sql);
  assert.equal(await repo.getPersonaForUser("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"), null);
  assert.match(calls[0].text, /user_id/);
  assert.deepEqual(calls[0].params, ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- tests/postgresRepository.test.ts`
Expected: FAIL because `createPostgresRepository` is missing.

- [ ] **Step 3: Define the repository interface**

```ts
export interface AppRepository {
  getUserByEmail(email: string): Promise<User | null>;
  createUserByEmail(email: string, passwordHash?: string): Promise<User>;
  setUserPassword(email: string, hash: string): Promise<void>;
  createVerificationCode(target: { email?: string; phone?: string }, code: string, ttlMinutes: number): Promise<void>;
  verifyCode(target: { email?: string; phone?: string }, code: string): Promise<boolean>;
  listPersonas(userId: string): Promise<Persona[]>;
  getPersonaForUser(id: string, userId: string): Promise<Persona | null>;
  createPersona(input: CreatePersonaInput): Promise<Persona>;
  deletePersona(id: string, userId: string): Promise<Persona | null>;
  countPersonasUsingVoice(userId: string, voiceId: string): Promise<number>;
  createVoiceProfile(input: CreateVoiceProfileInput): Promise<VoiceMeta>;
  getVoiceProfileForUser(voiceId: string, userId: string): Promise<VoiceMeta | null>;
  listVoiceProfiles(userId: string): Promise<VoiceMeta[]>;
  deleteVoiceProfile(voiceId: string, userId: string): Promise<boolean>;
  listMemories(personaId: string): Promise<Memory[]>;
  getMemoryById(id: string): Promise<Memory | null>;
  insertMemory(input: InsertMemoryInput): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  loadMemoriesWithEmbeddings(personaId: string): Promise<MemoryEmbedding[]>;
  listMessages(personaId: string, limit: number): Promise<Message[]>;
  insertMessage(input: InsertMessageInput): Promise<void>;
}
```

- [ ] **Step 4: Implement Postgres mappings and ownership predicates**

Every user-scoped query includes `user_id`. UUIDs remain generated in application code with `randomUUID()`. Embeddings are serialized as `[0.1,0.2,...]` for pgvector parameters and parsed back into `Float32Array`. Query functions map database timestamps to ISO strings at the boundary.

- [ ] **Step 5: Implement local and cloud selection**

`getRepository()` reads `getStorageConfig()`. Local mode returns an async wrapper around the current `db.ts` exports. Cloud mode returns a singleton Postgres repository. No route imports `getDb()` after Task 5.

- [ ] **Step 6: Run repository tests and type checking**

Run: `npm test -- tests/postgresRepository.test.ts`
Expected: PASS, including ownership, ordering, null mapping and vector serialization.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the repository boundary**

```bash
git add src/lib/storage/types.ts src/lib/storage/postgresRepository.ts src/lib/storage/repository.ts src/lib/db.ts tests/postgresRepository.test.ts
git commit -m "refactor: add async persistence repository"
```

### Task 4: Private voice object store

**Files:**
- Create: `src/lib/storage/checksum.ts`
- Create: `src/lib/storage/voiceObjectStore.ts`
- Test: `tests/voiceObjectStore.test.ts`
- Modify: `src/lib/voiceStore.ts`

- [ ] **Step 1: Write failing immutable-path and ownership tests**

```ts
it("builds an owner-scoped immutable pathname", () => {
  assert.equal(
    buildVoicePath("user-a", "voice-a", "abc123", "audio/wav"),
    "users/user-a/voices/voice-a/abc123.wav",
  );
});

it("does not return another user's voice", async () => {
  const store = createInMemoryVoiceStore();
  await store.put({ userId: "alice", voiceId: "v1", body: Buffer.from("secret"), mimeType: "audio/wav" });
  assert.equal(await store.get("v1", "bob"), null);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- tests/voiceObjectStore.test.ts`
Expected: FAIL because the object-store module is missing.

- [ ] **Step 3: Implement the object-store interface**

```ts
export interface VoiceObjectStore {
  put(input: PutVoiceInput): Promise<StoredVoiceObject>;
  get(voiceId: string, userId: string): Promise<{ meta: VoiceMeta; body: Buffer } | null>;
  list(userId: string): Promise<VoiceMeta[]>;
  delete(voiceId: string, userId: string): Promise<boolean>;
}
```

The cloud implementation computes SHA-256, uploads with `put(pathname, body, { access: "private", contentType, addRandomSuffix: false })`, and stores metadata through `AppRepository.createVoiceProfile()`. Reads call `getVoiceProfileForUser()` before Vercel Blob `get()`. Deletes remove Blob first, then call `deleteVoiceProfile()`; failures propagate for retry rather than reporting success.

- [ ] **Step 4: Wrap the current file store as local implementation**

The local adapter delegates to `saveVoiceForUser`, `loadVoiceForUser`, `readAudioBase64ForUser`, `listVoicesForUser` and `deleteVoiceForUser`, preserving existing tests and development behavior.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/voiceObjectStore.test.ts tests/voiceStore.test.ts`
Expected: PASS.

```bash
git add src/lib/storage/checksum.ts src/lib/storage/voiceObjectStore.ts src/lib/voiceStore.ts tests/voiceObjectStore.test.ts
git commit -m "feat: store voices in private object storage"
```

### Task 5: Migrate API routes to async storage boundaries

**Files:**
- Modify: `src/app/api/auth/login/route.ts`
- Modify: `src/app/api/auth/reset-password/route.ts`
- Modify: `src/app/api/auth/send-code/route.ts`
- Modify: `src/app/api/persona/route.ts`
- Modify: `src/app/api/memory/route.ts`
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/app/api/tts/route.ts`
- Modify: `src/app/api/voice/upload/route.ts`
- Test: `tests/storageRouteBoundary.test.ts`

- [ ] **Step 1: Add a failing source-boundary test**

```ts
it("production API routes do not import db or voiceStore directly", async () => {
  for (const file of ROUTE_FILES) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /@\/lib\/db/);
    assert.doesNotMatch(source, /@\/lib\/voiceStore/);
  }
});
```

- [ ] **Step 2: Run the boundary test and verify it fails**

Run: `npm test -- tests/storageRouteBoundary.test.ts`
Expected: FAIL and list the current direct imports.

- [ ] **Step 3: Convert each route to the repository**

At the start of each handler, obtain `const repo = getRepository()` and await all reads/writes. Voice routes use `getVoiceObjectStore()`. Keep `requireAuth()` before body processing or storage calls. Preserve current response shapes and status codes so existing pages continue to work.

Example:

```ts
const repo = getRepository();
const persona = await repo.getPersonaForUser(personaId, auth.userId);
if (!persona) return NextResponse.json({ error: "persona 不存在或不属于你" }, { status: 403 });
```

- [ ] **Step 4: Remove route access to the SQLite connection**

Replace `getDb().transaction(...)` in the persona route with a repository transaction method that deletes the persona and returns its `voiceId` atomically. Do not emulate a transaction with separate unchecked calls.

- [ ] **Step 5: Run route, ownership and regression tests**

Run: `npm test`
Expected: all existing tests and `storageRouteBoundary.test.ts` PASS.
Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit the route migration**

```bash
git add src/app/api src/lib/storage tests/storageRouteBoundary.test.ts
git commit -m "refactor: route data through durable storage"
```

### Task 6: Idempotent local-data migration

**Files:**
- Create: `scripts/migrate-local-data.ts`
- Create: `tests/localMigration.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing migration-plan tests**

```ts
it("does not upload an object whose checksum already exists", () => {
  const plan = planVoiceMigration(
    [{ voiceId: "v1", checksum: "abc", audioPath: "/tmp/v1.wav" }],
    new Set(["abc"]),
  );
  assert.deepEqual(plan, [{ voiceId: "v1", action: "skip", reason: "checksum_exists" }]);
});

it("reports a missing local audio file instead of marking success", () => {
  assert.deepEqual(classifyLocalVoice({ metaExists: true, audioExists: false }), "missing_audio");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- tests/localMigration.test.ts`
Expected: FAIL because migration planning functions are missing.

- [ ] **Step 3: Implement dry-run, import and JSON report modes**

The script accepts:

```text
--data-dir <path>       default ./data
--dry-run               perform no cloud writes
--report <path>         default ./migration-report.json
--user-map <path>       optional JSON map for legacy user ownership
```

It reads SQLite without modifying it, inventories every user/persona/memory/message/voice, computes voice checksums, compares cloud records, imports in dependency order, and writes one result per item: `imported`, `skipped`, `missing`, or `failed` with a reason. Re-running the same source must produce only `skipped` results.

- [ ] **Step 4: Add scripts and verify dry-run against a fixture**

```json
"data:migrate:dry": "node --import tsx scripts/migrate-local-data.ts --dry-run",
"data:migrate": "node --import tsx scripts/migrate-local-data.ts"
```

Run: `npm run data:migrate:dry -- --data-dir tests/fixtures/local-data`
Expected: exit 0 and JSON counts for every entity; no network access.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/localMigration.test.ts`
Expected: PASS.

```bash
git add scripts/migrate-local-data.ts tests/localMigration.test.ts tests/fixtures/local-data package.json
git commit -m "feat: migrate local data to durable storage"
```

### Task 7: Operator contract and full local verification

**Files:**
- Create: `.env.example`
- Modify: `docs/handoff.md`
- Modify: `CLAUDE.md`
- Test: all tests

- [ ] **Step 1: Document exact environment behavior**

`.env.example` must contain names but no secrets:

```dotenv
STORAGE_BACKEND=local
DATABASE_URL=
BLOB_READ_WRITE_TOKEN=
SILICONFLOW_API_KEY=
SESSION_SECRET=
AUTH_MODE=email
```

`docs/handoff.md` must state that production requires `STORAGE_BACKEND=cloud`, Neon and a private Blob store; SQLite and `data/voices` are development/migration-only. `CLAUDE.md` must remove stale statements that production data lives locally.

- [ ] **Step 2: Run the complete local verification bundle**

Run: `npm test`
Expected: all tests PASS.
Run: `npm run test:coverage`
Expected: PASS and new storage modules appear in coverage.
Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build`
Expected: PASS.
Run: `git diff --check`
Expected: no output.

- [ ] **Step 3: Verify the production guard**

Run: `NODE_ENV=production STORAGE_BACKEND=local npm run build`
Expected: build or runtime initialization fails with `Production requires STORAGE_BACKEND=cloud`; it must not silently create `./data`.

- [ ] **Step 4: Commit operator documentation**

```bash
git add .env.example docs/handoff.md CLAUDE.md
git commit -m "docs: define cloud storage operations"
```

### Task 8: Real Preview storage verification

**Files:**
- Modify only if required by verified platform behavior: `vercel.json`
- Evidence: migration report, Vercel deployment URL, Neon readback and Blob readback/delete output

- [ ] **Step 1: Provision isolated Preview resources**

Create a Neon Postgres database in AWS Singapore and a Vercel Private Blob store. Connect both to the existing `yusheng` Vercel project. Set Preview-only `STORAGE_BACKEND=cloud`; do not switch Production yet.

- [ ] **Step 2: Apply migrations and verify schema readback**

Run: `npm run db:migrate` with Preview `DATABASE_URL`.
Expected: `001_production_foundation.sql` is recorded exactly once in `schema_migrations`; a second run applies zero migrations.

- [ ] **Step 3: Deploy a Preview and exercise real storage**

Run: `npx vercel`
Expected: deployment is READY. Create two test accounts, upload one voice for account A, and verify account B cannot list/read/delete it. Restart/redeploy and verify account A still sees the same persona and voice metadata.

- [ ] **Step 4: Verify deletion at every layer**

Delete the test voice through the application. Query Postgres for the voice ID and list/get the Blob pathname.
Expected: metadata is absent or marked deleted according to repository contract, Blob get returns not found, and the API no longer synthesizes with that voice.

- [ ] **Step 5: Record evidence and decide the production switch**

Save only non-secret command output and IDs in `docs/verification/production-foundation.md`. Do not set Production `STORAGE_BACKEND=cloud` until data migration dry-run and readback succeed.

## Plan completion gate

This persistence plan is complete only when:

- no production API route imports SQLite or local voice storage directly;
- production refuses local persistence;
- Preview data survives redeployment;
- cross-user reads fail;
- real Private Blob upload/read/delete is proven;
- migration is idempotent and reports missing legacy files honestly;
- the full local verification bundle passes.
