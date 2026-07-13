# Voice Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record an owner-scoped, auditable authorization decision before creating a reusable provider voice, keep non-self and deceased cases pending manual review, and make revocation stop future synthesis while provider cleanup is retried safely.

**Architecture:** `voice_authorizations` is an append-preserving authorization record linked to one voice and owner. A pure policy function decides `approved` versus `pending_review`; only approved records may call `provisionVoicePreset`. Any recorded pending/revoked decision blocks TTS; `VOICE_AUTH_ENFORCEMENT=disabled` only grandfathers voices with no authorization record, allowing a staged rollout without ignoring an explicit decision.

**Tech Stack:** Next.js 15 route handlers, TypeScript, Neon Postgres, local SQLite compatibility, SiliconFlow preset voice lifecycle, Node test runner.

---

### Task 1: Authorization policy and durable schema

**Files:**
- Create: `src/lib/voiceAuthorizationPolicy.ts`
- Create: `migrations/003_voice_authorizations.sql`
- Modify: `src/lib/storage/types.ts`
- Test: `tests/voiceAuthorizationPolicy.test.ts`
- Test: `tests/postgresRepository.test.ts`

- [x] **Step 1: Write failing policy and migration tests**

```ts
assert.deepEqual(evaluateVoiceAuthorization({
  speakerStatus: "living",
  basis: "self",
  separateConsentConfirmed: true,
  thirdPartyProcessingConfirmed: true,
  syntheticDisclosureConfirmed: true,
}), { status: "approved", reasonCode: null });

assert.equal(evaluateVoiceAuthorization({
  speakerStatus: "deceased",
  basis: "close_relative_request",
  separateConsentConfirmed: true,
  thirdPartyProcessingConfirmed: true,
  syntheticDisclosureConfirmed: true,
}).status, "pending_review");
```

The migration test must require `voice_authorizations`, owner and voice foreign keys, constrained status/basis values, notice version, confirmation timestamps, revocation fields and an owner-scoped active-record index.

- [x] **Step 2: Run the tests and confirm RED**

Run: `node --import tsx --test tests/voiceAuthorizationPolicy.test.ts tests/postgresRepository.test.ts`

Expected: FAIL because the policy and migration do not exist.

- [x] **Step 3: Implement the policy, types and migration**

```ts
export const VOICE_AUTHORIZATION_NOTICE_VERSION = "voice-authorization-2026-07-13";

export function evaluateVoiceAuthorization(input: VoiceAuthorizationAttestation) {
  if (!input.separateConsentConfirmed || !input.thirdPartyProcessingConfirmed ||
      !input.syntheticDisclosureConfirmed) {
    return { status: "rejected" as const, reasonCode: "required_confirmation_missing" };
  }
  if (input.speakerStatus === "living" && input.basis === "self") {
    return { status: "approved" as const, reasonCode: null };
  }
  return { status: "pending_review" as const, reasonCode: "manual_review_required" };
}
```

The SQL table stores `id`, `voice_id`, `user_id`, `speaker_status`, `basis`, `status`, `reason_code`, three confirmation booleans, `notice_version`, `attested_at`, `reviewed_at`, `revoked_at` and `created_at`. It must not treat close-relative status as automatic approval.

- [x] **Step 4: Run targeted tests and confirm GREEN**

Run: `node --import tsx --test tests/voiceAuthorizationPolicy.test.ts tests/postgresRepository.test.ts`

Expected: PASS.

### Task 2: Owner-scoped repository lifecycle

**Files:**
- Modify: `src/lib/storage/types.ts`
- Modify: `src/lib/storage/postgresRepository.ts`
- Modify: `src/lib/storage/repository.ts`
- Modify: `src/lib/db.ts`
- Test: `tests/postgresRepository.test.ts`
- Test: `tests/voiceAuthorizationDb.test.ts`

- [x] **Step 1: Write failing repository tests**

```ts
const created = await repo.replaceVoiceAuthorization(input);
assert.equal(created.userId, "user-1");
assert.ok(sqlCalls.every(call => !call.text.includes("voice_authorizations") || call.params.includes("user-1")));
assert.equal((await repo.getCurrentVoiceAuthorization("voice-1", "user-1"))?.status, "approved");
assert.equal((await repo.revokeVoiceAuthorization("voice-1", "user-1"))?.status, "revoked");
```

- [x] **Step 2: Run and confirm RED**

Run: `node --import tsx --test tests/postgresRepository.test.ts tests/voiceAuthorizationDb.test.ts`

