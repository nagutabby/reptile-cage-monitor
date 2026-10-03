#include <ArduinoJson.h>
#include <M5Unified.h>
#include <NimBLEDevice.h>
#include <time.h>
#include <sys/time.h>

#include "mqtt_link.h"
#include "switchbot_ble.h"

namespace {
constexpr char CLIENT_ID[] = "reptile-controller";
constexpr char STATE_TOPIC[] = "reptile/cage/state";
constexpr char SHADOW_UPDATE_TOPIC[] = "$aws/things/reptile-controller/shadow/update";
constexpr char SHADOW_GET_TOPIC[] = "$aws/things/reptile-controller/shadow/get";
constexpr char SHADOW_GET_ACCEPTED_TOPIC[] = "$aws/things/reptile-controller/shadow/get/accepted";
constexpr char SHADOW_GET_REJECTED_TOPIC[] = "$aws/things/reptile-controller/shadow/get/rejected";
constexpr char SHADOW_DELTA_TOPIC[] = "$aws/things/reptile-controller/shadow/update/delta";
constexpr char UVB_MAC[] = "70:af:09:17:2a:d2";
constexpr char HEATER_MAC[] = "ac:27:6e:40:5a:a2";
MqttLink mqtt(CLIENT_ID);
bool lightOn = false;
bool heaterOn = false;
bool lightKnown = false;
bool heaterKnown = false;
bool stateDirty = true;
bool desiredLightOn = false;
bool desiredHeaterOn = false;
bool desiredLightKnown = false;
bool desiredHeaterKnown = false;
uint32_t shadowVersion = 0;
uint32_t bootId;
uint32_t sequence = 0;
uint32_t nextCheckMs = 0;
uint32_t nextShadowMs = 0;
uint32_t nextShadowGetMs = 0;
uint32_t nextLightTryMs = 0;
uint32_t nextHeaterTryMs = 0;

void onMessage(char* topic, byte* payload, unsigned int length) {
    if (strcmp(topic, SHADOW_GET_REJECTED_TOPIC) == 0) {
        Serial.println("[Shadow] get rejected");
        return;
    }
    if (strcmp(topic, SHADOW_GET_ACCEPTED_TOPIC) != 0 && strcmp(topic, SHADOW_DELTA_TOPIC) != 0) return;
    StaticJsonDocument<1536> doc;
    if (deserializeJson(doc, payload, length)) return;
    uint32_t version = doc["version"] | 0;
    if (version == 0) return;
    if (version < shadowVersion) return;
    shadowVersion = version;
    // get/accepted contains state.desired; update/delta contains desired fields
    // directly in state.
    JsonObject desired = strcmp(topic, SHADOW_DELTA_TOPIC) == 0
        ? doc["state"].as<JsonObject>()
        : doc["state"]["desired"].as<JsonObject>();
    if (desired.isNull()) return;
    if (desired["is_light_on"].is<bool>()) {
        desiredLightOn = desired["is_light_on"].as<bool>();
        desiredLightKnown = true;
    }
    if (desired["is_heater_on"].is<bool>()) {
        desiredHeaterOn = desired["is_heater_on"].as<bool>();
        desiredHeaterKnown = true;
    }
}

void checkPlugStates() {
    bool observed;
    if (SwitchBotBLE::plugReadState(UVB_MAC, observed)) {
        if (!lightKnown || lightOn != observed) stateDirty = true;
        lightOn = observed;
        lightKnown = true;
    }
    if (SwitchBotBLE::plugReadState(HEATER_MAC, observed)) {
        if (!heaterKnown || heaterOn != observed) stateDirty = true;
        heaterOn = observed;
        heaterKnown = true;
    }
}

void applyDesired(uint32_t nowMs) {
    if (!mqtt.connected()) return;
    if (desiredLightKnown && lightKnown && desiredLightOn != lightOn &&
        (int32_t)(nowMs - nextLightTryMs) >= 0) {
        nextLightTryMs = nowMs + 15000;
        bool ok = desiredLightOn ? SwitchBotBLE::plugTurnOn(UVB_MAC) : SwitchBotBLE::plugTurnOff(UVB_MAC);
        if (ok) checkPlugStates();
    }
    if (desiredHeaterKnown && heaterKnown && desiredHeaterOn != heaterOn &&
        (int32_t)(nowMs - nextHeaterTryMs) >= 0) {
        nextHeaterTryMs = nowMs + 15000;
        bool ok = desiredHeaterOn ? SwitchBotBLE::plugTurnOn(HEATER_MAC) : SwitchBotBLE::plugTurnOff(HEATER_MAC);
        if (ok) checkPlugStates();
    }
}

void reportState() {
    if (!stateDirty || !lightKnown || !heaterKnown || !mqtt.connected()) return;
    timeval now;
    gettimeofday(&now, nullptr);
    if (now.tv_sec < 1700000000) return;
    struct tm utc;
    gmtime_r(&now.tv_sec, &utc);
    char timestamp[32];
    snprintf(timestamp, sizeof(timestamp), "%04d-%02d-%02dT%02d:%02d:%02d.%06ldZ",
             utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour,
             utc.tm_min, utc.tm_sec, (long)now.tv_usec);
    char eventId[48];
    snprintf(eventId, sizeof(eventId), "controller-%08lx-%lu", (unsigned long)bootId,
             (unsigned long)++sequence);
    StaticJsonDocument<256> doc;
    doc["event_id"] = eventId;
    doc["observed_at"] = timestamp;
    doc["is_light_on"] = lightOn;
    doc["is_heater_on"] = heaterOn;
    char payload[256];
    serializeJson(doc, payload, sizeof(payload));
    stateDirty = !mqtt.publish(STATE_TOPIC, payload, true);
}

void reportShadow(uint32_t nowMs) {
    if (!lightKnown || !heaterKnown || !mqtt.connected()) return;
    if ((int32_t)(nowMs - nextShadowMs) < 0) return;
    StaticJsonDocument<256> doc;
    JsonObject state = doc.createNestedObject("state");
    JsonObject reported = state.createNestedObject("reported");
    reported["is_light_on"] = lightOn;
    reported["is_heater_on"] = heaterOn;
    char payload[256];
    serializeJson(doc, payload, sizeof(payload));
    if (mqtt.publish(SHADOW_UPDATE_TOPIC, payload)) nextShadowMs = nowMs + 60000;
}
} // namespace

