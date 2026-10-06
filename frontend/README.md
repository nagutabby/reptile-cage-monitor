# reptile-cage-monitor-site

Astro（Svelte、TypeScript）で作ったケージ監視画面です。AWS上のCloudFrontと非公開S3から配信し、ライブ表示にはAWS IoT CoreのMQTT、履歴にはHono APIとDynamoDBを使います。インフラとLambdaのコードは[リポジトリルート](../README.md)で管理します。

ログインせずにライブ値・履歴を閲覧できます。Cognitoでログインするとライトを切り替え、4つのエアコンIRプリセットを表示・編集して保存済み信号を送信できます。履歴は30分、6時間、12時間、1日、1週間から表示範囲を選択できます。IR信号の学習はUnit IR本体で行います。

## ローカルビルド

Node.js 24以降を使います。

```sh
pnpm --dir frontend/site install --frozen-lockfile
pnpm --dir frontend/site run check
pnpm --dir frontend/site run build
```

出力は`site/dist/`です。デプロイ時はCDKのS3 deployment constructが非公開バケットへ配信し、CloudFrontのキャッシュを更新します。
