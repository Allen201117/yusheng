# Effective Restoration Feedback Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an auditable backend that groups real voice conversations into sessions, traces server-issued sentences through TTS and playback events, accepts complete five-part feedback, and computes living/deceased effective-restoration rates without changing any page or visual behavior.

**Architecture:** Chat creates or reuses a server-owned persona session and persists each speech plan before SSE emission. Tracked TTS requests load the stored sentence instead of trusting browser text or controls, then persist the provider attempt. Playback events and feedback are owner-scoped and immutable; feedback qualifies only after three distinct completed turns have a completed tracked TTS attempt plus `play_started`. A pure metric function computes both cohorts separately.

**Tech Stack:** Next.js 15 App Router, TypeScript, Node test runner, SQLite/better-sqlite3, Neon Postgres, the existing repository abstraction, SiliconFlow TTS.

---

## Scope and locked decisions

- Source of truth: `docs/superpowers/specs/2026-07-14-core-conversation-design.md`, already marked user-approved.
- No visual changes to components, CSS, layouts, or interaction design. The user selected the non-visual telemetry option, so the chat page may wire the existing playback lifecycle to the telemetry client without changing the visible experience.
- Non-visual browser event sending and the playback-event receiver are locally wired and tested. `play_started` remains client-attested evidence of reported playback start only; local tests do not prove real Preview browser delivery, provider audio, deployed database readback, listening completion, or real-user value.
- A valid feedback session needs at least three distinct completed non-boundary turns. Each turn needs a completed tracked TTS attempt with a server-received `play_started` event.
- Client bodies never control evaluator identity, cohort, persona, voice, sentence text, speech controls, provider source/model, or server timings.
- Feedback is immutable and unique per session/evaluator. Legacy turns keep nullable `session_id` and cannot qualify.
- Passing locally does not authorize push, Preview, or Production.

## File map

Create:

- `migrations/006_restoration_feedback.sql`
- `src/lib/restorationMetrics.ts`
- `src/lib/ttsRoute.ts`
- `src/lib/playbackEventRoute.ts`
- `src/lib/conversationFeedbackRoute.ts`
- `src/app/api/playback-event/route.ts`
- `src/app/api/conversation-feedback/route.ts`
- `scripts/report-restoration-feedback.ts`
- `tests/restorationMetrics.test.ts`
- `tests/restorationFeedbackDb.test.ts`
- `tests/ttsRoute.test.ts`
- `tests/playbackEventRoute.test.ts`
- `tests/conversationFeedbackRoute.test.ts`
- `docs/verification/restoration-feedback.md`

Modify:

- `src/lib/storage/types.ts`
- `src/lib/db.ts`
- `src/lib/storage/repository.ts`
- `src/lib/storage/postgresRepository.ts`
- `src/lib/chatRoute.ts`
- `src/lib/speechPlanning.ts`
- `src/app/api/tts/route.ts`
- `tests/chatRoute.test.ts`
- `tests/speechPlanning.test.ts`
- `tests/conversationGroundingDb.test.ts`
- `tests/postgresRepository.test.ts`
- `tests/storageRouteBoundary.test.ts`
- `package.json`
- `CLAUDE.md`
- `docs/handoff.md`
- `docs/verification/production-foundation.md`

---

### Task 1: Define feedback contracts and north-star calculation

**Files:** Create `src/lib/restorationMetrics.ts`, `tests/restorationMetrics.test.ts`; modify `src/lib/storage/types.ts`.

- [ ] **Step 1: Write failing metric tests**

Cover every threshold and cohort rule:

```ts
const passing = {
  sessionId: "session-1",
  evaluatorUserId: "user-1",
  cohort: "living" as const,
  voiceSimilarity: 4,
  expressionSimilarity: 4,
  emotionFit: 4,
  factTrust: 4,
  discomfort: 2,
  majorFabrication: false,
  identityImpersonation: false,
  authorizationViolation: false,
};
assert.equal(isEffectiveRestorationFeedback(passing), true);
assert.equal(isEffectiveRestorationFeedback({ ...passing, voiceSimilarity: 3 }), false);
assert.equal(isEffectiveRestorationFeedback({ ...passing, discomfort: 3 }), false);
assert.equal(isEffectiveRestorationFeedback({ ...passing, majorFabrication: true }), false);
```

