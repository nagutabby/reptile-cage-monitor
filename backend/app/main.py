import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import anyio.to_thread
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request

from . import alerts, config, d1
from .schemas import DeviceStateOut, IoTStateIn, IoTTelemetryIn, ReadingIn, ReadingOut
from .time_format import utc_seconds

logger = logging.getLogger("reptile_monitor")

MAX_LOOKBACK_MINUTES = 7 * 24 * 60  # 1週間

# 同期エンドポイント(D1/LINE APIへのブロッキング呼び出しを含む)を実行するスレッドプールの
# 上限。anyioのデフォルト(40)は実トラフィック(M5Stackから1分間隔+ダッシュボード閲覧程度)
# に対して過大で、外部APIが詰まった際にスレッドが積み上がりメモリを圧迫しうるため絞る。
THREAD_LIMIT = 5


@asynccontextmanager
async def lifespan(app: FastAPI):
    anyio.to_thread.current_default_thread_limiter().total_tokens = THREAD_LIMIT
    yield


app = FastAPI(title="Reptile Monitor API", lifespan=lifespan)


def verify_api_key(x_api_key: str = Header(...)) -> None:
    if x_api_key != config.API_KEY:
        raise HTTPException(status_code=401, detail="invalid API key")


def verify_iot_key(x_iot_key: str = Header(...)) -> None:
    if not config.IOT_INGEST_KEY or x_iot_key != config.IOT_INGEST_KEY:
        raise HTTPException(status_code=401, detail="invalid IoT ingest key")


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/api/readings", status_code=201, dependencies=[Depends(verify_api_key)])
def create_reading(reading: ReadingIn) -> dict:
    environment = reading.to_environment()
    now = utc_seconds(datetime.now(timezone.utc))
    d1.query(
        "INSERT INTO readings (temp_c, humidity, is_light_on, is_heater_on, recorded_at) VALUES (?, ?, ?, ?, ?)",
        [environment.temperature.celsius, environment.humidity.percent, reading.is_light_on, reading.is_heater_on, now],
    )
    alerts.evaluate_and_notify(environment)
    return {"status": "ok"}


@app.post("/api/iot/telemetry", dependencies=[Depends(verify_iot_key)])
def ingest_telemetry(reading: IoTTelemetryIn) -> dict:
    environment = reading.to_environment()
    recorded_at = utc_seconds(reading.observed_at)
    inserted = d1.query(
        "INSERT INTO readings (event_id, temp_c, humidity, recorded_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(event_id) DO NOTHING RETURNING id",
        [reading.event_id, environment.temperature.celsius, environment.humidity.percent, recorded_at],
    )
    if inserted:
        alerts.evaluate_and_notify(environment)
    return {"status": "ok", "inserted": bool(inserted)}


@app.post("/api/iot/state", dependencies=[Depends(verify_iot_key)])
def ingest_state(state: IoTStateIn) -> dict:
    reported_at = utc_seconds(state.observed_at)
    d1.query(
        "INSERT INTO device_state (id, is_light_on, is_heater_on, reported_at, event_id) "
        "VALUES (1, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET is_light_on = excluded.is_light_on, "
        "is_heater_on = excluded.is_heater_on, reported_at = excluded.reported_at, "
        "event_id = excluded.event_id WHERE excluded.reported_at > device_state.reported_at",
        [state.is_light_on, state.is_heater_on, reported_at, state.event_id],
    )
    return {"status": "ok"}


@app.post("/api/iot")
@app.post("/api/iot/")
async def confirm_iot_destination(request: Request) -> dict:
    # AWS IoT の HTTP destination 確認時だけ呼ばれる。確認操作は運用者が CLI で行う。
    body = await request.json()
    if body.get("messageType") == "DestinationConfirmation" and body.get("confirmationToken"):
        logger.info("[IoT destination] confirmationToken=%s", body["confirmationToken"])
    return {"status": "ok"}


@app.get("/api/readings", response_model=list[ReadingOut], dependencies=[Depends(verify_api_key)])
def list_readings(minutes: int = Query(default=360, ge=1, le=MAX_LOOKBACK_MINUTES)) -> list[dict]:
    cutoff = utc_seconds(datetime.now(timezone.utc) - timedelta(minutes=minutes))
    return d1.query(
        "SELECT id, temp_c, humidity, recorded_at FROM readings WHERE recorded_at >= ? ORDER BY recorded_at ASC",
        [cutoff],
    )


@app.get("/api/device_state", response_model=DeviceStateOut, dependencies=[Depends(verify_api_key)])
def get_device_state() -> dict:
    current = d1.query("SELECT is_light_on, is_heater_on, reported_at FROM device_state WHERE id = 1")
    if current:
        row = current[0]
        return {
            "is_light_on": row["is_light_on"],
            "is_light_on_changed_at": row["reported_at"],
            "is_heater_on": row["is_heater_on"],
            "is_heater_on_changed_at": row["reported_at"],
        }
    light = d1.query(
        "SELECT is_light_on, recorded_at FROM readings WHERE is_light_on IS NOT NULL ORDER BY recorded_at DESC LIMIT 1",
    )
    heater = d1.query(
        "SELECT is_heater_on, recorded_at FROM readings WHERE is_heater_on IS NOT NULL ORDER BY recorded_at DESC LIMIT 1",
    )
    light_row = light[0] if light else {}
    heater_row = heater[0] if heater else {}
    return {
        "is_light_on": light_row.get("is_light_on"),
        "is_light_on_changed_at": light_row.get("recorded_at"),
        "is_heater_on": heater_row.get("is_heater_on"),
        "is_heater_on_changed_at": heater_row.get("recorded_at"),
    }


# LINE_TO_ID(push先のuserId)を特定するための診断用エンドポイント。LINE Developers
# コンソールのWebhook URLにここを設定し、ボットにメッセージを送るとサーバーログに
# userIdが出力される。署名検証はしていない(ログ出力のみで副作用がなく、ID特定後は
# LINE側のWebhook設定を無効化して構わないため)。
@app.post("/api/line/webhook")
async def line_webhook(request: Request) -> dict:
    body = await request.json()
    for event in body.get("events", []):
        user_id = event.get("source", {}).get("userId")
        if user_id:
            logger.info("[LINE webhook] userId=%s", user_id)
    return {"status": "ok"}
