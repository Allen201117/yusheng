# Production Foundation Verification

Updated: 2026-07-13 (Asia/Shanghai)

## Local evidence

- `npm test`: 134 passed, 0 failed after sentence voice streaming, crisis-safety, provider preset lifecycle and fallback changes.
- `npm run typecheck`: passed.
- `npm run build`: passed on Next.js 15.5.20.
- `git diff --check`: passed.
- Production local-storage guard: `NODE_ENV=production STORAGE_BACKEND=local` fails with `Production requires STORAGE_BACKEND=cloud`.
- Provider preset local evidence: ready presets avoid Blob reads; stale preset URI errors mark the preset failed and retry dynamic cloning once; general provider outages do not double-call; deleting voices cannot start new synthesis.

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

- Deployment: `dpl_H929kjZyiCuA1H1EscNF2pxqmRD4`
- URL: `https://yusheng-9n8hnkbru-allens-projects-5408d95e.vercel.app`
- Status: Ready
- Function region: `sin1`
- `/login`: HTTP 200 through Vercel protection bypass
- `/api/auth/check` without a session: HTTP 401 with `{"ok":false}`

## Pending gate

Neon is not provisioned because the Vercel account owner must first accept the Neon Marketplace terms. Until this is done:

- Preview does not have `DATABASE_URL` or `STORAGE_BACKEND=cloud`;
- Postgres schema migration/readback is not verified;
- authenticated voice/persona/memory/message persistence cannot be exercised;
- cross-account isolation and redeploy persistence are not yet proven;
- Production must not be promoted or switched to cloud storage.
