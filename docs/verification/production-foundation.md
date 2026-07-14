# Production Foundation Verification

Updated: 2026-07-14 (Asia/Shanghai)

## Local evidence

- Grounded focused regression bundle: 148 passed, 0 failed.
- `npm test`: 291 passed, 0 failed after adding grounded routing/evidence, boundary, playback failure isolation and same-voice retry probes.
- `npm run typecheck`: passed.
- `npm run build`: passed on Next.js 15.5.20 and includes `/api/chat`.
- `git diff --check`: passed.
- Production local-storage guard: `NODE_ENV=production STORAGE_BACKEND=local` fails with `Production requires STORAGE_BACKEND=cloud`.
- Provider preset local evidence: ready presets avoid Blob reads; stale preset URI errors mark the preset failed and retry dynamic cloning once; general provider outages do not double-call; deleting voices cannot start new synthesis.
- Persona knowledge local evidence: facts, relationship memories and speech styles are stored separately; only `confirmed` items are retrievable; manual `/api/memory` writes are explicit user confirmations; AI candidates remain `pending`; source revocation immediately revokes unsupported derived items and reports their references.
- Legacy memory local evidence: old rows are copied idempotently into source + relationship memory + evidence link records, while the old table remains intact in this phase. Cross-owner persona/voice conflicts and mismatched deterministic IDs abort instead of linking unrelated data.
- Grounded conversation local evidence: confirmed facts/memories are ranked separately from confirmed styles; known facts carry their evidence IDs; contradictory user claims and history-only claims do not become evidence; no evidence and retrieval failure degrade to companionship; boundary paths use fixed replies with zero free-model calls and no sentence events; completed grounded messages persist selection-time evidence IDs.
- Playback local evidence: a failed first sentence preparation reports exactly one error and does not block the next prepared sentence; retrying a sentence reuses the same `voiceId` and resolved source instead of switching to another persona voice.
- Deterministic probes verify routing and evidence only. They do not prove subjective voice resemblance, emotional authenticity or real-user success.
- `npm run probe:grounded` on 2026-07-14 returned `provider_not_configured` (exit 2). The four-case synthetic real-model behavior remains unverified in this shell; this is recorded as missing evidence, not a pass.
- Not locally complete: browser playback telemetry, effective-restoration feedback, people who know the voice owner, and a usable Preview environment.
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
