# reptile-cage-monitor firmware

ヒョウモントカゲモドキ用ケージの AtomS3 ファームウェア。センサー、ライト／ヒーター制御、エアコン制御用に端末ごとに異なる証明書でAWS IoT Coreへ接続します。

| 環境 | 役割 | MQTT 権限 |
| --- | --- | --- |
| `sensor-pub` | SwitchBot 温湿度計を BLE で読み、1 分ごとに測定値を送信 | `reptile-cage-monitor/cage/telemetry` への publish のみ |
| `controller-sub` | AtomS3 のボタンでライトを現在状態から切り替え、Shadow の `desired` を受けてプラグを操作し、実状態を報告 | Shadow の get/delta を購読、`reptile-cage-monitor/cage/state` と Shadow の `desired` / `reported` を publish |
| `ir-controller` | Webから受け取ったDaikin312の運転設定をUnit IRで送信 | 専用Shadowの get/delta を購読、`reptile-cage-monitor/air-conditioner/state` と Shadow の `reported` を publish |
| `inspection` | SwitchBot プラグの接続確認 | MQTT なし |

ライトの時刻制御とヒーターの温度判定は AWS Lambda が行い、Device Shadow の `desired` に書き込みます。AtomS3 の画面は常時点灯し、ライトとヒーターの BLE 確認状態を表示します。ボタンを押すとライトの現在状態を BLE で読み、反対の状態へ切り替えた後、その値を Shadow の `desired.is_light_on` に送信します。コントローラーは起動・再接続時に Shadow を取得し、以後の差分を受けてプラグを操作します。ボタン操作で Shadow への送信に失敗した場合は、接続後に再送します。
コントローラーは1分ごとにプラグから確認した状態を Shadow の `reported` に送ります。`desired` との不一致や3分を超える報告停止は Web と LINE で警告します。

## 準備

AWS IoT Core の Thing、証明書、ポリシーは [リポジトリルート](../README.md) の TypeScript CDK で管理します。各機器の秘密鍵と CSR はリポジトリの手順に従ってローカルで生成し、秘密鍵を Git に含めないでください。

```sh
cp include/wifi_config.h.example include/wifi_config.h
cp include/iot_config.h.example include/iot_config_sensor.h
cp include/iot_config.h.example include/iot_config_controller.h
cp include/iot_config.h.example include/iot_config_ir_controller.h
```

`wifi_config.h` に Wi-Fi 情報を設定します。IoT 設定ファイルには CDK の IoT endpoint、Amazon Root CA 1、各機器に対応する証明書と秘密鍵を PEM 形式で設定します。端末間で証明書や秘密鍵を共有しないでください。これらの設定ファイルは Git から除外されます。

## エアコンIRコントローラー

Unit IRをAtomS3のGrove端子に接続します。AtomS3側のG2が送信ピンです。Web画面で電源、モード、10〜32℃（0.5℃刻み）、風量、上下左右風向、湿度、センサー・省エネ・清掃などの機能を選び、赤外線送信を指示します。AWS IoT Coreの専用Thing Shadow `desired` に設定一式が書き込まれ、AtomS3がIRremoteESP8266の`IRDaikin312`で状態フレームとチェックサムを生成し、36.7kHzで送信します。

静音とパワフルはDaikin312プロトコル上で同時に設定できないため、画面でも片方を選ぶともう片方が解除されます。湿度は暖房／除湿モードで選べる有効範囲が異なります。送信結果はIR LEDから信号を出したことを示し、エアコン本体の受信や動作までは確認しません。送信IDをNVSに保存して、Shadow再取得時の重複送信を防ぎます。

## ビルド・書き込み

```sh
pio run --project-dir firmware -e sensor-pub
pio run --project-dir firmware -e controller-sub
pio run --project-dir firmware -e ir-controller
pio run --project-dir firmware -e sensor-pub --target upload --upload-port /dev/cu.usbmodemXXXX
pio run --project-dir firmware -e controller-sub --target upload --upload-port /dev/cu.usbmodemYYYY
pio run --project-dir firmware -e ir-controller --target upload --upload-port /dev/cu.usbmodemZZZZ
```

動作確認はシリアルログ、IoT Core の MQTT テストクライアント、Web アプリのライブ画面で行います。IoT endpoint と証明書はデプロイ後に設定するため、ローカルのビルド成功だけでは実通信を確認できません。
