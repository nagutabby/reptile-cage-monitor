# reptile-cage-monitor

ヒョウモントカゲモドキ用ケージ監視システムのモノレポです。AWS CDK・Lambda API、Astro/Svelte監視画面、AtomS3ファームウェアをまとめて管理します。コード変更だけではAWSリソースを作成・更新しません。

## ディレクトリ

- `firmware/`: AtomS3のセンサー、プラグ制御、エアコンIR制御、検査用ファームウェア
- `frontend/site/`: AstroとSvelteの監視画面
- `bin/`、`lib/`、`lambda/`: AWS CDKとLambda
- `test/`: CDK・Lambdaのテスト

## 構成

- CloudFrontはOAC経由で非公開S3のAstroサイトを配信し、`/api/*`、`/control/*`、`/session`をHTTP APIへ転送します。
- Hono API Lambdaは履歴・現在状態・公開Cognito設定を返します。ライト操作とエアコン操作はAPI GatewayのCognito JWT authorizerで保護されます。
- IoT Coreのテレメトリ、機器状態、Device ShadowのルールはLambdaを呼びます。ヒーターは1分ごと、ライトはJST 7時と19時に動作します。
- DynamoDBはオンデマンド課金で、履歴、機器状態、Shadow、通知状態を保存します。履歴にTTLは設定しません。
- LINE Messaging APIのチャネルアクセストークンと送信先IDはParameter Store Standard SecureStringから読みます。
- CloudFrontのURLをCognito公開クライアントのOAuthコールバックに使い、ブラウザーではAuthorization Code + PKCEを使います。閲覧者はIdentity Poolのゲスト権限でMQTTライブ値を購読できます。

## ローカル確認

Node.js 24以降とAWS CDK v2を使います。AWSへ変更を加えない確認コマンドは次のとおりです。

```sh
pnpm install --frozen-lockfile
pnpm --dir frontend/site install --frozen-lockfile
pnpm run build
pnpm test
pnpm run build:site
pnpm run synth -- -c cognitoDomainPrefix=YOUR-GLOBALLY-UNIQUE-PREFIX -c iotEndpoint=YOUR-ENDPOINT-ats.iot.ap-northeast-1.amazonaws.com
```

監視画面の型検査とビルドは `pnpm --dir frontend/site run check` と `pnpm --dir frontend/site run build` でも個別に実行できます。ファームウェアは PlatformIO でビルドします。

```sh
pio run --project-dir firmware -e sensor-pub
pio run --project-dir firmware -e controller-sub
pio run --project-dir firmware -e ir-controller
```

この構成は旧スタックからの再構築用です。`ReptileCageMonitor` は旧スタックとは別のCloudFormationスタックIDです。旧スタックと保持リソースを削除してから作成するため、DynamoDBの履歴、Cognitoユーザー、IoT証明書は引き継がれません。ViewerEmailで招待ユーザーを作り直し、機器を新しい証明書で再設定してください。Route 53のホストゾーン、ACM証明書、AWS IoT endpoint、CDK bootstrap、GitHub OIDC providerはスタック外に残します。

再構築後の通常の変更では、`pnpm run synth`でテンプレートを生成し、`cdk diff`を確認してから適用します。`cdk deploy`はAWSリソースを変更します。初回はAWS CLIの`sso-admin-profile`でログインし、ViewerEmailと機器ごとのCSRを指定します。機器の既存秘密鍵を保ったまま、CSRを新Thing名で作成してください。

```sh
openssl req -new -key devices/sensor.key -out devices/sensor.csr -subj "/CN=reptile-cage-monitor-sensor"
openssl req -new -key devices/controller.key -out devices/controller.csr -subj "/CN=reptile-cage-monitor-controller"
openssl req -new -key devices/ir-controller.key -out devices/ir-controller.csr -subj "/CN=reptile-cage-monitor-ir-controller"
aws sso login --profile sso-admin-profile
AWS_PROFILE=sso-admin-profile pnpm exec cdk deploy ReptileCageMonitor \
  --parameters ReptileCageMonitor:ViewerEmail="$VIEWER_EMAIL" \
  --parameters ReptileCageMonitor:SensorCsr="$(cat devices/sensor.csr)" \
  --parameters ReptileCageMonitor:ControllerCsr="$(cat devices/controller.csr)" \
  --parameters ReptileCageMonitor:IRControllerCsr="$(cat devices/ir-controller.csr)"
```

