import os

from dotenv import load_dotenv

load_dotenv()

API_KEY = os.environ["API_KEY"]
IOT_INGEST_KEY = os.environ.get("IOT_INGEST_KEY", "")

CLOUDFLARE_ACCOUNT_ID = os.environ["CLOUDFLARE_ACCOUNT_ID"]
CLOUDFLARE_D1_DATABASE_ID = os.environ["CLOUDFLARE_D1_DATABASE_ID"]
CLOUDFLARE_API_TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]

LINE_CHANNEL_ACCESS_TOKEN = os.environ["LINE_CHANNEL_ACCESS_TOKEN"]
LINE_TO_ID = os.environ["LINE_TO_ID"]

# 異常値判定のしきい値。機密情報ではないためコードの定数として管理する(.envには置かない)。
# ヒョウモントカゲモドキは乾燥系種。旧設計(ニシアフリカトカゲモドキ向け湿度55-70%)の
# 値は転用できない。飼育環境に応じて調整する場合はこの値を直接変更する。
TEMP_MIN_C = 24.0
TEMP_MAX_C = 32.0
HUMIDITY_MIN = 40.0
HUMIDITY_MAX = 90.0

ALERT_RESEND_INTERVAL_SEC = 60 * 60  # 異常が続いている間の再通知間隔(秒)
