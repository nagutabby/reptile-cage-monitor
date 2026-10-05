#include <Arduino.h>
#include <ArduinoJson.h>
#include <M5Unified.h>
#include <Preferences.h>
#include <ir_Daikin.h>

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

struct AirConditionerSettings {
    bool power;
    uint8_t mode;
    float tempC;
    uint8_t fan;
    uint8_t swingV;
    uint8_t swingH;
    bool quiet;
    bool powerful;
    bool econo;
    bool eye;
    bool eyeAuto;
    uint8_t eyeTimer;
    bool purify;
    bool mold;
    bool clean;
    uint8_t freshAir;
    uint8_t humidity;
    uint8_t beep;
    uint8_t light;
};

IRDaikin312 irac(IR_SEND_PIN);
MqttLink mqtt(CLIENT_ID);
Preferences storage;
bool storageReady = false;
bool previousMqttConnected = false;
bool hasLastSettings = false;
AirConditionerSettings lastSettings{};
String lastCommandId;
String lastCommandStatus;
String currentMessage = "Ready";

bool readBool(JsonObjectConst source, const char* key, bool* result) {
    JsonVariantConst value = source[key];
    if (!value.is<bool>()) return false;
    *result = value.as<bool>();
    return true;
}

const char* readText(JsonObjectConst source, const char* key) {
    JsonVariantConst value = source[key];
    return value.is<const char*>() ? value.as<const char*>() : "";
}

bool parseMode(const char* value, uint8_t* result) {
    if (strcmp(value, "auto") == 0) *result = kDaikinAuto;
    else if (strcmp(value, "cool") == 0) *result = kDaikinCool;
    else if (strcmp(value, "heat") == 0) *result = kDaikinHeat;
    else if (strcmp(value, "dry") == 0) *result = kDaikinDry;
    else if (strcmp(value, "fan") == 0) *result = kDaikinFan;
    else return false;
    return true;
}

bool parseFan(const char* value, uint8_t* result) {
    if (strcmp(value, "auto") == 0) *result = kDaikinFanAuto;
    else if (strcmp(value, "quiet") == 0) *result = kDaikinFanQuiet;
    else if (strlen(value) == 1 && value[0] >= '1' && value[0] <= '5') *result = value[0] - '0';
    else return false;
    return true;
}

bool parseSwingV(const char* value, uint8_t* result) {
    if (strcmp(value, "off") == 0) *result = kDaikin312SwingVOff;
    else if (strcmp(value, "swing") == 0) *result = kDaikin312SwingVAuto;
    else if (strcmp(value, "highest") == 0) *result = kDaikin312SwingVHighest;
    else if (strcmp(value, "high") == 0) *result = kDaikin312SwingVHigh;
    else if (strcmp(value, "upper_middle") == 0) *result = kDaikin312SwingVUpperMiddle;
    else if (strcmp(value, "lower_middle") == 0) *result = kDaikin312SwingVLowerMiddle;
    else if (strcmp(value, "low") == 0) *result = kDaikin312SwingVLow;
    else if (strcmp(value, "lowest") == 0) *result = kDaikin312SwingVLowest;
    else if (strcmp(value, "breeze") == 0) *result = kDaikin312SwingVBreeze;
    else if (strcmp(value, "circulate") == 0) *result = kDaikin312SwingVCirculate;
    else return false;
    return true;
}

bool parseSwingH(const char* value, uint8_t* result) {
    if (strcmp(value, "off") == 0) *result = kDaikin312SwingHOff;
    else if (strcmp(value, "swing") == 0) *result = kDaikin312SwingHAuto;
    else if (strcmp(value, "wide") == 0) *result = kDaikin312SwingHWide;
    else if (strcmp(value, "left_max") == 0) *result = kDaikin312SwingHLeftMax;
    else if (strcmp(value, "left") == 0) *result = kDaikin312SwingHLeft;
    else if (strcmp(value, "middle") == 0) *result = kDaikin312SwingHMiddle;
    else if (strcmp(value, "right") == 0) *result = kDaikin312SwingHRight;
    else if (strcmp(value, "right_max") == 0) *result = kDaikin312SwingHRightMax;
    else return false;
    return true;
}

