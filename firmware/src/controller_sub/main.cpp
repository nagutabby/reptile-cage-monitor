#include <ArduinoJson.h>
#include <M5Unified.h>
#include <NimBLEDevice.h>
#include <time.h>
#include <sys/time.h>

#include "mqtt_link.h"
#include "switchbot_ble.h"

namespace {
constexpr char CLIENT_ID[] = "reptile-cage-monitor-controller";
constexpr char STATE_TOPIC[] = "reptile-cage-monitor/cage/state";
constexpr char SHADOW_UPDATE_TOPIC[] = "$aws/things/reptile-cage-monitor-controller/shadow/update";
constexpr char SHADOW_GET_TOPIC[] = "$aws/things/reptile-cage-monitor-controller/shadow/get";
constexpr char SHADOW_GET_ACCEPTED_TOPIC[] = "$aws/things/reptile-cage-monitor-controller/shadow/get/accepted";
constexpr char SHADOW_GET_REJECTED_TOPIC[] = "$aws/things/reptile-cage-monitor-controller/shadow/get/rejected";
constexpr char SHADOW_DELTA_TOPIC[] = "$aws/things/reptile-cage-monitor-controller/shadow/update/delta";
constexpr char UVB_MAC[] = "70:af:09:17:2a:d2";
constexpr char HEATER_MAC[] = "ac:27:6e:40:5a:a2";
constexpr uint32_t PLUG_STATE_POLL_INTERVAL_MS = 30000;
constexpr uint32_t BACKGROUND_READ_TIMEOUT_MS = 1000;
constexpr uint8_t BACKGROUND_READ_ATTEMPTS = 2; // try both public and random BLE address types
constexpr uint32_t BACKGROUND_CONNECT_TIMEOUT_SECONDS = 2;
constexpr uint32_t BUTTON_DESIRED_RETRY_INTERVAL_MS = 5000;
MqttLink mqtt(CLIENT_ID);
bool lightOn = false;
bool heaterOn = false;
bool lightKnown = false;
bool heaterKnown = false;
bool stateDirty = true;
bool displayDirty = true;
bool desiredLightOn = false;
bool desiredHeaterOn = false;
bool desiredLightKnown = false;
bool desiredHeaterKnown = false;
bool lightCommandPending = false;
uint32_t lightCommandReceivedMs = 0;
bool buttonDesiredPublishPending = false;
bool buttonDesiredOn = false;
uint32_t nextButtonDesiredPublishMs = 0;
bool buttonIntentAwaitingShadow = false;
uint32_t buttonIntentBaseVersion = 0;
bool pollLightNext = true;
uint32_t shadowVersion = 0;
uint32_t bootId;
uint32_t sequence = 0;
uint32_t nextCheckMs = 0;
uint32_t nextShadowMs = 0;
uint32_t nextShadowGetMs = 0;
uint32_t nextLightTryMs = 0;
uint32_t nextHeaterTryMs = 0;

void recordLightState(bool isOn) {
    if (!lightKnown || lightOn != isOn) {
        stateDirty = true;
        displayDirty = true;
    }
    lightOn = isOn;
    lightKnown = true;
}

void recordHeaterState(bool isOn) {
    if (!heaterKnown || heaterOn != isOn) {
        stateDirty = true;
        displayDirty = true;
    }
    heaterOn = isOn;
    heaterKnown = true;
}

void renderStatus() {
    if (!displayDirty) return;
    displayDirty = false;

    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.setTextSize(1);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.setCursor(8, 8);
    M5.Display.print("CAGE STATUS");
    M5.Display.drawFastHLine(8, 24, 112, TFT_DARKGREY);

    M5.Display.setCursor(10, 34);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.print("LIGHT");
    M5.Display.setCursor(10, 47);
    M5.Display.setTextSize(2);
    M5.Display.setTextColor(!lightKnown ? TFT_YELLOW : (lightOn ? TFT_GREEN : TFT_RED), TFT_BLACK);
    M5.Display.print(!lightKnown ? "UNKNOWN" : (lightOn ? "ON" : "OFF"));

    M5.Display.drawFastHLine(8, 68, 112, TFT_DARKGREY);
    M5.Display.setTextSize(1);
    M5.Display.setCursor(10, 78);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.print("HEATER");
    M5.Display.setCursor(10, 91);
    M5.Display.setTextSize(2);
    M5.Display.setTextColor(!heaterKnown ? TFT_YELLOW : (heaterOn ? TFT_GREEN : TFT_RED), TFT_BLACK);
    M5.Display.print(!heaterKnown ? "UNKNOWN" : (heaterOn ? "ON" : "OFF"));

    M5.Display.setTextSize(1);
    M5.Display.setTextColor(TFT_DARKGREY, TFT_BLACK);
    M5.Display.setCursor(8, 119);
    M5.Display.print("LIVE BLE STATE");
}

void onMessage(char* topic, byte* payload, unsigned int length) {
    if (strcmp(topic, SHADOW_GET_REJECTED_TOPIC) == 0) {
        Serial.println("[Shadow] get rejected");
        return;
    }
    if (strcmp(topic, SHADOW_GET_ACCEPTED_TOPIC) != 0 && strcmp(topic, SHADOW_DELTA_TOPIC) != 0) return;
    JsonDocument doc;
    if (deserializeJson(doc, payload, length)) return;
    uint32_t version = doc["version"] | 0;
    if (version == 0) return;
    if (version < shadowVersion) return;
    shadowVersion = version;
    bool isDelta = strcmp(topic, SHADOW_DELTA_TOPIC) == 0;
    // get/accepted contains state.desired; update/delta contains desired fields
    // directly in state.
    JsonObject desired = strcmp(topic, SHADOW_DELTA_TOPIC) == 0
        ? doc["state"].as<JsonObject>()
        : doc["state"]["desired"].as<JsonObject>();
    if (desired.isNull()) return;
    if (desired["is_light_on"].is<bool>()) {
        // A get response already in flight when the local button was pressed
        // can contain an older desired value. Keep the button's newer intent
        // until the Shadow advances past the version seen at the press.
        if (!buttonIntentAwaitingShadow || version > buttonIntentBaseVersion) {
            buttonIntentAwaitingShadow = false;
            desiredLightOn = desired["is_light_on"].as<bool>();
            desiredLightKnown = true;
            if (isDelta) {
                // The local button may already have applied this value before
                // its delta arrives. Only dispatch a BLE command if state is
                // unknown or still differs from desired.
                lightCommandPending = !lightKnown || desiredLightOn != lightOn;
                if (lightCommandPending) {
                    lightCommandReceivedMs = millis();
                    // A fresh user/schedule command should not inherit a previous
                    // failed command's retry backoff.
                    nextLightTryMs = lightCommandReceivedMs;
                }
                Serial.printf("[Light] desired delta received: %s, version=%lu, apply=%s\n",
                              desiredLightOn ? "ON" : "OFF",
                              static_cast<unsigned long>(version),
                              lightCommandPending ? "yes" : "no");
            }
        }
    }
    if (desired["is_heater_on"].is<bool>()) {
        desiredHeaterOn = desired["is_heater_on"].as<bool>();
        desiredHeaterKnown = true;
    }
}

void checkPlugStates() {
    uint32_t checkStartMs = millis();
    bool observed;
    uint32_t readStartMs = millis();
    if (SwitchBotBLE::plugReadState(UVB_MAC, observed)) {
        recordLightState(observed);
        Serial.printf("[State] light verified %s in %lu ms\n",
                      lightOn ? "ON" : "OFF",
                      static_cast<unsigned long>(millis() - readStartMs));
    } else {
        Serial.printf("[State] light read failed in %lu ms\n",
                      static_cast<unsigned long>(millis() - readStartMs));
    }
    readStartMs = millis();
    if (SwitchBotBLE::plugReadState(HEATER_MAC, observed)) {
        recordHeaterState(observed);
        Serial.printf("[State] heater verified %s in %lu ms\n",
                      heaterOn ? "ON" : "OFF",
                      static_cast<unsigned long>(millis() - readStartMs));
    } else {
        Serial.printf("[State] heater read failed in %lu ms\n",
                      static_cast<unsigned long>(millis() - readStartMs));
    }
    nextCheckMs = millis() + PLUG_STATE_POLL_INTERVAL_MS;
    Serial.printf("[State] full verification completed in %lu ms\n",
                  static_cast<unsigned long>(millis() - checkStartMs));
}

void pollOnePlugState() {
    const char* mac = pollLightNext ? UVB_MAC : HEATER_MAC;
    const char* name = pollLightNext ? "light" : "heater";
    bool observed;
    uint32_t readStartMs = millis();
    bool ok = SwitchBotBLE::plugReadState(
        mac, observed, BACKGROUND_READ_TIMEOUT_MS, BACKGROUND_READ_ATTEMPTS, 0,
        BACKGROUND_CONNECT_TIMEOUT_SECONDS);
    uint32_t durationMs = millis() - readStartMs;
    if (ok) {
        if (pollLightNext) {
            recordLightState(observed);
        } else {
            recordHeaterState(observed);
        }
    }
    Serial.printf("[State] background %s read %s in %lu ms\n", name,
                  ok ? "OK" : "FAILED", static_cast<unsigned long>(durationMs));
    pollLightNext = !pollLightNext;
    nextCheckMs = millis() + PLUG_STATE_POLL_INTERVAL_MS;
}

void applyDesired(uint32_t nowMs) {
    if (!mqtt.connected()) return;
    bool lightNeedsApply = desiredLightKnown &&
        (lightCommandPending || (lightKnown && desiredLightOn != lightOn));
    if (lightNeedsApply &&
        (int32_t)(nowMs - nextLightTryMs) >= 0) {
        uint32_t commandStartMs = millis();
        if (lightCommandPending) {
            Serial.printf("[Light] command dispatch delay %lu ms\n",
                          static_cast<unsigned long>(commandStartMs - lightCommandReceivedMs));
        }
        Serial.printf("[Light] BLE command start -> %s\n", desiredLightOn ? "ON" : "OFF");
        bool ok = desiredLightOn ? SwitchBotBLE::plugTurnOn(UVB_MAC) : SwitchBotBLE::plugTurnOff(UVB_MAC);
        nextLightTryMs = millis() + 15000;
        Serial.printf("[Light] BLE command %s in %lu ms\n", ok ? "ACK" : "FAILED",
                      static_cast<unsigned long>(millis() - commandStartMs));
        if (ok) {
            lightCommandPending = false;
            checkPlugStates();
        }
    }
    if (desiredHeaterKnown && heaterKnown && desiredHeaterOn != heaterOn &&
        (int32_t)(nowMs - nextHeaterTryMs) >= 0) {
        nextHeaterTryMs = nowMs + 15000;
        bool ok = desiredHeaterOn ? SwitchBotBLE::plugTurnOn(HEATER_MAC) : SwitchBotBLE::plugTurnOff(HEATER_MAC);
        if (ok) checkPlugStates();
    }
}

void publishButtonDesired(uint32_t nowMs) {
    if (!buttonDesiredPublishPending || !mqtt.connected() ||
        (int32_t)(nowMs - nextButtonDesiredPublishMs) < 0) return;

    JsonDocument doc;
    JsonObject desired = doc["state"]["desired"].to<JsonObject>();
    desired["is_light_on"] = buttonDesiredOn;
    char payload[96];
    serializeJson(doc, payload, sizeof(payload));
    if (mqtt.publish(SHADOW_UPDATE_TOPIC, payload)) {
        buttonDesiredPublishPending = false;
        desiredLightOn = buttonDesiredOn;
        desiredLightKnown = true;
        Serial.printf("[Button] desired light %s published to Shadow\n",
                      buttonDesiredOn ? "ON" : "OFF");
    } else {
        nextButtonDesiredPublishMs = nowMs + BUTTON_DESIRED_RETRY_INTERVAL_MS;
        Serial.println("[Button] desired publish failed; will retry");
    }
}

void handleButtonPress() {
    if (!lightKnown) {
        bool observed;
        if (!SwitchBotBLE::plugReadState(UVB_MAC, observed, BACKGROUND_READ_TIMEOUT_MS,
                                         BACKGROUND_READ_ATTEMPTS, 0,
                                         BACKGROUND_CONNECT_TIMEOUT_SECONDS)) {
            Serial.println("[Button] light state read failed; no toggle sent");
            return;
        }
        recordLightState(observed);
    }

    const bool current = lightOn;
    const bool target = !current;
    const uint32_t commandStartMs = millis();
    Serial.printf("[Button] toggling light %s -> %s\n",
                  current ? "ON" : "OFF", target ? "ON" : "OFF");
    // The latest BLE-verified state is cached by the controller, so a button
    // press only needs the power command. Use short limits for this interactive
    // path while retaining one retry for transient BLE misses.
    constexpr uint32_t BUTTON_RESPONSE_TIMEOUT_MS = 1000;
    constexpr uint8_t BUTTON_COMMAND_ATTEMPTS = 2;
    constexpr uint32_t BUTTON_RETRY_DELAY_MS = 100;
    constexpr uint32_t BUTTON_CONNECT_TIMEOUT_SECONDS = 2;
    bool commandOk = target
        ? SwitchBotBLE::plugTurnOn(UVB_MAC, BUTTON_RESPONSE_TIMEOUT_MS,
                                   BUTTON_COMMAND_ATTEMPTS, BUTTON_RETRY_DELAY_MS,
                                   BUTTON_CONNECT_TIMEOUT_SECONDS)
        : SwitchBotBLE::plugTurnOff(UVB_MAC, BUTTON_RESPONSE_TIMEOUT_MS,
                                    BUTTON_COMMAND_ATTEMPTS, BUTTON_RETRY_DELAY_MS,
                                    BUTTON_CONNECT_TIMEOUT_SECONDS);
    Serial.printf("[Button] BLE command %s in %lu ms\n",
                  commandOk ? "ACK" : "FAILED",
                  static_cast<unsigned long>(millis() - commandStartMs));
    if (!commandOk) {
        Serial.println("[Button] BLE light command failed");
        return;
    }

    recordLightState(target);
    renderStatus();

    desiredLightOn = target;
    desiredLightKnown = true;
    lightCommandPending = false;
    buttonDesiredOn = target;
    buttonDesiredPublishPending = true;
    nextButtonDesiredPublishMs = millis();
    buttonIntentAwaitingShadow = true;
    buttonIntentBaseVersion = shadowVersion;
    publishButtonDesired(millis());
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
    JsonDocument doc;
    doc["event_id"] = eventId;
    doc["observed_at"] = timestamp;
    doc["is_light_on"] = lightOn;
    doc["is_heater_on"] = heaterOn;
    char payload[256];
    serializeJson(doc, payload, sizeof(payload));
    uint32_t publishStartMs = millis();
    bool published = mqtt.publish(STATE_TOPIC, payload, true);
    stateDirty = !published;
    Serial.printf("[State] MQTT publish %s in %lu ms\n", published ? "OK" : "FAILED",
                  static_cast<unsigned long>(millis() - publishStartMs));
}

void reportShadow(uint32_t nowMs) {
    if (!lightKnown || !heaterKnown || !mqtt.connected()) return;
    if ((int32_t)(nowMs - nextShadowMs) < 0) return;
    JsonDocument doc;
    JsonObject state = doc["state"].to<JsonObject>();
    JsonObject reported = state["reported"].to<JsonObject>();
    reported["is_light_on"] = lightOn;
    reported["is_heater_on"] = heaterOn;
    char payload[256];
    serializeJson(doc, payload, sizeof(payload));
    if (mqtt.publish(SHADOW_UPDATE_TOPIC, payload)) nextShadowMs = nowMs + 60000;
}
} // namespace

void setup() {
    M5.begin(M5.config());
    M5.Display.setBrightness(96);
    renderStatus();
    Serial.begin(115200);
    NimBLEDevice::init("ReptileController");
    bootId = esp_random();
    mqtt.setCallback(onMessage);
    mqtt.begin();
    checkPlugStates();
    renderStatus();
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
    if (M5.BtnA.wasPressed()) handleButtonPress();
    publishButtonDesired(millis());
    if (mqtt.connected() && (!desiredLightKnown || !desiredHeaterKnown) &&
        (int32_t)(now - nextShadowGetMs) >= 0) {
        mqtt.publish(SHADOW_GET_TOPIC, "");
        nextShadowGetMs = now + 15000;
    }
    applyDesired(now);
    if ((int32_t)(now - nextCheckMs) >= 0) {
        // Keep the MQTT loop responsive and bound background BLE work: check one
        // plug per interval with short public/random address attempts. The next interval checks the other plug.
        pollOnePlugState();
    }
    reportState();
    reportShadow(now);
    renderStatus();
    delay(10);
}
