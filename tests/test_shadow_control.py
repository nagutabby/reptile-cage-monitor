"""Behavior tests for cloud-owned Shadow commands."""

import importlib
import io
import json
import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


class FakeClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


boto3 = types.ModuleType("boto3")
botocore = types.ModuleType("botocore")
exceptions = types.ModuleType("botocore.exceptions")
exceptions.ClientError = FakeClientError
sys.modules.setdefault("boto3", boto3)
sys.modules.setdefault("botocore", botocore)
sys.modules.setdefault("botocore.exceptions", exceptions)
sys.path.insert(0, str(Path(__file__).parents[1] / "lambda"))
control = importlib.import_module("shadow_control")


class FakeIoTData:
    def __init__(self, shadow=None, retained=None):
        self.shadow = shadow or {"version": 1, "state": {"desired": {}}}
        self.retained = retained
        self.updates = []
        self.conflict_once = False

    def get_thing_shadow(self, **kwargs):
        return {"payload": io.BytesIO(json.dumps(self.shadow).encode())}

    def update_thing_shadow(self, **kwargs):
        if self.conflict_once:
            self.conflict_once = False
            raise FakeClientError("ConflictException")
        document = json.loads(kwargs["payload"])
        self.updates.append(document)
        self.shadow["state"]["desired"].update(document["state"]["desired"])
        self.shadow["version"] += 1

    def get_retained_message(self, **kwargs):
        if self.retained is None:
            raise FakeClientError("ResourceNotFoundException")
        return self.retained


class ShadowControlTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeIoTData()
        control._iot_data = self.client

    def test_heater_threshold_and_missing_temperature(self):
        now = datetime(2026, 9, 28, tzinfo=timezone.utc).timestamp()
        for temp, age, expected in ((31.9, 0, True), (32.0, 0, False), (31.9, 181, True)):
            with self.subTest(temp=temp, age=age):
                observed = datetime.fromtimestamp(now - age, timezone.utc).isoformat()
                self.client.retained = {
                    "payload": json.dumps({"observed_at": observed, "temp_c": temp}).encode(),
                    "lastModifiedTime": int((now - age) * 1000),
                }
                with patch.object(control.time, "time", return_value=now):
                    result = control.heater_handler({}, None)
                self.assertEqual(self.client.shadow["state"]["desired"]["is_heater_on"], expected)
                self.assertEqual(result["temperature_available"], not (age > 180))
        self.client.retained = None
        with patch.object(control.time, "time", return_value=now):
            control.heater_handler({}, None)
        self.assertTrue(self.client.shadow["state"]["desired"]["is_heater_on"])

    def test_manual_light_command_survives_late_schedule(self):
        self.client.shadow["state"]["desired"] = {
            "is_light_on": False, "light_command_at": 2000,
        }
        result = control.update_desired({"is_light_on": True, "light_command_at": 1000}, command_at=1000)
        self.assertEqual(result["status"], "superseded")
        self.assertEqual(self.client.updates, [])
        control.update_desired({"is_light_on": True, "light_command_at": 3000}, command_at=3000)
        self.assertEqual(self.client.shadow["state"]["desired"]["is_light_on"], True)

    def test_manual_endpoint_accepts_only_boolean_light_command(self):
        invalid = control.light_control_handler({"body": '{"is_light_on":1}'}, None)
        self.assertEqual(invalid["statusCode"], 400)
        self.assertEqual(control.light_control_handler({"body": "[]"}, None)["statusCode"], 400)
        with patch.object(control.time, "time", return_value=100):
            accepted = control.light_control_handler({"body": '{"is_light_on":false}'}, None)
        self.assertEqual(accepted["statusCode"], 200)
        self.assertEqual(self.client.shadow["state"]["desired"]["light_command_at"], 100000)

    def test_same_heater_value_does_not_rewrite_shadow(self):
        self.client.shadow["state"]["desired"]["is_heater_on"] = True
        result = control.update_desired({"is_heater_on": True})
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(self.client.updates, [])

    def test_conflict_is_retried_and_empty_light_is_seeded(self):
        self.client.conflict_once = True
        result = control.update_desired({"is_heater_on": True}, seed_light=True)
        self.assertEqual(result["status"], "updated")
        desired = self.client.shadow["state"]["desired"]
        self.assertIs(type(desired["is_light_on"]), bool)
        self.assertIs(type(desired["light_command_at"]), int)
        self.assertEqual(len(self.client.updates), 1)


if __name__ == "__main__":
    unittest.main()
