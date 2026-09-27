CREATE TABLE IF NOT EXISTS shadow_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    desired_light INTEGER,
    desired_heater INTEGER,
    reported_light INTEGER,
    reported_heater INTEGER,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_alert_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    is_abnormal INTEGER NOT NULL DEFAULT 0,
    last_alert_at TEXT
);

INSERT OR IGNORE INTO sync_alert_state (id, is_abnormal, last_alert_at) VALUES (1, 0, NULL);
