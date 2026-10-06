# reptile-cage-monitor firmware

ヒョウモントカゲモドキ用ケージの AtomS3 ファームウェア。センサー、ライト／ヒーター制御、エアコン制御用に端末ごとに異なる証明書でAWS IoT Coreへ接続します。

| 環境 | 役割 | MQTT 権限 |
| --- | --- | --- |
| `sensor-pub` | SwitchBot 温湿度計を BLE で読み、1 分ごとに測定値を送信 | `reptile-cage-monitor/cage/telemetry` への publish のみ |
| `controller-sub` | AtomS3 のボタンでライトを現在状態から切り替え、Shadow の `desired` を受けてプラグを操作し、実状態を報告 | Shadow の get/delta を購読、`reptile-cage-monitor/cage/state` と Shadow の `desired` / `reported` を publish |
| `ir-controller` | 4つのIRプリセットをNVSに保存し、Unit IRで学習・送信 | 専用Shadowの get/delta を購読、`reptile-cage-monitor/air-conditioner/state` に学習・送信結果をpublish |
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

## エアコンIRプリセット

Unit IRをAtomS3のGrove端子に接続します。AtomS3側のG1が受信、G2が送信ピンです。AtomS3のボタンを短押しするとプリセットIDを1→2→3→4→1と切り替えます。画面に選択中のIDと学習状態が表示されます。1秒以上長押しするとそのIDの学習を始め、60秒以内に信号を受信するとIRデータと設定をNVSへ保存して終了します。信号を受けない場合も60秒で終了します。再起動後も選択IDと各枠のデータを保持します。

Web画面ではID 1〜4の状態を見て、名前、冷房／暖房、設定温度（0.5℃刻み）、上下風向、風量を編集できます。保存するとDynamoDBの同じIDの行を更新し、改訂番号付きShadow通知で端末へ設定を同期します。保存済み信号を送信する操作もWebから行えます。学習結果はIoT Core経由でDynamoDBの対応するIDの行へupsertされるため、同じIDの再学習で履歴行は増えません。

IR受信は120 msの無信号で終了し、最大700個の間隔値を保存します。markは最大65,535 µs、spaceは最大131,070 µsを扱い、従来の16ビット保存データは起動時に32ビット形式へ移行します。送信搬送波は38 kHz、デューティ比50%で、同じRaw信号を100 ms間隔で2回送ります。送信結果はIR LEDから信号を出したことを示し、エアコン本体の受信や動作までは確認しません。距離や向きを調整しても反応しない場合は、IR LEDの出力不足を疑い、Unit IRを近づけるか外部駆動のIR送信器を使ってください。

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
