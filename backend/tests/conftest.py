import os

# app.config はimport時にこれらの環境変数を必須で読むため、実際の値がない
# テスト環境でも import が通るようダミー値を入れておく(秘密情報は使わない)。
os.environ.setdefault("API_KEY", "test-api-key")
os.environ.setdefault("IOT_INGEST_KEY", "test-iot-key")
os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID", "test-account")
os.environ.setdefault("CLOUDFLARE_D1_DATABASE_ID", "test-db")
os.environ.setdefault("CLOUDFLARE_API_TOKEN", "test-token")
os.environ.setdefault("LINE_CHANNEL_ACCESS_TOKEN", "test-line-token")
os.environ.setdefault("LINE_TO_ID", "test-line-to")
