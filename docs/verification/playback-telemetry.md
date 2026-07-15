# Playback telemetry verification boundary

## Proven locally

- The browser data path carries `X-TTS-Attempt-ID` into the ordered playback item.
- Successful tracked playback reports `audio_ready`, `play_started`, and `play_completed`; a playback error reports `play_failed`.
- A reset cancels active playback or the inter-sentence pause without letting an older item clear the newer item's cancel handle.
- Requests use the same event ID across bounded retries, `keepalive`, a bounded timeout, and a page-lifecycle `sendBeacon` flush containing only the four allowed fields.
- The page-lifecycle cleanup synchronously tries the same beacon flush before removing its listeners, so a Next.js SPA unmount does not silently skip pending events. Beacon-accepted events are removed; rejected events stay in the bounded module queue for a later remount/flush rather than being mislabeled as delivered.
- SQLite enforces one row per `(tts_attempt_id, event_type)` and owner-scoped idempotency.
- Postgres repository tests verify the lock order, targetless `ON CONFLICT DO NOTHING`, composite unique-index migration, and created/idempotent/conflict result branches.

The stable idempotency rule is: the same attempt, event type, and elapsed time is an idempotent retry even if a restarted client proposes a new event ID; the stored original row is returned with `created:false`. Reusing an event ID for another attempt/type, or reporting another elapsed time for an already stored attempt/type, is a conflict. Migration `007` locks the table against concurrent writes, then deterministically keeps the earliest existing row by `received_at, event_id` before adding the cardinality constraint.

## Not proven locally

There is no reachable local PostgreSQL service on `127.0.0.1:5432`. The Postgres tests use a fake SQL executor and are SQL-contract tests, not evidence of real database concurrency. They must not be described as a live concurrent Postgres pass.

Before production promotion, apply migration `007_playback_event_cardinality.sql` to an isolated Preview database, send concurrent identical and conflicting playback requests, and verify directly that exactly one row exists for each `(tts_attempt_id, event_type)` and that at most one request reports `created:true`.

The local browser tests use controlled audio objects. Real browser lifecycle delivery, real provider audio, Preview authentication, and deployed database readback remain external verification gates.
