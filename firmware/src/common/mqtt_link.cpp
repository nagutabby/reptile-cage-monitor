#include "mqtt_link.h"

#include <WiFi.h>
#include <time.h>

#if defined(IOT_SENSOR)
#include "iot_config_sensor.h"
#elif defined(IOT_CONTROLLER)
#include "iot_config_controller.h"
#elif defined(IOT_IR_CONTROLLER)
#include "iot_config_ir_controller.h"
#else
#error "Select IOT_SENSOR, IOT_CONTROLLER, or IOT_IR_CONTROLLER"
#endif
#include "wifi_config.h"

#ifndef MQTT_BUFFER_SIZE
#define MQTT_BUFFER_SIZE 1536
#endif

MqttLink::MqttLink(const char* clientId) : clientId_(clientId), client_(secureClient_) {}

void MqttLink::begin() {
    secureClient_.setCACert(IOT_ROOT_CA);
    secureClient_.setCertificate(IOT_DEVICE_CERT);
    secureClient_.setPrivateKey(IOT_PRIVATE_KEY);
    client_.setServer(IOT_ENDPOINT, 8883);
    // PubSubClient silently drops messages larger than the buffer (shadow get/accepted carries
    // per-element metadata; the IR "captured" event publishes up to 700 timings).
    client_.setBufferSize(MQTT_BUFFER_SIZE);
    client_.setKeepAlive(60);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    nextWifiTryMs_ = millis() + 15000;
    Serial.println("[WiFi] connecting");
    configTime(0, 0, "ntp.nict.jp", "time.cloudflare.com");
}

void MqttLink::loop() {
    uint32_t now = millis();
    if (WiFi.status() != WL_CONNECTED) {
        if (wifiConnected_) {
            Serial.println("[WiFi] disconnected");
            wifiConnected_ = false;
        }
        if ((int32_t)(now - nextWifiTryMs_) >= 0) {
            Serial.printf("[WiFi] reconnecting (status %d)\n", static_cast<int>(WiFi.status()));
            WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
            nextWifiTryMs_ = now + 15000;
        }
        return;
    }
    if (!wifiConnected_) {
        wifiConnected_ = true;
        nextMqttTryMs_ = now;
        Serial.printf("[WiFi] connected: %s, RSSI %d dBm\n",
                      WiFi.localIP().toString().c_str(), WiFi.RSSI());
    }
    // X.509 TLS validation requires a usable clock.
    if (time(nullptr) < 1700000000) return;
    if (!client_.connected()) {
        if ((int32_t)(now - nextMqttTryMs_) < 0) return;
        if (client_.connect(clientId_)) {
            Serial.println("[MQTT] connected");
            justConnected_ = true;
        } else {
            Serial.printf("[MQTT] connect failed: %d\n", client_.state());
            nextMqttTryMs_ = now + 5000;
        }
    }
    client_.loop();
}

bool MqttLink::connected() { return client_.connected(); }
bool MqttLink::publish(const char* topic, const char* payload, bool retained) {
    return client_.connected() && client_.publish(topic, payload, retained);
}
bool MqttLink::subscribe(const char* topic, uint8_t qos) {
    return client_.connected() && client_.subscribe(topic, qos);
}
void MqttLink::setCallback(MQTT_CALLBACK_SIGNATURE) { client_.setCallback(callback); }
bool MqttLink::consumeJustConnected() {
    bool result = justConnected_;
    justConnected_ = false;
    return result;
}

bool getUtcTimestamp(char* output, size_t outputSize) {
    time_t now = time(nullptr);
    if (now < 1700000000) return false;
    struct tm utc;
    gmtime_r(&now, &utc);
    return strftime(output, outputSize, "%Y-%m-%dT%H:%M:%SZ", &utc) > 0;
}
