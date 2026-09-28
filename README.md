# reptile-iot-cdk

ヒョウモントカゲモドキのケージ用 AWS リソースを管理する、独立した **Python AWS CDK** リポジトリです。CDK コードを push するだけでは AWS リソースは作成されません。デプロイは運用者が明示的に行います。

東京リージョンに、M5Stack 2 台の IoT Thing・証明書・個別 MQTT ポリシー、Cognito 閲覧者ログインと未ログイン閲覧用 Identity Pool ロール、WebSocket 用の一時認証情報 API、IoT Core から既存 FastAPI への HTTP ルール、ingest key とエラー保存先を定義します。Web 閲覧者には telemetry/state とコントローラー Shadow の受信権限、Shadow 取得要求の送信権限を与えます。Lambda が温度と時刻に応じて Shadow の `desired` を更新し、認証済み API からライトだけを手動切替できます。Shadow の更新停止を検出する Lambda は5分ごとにバックエンドを呼びます。

ヒーター Lambda は1分ごとに retained 温度を確認し、32°C 未満なら ON、以上なら OFF を指示します。温度が3分以上届かない場合は ON を指示します。ライトは JST 7:00 に ON、19:00 に OFF を指示します。手動切替は次の時刻イベントまで有効です。新しい Shadow が空の場合、ヒーター Lambda が現在の時間帯に合わせてライトの初期値も設定します。

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

`cdk bootstrap` と `cdk deploy` は AWS リソースを作成します。ユーザーからデプロイ指示がある時だけ実行してください。デプロイ時には上記 4 つの context に加え、`--parameters SensorCsr="$(cat devices/sensor.csr)"`、`--parameters ControllerCsr="$(cat devices/controller.csr)"`、`--parameters ViewerEmail=閲覧者のメールアドレス` を指定します。初回は CDK bootstrap が必要です。閲覧者のメールアドレスは Git に保存せず、Cognito の招待メールから初回ログインします。招待に含まれる仮パスワードの有効期限は 7 日です。

デプロイ後は stack outputs の証明書 ARN に対応する certificate ID で `aws iot describe-certificate` を呼び、各 PEM を取得します。Amazon Root CA 1、秘密鍵、証明書、IoT endpoint を [AtomS3 側](../atoms3-reptile-cage/) の機器別設定に格納します。

Secrets Manager の `IngestSecretArn` にある `key` を Render の `IOT_INGEST_KEY` に設定します。IoT HTTP destination の確認トークンは FastAPI の `/api/iot` が Render のログに出力するので、確認後に `aws iot confirm-topic-rule-destination` と `aws iot update-topic-rule-destination --status ENABLED` を実行します。Render への HTTPS 接続とルールの送信結果を確認してください。

Cognito app client の secret と User Pool ID を [Streamlit 側](../reptile-monitor/frontend/.streamlit/secrets.toml.example) に設定します。閲覧用 MQTT は未ログインでもゲスト Identity Pool ロールで購読できます。閲覧者アカウントは CDK が作成します。client secret や機器秘密鍵を Git に push しないでください。
Stack output の `LightControlUrl` を Streamlit の `LIGHT_CONTROL_URL` に設定します。CDK を先にデプロイし、Shadow の `desired` が Lambda で更新されることを確認してからコントローラーに新しいファームウェアを書き込みます。CDK デプロイだけでは実機の制御経路は切り替わりません。

## 月額コストの事前見積もり

2026-09-28 時点の旧構成は、Shadow を毎分更新する場合の概算 **$1.2/月** でした。新構成はヒーター制御 Lambda と retained メッセージ取得を毎分実行するため、料金を再見積もりしてからデプロイしてください。Shadow の更新は目標値が変わった時だけ行います。アカウント全体の3 USD予算は利用を停止しません。

AWS Budgets には、ユーザー指定により AWS CLI でアカウント全体の月額 **3 USD** 予算 `monthly-3-usd-alert` を別途作成済みです。実績 80%・100% と予測 100% で `nagutabby@nagutabby.uk` に通知します。予算は課金を停止しません。デプロイ後は Cost Explorer の実績と照合します。

料金の根拠: [AWS IoT Core](https://aws.amazon.com/iot-core/pricing/)、[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/)、[Cognito](https://aws.amazon.com/cognito/pricing/)、[API Gateway](https://aws.amazon.com/api-gateway/pricing/)。
