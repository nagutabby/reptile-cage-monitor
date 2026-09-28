"""APIエンドポイントの認証・呼び出しの回帰テスト(D1/LINEへは実際には接続しない)。"""

import logging
import re

from fastapi.testclient import TestClient

from app import alerts, config
from app import d1 as d1_module
from app.main import MAX_LOOKBACK_MINUTES, app

client = TestClient(app)


def test_iot_destination_confirmation_accepts_base_url_with_slash(caplog):
    with caplog.at_level(logging.INFO, logger="reptile_monitor"):
        response = client.post(
            "/api/iot/?confirmationToken=example-token",
            json={"messageType": "DestinationConfirmation", "confirmationToken": "example-token"},
            follow_redirects=False,
        )

    assert response.status_code == 200
    assert "confirmationToken=example-token" in caplog.text


def test_list_readings_requires_api_key_header():
    resp = client.get("/api/readings")
    assert resp.status_code == 422  # ヘッダー自体が無い


def test_list_readings_rejects_wrong_api_key():
    resp = client.get("/api/readings", headers={"X-API-Key": "wrong-key"})
    assert resp.status_code == 401


def test_list_readings_filters_by_minutes(monkeypatch):
    queries = []
    fake_rows = [{"id": 1, "temp_c": 27.0, "humidity": 50.0, "recorded_at": "2026-09-21T00:00:00+00:00"}]
    monkeypatch.setattr(d1_module, "query", lambda sql, params=None: queries.append((sql, params)) or fake_rows)

    resp = client.get("/api/readings", headers={"X-API-Key": config.API_KEY}, params={"minutes": 30})

    assert resp.status_code == 200
    assert resp.json() == fake_rows
    assert len(queries) == 1
    sql, params = queries[0]
    assert "WHERE recorded_at >= ?" in sql
    assert "ORDER BY recorded_at ASC" in sql
    assert len(params) == 1  # cutoff(直近30分前の時刻)のみ
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00", params[0])


def test_list_readings_default_minutes_is_used_when_omitted(monkeypatch):
    queries = []
    monkeypatch.setattr(d1_module, "query", lambda sql, params=None: queries.append((sql, params)) or [])

    resp = client.get("/api/readings", headers={"X-API-Key": config.API_KEY})

    assert resp.status_code == 200
    assert len(queries) == 1


def test_list_readings_rejects_minutes_below_one():
    resp = client.get("/api/readings", headers={"X-API-Key": config.API_KEY}, params={"minutes": 0})
    assert resp.status_code == 422


def test_list_readings_rejects_minutes_beyond_one_week():
    resp = client.get(
        "/api/readings", headers={"X-API-Key": config.API_KEY}, params={"minutes": MAX_LOOKBACK_MINUTES + 1}
    )
    assert resp.status_code == 422


def test_list_readings_accepts_minutes_at_one_week_boundary(monkeypatch):
    monkeypatch.setattr(d1_module, "query", lambda sql, params=None: [])

    resp = client.get(
        "/api/readings", headers={"X-API-Key": config.API_KEY}, params={"minutes": MAX_LOOKBACK_MINUTES}
    )

    assert resp.status_code == 200


def test_device_state_requires_api_key_header():
    resp = client.get("/api/device_state")
    assert resp.status_code == 422  # ヘッダー自体が無い


def test_device_state_returns_latest_non_null_values(monkeypatch):
    queries = []

    def fake_query(sql, params=None):
        queries.append(sql)
        if "FROM device_state" in sql:
            return []
        if "is_light_on" in sql:
            return [{"is_light_on": 1, "recorded_at": "2026-09-22T10:00:00+00:00"}]
        return [{"is_heater_on": 0, "recorded_at": "2026-09-22T09:00:00+00:00"}]

    monkeypatch.setattr(d1_module, "query", fake_query)

    resp = client.get("/api/device_state", headers={"X-API-Key": config.API_KEY})

    assert resp.status_code == 200
    assert resp.json() == {
        "is_light_on": True,
        "is_light_on_changed_at": "2026-09-22T10:00:00+00:00",
        "is_heater_on": False,
        "is_heater_on_changed_at": "2026-09-22T09:00:00+00:00",
    }
    assert len(queries) == 3


def test_device_state_is_null_when_never_reported(monkeypatch):
    monkeypatch.setattr(d1_module, "query", lambda sql, params=None: [])

    resp = client.get("/api/device_state", headers={"X-API-Key": config.API_KEY})

    assert resp.status_code == 200
    assert resp.json() == {
        "is_light_on": None,
        "is_light_on_changed_at": None,
        "is_heater_on": None,
        "is_heater_on_changed_at": None,
    }


def test_create_reading_inserts_and_evaluates_alert(monkeypatch):
    inserted_sql = []
    monkeypatch.setattr(d1_module, "query", lambda sql, params=None: inserted_sql.append(sql) or [])

    notified = []
    monkeypatch.setattr(alerts, "evaluate_and_notify", lambda environment: notified.append(environment))

    resp = client.post(
        "/api/readings",
        headers={"X-API-Key": config.API_KEY},
        json={"temp_c": 27.0, "humidity": 50.0},
    )

    assert resp.status_code == 201
    assert len(notified) == 1
    assert notified[0].temperature.celsius == 27.0
    assert notified[0].humidity.percent == 50.0
    assert any(sql.startswith("INSERT") for sql in inserted_sql)


