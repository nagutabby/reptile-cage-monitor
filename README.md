# reptile-monitor

ヒョウモントカゲモドキのケージを監視する Web アプリです。構成は [Python CDK](../reptile-iot-cdk/) と [AtomS3 ファームウェア](../atoms3-reptile-cage/) を参照してください。

| 部分 | 役割 |
| --- | --- |
| `backend/` | Render 上の FastAPI。IoT Core の HTTP ルールから測定値・制御状態を受け、Cloudflare D1 に保存し、異常値を LINE 通知 |
| `frontend/` | Streamlit。ログイン状態に関係なく Cognito ゲスト認証情報で IoT Core MQTT over WebSocket のライブ値を表示。履歴は FastAPI から取得 |
| `schema.sql` / `migrations/001_mqtt.sql` | 新規 D1 データベース用 / 既存 D1 データベースの MQTT 移行用 SQL |

## セットアップ

1. 既存の D1 データベースには `wrangler d1 execute reptile-monitor --remote --file migrations/001_mqtt.sql` と `wrangler d1 execute reptile-monitor --remote --file migrations/002_normalize_timestamps.sql` を順に実行します。新規 DB には `schema.sql` を使います。保存時刻は秒精度の UTC (`+00:00`) で統一します。
2. Render の `render.yaml` で backend をデプロイし、D1 と LINE の既存設定を維持します。IoT Core の ingest key は CDK が Secrets Manager に作成するため、デプロイ後に取得して Render の `IOT_INGEST_KEY` に設定します。
3. [reptile-iot-cdk](../reptile-iot-cdk/) を synth・deploy します。IoT HTTP destination の確認もその README に従います。
4. Streamlit Community Cloud の secrets に `frontend/.streamlit/secrets.toml.example` にある FastAPI と Cognito の値を設定します。IoT の Identity Pool ID と endpoint は公開情報としてアプリに設定済みです。ログインを使う場合は Cognito に閲覧者を登録します。
5. フロントエンドの MQTT bundle を更新する場合は `cd frontend/live && npm ci && npm run build` を実行し、生成した `live-client.bundle.js` をコミットします。

Render の `API_KEY` は履歴 API 用で、`IOT_INGEST_KEY` は IoT Core の HTTP ルール専用です。M5Stack にどちらのキーも保存しません。

## ローカル実行とテスト

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q
```

```sh
cd frontend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .streamlit/secrets.toml.example .streamlit/secrets.toml
.venv/bin/streamlit run app.py
```

Streamlit のローカルログインは Cognito app client の callback URL に `http://localhost:8501/oauth2callback` を追加してから使用します。公開先 URL と異なる場合は CDK の `webBaseUrl` を実際の公開先に合わせてください。
