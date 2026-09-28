# atoms3-reptile-cage

ヒョウモントカゲモドキ用ケージの AtomS3 ファームウェア。2 台を別々に書き込み、AWS IoT Core の MQTT で通信します。

| 環境 | 役割 | MQTT 権限 |
| --- | --- | --- |
| `sensor-pub` | SwitchBot 温湿度計を BLE で読み、1 分ごとに測定値を送信 | `reptile/cage/telemetry` への publish のみ |
| `controller-sub` | Shadow の `desired` を受けてプラグを操作し、実状態を報告 | Shadow の get/delta を購読、`reptile/cage/state` と Shadow の `reported` を publish |
| `inspection` | SwitchBot プラグの接続確認 | MQTT なし |

ライトの時刻制御とヒーターの温度判定は AWS Lambda が行い、Device Shadow の `desired` に書き込みます。コントローラーは起動・再接続時に Shadow を取得し、以後の差分を受けてプラグを操作します。AWS に接続できない間は直前のプラグ状態を維持します。
コントローラーは1分ごとにプラグから確認した状態を Shadow の `reported` に送ります。`desired` との不一致や3分を超える報告停止は Web と LINE で警告します。

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
