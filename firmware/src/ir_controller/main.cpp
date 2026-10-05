#include <Arduino.h>
#include <ArduinoJson.h>
#include <IRrecv.h>
#include <IRsend.h>
#include <M5Unified.h>
#include <Preferences.h>

#include "mqtt_link.h"

namespace {
constexpr char CLIENT_ID[] = "reptile-cage-monitor-ir-controller";
constexpr char SHADOW_UPDATE_TOPIC[] = "$aws/things/reptile-cage-monitor-ir-controller/shadow/update";
constexpr char SHADOW_GET_TOPIC[] = "$aws/things/reptile-cage-monitor-ir-controller/shadow/get";
constexpr char SHADOW_GET_ACCEPTED_TOPIC[] = "$aws/things/reptile-cage-monitor-ir-controller/shadow/get/accepted";
constexpr char SHADOW_GET_REJECTED_TOPIC[] = "$aws/things/reptile-cage-monitor-ir-controller/shadow/get/rejected";
constexpr char SHADOW_DELTA_TOPIC[] = "$aws/things/reptile-cage-monitor-ir-controller/shadow/update/delta";
constexpr char AIR_CONDITIONER_STATE_TOPIC[] = "reptile-cage-monitor/air-conditioner/state";
constexpr uint8_t IR_SEND_PIN = 2;
constexpr uint8_t IR_RECEIVE_PIN = 1;
constexpr uint16_t MAX_RAW_ITEMS = 700;
constexpr uint32_t LEARN_TIMEOUT_MS = 30000;
constexpr uint16_t IR_CARRIER_HZ = 36700;
constexpr const char* LEGACY_DESIRED_KEYS[] = {
    "air_conditioner_requested_at", "air_conditioner_power", "air_conditioner_swing_h",
    "air_conditioner_quiet", "air_conditioner_powerful", "air_conditioner_econo",
    "air_conditioner_eye", "air_conditioner_eye_auto", "air_conditioner_eye_timer",
    "air_conditioner_purify", "air_conditioner_mold", "air_conditioner_clean",
    "air_conditioner_fresh_air", "air_conditioner_humidity", "air_conditioner_beep",
    "air_conditioner_light",
};

struct AirConditionerPreset {
    String mode;
    float tempC;
    String fan;
    String swingV;
};

IRsend irsend(IR_SEND_PIN);
IRrecv irrecv(IR_RECEIVE_PIN);
MqttLink mqtt(CLIENT_ID);
Preferences storage;
bool storageReady = false;
bool previousMqttConnected = false;
bool learningActive = false;
uint32_t learningDeadline = 0;
AirConditionerPreset learningPreset;
String learningCommandId;
String lastCommandId;
String lastCommandStatus;
String currentMessage = "Ready";

bool readPreset(JsonObjectConst source, AirConditionerPreset* result) {
    const char* mode = source["air_conditioner_mode"] | "";
    const char* fan = source["air_conditioner_fan"] | "";
    const char* swingV = source["air_conditioner_swing_v"] | "";
    JsonVariantConst temperature = source["air_conditioner_temp_c"];
    if ((strcmp(mode, "cool") != 0 && strcmp(mode, "heat") != 0)
        || (strcmp(fan, "auto") != 0 && strcmp(fan, "quiet") != 0
            && !(strlen(fan) == 1 && fan[0] >= '1' && fan[0] <= '5'))
        || (strcmp(swingV, "off") != 0 && strcmp(swingV, "swing") != 0
            && strcmp(swingV, "highest") != 0 && strcmp(swingV, "high") != 0
            && strcmp(swingV, "upper_middle") != 0 && strcmp(swingV, "lower_middle") != 0
            && strcmp(swingV, "low") != 0 && strcmp(swingV, "lowest") != 0
            && strcmp(swingV, "breeze") != 0 && strcmp(swingV, "circulate") != 0)
        || (!temperature.is<float>() && !temperature.is<int>())) return false;

    const float tempC = temperature.as<float>();
    if (!isfinite(tempC) || tempC < 10.0f || tempC > 32.0f
        || fabsf(tempC * 2.0f - roundf(tempC * 2.0f)) > 0.001f
        || (strcmp(mode, "cool") == 0 && tempC < 18.0f)) return false;

    result->mode = mode;
    result->tempC = tempC;
    result->fan = fan;
    result->swingV = swingV;
    return true;
}

void putPreset(JsonObject target, const AirConditionerPreset& preset) {
    target["mode"] = preset.mode;
    target["temp_c"] = preset.tempC;
    target["fan"] = preset.fan;
    target["swing_v"] = preset.swingV;
}

void clearLegacyDesired(JsonObject desired) {
    desired["air_conditioner_command_id"] = nullptr;
    desired["air_conditioner_operation"] = nullptr;
    desired["air_conditioner_raw_data"] = nullptr;
    desired["air_conditioner_mode"] = nullptr;
    desired["air_conditioner_temp_c"] = nullptr;
    desired["air_conditioner_fan"] = nullptr;
    desired["air_conditioner_swing_v"] = nullptr;
    for (const char* key : LEGACY_DESIRED_KEYS) desired[key] = nullptr;
}

bool publishAirEvent(const char* commandId, const char* status, const AirConditionerPreset& preset,
                     const uint16_t* rawData = nullptr, uint16_t rawLength = 0) {
    JsonDocument event;
    event["command_id"] = commandId;
    event["status"] = status;
    event["reported_at"] = static_cast<uint64_t>(time(nullptr));
    putPreset(event["preset"].to<JsonObject>(), preset);
    if (rawData && rawLength) {
        JsonArray timings = event["raw_data"].to<JsonArray>();
        for (uint16_t index = 0; index < rawLength; ++index) timings.add(rawData[index]);
    }
    String payload;
    payload.reserve(measureJson(event) + 1);
    serializeJson(event, payload);
    return mqtt.publish(AIR_CONDITIONER_STATE_TOPIC, payload.c_str());
}

void rememberCommand(const char* commandId, const char* status) {
    lastCommandId = commandId;
    lastCommandStatus = status;
    if (storageReady) {
        storage.putString("last_cmd", commandId);
        storage.putString("last_status", status);
    }
}

void publishShadowResult(const char* commandId, const char* operation, const char* status,
                         const AirConditionerPreset& preset) {
    JsonDocument shadow;
    JsonObject state = shadow["state"].to<JsonObject>();
    JsonObject reported = state["reported"].to<JsonObject>();
    reported["air_conditioner_command_id"] = commandId;
    reported["air_conditioner_operation"] = operation;
    reported["air_conditioner_mode"] = preset.mode;
    reported["air_conditioner_temp_c"] = preset.tempC;
    reported["air_conditioner_fan"] = preset.fan;
    reported["air_conditioner_swing_v"] = preset.swingV;
    reported["air_conditioner_status"] = status;
    reported["air_conditioner_reported_at"] = static_cast<uint64_t>(time(nullptr));
    JsonObject desired = state["desired"].to<JsonObject>();
    clearLegacyDesired(desired);

    String payload;
    payload.reserve(measureJson(shadow) + 1);
    serializeJson(shadow, payload);
    mqtt.publish(SHADOW_UPDATE_TOPIC, payload.c_str());
}

void clearUnrecognizedCommand(const char* commandId, const char* status) {
    JsonDocument shadow;
    JsonObject state = shadow["state"].to<JsonObject>();
    JsonObject reported = state["reported"].to<JsonObject>();
    reported["air_conditioner_command_id"] = commandId;
    reported["air_conditioner_status"] = status;
    reported["air_conditioner_reported_at"] = static_cast<uint64_t>(time(nullptr));
    JsonObject desired = state["desired"].to<JsonObject>();
    clearLegacyDesired(desired);
    String payload;
    payload.reserve(measureJson(shadow) + 1);
    serializeJson(shadow, payload);
    mqtt.publish(SHADOW_UPDATE_TOPIC, payload.c_str());
}

void finishLearning(const uint16_t* rawData, uint16_t rawLength) {
    const String commandId = learningCommandId;
    const AirConditionerPreset preset = learningPreset;
    learningActive = false;
    learningCommandId = "";

    if (rawLength < 2 || rawLength > MAX_RAW_ITEMS) {
        currentMessage = "IR signal too long";
        publishAirEvent(commandId.c_str(), "failed", preset);
        rememberCommand(commandId.c_str(), "failed");
        publishShadowResult(commandId.c_str(), "learn", "failed", preset);
        return;
    }

    currentMessage = "IR learned";
    publishAirEvent(commandId.c_str(), "captured", preset, rawData, rawLength);
    rememberCommand(commandId.c_str(), "captured");
    publishShadowResult(commandId.c_str(), "learn", "captured", preset);
    Serial.printf("[IR] learned %u raw timings for %s\n", rawLength, commandId.c_str());
}

bool readRawData(JsonVariantConst source, uint16_t* target, uint16_t* length) {
    if (!source.is<JsonArrayConst>()) return false;
    JsonArrayConst timings = source.as<JsonArrayConst>();
    if (timings.size() < 2 || timings.size() > MAX_RAW_ITEMS) return false;
    uint16_t index = 0;
    for (JsonVariantConst timing : timings) {
        if (!timing.is<unsigned int>() && !timing.is<int>()) return false;
        const int32_t value = timing.as<int32_t>();
        if (value <= 0 || value > UINT16_MAX) return false;
        target[index++] = static_cast<uint16_t>(value);
    }
    *length = index;
    return true;
}

void handleCommand(JsonObjectConst desired) {
    const char* commandId = desired["air_conditioner_command_id"] | "";
    const char* operation = desired["air_conditioner_operation"] | "";
    if (!commandId[0]) return;

    if (strcmp(operation, "learn") != 0 && strcmp(operation, "send") != 0) {
        rememberCommand(commandId, "ignored");
        clearUnrecognizedCommand(commandId, "ignored");
        Serial.printf("[IR] ignored unrecognized command %s\n", commandId);
        return;
    }

    AirConditionerPreset preset;
    if (!readPreset(desired, &preset)) {
        currentMessage = "Invalid preset";
        rememberCommand(commandId, "failed");
        clearUnrecognizedCommand(commandId, "failed");
        Serial.printf("[IR] invalid preset for command %s\n", commandId);
        return;
    }
    if (learningActive && learningCommandId == commandId) return;

    const String previousCommandId = storageReady
        ? storage.getString("last_cmd", lastCommandId)
        : lastCommandId;
    if (previousCommandId == commandId) {
        const String previousStatus = storageReady
            ? storage.getString("last_status", lastCommandStatus.length() ? lastCommandStatus : "failed")
            : (lastCommandStatus.length() ? lastCommandStatus : "failed");
        publishAirEvent(commandId, previousStatus.c_str(), preset);
        publishShadowResult(commandId, operation, previousStatus.c_str(), preset);
        return;
    }

    if (strcmp(operation, "learn") == 0) {
        learningPreset = preset;
        learningCommandId = commandId;
        learningDeadline = millis() + LEARN_TIMEOUT_MS;
        learningActive = true;
        currentMessage = "Point remote at Unit IR";
        publishAirEvent(commandId, "learning", preset);
        Serial.printf("[IR] learning started for %s\n", commandId);
        return;
    }

    uint16_t rawData[MAX_RAW_ITEMS];
    uint16_t rawLength = 0;
    bool valid = strcmp(operation, "send") == 0
        && readRawData(desired["air_conditioner_raw_data"], rawData, &rawLength);
    const char* status = "failed";
    if (valid) {
        irsend.sendRaw(rawData, rawLength, IR_CARRIER_HZ);
        status = "sent";
        currentMessage = "Raw IR sent";
        Serial.printf("[IR] sent %u raw timings for %s\n", rawLength, commandId);
    } else {
        currentMessage = "Invalid IR data";
        Serial.printf("[IR] invalid command %s\n", commandId);
    }

    rememberCommand(commandId, status);
    publishAirEvent(commandId, status, preset);
    publishShadowResult(commandId, operation, status, preset);
}

void onMqttMessage(char* topic, uint8_t* payload, unsigned int length) {
    if (strcmp(topic, SHADOW_GET_REJECTED_TOPIC) == 0) {
        Serial.println("[Shadow] get rejected");
        return;
    }
    if (strcmp(topic, SHADOW_DELTA_TOPIC) == 0) {
        mqtt.publish(SHADOW_GET_TOPIC, "{}");
        return;
    }
    if (strcmp(topic, SHADOW_GET_ACCEPTED_TOPIC) != 0) return;

    JsonDocument document;
    if (deserializeJson(document, payload, length)) {
        Serial.println("[Shadow] invalid JSON");
        return;
    }
    JsonObjectConst desired = document["state"]["desired"].as<JsonObjectConst>();
    handleCommand(desired);
}

void onConnection() {
    mqtt.subscribe(SHADOW_GET_ACCEPTED_TOPIC);
    mqtt.subscribe(SHADOW_GET_REJECTED_TOPIC);
    mqtt.subscribe(SHADOW_DELTA_TOPIC);
    mqtt.publish(SHADOW_GET_TOPIC, "{}");
    Serial.println("[Shadow] requested current state");
}

void pollInfrared() {
    if (learningActive) {
        if (static_cast<int32_t>(millis() - learningDeadline) >= 0) {
            const String commandId = learningCommandId;
            const AirConditionerPreset preset = learningPreset;
            learningActive = false;
            learningCommandId = "";
            currentMessage = "IR learn timed out";
            publishAirEvent(commandId.c_str(), "failed", preset);
            rememberCommand(commandId.c_str(), "failed");
            publishShadowResult(commandId.c_str(), "learn", "failed", preset);
            Serial.printf("[IR] learn timed out for %s\n", commandId.c_str());
        } else {
            decode_results results{};
            if (irrecv.decode(&results)) {
                const uint16_t rawLength = results.rawlen > kStartOffset
                    ? results.rawlen - kStartOffset
                    : 0;
                if (rawLength >= 2 && rawLength <= MAX_RAW_ITEMS) {
                    uint16_t rawData[MAX_RAW_ITEMS];
                    for (uint16_t index = 0; index < rawLength; ++index) {
                        const uint32_t micros = static_cast<uint32_t>(results.rawbuf[index + kStartOffset]) * kRawTick;
                        rawData[index] = static_cast<uint16_t>(micros > UINT16_MAX ? UINT16_MAX : max<uint32_t>(micros, 1));
                    }
                    finishLearning(rawData, rawLength);
                } else {
                    currentMessage = "IR signal too long";
                    Serial.printf("[IR] ignored capture with %u timings\n", rawLength);
                }
                irrecv.resume();
            }
        }
    } else {
        decode_results results{};
        if (irrecv.decode(&results)) irrecv.resume();
    }
}

void drawScreen() {
    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.setCursor(4, 4);
    M5.Display.setTextSize(1);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.println("IR RAW PRESETS");
    M5.Display.printf("MQTT: %s\n", mqtt.connected() ? "online" : "offline");
    M5.Display.println(currentMessage);
    if (learningActive) {
        M5.Display.printf("%s %.1f C\n", learningPreset.mode.c_str(), learningPreset.tempC);
        M5.Display.printf("Fan %s V %s\n", learningPreset.fan.c_str(), learningPreset.swingV.c_str());
    }
    M5.Display.println("Web presets -> IR");
}
}  // namespace

void setup() {
    Serial.begin(115200);
    auto config = M5.config();
    M5.begin(config);
    M5.Display.setRotation(0);
    M5.Display.setBrightness(80);

    storageReady = storage.begin("irremote", false);
    if (storageReady) {
        lastCommandId = storage.getString("last_cmd", "");
        lastCommandStatus = storage.getString("last_status", "");
    } else {
        Serial.println("[NVS] failed to open preferences");
    }

    irsend.begin();
    irrecv.enableIRIn();
    mqtt.setCallback(onMqttMessage);
    mqtt.begin();
    drawScreen();
    Serial.println("[IR] raw controller ready: RX GPIO1, TX GPIO2");
}

void loop() {
    M5.update();
    mqtt.loop();
    if (mqtt.consumeJustConnected()) onConnection();
    pollInfrared();

    const bool mqttConnected = mqtt.connected();
    if (mqttConnected != previousMqttConnected) {
        previousMqttConnected = mqttConnected;
        drawScreen();
    }
    static String previousScreenMessage;
    if (previousScreenMessage != currentMessage) {
        previousScreenMessage = currentMessage;
        drawScreen();
    }
    delay(5);
}
