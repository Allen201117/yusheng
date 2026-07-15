LOCK TABLE playback_events IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM playback_events
WHERE event_id IN (
  SELECT event_id
  FROM (
    SELECT event_id,
           row_number() OVER (
             PARTITION BY tts_attempt_id, event_type
             ORDER BY received_at, event_id
           ) AS duplicate_rank
    FROM playback_events
  ) ranked
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_events_one_type_per_attempt
  ON playback_events(tts_attempt_id, event_type);