Also test all four positive-score fields, all three red lines, distinct evaluator counting, living/deceased isolation, zero denominator returning `null`, duplicate session rejection, and the `10 evaluators / 30 sessions / 60%` initial gate.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test tests/restorationMetrics.test.ts
```

Expected: module/types missing.

- [ ] **Step 3: Add exact contracts**

```ts
export type RestorationCohort = "living" | "deceased";
export type ConversationSessionStatus = "active" | "rated" | "expired";
export type TtsAttemptStatus = "started" | "completed" | "failed";
export type PlaybackEventType = "audio_ready" | "play_started" | "play_completed" | "play_failed";
export type EvaluatorRelation = "self" | "family" | "friend" | "other";

export type RestorationScores = {
  voiceSimilarity: number;
  expressionSimilarity: number;
  emotionFit: number;
  factTrust: number;
  discomfort: number;
  majorFabrication: boolean;
  identityImpersonation: boolean;
  authorizationViolation: boolean;
};

export type RestorationMetricRow = RestorationScores & {
  sessionId: string;
  evaluatorUserId: string;
  cohort: RestorationCohort;
};
```

Define explicit `ConversationSession`, `ConversationSentence`, `TtsAttempt`, `PlaybackEvent`, `ConversationFeedback`, and `FeedbackEligibility` types. No index signatures.

- [ ] **Step 4: Implement pure functions**

```ts
export function isEffectiveRestorationFeedback(row: RestorationMetricRow): boolean {
  return row.voiceSimilarity >= 4
    && row.expressionSimilarity >= 4
    && row.emotionFit >= 4
    && row.factTrust >= 4
    && row.discomfort <= 2
    && !row.majorFabrication
    && !row.identityImpersonation
    && !row.authorizationViolation;
}

export function summarizeRestorationFeedback(
  rows: RestorationMetricRow[],
): { living: CohortSummary; deceased: CohortSummary; bothCohortsMeetInitialGate: boolean };
```

`CohortSummary` contains evaluator/session/effective counts, `effectiveRate`, and `meetsInitialGate`. Repeated `sessionId` throws `duplicate_feedback_session`.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test tests/restorationMetrics.test.ts
npm run typecheck
git add src/lib/storage/types.ts src/lib/restorationMetrics.ts tests/restorationMetrics.test.ts
git commit -m "feat: define restoration feedback metrics"
```

---

### Task 2: Add the auditable schema in Postgres and SQLite

**Files:** Create `migrations/006_restoration_feedback.sql`, `tests/restorationFeedbackDb.test.ts`; modify `src/lib/db.ts`, `tests/postgresRepository.test.ts`.

- [ ] **Step 1: Write failing schema tests**

