#pragma once

#include <Arduino.h>
#include <PubSubClient.h>
#include <WiFiClientSecure.h>

class MqttLink {
public:
    explicit MqttLink(const char* clientId);
    void begin();
    void loop();
    bool connected();
    bool publish(const char* topic, const char* payload, bool retained = false);
    bool subscribe(const char* topic, uint8_t qos = 1);
    void setCallback(MQTT_CALLBACK_SIGNATURE);
    bool consumeJustConnected();

private:
    const char* clientId_;
    WiFiClientSecure secureClient_;
    PubSubClient client_;
    uint32_t nextWifiTryMs_ = 0;
    uint32_t nextMqttTryMs_ = 0;
    bool justConnected_ = false;
};

bool getUtcTimestamp(char* output, size_t outputSize);
