# Production Foundation Verification

Updated: 2026-07-15 (Asia/Shanghai)

## Local evidence

- Grounded focused regression bundle: 155 passed, 0 failed.
- `npm test`: 420 passed, 0 failed after adding restoration session/feedback qualification, browser playback telemetry, aggregate-report privacy coverage, and file-level proof for missing, permission-denied, invalid-path, non-regular/symlink, legacy, active-WAL, WAL-close-race, concurrent-growth, oversized, unsafe-temp-root and normal SQLite report paths.
- `npm run typecheck`: passed.
- `npm run build`: passed on Next.js 15.5.20 and includes `/api/chat`, `/api/tts`, `/api/playback-event` and `/api/conversation-feedback`.
- `npm run db:migrate:dry`: passed and lists migrations `001` through `007`, including restoration feedback and playback-event cardinality.
- Empty `npm run --silent report:restoration`: returns one machine-readable JSON value with zero evaluators/sessions/effective sessions, `null` rates and `bothCohortsMeetInitialGate:false`, without creating a SQLite file. Only `ENOENT` means empty; permission/path/storage errors fail stably. An existing source must be a non-empty, non-symlink regular file no larger than 256 MiB. The command copies exactly the first `fstat` size from one read-only descriptor, verifies copied bytes and temporary-file size, then requires `fstat A → sidecar check → fstat B` with both fingerprints unchanged. Growth, WAL-close checkpoints, active WAL/journal files, unmigrated schema, or invalid file types fail without an old report. Temporary snapshot directories are empty after both success and rejection. Postgres runs the metric SELECT only.
- `git diff --check`: passed.
- Production local-storage guard: `NODE_ENV=production STORAGE_BACKEND=local` fails with `Production requires STORAGE_BACKEND=cloud`.
- Provider preset local evidence: ready presets avoid Blob reads; stale preset URI errors mark the preset failed and retry dynamic cloning once; general provider outages do not double-call; deleting voices cannot start new synthesis.
- Persona knowledge local evidence: facts, relationship memories and speech styles are stored separately; only `confirmed` items are retrievable; manual `/api/memory` writes are explicit user confirmations; AI candidates remain `pending`; source revocation immediately revokes unsupported derived items and reports their references.
- Legacy memory local evidence: old rows are copied idempotently into source + relationship memory + evidence link records, while the old table remains intact in this phase. Cross-owner persona/voice conflicts and mismatched deterministic IDs abort instead of linking unrelated data.
- Grounded conversation local evidence: confirmed facts/memories are ranked separately from confirmed styles; known facts carry their evidence IDs; contradictory user claims and history-only claims do not become evidence; no evidence and retrieval failure degrade to companionship; boundary paths use fixed replies with zero free-model calls and no sentence events; completed grounded messages persist selection-time evidence IDs.
- Playback local evidence: a failed first sentence preparation reports exactly one error and does not block the next prepared sentence. For an external retry of the same persona's sentence, the production persona→voice binding, source resolution and synthesis chain resolve persona A to voice/source A on both attempts; a simultaneous persona B/voice B fixture is never accessed or used. This does not claim an automatic provider retry: a general 503 still makes one provider call per request.
- Deterministic probes verify routing and evidence only. They do not prove subjective voice resemblance, emotional authenticity or real-user success.
- `npm run probe:grounded` on 2026-07-14 returned `provider_not_configured` (exit 2). The four-case synthetic real-model behavior remains unverified in this shell; this is recorded as missing evidence, not a pass.
- Probe result semantics are regression-tested separately: only completed content assertion failures are `red_line_failed` (exit 1); missing configuration is exit 2; network, HTTP 401/429/5xx, timeout and response parsing failures are `provider_failed` (exit 3). Every case has one cancellable provider call at most, and provider reports include only stable error category/name fields.
- Restoration feedback local evidence: non-visual browser telemetry sends the tracked playback lifecycle, feedback requires three distinct completed audible turns and blocks while any turn/TTS attempt is still started, red lines override scores, and the aggregate command separates living/deceased cohorts while excluding comments, transcripts, voice/provider metadata and audio paths. `play_started` is client-attested and TTS success is not proof of playback or listening completion.
- Not locally complete: real Preview browser + provider + database readback, people who know the voice owner, the 2+2 dry run, the 10/30/60% gate in each cohort, and a usable Preview environment. Synthetic tests are not user proof.
- Local tests, typecheck and build do not authorize a push, Preview deployment or Production promotion.

## Vercel project and Git deployment

- Team/project: `allens-projects-5408d95e/yusheng`
- Project ID: `prj_PwsWAzCD36B9489K5ZNtrMNGxUXB`
- Git source: `Allen201117/yusheng`
- Production branch: `main`
- Verification branch: `codex/production-foundation`
- Automatic Preview deploys are active for pushed branch commits.

## Private Blob verification

- Store: `yusheng-preview-voices`
- Store ID: `store_kIXLYEVNG2BIiweN`
- Region/access: `sin1`, private
- Environment connection: Preview only
- Real check: uploaded a fixture, read it through authenticated private access, verified byte equality, deleted it, and confirmed the store returned zero blobs.

## Latest verified Preview

- Deployment: `dpl_2vLt2gyDUs3ZUxBqMTYNTvLaMVtB`
- URL: `https://yusheng-12r8gmyuh-allens-projects-5408d95e.vercel.app`
- Status: Ready
- Function region: `sin1`
- `/login`: HTTP 200 through Vercel protection bypass
- `/api/auth/check` without a session: HTTP 401 with `{"ok":false}`
- `/api/auth/login` with a disposable test identity: HTTP 500 on four retried requests. Vercel runtime logs consistently reported `STORAGE_BACKEND must be local or cloud`; no test user was created.
- Preview environment listing contains `AUTH_MODE`, `RESEND_API_KEY`, `SESSION_SECRET`, `SILICONFLOW_API_KEY` and `BLOB_READ_WRITE_TOKEN`, but no `STORAGE_BACKEND` or `DATABASE_URL`.

## Pending gate

Neon is not provisioned because the Vercel account owner must first accept the Neon Marketplace terms. Preview remains unusable until Neon supplies `DATABASE_URL` and Preview is configured with `STORAGE_BACKEND=cloud`. Until this is done:

- Preview does not have `DATABASE_URL` or `STORAGE_BACKEND=cloud`;
- Postgres schema migration/readback is not verified;
- authenticated voice/persona/memory/message persistence cannot be exercised;
- cross-account isolation and redeploy persistence are not yet proven;
- Production must not be promoted or switched to cloud storage.

The current Preview proves automatic Git deployment and public route execution only. It is not a usable product environment until the database gate is completed.