bool parseHumidity(const char* value, uint8_t mode, uint8_t* result) {
    if (strcmp(value, "off") == 0) *result = kDaikin312HumidityOff;
    else if (strcmp(value, "auto") == 0) *result = kDaikin312HumidityAuto;
    else if (strcmp(value, "40") == 0 && mode == kDaikinHeat) *result = kDaikin312HumidityHeatLow;
    else if (strcmp(value, "45") == 0 && mode == kDaikinHeat) *result = kDaikin312HumidityHeatMedium;
    else if (strcmp(value, "50") == 0 && mode == kDaikinHeat) *result = kDaikin312HumidityHeatHigh;
    else if (strcmp(value, "50") == 0 && mode == kDaikinDry) *result = kDaikin312HumidityDryLow;
    else if (strcmp(value, "55") == 0 && mode == kDaikinDry) *result = kDaikin312HumidityDryMedium;
    else if (strcmp(value, "60") == 0 && mode == kDaikinDry) *result = kDaikin312HumidityDryHigh;
    else return false;
    return true;
}

bool parseSettings(JsonObjectConst command, AirConditionerSettings* result) {
    if (!readBool(command, "air_conditioner_power", &result->power)
        || !parseMode(readText(command, "air_conditioner_mode"), &result->mode)
        || !parseFan(readText(command, "air_conditioner_fan"), &result->fan)
        || !parseSwingV(readText(command, "air_conditioner_swing_v"), &result->swingV)
        || !parseSwingH(readText(command, "air_conditioner_swing_h"), &result->swingH)
        || !readBool(command, "air_conditioner_quiet", &result->quiet)
        || !readBool(command, "air_conditioner_powerful", &result->powerful)
        || !readBool(command, "air_conditioner_econo", &result->econo)
        || !readBool(command, "air_conditioner_eye", &result->eye)
        || !readBool(command, "air_conditioner_eye_auto", &result->eyeAuto)
        || !readBool(command, "air_conditioner_purify", &result->purify)
        || !readBool(command, "air_conditioner_mold", &result->mold)
        || !readBool(command, "air_conditioner_clean", &result->clean)) return false;

    JsonVariantConst temperature = command["air_conditioner_temp_c"];
    if (!temperature.is<float>() && !temperature.is<int>()) return false;
    result->tempC = temperature.as<float>();
    if (!isfinite(result->tempC) || result->tempC < 10.0f || result->tempC > 32.0f
        || fabsf(result->tempC * 2.0f - roundf(result->tempC * 2.0f)) > 0.001f
        || (result->mode == kDaikinCool && result->tempC < kDaikin312MinCoolTemp)) return false;
    if (result->quiet && result->powerful) return false;

    const char* eyeTimer = readText(command, "air_conditioner_eye_timer");
    if (strcmp(eyeTimer, "off") == 0) result->eyeTimer = kDaikin312EyeTimerOff;
    else if (strcmp(eyeTimer, "1h") == 0) result->eyeTimer = kDaikin312EyeTimer1Hr;
    else if (strcmp(eyeTimer, "3h") == 0) result->eyeTimer = kDaikin312EyeTimer3Hr;
    else return false;

    const char* freshAir = readText(command, "air_conditioner_fresh_air");
    if (strcmp(freshAir, "off") == 0) result->freshAir = 0;
    else if (strcmp(freshAir, "on") == 0) result->freshAir = 1;
    else if (strcmp(freshAir, "high") == 0) result->freshAir = 2;
    else return false;

    if (!parseHumidity(readText(command, "air_conditioner_humidity"), result->mode, &result->humidity)) return false;
    if (result->mode == kDaikinHeat
        && result->humidity != kDaikin312HumidityOff
        && result->humidity != kDaikin312HumidityAuto
        && result->humidity != kDaikin312HumidityHeatLow
        && result->humidity != kDaikin312HumidityHeatMedium
        && result->humidity != kDaikin312HumidityHeatHigh) return false;
    if (result->mode == kDaikinDry
        && result->humidity != kDaikin312HumidityOff
        && result->humidity != kDaikin312HumidityAuto
        && result->humidity != kDaikin312HumidityDryLow
        && result->humidity != kDaikin312HumidityDryMedium
        && result->humidity != kDaikin312HumidityDryHigh) return false;
    if (result->mode != kDaikinHeat && result->mode != kDaikinDry
        && result->humidity != kDaikin312HumidityOff) return false;

    const char* beep = readText(command, "air_conditioner_beep");
    if (strcmp(beep, "off") == 0) result->beep = kDaikinBeepOff;
    else if (strcmp(beep, "quiet") == 0) result->beep = kDaikinBeepQuiet;
    else if (strcmp(beep, "loud") == 0) result->beep = kDaikinBeepLoud;
    else return false;

    const char* light = readText(command, "air_conditioner_light");
    if (strcmp(light, "off") == 0) result->light = kDaikinLightOff;
    else if (strcmp(light, "dim") == 0) result->light = kDaikinLightDim;
    else if (strcmp(light, "bright") == 0) result->light = kDaikinLightBright;
    else return false;
    return true;
}

