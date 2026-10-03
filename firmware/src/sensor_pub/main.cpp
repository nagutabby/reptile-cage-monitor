#include <ArduinoJson.h>
#include <M5Unified.h>
#include <NimBLEDevice.h>

#include "mqtt_link.h"
#include "switchbot_ble.h"

namespace {
constexpr char CLIENT_ID[] = "reptile-sensor";
constexpr char TOPIC[] = "reptile/cage/telemetry";
constexpr char METER_MAC[] = "eb:6b:03:06:2f:57";
MqttLink mqtt(CLIENT_ID);
uint32_t bootId;
uint32_t sequence = 0;
uint32_t nextReadMs = 0;

void sendReading() {
    float tempC;
    uint8_t humidity;
    if (!SwitchBotBLE::meterScanRead(METER_MAC, tempC, humidity)) {
        Serial.println("[Meter] scan failed");
        return;
    }
    char timestamp[24];
    if (!getUtcTimestamp(timestamp, sizeof(timestamp))) return;
    char eventId[48];
    snprintf(eventId, sizeof(eventId), "sensor-%08lx-%lu", (unsigned long)bootId,
             (unsigned long)++sequence);
    StaticJsonDocument<256> doc;
    doc["event_id"] = eventId;
    doc["observed_at"] = timestamp;
    doc["temp_c"] = tempC;
    doc["humidity"] = humidity;
    char payload[256];
    serializeJson(doc, payload, sizeof(payload));
    Serial.printf("[Meter] %.1f C %u %%\n", tempC, humidity);
    Serial.println(mqtt.publish(TOPIC, payload, true) ? "[MQTT] published" : "[MQTT] publish failed");
}
} // namespace

void setup() {
    M5.begin(M5.config());
    Serial.begin(115200);
    NimBLEDevice::init("ReptileSensor");
    bootId = esp_random();
    mqtt.begin();
}

void loop() {
    M5.update();
    mqtt.loop();
    uint32_t now = millis();
    if (mqtt.connected() && (int32_t)(now - nextReadMs) >= 0) {
        nextReadMs = now + 60000;
        sendReading();
    }
    delay(10);
}
