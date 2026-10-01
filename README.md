# reptile-iot-cdk

ヒョウモントカゲモドキのモニターをAWS上で動かすTypeScriptプロジェクトです。AstroとSvelteの静的サイトを非公開S3＋CloudFrontから配信し、Hono API・イベント処理・AWS CDKもTypeScriptで管理します。コード変更だけではAWSリソースを作成・更新しません。

## 構成

- CloudFrontはOAC経由で非公開S3のAstroサイトを配信し、`/api/*`、`/control/*`、`/session`をHTTP APIへ転送します。
- Hono API Lambdaは履歴・現在状態・公開Cognito設定を返します。ライト操作はAPI GatewayのCognito JWT authorizerで保護されます。
- IoT Coreのテレメトリ、機器状態、Device Shadowルールはイベント用Lambdaを直接呼びます。ヒーターは1分ごと、ライトはJST 7時と19時に動作します。
- DynamoDBはオンデマンド課金で、履歴、機器状態、Shadow、通知状態を保存します。履歴にTTLは設定しません。
- LINE Messaging APIのチャネルアクセストークンと送信先IDはParameter Store Standard SecureStringから読みます。
- CloudFrontのURLをCognito公開クライアントのOAuthコールバックに使い、ブラウザーではAuthorization Code + PKCEを使います。閲覧者はIdentity Poolのゲスト権限でMQTTライブ値を購読できます。

## ローカル確認

Node.js 24以降とAWS CDK v2を使います。AWSへ変更を加えない確認コマンドは次のとおりです。

```sh
cd reptile-iot-cdk
npm ci
npm run build
npm test
npm run build:site
npm run synth -- -c cognitoDomainPrefix=YOUR-GLOBALLY-UNIQUE-PREFIX -c iotEndpoint=YOUR-ENDPOINT-ats.iot.ap-northeast-1.amazonaws.com
```

`npm run synth`はCDKテンプレートをローカル生成するだけです。AWSへの適用前に`cdk diff`を確認してください。特にCognito User Pool、Identity Pool、IoT Thing、証明書の削除・置換がないことを確認します。旧Python CDKとConstruct ID／Stack IDを揃えていますが、CDK更新で論理IDやプロパティ差分が発生しないことをdiffで確認してから適用してください。

初回の公開にはCloudFormation bootstrapが必要です。`cdk deploy`、CDK bootstrap、IoTルール切替はAWSリソースを変更するため、このREADMEでは自動実行しません。

## LINEパラメーター

値はGitやCDK contextに置かず、Standard階層のSecureStringとして登録します。LINE NotifyではなくLINE Messaging APIのチャネルアクセストークンと、push先のLINE user IDを登録してください。

```sh
aws ssm put-parameter --region ap-northeast-1 --name /reptile-monitor/line/channel-access-token --type SecureString --tier Standard --value "$LINE_CHANNEL_ACCESS_TOKEN" --overwrite
aws ssm put-parameter --region ap-northeast-1 --name /reptile-monitor/line/to-id --type SecureString --tier Standard --value "$LINE_TO_ID" --overwrite
```

別の名前を使う場合は`lineTokenParameterName`と`lineToParameterName`をCDK contextで指定します。関数ロールにはその2つのパラメーターの読み取り権限だけを付与します。

## 機器仕様

- MQTTトピックは`reptile/cage/telemetry`と`reptile/cage/state`です。Device Shadowは`reptile-controller`の名前付きThingのclassic Shadowを使用します。
- 温度が32°C未満ならヒーターON、32°C以上ならOFFです。3分を超えて新しい温度を受け取れない場合はヒーターONにします。
- 新しいShadowにライト状態がない場合、ヒーター処理が現時刻に合うライト状態を初期設定します。ライトの予定制御はJST 7:00 ON、19:00 OFFで、手動操作は次の予定時刻まで有効です。
- 24–32°C、湿度40–90%から外れた最初の値でLINE通知し、異常が続く場合は1時間間隔で再通知します。機器同期通知は実装しません。

## コスト

DynamoDBはオンデマンド、LambdaとHTTP APIは従量課金です。サイト配信はCloudFront Price Class 100を使います。東京リージョンで稼働し、独自ドメインは追加しません。IoT Coreの接続・メッセージ・Shadow・ルール処理、CloudFront転送量を実利用量で見積もってください。

AWS Budgetsの月額予算は`monthly-5-usd-alert`（5 USD）です。実績80%・100%、予測100%の各アラートは従来の通知先を維持しています。Budgetは課金を停止しないため、Cost Explorerで実額も確認してください。