const char* modeLabel(uint8_t mode) {
    switch (mode) {
        case kDaikinCool: return "Cool";
        case kDaikinHeat: return "Heat";
        case kDaikinDry: return "Dry";
        case kDaikinFan: return "Fan";
        default: return "Auto";
    }
}

const char* fanLabel(uint8_t fan) {
    if (fan == kDaikinFanAuto) return "Auto";
    if (fan == kDaikinFanQuiet) return "Quiet";
    static char label[8];
    snprintf(label, sizeof(label), "%u", fan);
    return label;
}

const char* swingVLabel(uint8_t position) {
    if (position == kDaikin312SwingVOff) return "Fixed";
    if (position == kDaikin312SwingVAuto) return "Swing";
    if (position == kDaikin312SwingVHighest) return "Top";
    if (position == kDaikin312SwingVHigh) return "High";
    if (position == kDaikin312SwingVUpperMiddle) return "Up-mid";
    if (position == kDaikin312SwingVLowerMiddle) return "Low-mid";
    if (position == kDaikin312SwingVLow) return "Low";
    if (position == kDaikin312SwingVLowest) return "Bottom";
    if (position == kDaikin312SwingVBreeze) return "Breeze";
    return "Circulate";
}

void drawScreen() {
    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.setCursor(4, 4);
    M5.Display.setTextSize(1);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.println("DAIKIN 312 IR");
    M5.Display.printf("MQTT: %s\n", mqtt.connected() ? "online" : "offline");
    M5.Display.println(currentMessage);
    if (hasLastSettings) {
        M5.Display.printf("%s %s %.1f C\n", lastSettings.power ? "ON" : "OFF",
                          modeLabel(lastSettings.mode), lastSettings.tempC);
        M5.Display.printf("Fan %s  V %s\n", fanLabel(lastSettings.fan), swingVLabel(lastSettings.swingV));
        M5.Display.printf("H swing: %s\n", lastSettings.swingH == kDaikin312SwingHAuto ? "Swing" : "Set");
    }
    M5.Display.println("Web settings -> IR");
}

void copyDesiredToReported(JsonObject reported, JsonObjectConst desired) {
    for (JsonPairConst pair : desired) {
        const char* key = pair.key().c_str();
        if (strncmp(key, "air_conditioner_", sizeof("air_conditioner_") - 1) == 0) {
            reported[key] = pair.value();
        }
    }
}

void publishCommandResult(const char* commandId, const char* status, JsonObjectConst desired) {
    const uint64_t reportedAt = static_cast<uint64_t>(time(nullptr));
    JsonDocument event;
    event["command_id"] = commandId;
    event["status"] = status;
    event["reported_at"] = reportedAt;
    JsonObject eventSettings = event["settings"].to<JsonObject>();
    copyDesiredToReported(eventSettings, desired);
    char eventPayload[1800];
    const size_t eventSize = serializeJson(event, eventPayload, sizeof(eventPayload));
    if (eventSize) mqtt.publish(AIR_CONDITIONER_STATE_TOPIC, eventPayload, true);

    JsonDocument shadow;
    JsonObject reported = shadow["state"]["reported"].to<JsonObject>();
    copyDesiredToReported(reported, desired);
    reported["air_conditioner_command_id"] = commandId;
    reported["air_conditioner_status"] = status;
    reported["air_conditioner_reported_at"] = reportedAt;
    char shadowPayload[1800];
    const size_t shadowSize = serializeJson(shadow, shadowPayload, sizeof(shadowPayload));
    if (shadowSize) mqtt.publish(SHADOW_UPDATE_TOPIC, shadowPayload);
}