LINE Messaging APIのSecureStringは新しい`/reptile-cage-monitor/line/`パスに登録します。再構築時に既存値を移行する場合は、値を端末出力やシェル履歴に表示せず、新しいSecureStringとして保存してから旧パラメーターを削除してください。

初回の公開にはCloudFormation bootstrapが必要です。`cdk deploy`、CDK bootstrap、IoTルール切替はAWSリソースを変更するため、このREADMEでは自動実行しません。

## カスタムドメイン

`monitor.app.nagutabby.uk` はRoute 53の公開ホストゾーン`app.nagutabby.uk`から配信し、親の`nagutabby.uk`ゾーンはCloudflareに残します。Cloudflare CLIで`app`のNSレコード4件をRoute 53へ委任します。CloudFront用ACM証明書は`us-east-1`でDNS検証し、CDKはCloudFrontの別名、Cognitoのコールバック／ログアウトURL、Route 53のA／AAAA Aliasを設定します。

ホストゾーンとACM証明書はCDKスタック外で作成します。`cdk.json`の`dashboardDomainName`、`dashboardCertificateArn`、`dashboardHostedZoneName`、`dashboardHostedZoneId`には、その環境の実値を設定してください。証明書検証CNAMEをRoute 53ゾーンに作成し、CloudflareでNS委任して証明書が`ISSUED`になった後に`cdk diff`を確認してから`cdk deploy`します。追加ホスト名を維持する場合は`dashboardAdditionalDomainName`と追加ゾーンの名前・IDも設定します。

## LINEパラメーター

値はGitやCDK contextに置かず、Standard階層のSecureStringとして登録します。LINE NotifyではなくLINE Messaging APIのチャネルアクセストークンと、push先のLINE user IDを登録してください。

```sh
aws ssm put-parameter --region ap-northeast-1 --name /reptile-cage-monitor/line/channel-access-token --type SecureString --tier Standard --value "$LINE_CHANNEL_ACCESS_TOKEN" --overwrite
aws ssm put-parameter --region ap-northeast-1 --name /reptile-cage-monitor/line/to-id --type SecureString --tier Standard --value "$LINE_TO_ID" --overwrite
```

別の名前を使う場合は`lineTokenParameterName`と`lineToParameterName`をCDK contextで指定します。関数ロールにはその2つのパラメーターの読み取り権限だけを付与します。

## 機器仕様

- Thing／MQTT client IDは`reptile-cage-monitor-sensor`、`reptile-cage-monitor-controller`、`reptile-cage-monitor-ir-controller`です。エアコンの操作はIRコントローラー専用のclassic Shadowと`reptile-cage-monitor/air-conditioner/state`を使います。
- エアコンはDaikin312形式です。Webの指定値（電源、冷房／暖房／ドライ、0.5℃刻みの設定温度、上下風向、風量）をShadow経由でIRコントローラーへ渡し、IRremoteESP8266の`IRDaikin312`で組み立てて送信します。それ以外の項目は実機リモコンから取得した初期値のままです。
- 温度が32°C未満ならヒーターON、32°C以上ならOFFです。3分を超えて新しい温度を受け取れない場合はヒーターONにします。
- 新しいShadowにライト状態がない場合、ヒーター処理が現時刻に合うライト状態を初期設定します。ライトの予定制御はJST 7:00 ON、19:00 OFFで、手動操作は次の予定時刻まで有効です。
- 24–32°C、湿度40–90%から外れた最初の値でLINE通知し、異常が続く場合は1時間間隔で再通知します。機器同期通知は実装しません。

## コスト

DynamoDBはオンデマンド、LambdaとHTTP APIは従量課金です。サイト配信はCloudFront Price Class 100を使います。東京リージョンで稼働し、独自ドメインのDNSにはRoute 53の公開ホストゾーンを使います。IoT Coreの接続・メッセージ・Shadow・ルール処理、CloudFront転送量、Route 53利用料を実利用量で見積もってください。

AWS Budgetsの月額予算は`monthly-5-usd-alert`（5 USD）です。実績80%・100%、予測100%の各アラートは従来の通知先を維持しています。Budgetは課金を停止しないため、Cost Explorerで実額も確認してください。
