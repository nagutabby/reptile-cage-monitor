"""Cloud-owned desired state for the reptile controller."""

import json
import math
import os
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import boto3
from botocore.exceptions import ClientError


THING_NAME = "reptile-controller"
TELEMETRY_TOPIC = "reptile/cage/telemetry"
TEMPERATURE_LIMIT_C = 32.0
TEMPERATURE_MAX_AGE_SECONDS = 180
JST = ZoneInfo("Asia/Tokyo")

_iot_data = None


def iot_data():
    global _iot_data
    if _iot_data is None:
        _iot_data = boto3.client("iot-data", endpoint_url=f"https://{os.environ['IOT_ENDPOINT']}")
    return _iot_data


def get_shadow():
    try:
        response = iot_data().get_thing_shadow(thingName=THING_NAME)
    except ClientError as error:
        if error.response["Error"]["Code"] == "ResourceNotFoundException":
            return {"version": None, "state": {}}
        raise
    return json.loads(response["payload"].read())


def update_desired(values, *, command_at=None, seed_light=False):
    """Update only supplied keys; retry if another writer changed the shadow."""
    for _ in range(6):
        shadow = get_shadow()
        desired = shadow.get("state", {}).get("desired", {})
        if command_at is not None and desired.get("light_command_at", -1) > command_at:
            return {"status": "superseded"}
        changes = dict(values)
        if seed_light and "is_light_on" not in desired:
            now = datetime.now(JST)
            boundary_hour = 19 if now.hour >= 19 or now.hour < 7 else 7
            boundary = now.replace(hour=boundary_hour, minute=0, second=0, microsecond=0)
            if now.hour < 7:
                boundary -= timedelta(days=1)
            changes.update(is_light_on=boundary_hour == 7, light_command_at=int(boundary.timestamp() * 1000))
        if all(desired.get(key) == value for key, value in changes.items()):
            return {"status": "unchanged"}
        request = {"state": {"desired": changes}}
        if shadow.get("version") is not None:
            request["version"] = shadow["version"]
        try:
            iot_data().update_thing_shadow(thingName=THING_NAME, payload=json.dumps(request).encode())
            return {"status": "updated"}
        except ClientError as error:
            if error.response["Error"]["Code"] not in ("ConflictException", "VersionConflictException"):
                raise
    raise RuntimeError("Shadow remained in conflict after retries")


def _retained_temperature(now):
    try:
        message = iot_data().get_retained_message(topic=TELEMETRY_TOPIC)
    except ClientError as error:
        if error.response["Error"]["Code"] == "ResourceNotFoundException":
            return None
        raise
    try:
        reading = json.loads(message["payload"])
        observed = datetime.fromisoformat(reading["observed_at"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(reading, dict):
        return None
    if observed.tzinfo is None:
        return None
    age = now - observed.timestamp()
    stored_age = now - message["lastModifiedTime"] / 1000
    temp = reading.get("temp_c")
    if (not isinstance(temp, (float, int)) or isinstance(temp, bool) or not math.isfinite(temp)
            or age < 0 or age > TEMPERATURE_MAX_AGE_SECONDS
            or stored_age < 0 or stored_age > TEMPERATURE_MAX_AGE_SECONDS):
        return None
    return temp


def heater_handler(event, context):
    temp = _retained_temperature(time.time())
    result = update_desired({"is_heater_on": temp is None or temp < TEMPERATURE_LIMIT_C}, seed_light=True)
    return {**result, "temperature_available": temp is not None}


def light_schedule_handler(event, context):
    hour = event["hour"]
    if hour not in (7, 19):
        raise ValueError("invalid light schedule hour")
    now = datetime.now(JST)
    scheduled = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if abs((now - scheduled).total_seconds()) > 300:
        raise ValueError("light schedule event arrived outside its five-minute window")
    command_at = int(scheduled.timestamp() * 1000)
    return update_desired({"is_light_on": hour == 7, "light_command_at": command_at}, command_at=command_at)


def light_control_handler(event, context):
    try:
        body = json.loads(event.get("body") or "{}")
    except (TypeError, ValueError):
        body = {}
    if not isinstance(body, dict) or type(body.get("is_light_on")) is not bool:
        return {"statusCode": 400, "body": json.dumps({"error": "is_light_on must be boolean"})}
    command_at = int(time.time() * 1000)
    result = update_desired({"is_light_on": body["is_light_on"], "light_command_at": command_at}, command_at=command_at)
    return {"statusCode": 200, "headers": {"Content-Type": "application/json"}, "body": json.dumps(result)}
