# atoms3-reptile-cage

ヒョウモントカゲモドキ用ケージの AtomS3 ファームウェア。2 台を別々に書き込み、AWS IoT Core の MQTT で通信します。

| 環境 | 役割 | MQTT 権限 |
| --- | --- | --- |
| `sensor-pub` | SwitchBot 温湿度計を BLE で読み、1 分ごとに測定値を送信 | `reptile/cage/telemetry` への publish のみ |
| `controller-sub` | 測定値を受信してヒーターを制御し、JST 7–19 時に UVB ライトを制御 | telemetry の subscribe、`reptile/cage/state` と Device Shadow への publish |
| `inspection` | SwitchBot プラグの接続確認 | MQTT なし |

ヒーターは 32°C を境に ON/OFF します。測定値が届かない間は直前の状態を維持します。古い retained 測定値は制御に使いません。
コントローラーは1分ごとに Device Shadow の `desired`（自動制御の目標）と `reported`（プラグから確認した状態）を更新します。両者の不一致や3分を超える報告停止は Web と LINE で警告します。

## 準備

AWS IoT Core の Thing、証明書、ポリシーは [reptile-iot-cdk](../reptile-iot-cdk/) の Python CDK で管理します。各機器の秘密鍵と CSR はそのリポジトリの手順に従ってローカルで生成し、秘密鍵を Git に含めないでください。

```sh
cp include/wifi_config.h.example include/wifi_config.h
cp include/iot_config.h.example include/iot_config_sensor.h
cp include/iot_config.h.example include/iot_config_controller.h
```

`wifi_config.h` に Wi-Fi 情報を設定します。IoT 設定ファイルには CDK の IoT endpoint、Amazon Root CA 1、各機器に対応する証明書と秘密鍵を PEM 形式で設定します。両機器で証明書を共有しないでください。これらの設定ファイルは Git から除外されます。

## ビルド・書き込み

```sh
pio run -e sensor-pub
pio run -e controller-sub
pio run -e sensor-pub --target upload --upload-port /dev/cu.usbmodemXXXX
pio run -e controller-sub --target upload --upload-port /dev/cu.usbmodemYYYY
```

動作確認はシリアルログ、IoT Core の MQTT テストクライアント、Web アプリのライブ画面で行います。IoT endpoint と証明書はデプロイ後に設定するため、ローカルのビルド成功だけでは実通信を確認できません。
