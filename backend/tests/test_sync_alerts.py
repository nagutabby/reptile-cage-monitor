"""Shadow 差分と更新停止の LINE 通知を確認する。"""

from datetime import datetime, timedelta, timezone

from app import sync_alerts


def test_shadow_mismatch_notifies_once_and_recovers(monkeypatch):
    now = datetime(2026, 9, 28, 0, 0, tzinfo=timezone.utc)
    row = {
        "desired_light": 1, "reported_light": 0,
        "desired_heater": 0, "reported_heater": 0,
        "updated_at": now.isoformat(),
    }
    alert = {"is_abnormal": 0, "last_alert_at": None}
    sent = []

    def query(sql, params=None):
        if sql.startswith("SELECT * FROM shadow_state"):
            return [row]
        if sql.startswith("SELECT is_abnormal"):
            return [alert.copy()]
        if sql.startswith("UPDATE sync_alert_state"):
            alert["is_abnormal"] = 0 if "is_abnormal = 0" in sql else 1
            if params:
                alert["last_alert_at"] = params[0]
        return []

    monkeypatch.setattr(sync_alerts.d1, "query", query)
    monkeypatch.setattr(sync_alerts.line_client, "push_message", sent.append)

    assert "ライト: desired=ON / reported=OFF" in sync_alerts.evaluate_and_notify(now)
    sync_alerts.evaluate_and_notify(now + timedelta(minutes=1))
    assert len(sent) == 1
    row["reported_light"] = 1
    row["updated_at"] = (now + timedelta(minutes=2)).isoformat()
    assert sync_alerts.evaluate_and_notify(now + timedelta(minutes=2)) == []
    assert alert["is_abnormal"] == 0


def test_stale_shadow_renotifies_hourly(monkeypatch):
    now = datetime(2026, 9, 28, 0, 0, tzinfo=timezone.utc)
    row = {
        "desired_light": 1, "reported_light": 1,
        "desired_heater": 0, "reported_heater": 0,
        "updated_at": (now - timedelta(minutes=4)).isoformat(),
    }
    alert = {"is_abnormal": 0, "last_alert_at": None}
    sent = []

    def query(sql, params=None):
        if sql.startswith("SELECT * FROM shadow_state"):
            return [row]
        if sql.startswith("SELECT is_abnormal"):
            return [alert.copy()]
        if sql.startswith("UPDATE sync_alert_state"):
            alert.update(is_abnormal=1, last_alert_at=params[0])
        return []

    monkeypatch.setattr(sync_alerts.d1, "query", query)
    monkeypatch.setattr(sync_alerts.line_client, "push_message", sent.append)

    sync_alerts.evaluate_and_notify(now)
    sync_alerts.evaluate_and_notify(now + timedelta(minutes=30))
    sync_alerts.evaluate_and_notify(now + timedelta(minutes=61))
    assert len(sent) == 2
    assert "状態報告が3分以上ありません" in sent[0]


def test_legacy_d1_boolean_strings_are_compared_correctly():
    now = datetime(2026, 9, 28, 0, 0, tzinfo=timezone.utc)
    row = {
        "desired_light": "false", "reported_light": "true",
        "desired_heater": "false", "reported_heater": "false",
        "updated_at": now.isoformat(),
    }
    assert sync_alerts._problems(row, now) == ["ライト: desired=OFF / reported=ON"]
