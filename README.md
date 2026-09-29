# reptile-monitor

ヒョウモントカゲモドキのケージを監視する Web アプリです。構成は [Python CDK](../reptile-iot-cdk/) と [AtomS3 ファームウェア](../atoms3-reptile-cage/) を参照してください。

| 部分 | 役割 |
| --- | --- |
| `backend/` | Render 上の FastAPI。IoT Core の HTTP ルールから測定値・制御状態・Shadow を受け、Cloudflare D1 に保存し、温湿度の異常値を LINE 通知 |
| `frontend/` | Streamlit。全員に MQTT のライブ値を表示し、ログイン済みユーザーにライトの手動切替を提供。履歴は FastAPI から取得 |
| `schema.sql` / `migrations/` | 新規 D1 データベース用 / 既存 D1 データベースの段階的な移行用 SQL |

## セットアップ

1. 既存の D1 データベースには `migrations/001_mqtt.sql`、`002_normalize_timestamps.sql`、`003_shadow_sync.sql` を番号順に `wrangler d1 execute reptile-monitor --remote --file <ファイル>` で適用します。新規 DB には `schema.sql` を使います。保存時刻は秒精度の UTC (`+00:00`) で統一します。
2. Render の `render.yaml` で backend をデプロイし、D1 と LINE の既存設定を維持します。IoT Core の ingest key は CDK が Secrets Manager に作成するため、デプロイ後に取得して Render の `IOT_INGEST_KEY` に設定します。
3. [reptile-iot-cdk](../reptile-iot-cdk/) を synth・deploy します。IoT HTTP destination の確認もその README に従います。デプロイ後、Render の `COGNITO_METADATA_URL` に Cognito User Pool の OIDC metadata URL (`https://cognito-idp.<region>.amazonaws.com/<user-pool-id>/.well-known/openid-configuration`) を設定します。
4. Streamlit Community Cloud の secrets に `frontend/.streamlit/secrets.toml.example` にある FastAPI と Cognito の値を設定します。`server_metadata_url` は FastAPI backend の `/auth/cognito/.well-known/openid-configuration` を指定します。この経由先は Cognito の metadata から `end_session_endpoint` を除き、Streamlit のログアウトをアプリ内で完了させます。IoT の Identity Pool ID・endpoint とライト操作 API の URL は公開情報としてアプリに設定済みです。ライト操作には Cognito ログインが必要です。別の AWS スタックを使う場合は `LIGHT_CONTROL_URL` を設定します。
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
