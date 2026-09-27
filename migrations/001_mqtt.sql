-- Run once on an existing D1 database. Fresh databases use schema.sql instead.
ALTER TABLE readings ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_event_id ON readings (event_id);

CREATE TABLE IF NOT EXISTS device_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    is_light_on INTEGER NOT NULL,
    is_heater_on INTEGER NOT NULL,
    reported_at TEXT NOT NULL,
    event_id TEXT NOT NULL
);
