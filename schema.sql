CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    temp_c REAL NOT NULL,
    humidity REAL NOT NULL,
    -- 状態が変化したタイミングの行だけ値が入る(それ以外はNULL)。
    -- 現在値は「NULLでない最新行」を参照して求める。
    is_light_on INTEGER,
    is_heater_on INTEGER,
    recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_readings_recorded_at ON readings (recorded_at);

CREATE TABLE IF NOT EXISTS alert_state (
    id INTEGER PRIMARY KEY,
    is_abnormal INTEGER NOT NULL DEFAULT 0,
    last_alert_at TEXT
);

INSERT OR IGNORE INTO alert_state (id, is_abnormal, last_alert_at) VALUES (1, 0, NULL);

CREATE TABLE IF NOT EXISTS device_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    is_light_on INTEGER NOT NULL,
    is_heater_on INTEGER NOT NULL,
    reported_at TEXT NOT NULL,
    event_id TEXT NOT NULL
);

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
