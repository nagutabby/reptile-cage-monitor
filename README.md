# reptile-monitor

Astro（Svelte、TypeScript）で作ったケージ監視画面です。AWS上のCloudFrontと非公開S3から配信し、ライブ表示にはAWS IoT CoreのMQTT、履歴にはHono APIとDynamoDBを使います。インフラとLambdaのコードは[reptile-iot-cdk](../reptile-iot-cdk/)で管理します。

ログインせずにライブ値・履歴を閲覧でき、Cognitoでログインするとライトを切り替えられます。履歴は30分、6時間、12時間、1日、1週間から表示範囲を選択できます。

## ローカルビルド

Node.js 24以降を使います。

```sh
cd reptile-monitor/frontend/site
npm ci
npm run check
npm run build
```

出力は`frontend/site/dist/`です。デプロイ時はCDKのS3 deployment constructが非公開バケットへ配信し、CloudFrontのキャッシュを更新します。
