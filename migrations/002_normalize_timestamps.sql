-- Existing UTC timestamps with microseconds become the canonical seconds-only format.
-- Run once after 001_mqtt.sql on an existing database. Safe to rerun.
UPDATE readings
SET recorded_at = substr(recorded_at, 1, 19) || '+00:00'
WHERE length(recorded_at) = 32
  AND substr(recorded_at, 20, 1) = '.'
  AND substr(recorded_at, -6) = '+00:00';

UPDATE device_state
SET reported_at = substr(reported_at, 1, 19) || '+00:00'
WHERE length(reported_at) = 32
  AND substr(reported_at, 20, 1) = '.'
  AND substr(reported_at, -6) = '+00:00';

UPDATE alert_state
SET last_alert_at = substr(last_alert_at, 1, 19) || '+00:00'
WHERE length(last_alert_at) = 32
  AND substr(last_alert_at, 20, 1) = '.'
  AND substr(last_alert_at, -6) = '+00:00';