Assert: one active session per persona/evaluator; legacy nullable `conversation_turns.session_id`; unique sentence index per turn; unique attempt number per sentence; idempotent playback `event_id`; one feedback per session/evaluator; integer scores `1..5`; both attestation booleans true; owner/foreign-key failures roll back.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts
```

- [ ] **Step 3: Create migration 006**

Use these exact boundaries:

```sql
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id text PRIMARY KEY,
  persona_id text NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  evaluator_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voice_id text NOT NULL,
  voice_authorization_id text NOT NULL REFERENCES voice_authorizations(id),
  cohort text NOT NULL CHECK (cohort IN ('living','deceased')),
  status text NOT NULL CHECK (status IN ('active','rated','expired')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  rated_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sessions_one_active
  ON conversation_sessions(persona_id, evaluator_user_id) WHERE status = 'active';
ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS session_id text REFERENCES conversation_sessions(id) ON DELETE SET NULL;
```

Add `conversation_sentences` with server text/controls/planner version and `UNIQUE(turn_id,sentence_index)`; `tts_attempts` with sentence/session/turn/persona/voice, attempt number, status, source, provider voice ID, model/config versions, fallback, timings, stable error and `UNIQUE(sentence_id,attempt_no)`; `playback_events` with id, attempt, bounded event type/client elapsed; `conversation_feedback` with owner/session/persona, relation, two true attestations, five bounded scores, three red lines, bounded comment, and `UNIQUE(session_id,evaluator_user_id)`.

Also add an idempotent legacy-safe column instead of changing the existing degradation enum:

```sql
ALTER TABLE conversation_turns
  ADD COLUMN IF NOT EXISTS speech_tracking_failed boolean NOT NULL DEFAULT false;
```

The exact score constraints are:

```sql
voice_similarity integer NOT NULL CHECK (voice_similarity BETWEEN 1 AND 5),
expression_similarity integer NOT NULL CHECK (expression_similarity BETWEEN 1 AND 5),
emotion_fit integer NOT NULL CHECK (emotion_fit BETWEEN 1 AND 5),
fact_trust integer NOT NULL CHECK (fact_trust BETWEEN 1 AND 5),
discomfort integer NOT NULL CHECK (discomfort BETWEEN 1 AND 5)
```

- [ ] **Step 4: Mirror schema in SQLite**

Use equivalent constraints and partial index. Add `session_id` using the existing idempotent column-presence migration pattern. Never rewrite existing turns.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts
npm run db:migrate:dry
npm run typecheck
git add migrations/006_restoration_feedback.sql src/lib/db.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts
git commit -m "feat: add restoration feedback schema"
```

---

### Task 3: Create server-owned sessions and bind new turns

**Files:** Modify repository/types/DB adapters, `src/lib/chatRoute.ts`, and session-related tests.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
const first = await repo.getOrStartConversationSession({
  proposedSessionId: "session-1",
  personaId: "persona-1",
  evaluatorUserId: "user-1",
  voiceId: "voice-1",
  voiceAuthorizationId: "auth-1",
  cohort: "living",
  now: "2026-07-14T10:00:00.000Z",
  staleBefore: "2026-07-14T09:30:00.000Z",
});
```

Test active reuse, 30-minute expiry, concurrent reuse, persona/user isolation, authorization cohort snapshot, turn/session mismatch rollback, `meta.sessionId`, and no session creation for boundaries or denied authorization.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/conversationGroundingDb.test.ts tests/chatRoute.test.ts
```

- [ ] **Step 3: Add repository signatures**

```ts
getOrStartConversationSession(input: {
  proposedSessionId: string;
  personaId: string;
  evaluatorUserId: string;
  voiceId: string;
  voiceAuthorizationId: string;
  cohort: RestorationCohort;
  now: string;
  staleBefore: string;
}): Promise<ConversationSession>;

startConversationTurn(input: {
  turnId: string;
  sessionId: string;
  personaId: string;
  userMessageId: string;
  content: string;
}): Promise<ConversationTurn>;
```

Add `sessionId: string | null` to the turn type for legacy compatibility.

- [ ] **Step 4: Implement atomic lifecycle**

Both adapters validate owner-scoped persona, expire stale active session, reuse a fresh active session or insert the proposed UUID, and update activity when starting the turn. Postgres locks the persona row before session selection; SQLite uses one transaction. Do not rely only on unique-index error recovery.

- [ ] **Step 5: Integrate chat**

After approved authorization, before the turn starts, snapshot authorization ID, speaker status (`living`/`deceased`), and voice. Add `sessionId` to meta. Preserve strict authorization, evidence-before-model, one model stream, and emergency boundary behavior.

- [ ] **Step 6: Verify and commit**

```bash
node --import tsx --test tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/conversationGroundingDb.test.ts tests/chatRoute.test.ts
npm run typecheck
git add src/lib/storage/types.ts src/lib/db.ts src/lib/storage/repository.ts src/lib/storage/postgresRepository.ts src/lib/chatRoute.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/conversationGroundingDb.test.ts tests/chatRoute.test.ts
git commit -m "feat: bind grounded turns to restoration sessions"
```

---

### Task 4: Persist server-issued sentences and tracked TTS attempts

**Files:** Modify storage/types/adapters, chat/speech planning; create `src/lib/ttsRoute.ts`, `tests/ttsRoute.test.ts`; make the app TTS route thin.

- [ ] **Step 1: Write failing trace tests**

Prove sentence persistence happens before SSE; persistence failure emits no untracked sentence and stores `speechTrackingFailed=true` on the completed turn; tracked TTS ignores client text/controls/persona/voice; cross-owner IDs fail; attempts use started→completed/failed compare-and-set; raw provider errors are absent; tracked success returns `X-TTS-Attempt-ID`; untracked preview/replay writes no qualifying attempt; revoked authorization blocks completion; 503 remains one provider call per request.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test tests/ttsRoute.test.ts tests/chatRoute.test.ts tests/speechPlanning.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/storageRouteBoundary.test.ts
```

- [ ] **Step 3: Add contracts**

```ts
export const SPEECH_PLANNER_VERSION = "keyword-v1";
export type TrackedSpeechPlan = SpeechPlan & { sentenceId: string };

recordConversationSentence(input: {
  id: string; sessionId: string; turnId: string; personaId: string;
  plan: SpeechPlan; plannerVersion: string;
}): Promise<ConversationSentence>;

getConversationSentenceForSynthesis(
  sentenceId: string,
  evaluatorUserId: string,
): Promise<(ConversationSentence & { voiceId: string }) | null>;

startTtsAttempt(input: {
  id: string; sentenceId: string; evaluatorUserId: string;
  voiceSource: "preset" | "dynamic"; providerVoiceId: string | null;
  ttsModel: string; ttsConfigVersion: string;
}): Promise<TtsAttempt>;

completeTtsAttempt(input: {
  id: string; evaluatorUserId: string; voiceSource: "preset" | "dynamic";
  fellBack: boolean; storageMs: number; providerMs: number; totalMs: number;
}): Promise<TtsAttempt>;

failTtsAttempt(input: {
  id: string; evaluatorUserId: string; stableErrorCode: string; totalMs: number;
}): Promise<boolean>;
```

Add `speechTrackingFailed: boolean` to `ConversationTurn` and `speechTrackingFailed: boolean` to `completeConversationTurn`. Map it to the Task 2 column. This is independent from retrieval/model degradation and does not overload the existing degradation enum.

- [ ] **Step 4: Persist before emission**

For every `SpeechPlanAccumulator` output, generate a sentence UUID, await persistence, then emit `{ sentence: { ...plan, sentenceId } }`. On failure, log stable IDs/error name, emit no sentence, keep the text response, and complete with `speechTrackingFailed=true` while preserving the real retrieval/model degradation reason.

- [ ] **Step 5: Extract an injectable TTS handler**

Move current TTS logic to `createTtsHandlers(dependencies)` in `src/lib/ttsRoute.ts`. For tracked requests, load stored sentence by user and replace every client value. Start the attempt after auth/authorization/rate limit and before provider call; complete/fail it in the response branch using exported model/config constants. Untracked requests preserve current behavior but write no attempt.

- [ ] **Step 6: Implement owner-scoped transactions**

Every query joins session→persona and checks evaluator. Allocate attempt numbers under a sentence lock/SQLite transaction. Completion/failure requires `status='started'`.

- [ ] **Step 7: Verify and commit**

```bash
node --import tsx --test tests/ttsRoute.test.ts tests/chatRoute.test.ts tests/speechPlanning.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/storageRouteBoundary.test.ts tests/voiceSynthesisService.test.ts
npm run typecheck
git add src/lib/storage/types.ts src/lib/db.ts src/lib/storage/repository.ts src/lib/storage/postgresRepository.ts src/lib/speechPlanning.ts src/lib/chatRoute.ts src/lib/ttsRoute.ts src/app/api/tts/route.ts tests/ttsRoute.test.ts tests/speechPlanning.test.ts tests/chatRoute.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/storageRouteBoundary.test.ts
git commit -m "feat: trace grounded speech synthesis attempts"
```

---

### Task 5: Receive idempotent playback events

**Files:** Create `src/lib/playbackEventRoute.ts`, `src/app/api/playback-event/route.ts`, `tests/playbackEventRoute.test.ts`; modify repository/types/adapters and boundary tests.

- [ ] **Step 1: Write failing API and persistence tests**

The exact POST body is:

```ts
{
  eventId: string;
  ttsAttemptId: string;
  eventType: "audio_ready" | "play_started" | "play_completed" | "play_failed";
  clientElapsedMs: number;
}
```

Test auth first, exact-key rejection, bounded IDs, integer elapsed `0..300000`, completed-attempt requirement, owner isolation, identical retry idempotency, conflicting reuse rejection, and absence of raw audio/text/free-form errors.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test tests/playbackEventRoute.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/storageRouteBoundary.test.ts
```

- [ ] **Step 3: Add the repository method**

```ts
recordPlaybackEvent(input: {
  eventId: string;
  ttsAttemptId: string;
  evaluatorUserId: string;
  eventType: PlaybackEventType;
  clientElapsedMs: number;
}): Promise<{ event: PlaybackEvent; created: boolean }>;
```

Join attempt→session and check the authenticated evaluator. Accept only a completed attempt. Return `created:false` only when an existing event has identical attempt/type/elapsed; otherwise throw `playback_event_conflict`.

- [ ] **Step 4: Implement strict DI handlers**

Follow `createChatHandlers`: authenticate, validate exact body shape, then write. Stable responses:

- `201 { ok:true, created:true }` new event;
- `200 { ok:true, created:false }` exact retry;
- `400` validation;
- `403` unknown/non-owned attempt without existence disclosure;
- `409` conflicting event ID;
- generic `500` persistence error.

Logs contain only event type, stable IDs, elapsed, and error name.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test tests/playbackEventRoute.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/storageRouteBoundary.test.ts
npm run typecheck
git add src/lib/playbackEventRoute.ts src/app/api/playback-event/route.ts src/lib/storage/types.ts src/lib/db.ts src/lib/storage/repository.ts src/lib/storage/postgresRepository.ts tests/playbackEventRoute.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/storageRouteBoundary.test.ts
git commit -m "feat: record grounded playback events"
```

---

### Task 6: Accept only eligible, complete, immutable feedback

**Files:** Create `src/lib/conversationFeedbackRoute.ts`, `src/app/api/conversation-feedback/route.ts`, `tests/conversationFeedbackRoute.test.ts`; modify repository/types/adapters and boundary tests.

- [ ] **Step 1: Write failing eligibility and submission tests**

The POST body is exactly:

```ts
{
  sessionId: string;
  evaluatorRelation: "self" | "family" | "friend" | "other";
  knowsVoiceOwner: true;
  heardAllRounds: true;
  voiceSimilarity: 1 | 2 | 3 | 4 | 5;
  expressionSimilarity: 1 | 2 | 3 | 4 | 5;
  emotionFit: 1 | 2 | 3 | 4 | 5;
  factTrust: 1 | 2 | 3 | 4 | 5;
  discomfort: 1 | 2 | 3 | 4 | 5;
  majorFabrication: boolean;
  identityImpersonation: boolean;
  authorizationViolation: boolean;
  comment?: string | null;
}
```

Cover missing/extra keys, non-integer scores, comment controls/length, cross-owner access, fewer than three audible turns, three attempts from only two turns, failed/boundary/unplayed turns, duplicate feedback, server cohort snapshot, red lines overriding scores, and transaction rollback.

GET `?sessionId=` returns only current-user eligibility and existing feedback status; never comments, sentence text, voice/provider IDs, or other-user existence.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test tests/conversationFeedbackRoute.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/storageRouteBoundary.test.ts
```

- [ ] **Step 3: Add repository methods**

```ts
getFeedbackEligibility(
  sessionId: string,
  evaluatorUserId: string,
): Promise<FeedbackEligibility | null>;

submitConversationFeedback(input: {
  id: string;
  sessionId: string;
  evaluatorUserId: string;
  evaluatorRelation: EvaluatorRelation;
  knowsVoiceOwner: true;
  heardAllRounds: true;
  scores: RestorationScores;
  comment: string | null;
}): Promise<ConversationFeedback>;
```

Eligibility contains only `completedAudibleTurnCount`, `requiredAudibleTurnCount:3`, `eligible`, `sessionStatus`, and `alreadySubmitted`.

- [ ] **Step 4: Implement one atomic qualification transaction**

Lock the owner-scoped active session; reject existing feedback; count distinct session turns where status is completed, mode is grounded/companionship, an attempt completed, and that attempt has `play_started`; require count `>=3` and both attestations; insert with session-owned persona/evaluator; mark session rated; return the row. No client count/cohort/persona/evaluator enters SQL.

- [ ] **Step 5: Implement stable route behavior**

Return `201 { feedbackId, sessionId, effective }`; GET eligibility as `200`; unknown/non-owner `403`; duplicate `409 FEEDBACK_ALREADY_SUBMITTED`; insufficient evidence `422 FEEDBACK_SESSION_NOT_ELIGIBLE` with current/required counts only; generic `500`. Never log comments or individual scores.

- [ ] **Step 6: Verify and commit**

```bash
node --import tsx --test tests/conversationFeedbackRoute.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/storageRouteBoundary.test.ts tests/restorationMetrics.test.ts
npm run typecheck
git add src/lib/conversationFeedbackRoute.ts src/app/api/conversation-feedback/route.ts src/lib/storage/types.ts src/lib/db.ts src/lib/storage/repository.ts src/lib/storage/postgresRepository.ts tests/conversationFeedbackRoute.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts tests/storageRouteBoundary.test.ts
git commit -m "feat: validate effective restoration feedback"
```

---

### Task 7: Produce an aggregate-only cohort report

**Files:** Create `scripts/report-restoration-feedback.ts`, `docs/verification/restoration-feedback.md`; modify repository/adapters, tests, package and operational docs.

- [ ] **Step 1: Write failing report-boundary tests**

Add:

```ts
listRestorationMetricRows(): Promise<RestorationMetricRow[]>;
```

Assert the query/result contains only session ID, evaluator user ID, cohort, five scores, and three booleans. It must exclude email, persona name, comment, sentence text, voice/provider IDs, and audio paths. Test zero rows, one cohort, both below gate, and both meeting gate.

- [ ] **Step 2: Verify RED**

```bash
node --import tsx --test tests/restorationMetrics.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts
```

- [ ] **Step 3: Implement report command**

Add:

```json
"report:restoration": "node --import tsx scripts/report-restoration-feedback.ts"
```

The script uses a dedicated read-only report data source, reads metric rows, calls `summarizeRestorationFeedback`, and prints JSON only. It must not call the SQLite `getDb()` initializer, create a missing database, initialize or migrate schema, change pragmas, or write Postgres. A missing local database means empty rows; an existing unmigrated or active-WAL database fails stably without changes. On configuration/storage failure, print stable `report_unavailable`, exit non-zero, and never dump connection strings or raw errors.

- [ ] **Step 4: Update operational truth**

Document the five scores, three red lines, three-audible-turn rule, and cohort gates. State that non-visual browser `play_started` sending is locally wired and tested, but is client-attested only; TTS success is not playback or listening completion; synthetic tests are not user proof; the first dry run is living 2 + deceased 2 people with 3 sessions each and does not pass the product; the real gate remains 10/30/60% in each cohort; real Preview browser + provider + database readback and push are separate gates.

- [ ] **Step 5: Verify and commit**

```bash
node --import tsx --test tests/restorationMetrics.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts
npm run --silent report:restoration
git diff --check
git add scripts/report-restoration-feedback.ts docs/verification/restoration-feedback.md src/lib/storage/types.ts src/lib/db.ts src/lib/storage/repository.ts src/lib/storage/postgresRepository.ts tests/restorationMetrics.test.ts tests/restorationFeedbackDb.test.ts tests/postgresRepository.test.ts package.json CLAUDE.md docs/handoff.md docs/verification/production-foundation.md
git commit -m "docs: report effective restoration evidence"
```

Empty data must produce zero/null summaries and `bothCohortsMeetInitialGate:false`, not a pass.

---

### Task 8: Complete local verification and stop before external changes

- [ ] **Step 1: Run focused bundle**

```bash
node --import tsx --test \
  tests/restorationMetrics.test.ts \
  tests/restorationFeedbackDb.test.ts \
  tests/playbackEventRoute.test.ts \
  tests/conversationFeedbackRoute.test.ts \
  tests/ttsRoute.test.ts \
  tests/chatRoute.test.ts \
  tests/speechPlanning.test.ts \
  tests/conversationGroundingDb.test.ts \
  tests/postgresRepository.test.ts \
  tests/storageRouteBoundary.test.ts \
  tests/voiceSynthesisService.test.ts
```

- [ ] **Step 2: Run full gate sequentially**

Do not parallelize typecheck/build because both use `.next`.

```bash
npm test
npm run db:migrate:dry
npm run typecheck
npm run build
npm run --silent report:restoration
git diff --check
git status --short
```

Expected: all tests pass; migration dry-run lists migration `006` and schema tests pass; build contains `/api/chat`, `/api/tts`, `/api/playback-event`, `/api/conversation-feedback`; report does not claim success; no unrelated/frontend file changed.

- [ ] **Step 3: Independent completion audit**

Review owner isolation for session/sentence/attempt/event/feedback; rejection of client identity/cohort/voice/text/model metadata; compare-and-set transactions; event idempotency; feedback immutability; three distinct turns rather than three sentences; red-line precedence; no secrets/audio/transcripts/comments/raw provider errors in logs/reports; local non-visual browser wiring and its client-attested-only boundary; explicit absence of real Preview browser + provider + database readback evidence and real cohorts.

- [ ] **Step 4: Stop before push/deploy**

Report commits and counts. Do not push, create Preview, change Vercel variables, provision Neon, or promote Production without explicit permission.

---

## Plan self-review

Spec coverage:

- North-star thresholds: Tasks 1, 6, 7.
- Living/deceased authorization snapshot: Tasks 2, 3.
- Three real audible turns: Tasks 4, 5, 6.
- Session/feedback boundaries: Tasks 2, 3, 6.
- Sentence→TTS→playback trace: Tasks 4, 5.
- Client cannot forge qualifying truth: Tasks 3–6.
- SQLite/Postgres parity: Tasks 2–7.
- No fake user/Preview evidence: Tasks 7, 8.
- No visual/frontend changes: locked scope and Task 8 audit.

Explicit remaining work after this plan:

- Non-visual browser event sending is locally wired and tested; real Preview browser lifecycle delivery, provider audio, deployed database readback, and listening completion remain external gates.
- Usable Preview still needs Neon, `STORAGE_BACKEND=cloud`, migrations, and explicit push.
- Real provider/model runs, 2+2 dry run, and final 10+10 cohorts remain external gates; `play_started` alone is not real-user proof.
- Voice-generation versioning, multi-material experiments, and sentence emotion correction follow real feedback rather than preceding it.
