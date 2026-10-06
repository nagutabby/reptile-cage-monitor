#include <Arduino.h>
#include <ArduinoJson.h>
#include <IRsend.h>
#include <ir_Daikin.h>
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
// 実機のリモコンから取得したDaikin312の状態(冷房27℃・風量静音・風向固定)。アプリで設定しない項目はこの値のまま送る
constexpr uint8_t DEFAULT_STATE[kDaikin312StateLength] = {
    0x11, 0xDA, 0x27, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x0E, 0x00, 0x00, 0x11, 0x00, 0x50,
    0x00, 0x00, 0x00, 0x00, 0x83, 0x11, 0xDA, 0x27, 0x00, 0x00, 0x39, 0x36, 0x00, 0xB0, 0x00,
    0x00, 0x06, 0x60, 0x00, 0x00, 0xC3, 0x00, 0x00, 0x5A,
};
// このキー群はdesiredに残さない。旧版のプリセット用キーも、残っていればここで掃除する
constexpr const char* DESIRED_KEYS[] = {
    "air_conditioner_command_id", "air_conditioner_power", "air_conditioner_mode",
    "air_conditioner_temp_c", "air_conditioner_fan", "air_conditioner_swing_v",
    "air_conditioner_operation", "air_conditioner_raw_data", "air_conditioner_preset_id",
    "air_conditioner_revision", "air_conditioner_name", "air_conditioner_requested_at",
    "air_conditioner_swing_h", "air_conditioner_quiet",
    "air_conditioner_powerful", "air_conditioner_econo", "air_conditioner_eye",
    "air_conditioner_eye_auto", "air_conditioner_eye_timer", "air_conditioner_purify",
    "air_conditioner_mold", "air_conditioner_clean", "air_conditioner_fresh_air",
    "air_conditioner_humidity", "air_conditioner_beep", "air_conditioner_light",
};

struct Option {
    const char* name;
    uint8_t value;
};

constexpr Option MODES[] = {{"cool", kDaikinCool}, {"heat", kDaikinHeat}, {"dry", kDaikinDry}};
constexpr Option FANS[] = {
    {"auto", kDaikinFanAuto}, {"quiet", kDaikinFanQuiet},
    {"1", 1}, {"2", 2}, {"3", 3}, {"4", 4}, {"5", 5},
};
constexpr Option SWINGS_V[] = {
    {"off", kDaikin312SwingVOff}, {"swing", kDaikin312SwingVSwing},
    {"highest", kDaikin312SwingVHighest}, {"high", kDaikin312SwingVHigh},
    {"upper_middle", kDaikin312SwingVUpperMiddle}, {"lower_middle", kDaikin312SwingVLowerMiddle},
    {"low", kDaikin312SwingVLow}, {"lowest", kDaikin312SwingVLowest},
    {"breeze", kDaikin312SwingVBreeze}, {"circulate", kDaikin312SwingVCirculate},
};

struct AirConditionerSettings {
    bool power;
    const Option* mode;
    float tempC;
    const Option* fan;
    const Option* swingV;
};

IRDaikin312 ac(IR_SEND_PIN);
MqttLink mqtt(CLIENT_ID);
Preferences storage;
bool storageReady = false;
bool previousMqttConnected = false;
String lastCommandId;
String lastCommandStatus;
String currentMessage = "Ready";
String lastSettingsText;

template <size_t N>
const Option* findOption(const Option (&options)[N], const char* name) {
    for (const Option& option : options) {
        if (strcmp(option.name, name) == 0) return &option;
    }
    return nullptr;
}

bool readSettings(JsonObjectConst source, AirConditionerSettings* result) {
    JsonVariantConst power = source["air_conditioner_power"];
    const Option* mode = findOption(MODES, source["air_conditioner_mode"] | "");
    const Option* fan = findOption(FANS, source["air_conditioner_fan"] | "");
    const Option* swingV = findOption(SWINGS_V, source["air_conditioner_swing_v"] | "");
    JsonVariantConst temperature = source["air_conditioner_temp_c"];
    if (!power.is<bool>() || !mode || !fan || !swingV
        || (!temperature.is<float>() && !temperature.is<int>())) return false;

    const float tempC = temperature.as<float>();
    if (!isfinite(tempC)) return false;

    *result = {power.as<bool>(), mode, tempC, fan, swingV};
    return true;
}

void putSettings(JsonObject target, const AirConditionerSettings& settings) {
    target["air_conditioner_power"] = settings.power;
    target["air_conditioner_mode"] = settings.mode->name;
    target["air_conditioner_temp_c"] = settings.tempC;
    target["air_conditioner_fan"] = settings.fan->name;
    target["air_conditioner_swing_v"] = settings.swingV->name;
}