Expected: FAIL because repository methods are missing.

- [x] **Step 3: Implement Postgres and SQLite-compatible methods**

`replaceVoiceAuthorization` must run in one transaction: revoke any `approved` or `pending_review` record for the same owner/voice, then insert the new decision. `getCurrentVoiceAuthorization` orders by `created_at DESC`; `revokeVoiceAuthorization` updates only the current owner's active record and returns the mapped row. Local SQLite must expose the same behavior.

- [x] **Step 4: Run targeted tests and typecheck**

Run: `node --import tsx --test tests/postgresRepository.test.ts tests/voiceAuthorizationDb.test.ts && npm run typecheck`

Expected: PASS.

### Task 3: Preset revocation without deleting the source recording

**Files:**
- Modify: `src/lib/voicePresetService.ts`
- Test: `tests/voicePresetService.test.ts`

- [x] **Step 1: Write failing revocation tests**

```ts
const result = await revokeVoicePreset("voice-1", "user-1", deps);
assert.equal(result, "revoked");
assert.deepEqual(calls, ["meta", "state:deleting", "provider:delete", "state:not_created"]);
assert.doesNotMatch(calls.join(","), /store:delete/);
```

Also assert provider failure preserves the provider URI in `failed` state for retry.

- [x] **Step 2: Run and confirm RED**

Run: `node --import tsx --test tests/voicePresetService.test.ts`

Expected: FAIL because `revokeVoicePreset` does not exist.

- [x] **Step 3: Implement source-preserving revocation**

Reuse the provider deletion state transitions from `deleteVoiceEverywhere`, but do not call `VoiceObjectStore.delete`. On success set provider state to `not_created`; on failure keep URI + stable error code and throw a sanitized error.

- [x] **Step 4: Run and confirm GREEN**

Run: `node --import tsx --test tests/voicePresetService.test.ts`

Expected: PASS.

### Task 4: Authenticated authorization API and controlled provisioning

**Files:**
- Create: `src/app/api/voice/authorization/route.ts`
- Modify: `tests/storageRouteBoundary.test.ts`
- Create: `tests/voiceAuthorizationRoute.test.ts`

- [x] **Step 1: Write failing route tests**

The tests assert owner mismatch and missing confirmations stop before persistence, self approval persists before `provisionVoicePreset`, non-self/deceased returns `pending_review` without upload, replacement pending authorization revokes an existing preset, and DELETE persists revocation before reporting retryable cleanup.

- [x] **Step 2: Run and confirm RED**

Run: `node --import tsx --test tests/voiceAuthorizationRoute.test.ts tests/storageRouteBoundary.test.ts`

Expected: FAIL because the route does not exist.

- [x] **Step 3: Implement GET, POST and DELETE handlers**

POST must call `requireAuth`, verify `voiceId` with `getMeta(voiceId, userId)`, evaluate server-owned policy, persist the notice version, and provision only when status is `approved`. DELETE must persist revocation before provider cleanup; cleanup failure is explicit and retryable, not reported as fully complete.

- [x] **Step 4: Run and confirm GREEN**

Run: `node --import tsx --test tests/voiceAuthorizationRoute.test.ts tests/storageRouteBoundary.test.ts`

Expected: PASS.

### Task 5: TTS gating, documentation and verification

**Files:**
- Modify: `src/app/api/tts/route.ts`
- Modify: `.env.example`
- Modify: `CLAUDE.md`
- Modify: `docs/handoff.md`
- Test: `tests/voiceAuthorizationPolicy.test.ts`
- Test: `tests/storageRouteBoundary.test.ts`

- [x] **Step 1: Write failing gating tests**

```ts
assert.equal(canSynthesizeVoice({ authorization: revoked, enforcementEnabled: false }), false);
assert.equal(canSynthesizeVoice({ authorization: null, enforcementEnabled: false }), true);
assert.equal(canSynthesizeVoice({ authorization: null, enforcementEnabled: true }), false);
assert.equal(canSynthesizeVoice({ authorization: approved, enforcementEnabled: true }), true);
```

- [x] **Step 2: Implement staged enforcement**

`/api/tts` rejects every recorded non-approved decision. With `VOICE_AUTH_ENFORCEMENT=enabled`, it also rejects voices with no authorization record. Documentation must state that Production is not ready to enable enforcement until the functional consent client flow exists; do not claim legal compliance from schema/tests alone.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0. Then deploy only to Preview, verify `/login` 200 and unauthenticated `/api/auth/check` 401, and keep Production unchanged.
