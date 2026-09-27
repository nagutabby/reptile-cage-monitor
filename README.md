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

Secrets Manager の `IngestSecretArn` にある `key` を Render の `IOT_INGEST_KEY` に設定します。IoT HTTP destination の確認トークンは FastAPI の `/api/iot` が Render のログに出力するので、確認後に `aws iot confirm-topic-rule-destination` と `aws iot update-topic-rule-destination --status ENABLED` を実行します。Render への HTTPS 接続とルールの送信結果を確認してください。

Cognito app client の secret、User Pool ID、`SessionUrl` を [Streamlit 側](../reptile-monitor/frontend/.streamlit/secrets.toml.example) に設定し、閲覧者アカウントを作成します。これらの実値や機器秘密鍵を Git に push しないでください。

## 月額コストの事前見積もり

2026-09-27 時点。東京リージョン、温湿度を毎分 1 件、状態を 1 日 4 件、Web を 1 日 1 時間閲覧、30 日稼働と仮定します。AWS Price List API の東京料金を使うと、IoT Core のメッセージ・接続・ルールは約 **$0.13/月**、Secrets Manager は 1 secret とルール実行ごとに 1 回の取得を仮定して約 **$0.62/月**、合計約 **$0.75/月** です。API Gateway、Lambda、S3 エラー保存、CloudWatch Logs、Cognito はこの小規模利用では少額または無料枠内と見込みます。実際のトラフィック、無料枠の共有状況、ログ量、失敗時のリトライ、為替で変動します。

AWS Budgets には、ユーザー指定により AWS CLI でアカウント全体の月額 **3 USD** 予算 `monthly-3-usd-alert` を別途作成済みです。実績 80%・100% と予測 100% で `nagutabby@nagutabby.uk` に通知します。予算は課金を停止しません。デプロイ後は Cost Explorer の実績と照合します。

料金の根拠: [AWS IoT Core](https://aws.amazon.com/iot-core/pricing/)、[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/)、[Cognito](https://aws.amazon.com/cognito/pricing/)、[API Gateway](https://aws.amazon.com/api-gateway/pricing/)。
