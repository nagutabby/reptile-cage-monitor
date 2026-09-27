"""Shadow の desired/reported 差分と更新停止を LINE に通知する。"""

from datetime import datetime, timezone

from . import config, d1, line_client
from .time_format import utc_seconds


def _state() -> dict | None:
    rows = d1.query("SELECT * FROM shadow_state WHERE id = 1")
    return rows[0] if rows else None


def _problems(row: dict, now: datetime) -> list[str]:
    problems = []
    updated_at = datetime.fromisoformat(row["updated_at"])
    if (now - updated_at).total_seconds() > config.SHADOW_STALE_SECONDS:
        problems.append("コントローラーからの状態報告が3分以上ありません")
    for name, desired_key, reported_key in (
        ("ライト", "desired_light", "reported_light"),
        ("パネルヒーター", "desired_heater", "reported_heater"),
    ):
        desired = row[desired_key]
        reported = row[reported_key]
        if desired is not None and (reported is None or bool(desired) != bool(reported)):
            actual = "不明" if reported is None else ("ON" if reported else "OFF")
            problems.append(f"{name}: desired={'ON' if desired else 'OFF'} / reported={actual}")
    return problems


def evaluate_and_notify(now: datetime | None = None) -> list[str]:
    row = _state()
    if row is None:
        return []  # 初回の Shadow 更新まで監視対象がない
    now = now or datetime.now(timezone.utc)
    problems = _problems(row, now)
    previous = d1.query("SELECT is_abnormal, last_alert_at FROM sync_alert_state WHERE id = 1")[0]
    was_abnormal = bool(previous["is_abnormal"])
    last_alert_at = datetime.fromisoformat(previous["last_alert_at"]) if previous["last_alert_at"] else None
    if not problems:
        if was_abnormal:
            d1.query("UPDATE sync_alert_state SET is_abnormal = 0 WHERE id = 1")
        return []
    if not was_abnormal or last_alert_at is None or (now - last_alert_at).total_seconds() >= config.ALERT_RESEND_INTERVAL_SEC:
        line_client.push_message("[状態同期異常] ヒョウモントカゲモドキ ケージ\n" + "\n".join(problems))
        d1.query(
            "UPDATE sync_alert_state SET is_abnormal = 1, last_alert_at = ? WHERE id = 1",
            [utc_seconds(now)],
        )
    return problems