// 範囲外や0.5℃刻みでない温度はsetTempが丸めるため、読み戻した値が違えば不正な指示として扱う
bool applySettings(const AirConditionerSettings& settings) {
    ac.setRaw(DEFAULT_STATE);
    ac.setPower(settings.power);
    ac.setMode(settings.mode->value);  // 冷房は下限温度が違うため、温度より先に設定する
    ac.setTemp(settings.tempC);
    ac.setFan(settings.fan->value);
    ac.setSwingVertical(settings.swingV->value);
    return ac.getTemp() == settings.tempC;
}

bool publishAirEvent(const char* commandId, const char* status) {
    JsonDocument event;
    event["command_id"] = commandId;
    event["status"] = status;
    event["reported_at"] = static_cast<uint64_t>(time(nullptr));
    String payload;
    serializeJson(event, payload);
    return mqtt.publish(AIR_CONDITIONER_STATE_TOPIC, payload.c_str());
}

void publishShadowResult(const char* commandId, const char* status, const AirConditionerSettings* settings) {
    JsonDocument shadow;
    JsonObject state = shadow["state"].to<JsonObject>();
    JsonObject reported = state["reported"].to<JsonObject>();
    reported["air_conditioner_command_id"] = commandId;
    reported["air_conditioner_status"] = status;
    reported["air_conditioner_reported_at"] = static_cast<uint64_t>(time(nullptr));
    if (settings) putSettings(reported, *settings);
    JsonObject desired = state["desired"].to<JsonObject>();
    for (const char* key : DESIRED_KEYS) desired[key] = nullptr;
    String payload;
    serializeJson(shadow, payload);
    mqtt.publish(SHADOW_UPDATE_TOPIC, payload.c_str());
}

void rememberCommand(const char* commandId, const char* status) {
    lastCommandId = commandId;
    lastCommandStatus = status;
    if (storageReady) {
        storage.putString("last_cmd", commandId);
        storage.putString("last_status", status);
    }
}

void finishCommand(const char* commandId, const char* status, const AirConditionerSettings* settings) {
    rememberCommand(commandId, status);
    publishAirEvent(commandId, status);
    publishShadowResult(commandId, status, settings);
}

void handleCommand(JsonObjectConst desired) {
    const char* commandId = desired["air_conditioner_command_id"] | "";
    if (!commandId[0]) {
        // 旧版のキーだけが残っているとdeltaが解消されないので掃除する
        if (desired.size() > 0) publishShadowResult("", "ignored", nullptr);
        return;
    }

    AirConditionerSettings settings;
    if (!readSettings(desired, &settings) || !applySettings(settings)) {
        currentMessage = "Invalid settings";
        Serial.printf("[IR] invalid settings for command %s\n", commandId);
        finishCommand(commandId, "failed", nullptr);
        return;
    }

    // 再接続でShadowを取得し直しても同じ指示を二重に送信しない
    if (lastCommandId == commandId) {
        publishAirEvent(commandId, lastCommandStatus.c_str());
        publishShadowResult(commandId, lastCommandStatus.c_str(), &settings);
        return;
    }

    ac.send();
    lastSettingsText = String(settings.power ? "on " : "off ") + settings.mode->name + " " + String(settings.tempC, 1) + "C fan " + settings.fan->name
        + " V " + settings.swingV->name;
    currentMessage = "IR sent";
    Serial.printf("[IR] sent %s for %s\n", lastSettingsText.c_str(), commandId);
    finishCommand(commandId, "sent", &settings);
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
    handleCommand(document["state"]["desired"].as<JsonObjectConst>());
}

void onConnection() {
    mqtt.subscribe(SHADOW_GET_ACCEPTED_TOPIC);
    mqtt.subscribe(SHADOW_GET_REJECTED_TOPIC);
    mqtt.subscribe(SHADOW_DELTA_TOPIC);
    mqtt.publish(SHADOW_GET_TOPIC, "{}");
    Serial.println("[Shadow] requested current state");
}

void drawScreen() {
    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.setCursor(4, 4);
    M5.Display.setTextSize(1);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.println("IR AIR CONDITIONER");
    M5.Display.printf("MQTT: %s\n", mqtt.connected() ? "online" : "offline");
    M5.Display.println(currentMessage);
    if (lastSettingsText.length()) M5.Display.println(lastSettingsText);
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

    ac.begin();
    mqtt.setCallback(onMqttMessage);
    mqtt.begin();
    drawScreen();
    Serial.println("[IR] Daikin312 controller ready: TX GPIO2");
}

void loop() {
    M5.update();
    mqtt.loop();
    if (mqtt.consumeJustConnected()) onConnection();

    const bool mqttConnected = mqtt.connected();
    static String previousScreenText;
    const String screenText = currentMessage + "\n" + lastSettingsText;
    if (mqttConnected != previousMqttConnected || previousScreenText != screenText) {
        previousMqttConnected = mqttConnected;
        previousScreenText = screenText;
        drawScreen();
    }
    delay(5);
}
