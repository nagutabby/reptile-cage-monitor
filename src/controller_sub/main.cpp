#include <ArduinoJson.h>
#include <M5Unified.h>
#include <NimBLEDevice.h>
#include <time.h>
#include <sys/time.h>

#include "control_logic.h"
#include "mqtt_link.h"
#include "switchbot_ble.h"

namespace {
constexpr char CLIENT_ID[] = "reptile-controller";
constexpr char TELEMETRY_TOPIC[] = "reptile/cage/telemetry";
constexpr char STATE_TOPIC[] = "reptile/cage/state";
constexpr char UVB_MAC[] = "70:af:09:17:2a:d2";
constexpr char HEATER_MAC[] = "ac:27:6e:40:5a:a2";
MqttLink mqtt(CLIENT_ID);
bool lightOn = false;
bool heaterOn = false;
bool lightKnown = false;
bool heaterKnown = false;
bool stateDirty = true;
bool pendingTemperature = false;
float latestTemperature = 0;
uint32_t bootId;
uint32_t sequence = 0;
uint32_t nextCheckMs = 0;

void onMessage(char* topic, byte* payload, unsigned int length) {
    if (strcmp(topic, TELEMETRY_TOPIC) != 0 || length >= 256) return;
    StaticJsonDocument<256> doc;
    if (deserializeJson(doc, payload, length)) return;
    const char* observed = doc["observed_at"];
    if (!observed || !doc["temp_c"].is<float>()) return;
    struct tm sample = {};
    if (!strptime(observed, "%Y-%m-%dT%H:%M:%SZ", &sample)) return;
    sample.tm_isdst = 0;
    time_t sampleTime = mktime(&sample);
    time_t now = time(nullptr);
    // A retained message can be delivered after a long disconnection.
    if (now < sampleTime || now - sampleTime > 120) return;
    latestTemperature = doc["temp_c"].as<float>();
    pendingTemperature = true;
}

void checkPlugStates() {
    bool previouslyKnown = lightKnown && heaterKnown;
    if (!lightKnown) lightKnown = SwitchBotBLE::plugReadState(UVB_MAC, lightOn);
    if (!heaterKnown) heaterKnown = SwitchBotBLE::plugReadState(HEATER_MAC, heaterOn);
    if (!previouslyKnown && lightKnown && heaterKnown) stateDirty = true;
}

void applyLightSchedule() {
    if (!lightKnown) return;
    time_t now = time(nullptr);
    if (now < 1700000000) return;
    struct tm local;
    gmtime_r(&now, &local);
    int jstHour = (local.tm_hour + 9) % 24;
    local.tm_hour = jstHour;
    bool desired = ControlLogic::computeDesiredLightOn(local, 7, 19);
    if (desired == lightOn) return;
    bool ok = desired ? SwitchBotBLE::plugTurnOn(UVB_MAC) : SwitchBotBLE::plugTurnOff(UVB_MAC);
    if (ok) {
        lightOn = desired;
        stateDirty = true;
        Serial.printf("[Light] %s\n", desired ? "ON" : "OFF");
    }
}

void applyTemperature() {
    if (!pendingTemperature) return;
    pendingTemperature = false;
    if (!heaterKnown) return;
    bool desired = ControlLogic::computeDesiredHeaterOn(latestTemperature, 32.0f);
    if (desired == heaterOn) return;
    bool ok = desired ? SwitchBotBLE::plugTurnOn(HEATER_MAC) : SwitchBotBLE::plugTurnOff(HEATER_MAC);
    if (ok) {
        heaterOn = desired;
        stateDirty = true;
        Serial.printf("[Heater] %s\n", desired ? "ON" : "OFF");
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
        mqtt.subscribe(TELEMETRY_TOPIC);
        stateDirty = true;
    }
    uint32_t now = millis();
    if ((int32_t)(now - nextCheckMs) >= 0) {
        nextCheckMs = now + 60000;
        checkPlugStates();
        applyLightSchedule();
    }
    applyTemperature();
    reportState();
    delay(10);
}