void setup() {
    M5.begin(M5.config());
    Serial.begin(115200);
    NimBLEDevice::init("ReptileController");
    bootId = esp_random();
    mqtt.setCallback(onMessage);
    mqtt.begin();
    checkPlugStates();
}

void loop() {
    M5.update();
    mqtt.loop();
    if (mqtt.consumeJustConnected()) {
        desiredLightKnown = false;
        desiredHeaterKnown = false;
        mqtt.subscribe(SHADOW_GET_ACCEPTED_TOPIC);
        mqtt.subscribe(SHADOW_GET_REJECTED_TOPIC);
        mqtt.subscribe(SHADOW_DELTA_TOPIC);
        mqtt.publish(SHADOW_GET_TOPIC, "");
        nextShadowGetMs = millis() + 15000;
        stateDirty = true;
    }
    uint32_t now = millis();
    if (mqtt.connected() && (!desiredLightKnown || !desiredHeaterKnown) &&
        (int32_t)(now - nextShadowGetMs) >= 0) {
        mqtt.publish(SHADOW_GET_TOPIC, "");
        nextShadowGetMs = now + 15000;
    }
    if ((int32_t)(now - nextCheckMs) >= 0) {
        nextCheckMs = now + 60000;
        checkPlugStates();
    }
    applyDesired(now);
    reportState();
    reportShadow(now);
    delay(10);
}
