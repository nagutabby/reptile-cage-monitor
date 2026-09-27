"""Periodically ask the backend to detect stale controller shadow reports."""

import json
import os
from urllib.request import Request, urlopen

import boto3


_secrets = boto3.client("secretsmanager")


def handler(_event, _context):
    secret = _secrets.get_secret_value(SecretId=os.environ["INGEST_SECRET_ARN"])
    key = json.loads(secret["SecretString"])["key"]
    request = Request(
        os.environ["BACKEND_URL"], data=b"{}", method="POST",
        headers={"Content-Type": "application/json", "X-IoT-Key": key},
    )
    with urlopen(request, timeout=20) as response:
        return json.load(response)
