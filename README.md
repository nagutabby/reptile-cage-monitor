# reptile-iot-cdk

ヒョウモントカゲモドキのケージ用 AWS リソースを管理する、独立した **Python AWS CDK** リポジトリです。CDK コードを push するだけでは AWS リソースは作成されません。デプロイは運用者が明示的に行います。

東京リージョンに、M5Stack 2 台の IoT Thing・証明書・個別 MQTT ポリシー、Cognito 閲覧者ログイン、WebSocket 用の一時認証情報 API、IoT Core から既存 FastAPI への HTTP ルール、ingest key とエラー保存先を定義します。Web 閲覧者には telemetry/state の受信権限だけを与えます。

## ローカルでの確認

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci
aws sso login --profile sso-admin-profile
export AWS_PROFILE=sso-admin-profile
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export IOT_ENDPOINT=$(aws iot describe-endpoint --region ap-northeast-1 --endpoint-type iot:Data-ATS --query endpointAddress --output text)
npm run synth -- \
  -c backendBaseUrl=https://YOUR-BACKEND.onrender.com \
  -c webBaseUrl=https://YOUR-APP.streamlit.app \
  -c cognitoDomainPrefix=YOUR-GLOBALLY-UNIQUE-PREFIX \
  -c iotEndpoint=$IOT_ENDPOINT
```

`synth` はテンプレート生成のみです。実際の公開 URL を指定してください。Cognito の domain prefix はリージョン内で利用可能な名前にします。認証済みの AWS SSO profile を使用し、アクセスキーをリポジトリに保存しません。

## デプロイ時に必要なもの

各 M5Stack の秘密鍵と CSR を別々にローカル生成します。`devices/` は Git 除外対象です。

```sh
mkdir -p devices
openssl ecparam -name prime256v1 -genkey -noout -out devices/sensor.key
openssl req -new -key devices/sensor.key -subj /CN=reptile-sensor -out devices/sensor.csr
openssl ecparam -name prime256v1 -genkey -noout -out devices/controller.key
openssl req -new -key devices/controller.key -subj /CN=reptile-controller -out devices/controller.csr
```

`cdk bootstrap` と `cdk deploy` は AWS リソースを作成します。ユーザーからデプロイ指示がある時だけ実行してください。デプロイ時には上記 4 つの context に加え、`--parameters SensorCsr="$(cat devices/sensor.csr)"` と `--parameters ControllerCsr="$(cat devices/controller.csr)"` を指定します。初回は CDK bootstrap が必要です。

デプロイ後は stack outputs の証明書 ARN に対応する certificate ID で `aws iot describe-certificate` を呼び、各 PEM を取得します。Amazon Root CA 1、秘密鍵、証明書、IoT endpoint を [AtomS3 側](../atoms3-reptile-cage/) の機器別設定に格納します。

Secrets Manager の `IngestSecretArn` にある `key` を Render の `IOT_INGEST_KEY` に設定します。IoT HTTP destination の確認トークンは FastAPI の `/api/iot/confirm` が Render のログに出力するので、確認後に `aws iot confirm-topic-rule-destination` を実行します。Render への HTTPS 接続とルールの送信結果を確認してください。

Cognito app client の secret、User Pool ID、`SessionUrl` を [Streamlit 側](../reptile-monitor/frontend/.streamlit/secrets.toml.example) に設定し、閲覧者アカウントを作成します。これらの実値や機器秘密鍵を Git に push しないでください。