def test_create_reading_accepts_optional_device_state(monkeypatch):
    inserted_params = []
    monkeypatch.setattr(
        d1_module, "query", lambda sql, params=None: inserted_params.append(params) or []
    )
    monkeypatch.setattr(alerts, "evaluate_and_notify", lambda environment: None)

    resp = client.post(
        "/api/readings",
        headers={"X-API-Key": config.API_KEY},
        json={"temp_c": 27.0, "humidity": 50.0, "is_light_on": True, "is_heater_on": False},
    )

    assert resp.status_code == 201
    assert inserted_params == [[27.0, 50.0, True, False, inserted_params[0][4]]]
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00", inserted_params[0][4])


def test_create_reading_rejects_out_of_range_temp_c():
    resp = client.post(
        "/api/readings",
        headers={"X-API-Key": config.API_KEY},
        json={"temp_c": 60.1, "humidity": 50.0},
    )
    assert resp.status_code == 422


def test_create_reading_rejects_out_of_range_humidity():
    resp = client.post(
        "/api/readings",
        headers={"X-API-Key": config.API_KEY},
        json={"temp_c": 27.0, "humidity": 100.1},
    )
    assert resp.status_code == 422


def test_create_reading_stores_null_when_device_state_omitted(monkeypatch):
    inserted_params = []
    monkeypatch.setattr(
        d1_module, "query", lambda sql, params=None: inserted_params.append(params) or []
    )
    monkeypatch.setattr(alerts, "evaluate_and_notify", lambda environment: None)

    resp = client.post(
        "/api/readings",
        headers={"X-API-Key": config.API_KEY},
        json={"temp_c": 27.0, "humidity": 50.0},
    )

    assert resp.status_code == 201
    assert inserted_params == [[27.0, 50.0, None, None, inserted_params[0][4]]]


def test_iot_telemetry_is_idempotent_and_alerts_once(monkeypatch):
    queries = []
    inserts = iter([[{"id": 1}], []])
    monkeypatch.setattr(d1_module, "query", lambda sql, params=None: queries.append((sql, params)) or next(inserts))
    notified = []
    monkeypatch.setattr(alerts, "evaluate_and_notify", lambda environment: notified.append(environment))
    payload = {
        "event_id": "sensor-123-1",
        "observed_at": "2026-09-27T10:00:00.123456+09:00",
        "temp_c": 27,
        "humidity": 50,
    }

    first = client.post("/api/iot/telemetry", headers={"X-IoT-Key": "test-iot-key"}, json=payload)
    second = client.post("/api/iot/telemetry", headers={"X-IoT-Key": "test-iot-key"}, json=payload)

    assert first.json() == {"status": "ok", "inserted": True}
    assert second.json() == {"status": "ok", "inserted": False}
    assert len(notified) == 1
    assert queries[0][1] == ["sensor-123-1", 27.0, 50.0, "2026-09-27T01:00:00+00:00"]


def test_shadow_documents_keep_latest_version(monkeypatch):
    queries = []
    monkeypatch.setattr(d1_module, "query", lambda sql, params=None: queries.append((sql, params)) or [])
    document = {
        "current": {
            "version": 4,
            "state": {
                "desired": {"is_light_on": True, "is_heater_on": False},
                "reported": {"is_light_on": False, "is_heater_on": False},
            },
        },
        "timestamp": 1790553600,
    }
    response = client.post("/api/iot/shadow", headers={"X-IoT-Key": "test-iot-key"}, json=document)
    assert response.status_code == 200
    assert "excluded.version > shadow_state.version" in queries[0][0]
    assert queries[0][1][:5] == [4, 1, 0, 0, 0]
    assert client.post("/api/iot/check-sync", headers={"X-IoT-Key": "test-iot-key"}).status_code == 404


def test_iot_ingest_rejects_wrong_key_and_invalid_measurement(monkeypatch):
    monkeypatch.setattr(d1_module, "query", lambda sql, params=None: (_ for _ in ()).throw(AssertionError("unexpected query")))
    payload = {"event_id": "sensor-123-1", "observed_at": "2026-09-27T01:00:00Z", "temp_c": 27, "humidity": 50}
    assert client.post("/api/iot/telemetry", headers={"X-IoT-Key": "wrong"}, json=payload).status_code == 401
    payload["temp_c"] = 100
    assert client.post("/api/iot/telemetry", headers={"X-IoT-Key": "test-iot-key"}, json=payload).status_code == 422


def test_iot_state_updates_current_state(monkeypatch):
    queries = []
    monkeypatch.setattr(d1_module, "query", lambda sql, params=None: queries.append((sql, params)) or [])
    payload = {
        "event_id": "controller-123-1",
        "observed_at": "2026-09-27T10:00:00.123456+09:00",
        "is_light_on": True,
        "is_heater_on": False,
    }
    resp = client.post("/api/iot/state", headers={"X-IoT-Key": "test-iot-key"}, json=payload)
    assert resp.status_code == 200
    assert "excluded.reported_at > device_state.reported_at" in queries[0][0]
    assert queries[0][1] == [True, False, "2026-09-27T01:00:00+00:00", "controller-123-1"]


def test_device_state_prefers_mqtt_report(monkeypatch):
    monkeypatch.setattr(
        d1_module,
        "query",
        lambda sql, params=None: [
            {"is_light_on": 1, "is_heater_on": 0, "reported_at": "2026-09-27T01:00:00+00:00"}
        ],
    )
    resp = client.get("/api/device_state", headers={"X-API-Key": config.API_KEY})
    assert resp.status_code == 200
    assert resp.json()["is_light_on"] is True
    assert resp.json()["is_heater_on"] is False