void rememberCommand(const char* commandId, const char* status) {
    lastCommandId = commandId;
    lastCommandStatus = status;
    if (storageReady) {
        storage.putString("last_cmd", commandId);
        storage.putString("last_status", status);
    }
}

void handleCommand(JsonObjectConst desired) {
    const char* commandId = readText(desired, "air_conditioner_command_id");
    if (!commandId[0]) return;

    AirConditionerSettings settings{};
    const bool validSettings = parseSettings(desired, &settings);
    if (validSettings) {
        lastSettings = settings;
        hasLastSettings = true;
    }

    const String previousCommandId = storageReady
        ? storage.getString("last_cmd", lastCommandId)
        : lastCommandId;
    if (previousCommandId == commandId) {
        const String previousStatus = storageReady
            ? storage.getString("last_status", lastCommandStatus.length() ? lastCommandStatus : "failed")
            : (lastCommandStatus.length() ? lastCommandStatus : "failed");
        publishCommandResult(commandId, previousStatus.c_str(), desired);
        Serial.printf("[IR] ignored duplicate command %s\n", commandId);
        return;
    }

    const char* status = "failed";
    if (validSettings) {
        irac.setMode(settings.mode);
        irac.setTemp(settings.tempC);
        irac.setFan(settings.fan);
        irac.setSwingVertical(settings.swingV);
        irac.setSwingHorizontal(settings.swingH);
        irac.setPower(settings.power);
        irac.setQuiet(settings.quiet);
        irac.setPowerful(settings.powerful);
        irac.setEcono(settings.econo);
        irac.setEye(settings.eye);
        irac.setEyeAuto(settings.eyeAuto);
        irac.setEyeTimer(settings.eyeTimer);
        irac.setPurify(settings.purify);
        irac.setMold(settings.mold);
        irac.setClean(settings.clean);
        irac.setFreshAir(settings.freshAir != 0);
        irac.setFreshAirHigh(settings.freshAir == 2);
        irac.setHumidity(settings.humidity);
        irac.setBeep(settings.beep);
        irac.setLight(settings.light);
        irac.send();
        status = "sent";
        currentMessage = "IR sent";
        Serial.printf("[IR] sent command %s: %s %.1fC fan=%s\n", commandId,
                      modeLabel(settings.mode), settings.tempC, fanLabel(settings.fan));
    } else {
        currentMessage = "Invalid settings";
        Serial.printf("[IR] invalid settings for command %s\n", commandId);
    }

    rememberCommand(commandId, status);
    publishCommandResult(commandId, status, desired);
    drawScreen();
}

void onMqttMessage(char* topic, uint8_t* payload, unsigned int length) {
    if (strcmp(topic, SHADOW_GET_REJECTED_TOPIC) == 0) {
        Serial.println("[Shadow] get rejected");
        return;
    }
    if (strcmp(topic, SHADOW_DELTA_TOPIC) == 0) {
        // Delta omits values that already match reported. Fetch the full desired
        // state so a command with an unchanged setting can still be applied.
        mqtt.publish(SHADOW_GET_TOPIC, "{}");
        return;
    }
    if (strcmp(topic, SHADOW_GET_ACCEPTED_TOPIC) != 0) return;

    JsonDocument document;
    if (deserializeJson(document, payload, length)) {
        Serial.println("[Shadow] invalid JSON");
        return;
    }
    JsonObjectConst state = document["state"].as<JsonObjectConst>();
    JsonObjectConst desired = state["desired"].as<JsonObjectConst>();
    handleCommand(desired);
}

void onConnection() {
    mqtt.subscribe(SHADOW_GET_ACCEPTED_TOPIC);
    mqtt.subscribe(SHADOW_GET_REJECTED_TOPIC);
    mqtt.subscribe(SHADOW_DELTA_TOPIC);
    mqtt.publish(SHADOW_GET_TOPIC, "{}");
    Serial.println("[Shadow] requested current state");
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

    irac.begin();
    mqtt.setCallback(onMqttMessage);
    mqtt.begin();
    drawScreen();
    Serial.println("[IR] Daikin312 controller ready: TX GPIO2, 36.7 kHz");
}

void loop() {
    M5.update();
    mqtt.loop();
    if (mqtt.consumeJustConnected()) onConnection();

    const bool mqttConnected = mqtt.connected();
    if (mqttConnected != previousMqttConnected) {
        previousMqttConnected = mqttConnected;
        drawScreen();
    }
    delay(5);
}
