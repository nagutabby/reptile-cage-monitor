"""D1 に保存する UTC 時刻の表記を統一する。"""

from datetime import datetime, timezone


def utc_seconds(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds")
