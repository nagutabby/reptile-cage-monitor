# reptile-cage-monitor-site

Astro（Svelte、TypeScript）で作ったケージ監視画面です。AWS上のCloudFrontと非公開S3から配信し、ライブ表示にはAWS IoT CoreのMQTT、履歴にはHono APIとDynamoDBを使います。インフラとLambdaのコードは[リポジトリルート](../README.md)で管理します。

ログインせずにライブ値・履歴を閲覧できます。Cognitoでログインするとライトを切り替え、エアコン（電源、冷房／暖房、設定温度、上下風向、風量）へ設定を送信できます。履歴は30分、6時間、12時間、1日、1週間から表示範囲を選択できます。

## ローカルビルド

Node.js 24以降を使います。

```sh
pnpm --dir frontend/site install --frozen-lockfile
pnpm --dir frontend/site run check
pnpm --dir frontend/site run build
```

出力は`site/dist/`です。デプロイ時はCDKのS3 deployment constructが非公開バケットへ配信し、CloudFrontのキャッシュを更新します。
