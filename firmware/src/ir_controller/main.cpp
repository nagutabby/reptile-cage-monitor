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
constexpr uint32_t MAX_RAW_SPACE_US = 131070;
constexpr uint8_t IR_RECEIVE_TIMEOUT_MS = 120;
constexpr uint8_t IR_SEND_DUTY_PERCENT = 50;
constexpr uint8_t IR_SEND_ATTEMPTS = 2;
constexpr uint16_t IR_REPEAT_GAP_MS = 100;
constexpr uint8_t PRESET_COUNT = 4;
constexpr uint32_t LEARN_TIMEOUT_MS = 60000;
constexpr uint32_t LEARN_LONG_PRESS_MS = 1000;
constexpr uint16_t IR_CARRIER_HZ = 38000;
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

struct PresetSlot {
    String name;
    AirConditionerPreset settings;
    uint32_t revision = 0;
    uint32_t rawData[MAX_RAW_ITEMS]{};
    uint16_t rawLength = 0;
    bool cloudSavePending = false;
};

IRsend irsend(IR_SEND_PIN);
// kRawBuf(100)ではDaikinの全フレーム(数百要素)が切り捨てられるため、保存上限+先頭1要素を確保する
IRrecv irrecv(IR_RECEIVE_PIN, MAX_RAW_ITEMS + kStartOffset, IR_RECEIVE_TIMEOUT_MS);
MqttLink mqtt(CLIENT_ID);
Preferences storage;
bool storageReady = false;
bool previousMqttConnected = false;
bool learningActive = false;
uint32_t learningDeadline = 0;
uint8_t selectedPresetId = 1;
uint8_t learningPresetId = 1;
bool longPressHandled = false;
uint32_t nextCloudRetryMs = 0;
PresetSlot presets[PRESET_COUNT];
AirConditionerPreset learningPreset;
String learningName;
uint32_t learningRevision = 0;
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

uint8_t presetIndex(uint8_t presetId) {
    return static_cast<uint8_t>(presetId - 1);
}

String presetKey(const char* prefix, uint8_t presetId) {
    return String(prefix) + String(presetId);
}

bool validPresetSettings(const AirConditionerPreset& preset) {
    const char* mode = preset.mode.c_str();
    const char* fan = preset.fan.c_str();
    const char* swingV = preset.swingV.c_str();
    const float temperature = preset.tempC;
    return (strcmp(mode, "cool") == 0 || strcmp(mode, "heat") == 0)
        && (strcmp(fan, "auto") == 0 || strcmp(fan, "quiet") == 0
            || (strlen(fan) == 1 && fan[0] >= '1' && fan[0] <= '5'))
        && (strcmp(swingV, "off") == 0 || strcmp(swingV, "swing") == 0
            || strcmp(swingV, "highest") == 0 || strcmp(swingV, "high") == 0
            || strcmp(swingV, "upper_middle") == 0 || strcmp(swingV, "lower_middle") == 0
            || strcmp(swingV, "low") == 0 || strcmp(swingV, "lowest") == 0
            || strcmp(swingV, "breeze") == 0 || strcmp(swingV, "circulate") == 0)
        && isfinite(temperature) && temperature >= 10.0f && temperature <= 32.0f
        && fabsf(temperature * 2.0f - roundf(temperature * 2.0f)) <= 0.001f
        && (strcmp(mode, "heat") == 0 || temperature >= 18.0f);
}

bool savePresetSettings(uint8_t presetId, const AirConditionerPreset& preset,
                        const String& name, uint32_t revision) {
    if (presetId < 1 || presetId > PRESET_COUNT || !validPresetSettings(preset)) return false;
    PresetSlot& slot = presets[presetIndex(presetId)];
    slot.settings = preset;
    slot.name = name.length() ? name.substring(0, 48) : String("Preset ") + String(presetId);
    slot.revision = revision;
    if (!storageReady) return false;
    bool stored = true;
    stored &= storage.putString(presetKey("mode", presetId).c_str(), preset.mode) > 0;
    stored &= storage.putFloat(presetKey("temp", presetId).c_str(), preset.tempC) > 0;
    stored &= storage.putString(presetKey("fan", presetId).c_str(), preset.fan) > 0;
    stored &= storage.putString(presetKey("swing", presetId).c_str(), preset.swingV) > 0;
    stored &= storage.putString(presetKey("name", presetId).c_str(), slot.name) > 0;
    stored &= storage.putUInt(presetKey("rev", presetId).c_str(), revision) > 0;
    return stored;
}

bool validRawData(const uint32_t* rawData, uint16_t rawLength) {
    if (!rawData || rawLength < 2 || rawLength > MAX_RAW_ITEMS) return false;
    for (uint16_t index = 0; index < rawLength; ++index) {
        const uint32_t maxValue = index % 2 == 0 ? UINT16_MAX : MAX_RAW_SPACE_US;
        if (rawData[index] == 0 || rawData[index] > maxValue) return false;
    }
    return true;
}

bool savePresetRaw(uint8_t presetId, const uint32_t* rawData, uint16_t rawLength) {
    if (!storageReady || presetId < 1 || presetId > PRESET_COUNT
        || !validRawData(rawData, rawLength)) return false;
    const String rawKey = presetKey("raw", presetId);
    const String lengthKey = presetKey("len", presetId);
    const String pendingKey = presetKey("cloud", presetId);
    const size_t bytes = static_cast<size_t>(rawLength) * sizeof(uint32_t);
    PresetSlot& slot = presets[presetIndex(presetId)];
    slot.cloudSavePending = true;
    storage.putBool(pendingKey.c_str(), true);
    if (storage.putBytes(rawKey.c_str(), rawData, bytes) != bytes
        || storage.putUShort(lengthKey.c_str(), rawLength) != sizeof(uint16_t)) return false;
    memcpy(slot.rawData, rawData, bytes);
    slot.rawLength = rawLength;
    slot.cloudSavePending = true;
    return true;
}

void loadPresets() {
    for (uint8_t presetId = 1; presetId <= PRESET_COUNT; ++presetId) {
        PresetSlot& slot = presets[presetIndex(presetId)];
        slot.name = String("Preset ") + String(presetId);
        slot.settings.mode = "cool";
        slot.settings.tempC = 27.0f;
        slot.settings.fan = "auto";
        slot.settings.swingV = "off";
        if (!storageReady) continue;

        AirConditionerPreset stored;
        stored.mode = storage.getString(presetKey("mode", presetId).c_str(), "cool");
        stored.tempC = storage.getFloat(presetKey("temp", presetId).c_str(), 27.0f);
        stored.fan = storage.getString(presetKey("fan", presetId).c_str(), "auto");
        stored.swingV = storage.getString(presetKey("swing", presetId).c_str(), "off");
        if (validPresetSettings(stored)) slot.settings = stored;
        slot.name = storage.getString(presetKey("name", presetId).c_str(), slot.name);
        slot.revision = storage.getUInt(presetKey("rev", presetId).c_str(), 0);
        slot.cloudSavePending = storage.getBool(presetKey("cloud", presetId).c_str(), false);
        const uint16_t length = storage.getUShort(presetKey("len", presetId).c_str(), 0);
        if (length >= 2 && length <= MAX_RAW_ITEMS) {
            const String rawKey = presetKey("raw", presetId);
            const size_t currentBytes = static_cast<size_t>(length) * sizeof(uint32_t);
            const size_t legacyBytes = static_cast<size_t>(length) * sizeof(uint16_t);
            if (storage.getBytesLength(rawKey.c_str()) == currentBytes
                && storage.getBytes(rawKey.c_str(), slot.rawData, currentBytes) == currentBytes
                && validRawData(slot.rawData, length)) {
                slot.rawLength = length;
            } else if (storage.getBytesLength(rawKey.c_str()) == legacyBytes) {
                uint16_t legacyRaw[MAX_RAW_ITEMS];
                if (storage.getBytes(rawKey.c_str(), legacyRaw, legacyBytes) == legacyBytes) {
                    for (uint16_t index = 0; index < length; ++index) slot.rawData[index] = legacyRaw[index];
                    if (validRawData(slot.rawData, length)
                        && storage.putBytes(rawKey.c_str(), slot.rawData, currentBytes) == currentBytes) {
                        slot.rawLength = length;
                    }
                }
            }
        }
    }
    selectedPresetId = storageReady ? storage.getUChar("selected", 1) : 1;
    if (selectedPresetId < 1 || selectedPresetId > PRESET_COUNT) selectedPresetId = 1;
}

void clearLegacyDesired(JsonObject desired) {
    desired["air_conditioner_command_id"] = nullptr;
    desired["air_conditioner_operation"] = nullptr;
    desired["air_conditioner_raw_data"] = nullptr;
    desired["air_conditioner_mode"] = nullptr;
    desired["air_conditioner_temp_c"] = nullptr;
    desired["air_conditioner_fan"] = nullptr;
    desired["air_conditioner_swing_v"] = nullptr;
    desired["air_conditioner_preset_id"] = nullptr;
    desired["air_conditioner_revision"] = nullptr;
    desired["air_conditioner_name"] = nullptr;
    for (const char* key : LEGACY_DESIRED_KEYS) desired[key] = nullptr;
}

bool publishAirEvent(uint8_t presetId, const char* commandId, const char* status,
                     const AirConditionerPreset& preset, const String& name, uint32_t revision,
                     const uint32_t* rawData = nullptr, uint16_t rawLength = 0) {
    JsonDocument event;
    event["command_id"] = commandId;
    event["preset_id"] = presetId;
    event["name"] = name;
    event["revision"] = revision;
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

void markCapturePublished(uint8_t presetId) {
    if (presetId < 1 || presetId > PRESET_COUNT) return;
    PresetSlot& slot = presets[presetIndex(presetId)];
    slot.cloudSavePending = false;
    if (storageReady) storage.putBool(presetKey("cloud", presetId).c_str(), false);
}

void retryPendingCaptureEvents() {
    if (!storageReady || !mqtt.connected()) return;
    for (uint8_t presetId = 1; presetId <= PRESET_COUNT; ++presetId) {
        const PresetSlot& slot = presets[presetIndex(presetId)];
        if (!slot.cloudSavePending || slot.rawLength < 2) continue;
        const String commandId = String("capture-sync-") + String(presetId) + "-" + String(millis());
        if (publishAirEvent(presetId, commandId.c_str(), "captured", slot.settings, slot.name,
                            slot.revision, slot.rawData, slot.rawLength)) {
            markCapturePublished(presetId);
        }
    }
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
                         uint8_t presetId, const AirConditionerPreset& preset,
                         const String& name, uint32_t revision) {
    JsonDocument shadow;
    JsonObject state = shadow["state"].to<JsonObject>();
    JsonObject reported = state["reported"].to<JsonObject>();
    reported["air_conditioner_command_id"] = commandId;
    reported["air_conditioner_operation"] = operation;
    reported["air_conditioner_mode"] = preset.mode;
    reported["air_conditioner_temp_c"] = preset.tempC;
    reported["air_conditioner_fan"] = preset.fan;
    reported["air_conditioner_swing_v"] = preset.swingV;
    reported["air_conditioner_preset_id"] = presetId;
    reported["air_conditioner_revision"] = revision;
    reported["air_conditioner_name"] = name;
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

void finishLearning(const uint32_t* rawData, uint16_t rawLength) {
    const String commandId = learningCommandId;
    const AirConditionerPreset preset = learningPreset;
    const String name = learningName;
    const uint32_t revision = learningRevision;
    const uint8_t presetId = learningPresetId;
    learningActive = false;
    learningCommandId = "";

    if (rawLength < 2 || rawLength > MAX_RAW_ITEMS || !validRawData(rawData, rawLength)) {
        currentMessage = rawLength > MAX_RAW_ITEMS ? "IR signal too long" : "Invalid IR signal";
        publishAirEvent(presetId, commandId.c_str(), "failed", preset, name, revision);
        rememberCommand(commandId.c_str(), "failed");
        publishShadowResult(commandId.c_str(), "learn", "failed", presetId, preset, name, revision);
        return;
    }

    if (!savePresetRaw(presetId, rawData, rawLength)) {
        currentMessage = "NVS save failed";
        publishAirEvent(presetId, commandId.c_str(), "failed", preset, name, revision);
        rememberCommand(commandId.c_str(), "failed");
        publishShadowResult(commandId.c_str(), "learn", "failed", presetId, preset, name, revision);
        return;
    }

    currentMessage = String("Preset ") + String(presetId) + " learned";
    if (publishAirEvent(presetId, commandId.c_str(), "captured", preset, name, revision, rawData, rawLength)) {
        markCapturePublished(presetId);
    }
    rememberCommand(commandId.c_str(), "captured");
    publishShadowResult(commandId.c_str(), "learn", "captured", presetId, preset, name, revision);
    Serial.printf("[IR] learned %u raw timings for %s\n", rawLength, commandId.c_str());
}

void startLearning(uint8_t presetId, const String& commandId,
                   const AirConditionerPreset& preset, const String& name, uint32_t revision) {
    if (presetId < 1 || presetId > PRESET_COUNT || !validPresetSettings(preset)) return;
    if (!savePresetSettings(presetId, preset, name, revision)) {
        currentMessage = "NVS settings save failed";
        return;
    }
    learningPresetId = presetId;
    learningPreset = preset;
    learningName = name;
    learningRevision = revision;
    learningCommandId = commandId;
    learningDeadline = millis() + LEARN_TIMEOUT_MS;
    learningActive = true;
    currentMessage = String("Learning preset ") + String(presetId);
    publishAirEvent(presetId, commandId.c_str(), "learning", preset, name, revision);
    Serial.printf("[IR] learning started for preset %u (%s)\n", presetId, commandId.c_str());
}

bool readRawData(JsonVariantConst source, uint32_t* target, uint16_t* length) {
    if (!source.is<JsonArrayConst>()) return false;
    JsonArrayConst timings = source.as<JsonArrayConst>();
    if (timings.size() < 2 || timings.size() > MAX_RAW_ITEMS) return false;
    uint16_t index = 0;
    for (JsonVariantConst timing : timings) {
        if (!timing.is<uint32_t>() && !timing.is<int>()) return false;
        const int64_t value = timing.as<int64_t>();
        const uint32_t maxValue = index % 2 == 0 ? UINT16_MAX : MAX_RAW_SPACE_US;
        if (value <= 0 || static_cast<uint64_t>(value) > maxValue) return false;
        target[index++] = static_cast<uint32_t>(value);
    }
    *length = index;
    return true;
}

bool syncPresetSettings(JsonObjectConst desired, uint8_t* syncedPresetId) {
    JsonVariantConst idValue = desired["air_conditioner_preset_id"];
    if (idValue.isNull()) return false;
    if (!idValue.is<int>() && !idValue.is<unsigned int>()) return false;
    const int rawId = idValue.as<int>();
    if (rawId < 1 || rawId > PRESET_COUNT) return false;

    const uint8_t presetId = static_cast<uint8_t>(rawId);
    AirConditionerPreset preset;
    if (!readPreset(desired, &preset)) return false;
    JsonVariantConst revisionValue = desired["air_conditioner_revision"];
    const uint32_t revision = revisionValue.is<uint32_t>() ? revisionValue.as<uint32_t>() : 0;
    PresetSlot& slot = presets[presetIndex(presetId)];
    if (revision >= slot.revision) {
        const char* requestedName = desired["air_conditioner_name"] | slot.name.c_str();
        if (!savePresetSettings(presetId, preset, String(requestedName), revision)) {
            currentMessage = "NVS settings save failed";
        }
    }
    *syncedPresetId = presetId;
    return true;
}

void publishPresetSyncResult(uint8_t presetId) {
    if (presetId < 1 || presetId > PRESET_COUNT) return;
    const PresetSlot& slot = presets[presetIndex(presetId)];
    JsonDocument shadow;
    JsonObject state = shadow["state"].to<JsonObject>();
    JsonObject reported = state["reported"].to<JsonObject>();
    reported["air_conditioner_preset_id"] = presetId;
    reported["air_conditioner_revision"] = slot.revision;
    reported["air_conditioner_name"] = slot.name;
    reported["air_conditioner_mode"] = slot.settings.mode;
    reported["air_conditioner_temp_c"] = slot.settings.tempC;
    reported["air_conditioner_fan"] = slot.settings.fan;
    reported["air_conditioner_swing_v"] = slot.settings.swingV;
    JsonObject desired = state["desired"].to<JsonObject>();
    clearLegacyDesired(desired);
    String payload;
    payload.reserve(measureJson(shadow) + 1);
    serializeJson(shadow, payload);
    mqtt.publish(SHADOW_UPDATE_TOPIC, payload.c_str());
}

void handleCommand(JsonObjectConst desired) {
    uint8_t syncedPresetId = 0;
    const bool syncedSettings = syncPresetSettings(desired, &syncedPresetId);
    const char* commandId = desired["air_conditioner_command_id"] | "";
    const char* operation = desired["air_conditioner_operation"] | "";
    if (!commandId[0]) {
        if (syncedSettings) publishPresetSyncResult(syncedPresetId);
        return;
    }

    if (strcmp(operation, "learn") != 0 && strcmp(operation, "send") != 0) {
        rememberCommand(commandId, "ignored");
        clearUnrecognizedCommand(commandId, "ignored");
        Serial.printf("[IR] ignored unrecognized command %s\n", commandId);
        return;
    }

    JsonVariantConst idValue = desired["air_conditioner_preset_id"];
    const int rawId = idValue.is<int>() || idValue.is<unsigned int>() ? idValue.as<int>() : 0;
    if (rawId < 1 || rawId > PRESET_COUNT) {
        currentMessage = "Invalid preset ID";
        rememberCommand(commandId, "failed");
        clearUnrecognizedCommand(commandId, "failed");
        return;
    }
    const uint8_t presetId = static_cast<uint8_t>(rawId);
    AirConditionerPreset preset;
    if (!readPreset(desired, &preset)) {
        currentMessage = "Invalid preset";
        rememberCommand(commandId, "failed");
        clearUnrecognizedCommand(commandId, "failed");
        Serial.printf("[IR] invalid preset for command %s\n", commandId);
        return;
    }
    PresetSlot& slot = presets[presetIndex(presetId)];
    const char* requestedName = desired["air_conditioner_name"] | slot.name.c_str();
    const JsonVariantConst revisionValue = desired["air_conditioner_revision"];
    const uint32_t revision = revisionValue.is<uint32_t>() ? revisionValue.as<uint32_t>() : slot.revision;
    if (revision >= slot.revision) savePresetSettings(presetId, preset, String(requestedName), revision);
    if (learningActive && learningCommandId == commandId) return;

    const String previousCommandId = storageReady
        ? storage.getString("last_cmd", lastCommandId)
        : lastCommandId;
    if (previousCommandId == commandId) {
        const String previousStatus = storageReady
            ? storage.getString("last_status", lastCommandStatus.length() ? lastCommandStatus : "failed")
            : (lastCommandStatus.length() ? lastCommandStatus : "failed");
        publishAirEvent(presetId, commandId, previousStatus.c_str(), preset, slot.name, slot.revision);
        publishShadowResult(commandId, operation, previousStatus.c_str(), presetId, preset, slot.name, slot.revision);
        return;
    }

    if (strcmp(operation, "learn") == 0) {
        startLearning(presetId, String(commandId), preset, slot.name, slot.revision);
        return;
    }

    uint32_t rawData[MAX_RAW_ITEMS];
    uint16_t rawLength = 0;
    bool valid = strcmp(operation, "send") == 0
        && readRawData(desired["air_conditioner_raw_data"], rawData, &rawLength);
    const char* status = "failed";
    if (valid) {
        for (uint8_t attempt = 0; attempt < IR_SEND_ATTEMPTS; ++attempt) {
            irsend.enableIROut(IR_CARRIER_HZ, IR_SEND_DUTY_PERCENT);
            for (uint16_t index = 0; index < rawLength; ++index) {
                if (index % 2 == 0) irsend.mark(static_cast<uint16_t>(rawData[index]));
                else irsend.space(rawData[index]);
            }
            if (attempt + 1 < IR_SEND_ATTEMPTS) delay(IR_REPEAT_GAP_MS);
        }
        status = "sent";
        currentMessage = "Raw IR sent";
        Serial.printf("[IR] sent %u raw timings for %s\n", rawLength, commandId);
    } else {
        currentMessage = "Invalid IR data";
        Serial.printf("[IR] invalid command %s\n", commandId);
    }

    rememberCommand(commandId, status);
    publishAirEvent(presetId, commandId, status, preset, slot.name, slot.revision);
    publishShadowResult(commandId, operation, status, presetId, preset, slot.name, slot.revision);
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
    retryPendingCaptureEvents();
    Serial.println("[Shadow] requested current state");
}

void pollInfrared() {
    if (learningActive) {
        if (static_cast<int32_t>(millis() - learningDeadline) >= 0) {
            const String commandId = learningCommandId;
            const AirConditionerPreset preset = learningPreset;
            const String name = learningName;
            const uint32_t revision = learningRevision;
            const uint8_t presetId = learningPresetId;
            learningActive = false;
            learningCommandId = "";
            currentMessage = "IR learn timed out";
            publishAirEvent(presetId, commandId.c_str(), "failed", preset, name, revision);
            rememberCommand(commandId.c_str(), "failed");
            publishShadowResult(commandId.c_str(), "learn", "failed", presetId, preset, name, revision);
            Serial.printf("[IR] learn timed out for %s\n", commandId.c_str());
        } else {
            decode_results results{};
            if (irrecv.decode(&results)) {
                const uint16_t rawLength = results.rawlen > kStartOffset
                    ? results.rawlen - kStartOffset
                    : 0;
                if (!results.overflow && rawLength >= 2 && rawLength <= MAX_RAW_ITEMS) {
                    uint32_t rawData[MAX_RAW_ITEMS];
                    for (uint16_t index = 0; index < rawLength; ++index) {
                        const uint32_t micros = static_cast<uint32_t>(results.rawbuf[index + kStartOffset]) * kRawTick;
                        rawData[index] = max<uint32_t>(micros, 1);
                    }
                    finishLearning(rawData, rawLength);
                } else {
                    Serial.printf("[IR] ignored capture with %u timings (overflow=%d)\n", rawLength, results.overflow);
                    finishLearning(nullptr, results.overflow ? MAX_RAW_ITEMS + 1 : rawLength);
                }
                irrecv.resume();
            }
        }
    } else {
        decode_results results{};
        if (irrecv.decode(&results)) irrecv.resume();
    }
}

void drawScreen();

void pollButton() {
    if (M5.BtnA.pressedFor(LEARN_LONG_PRESS_MS) && !longPressHandled) {
        longPressHandled = true;
        if (!learningActive) {
            const PresetSlot& slot = presets[presetIndex(selectedPresetId)];
            const String commandId = String("button-") + String(selectedPresetId) + "-" + String(millis());
            startLearning(selectedPresetId, commandId, slot.settings, slot.name, slot.revision);
        }
    }
    if (M5.BtnA.wasReleased()) {
        if (!longPressHandled) {
            selectedPresetId = selectedPresetId >= PRESET_COUNT ? 1 : selectedPresetId + 1;
            if (storageReady) storage.putUChar("selected", selectedPresetId);
            currentMessage = String("Selected preset ") + String(selectedPresetId);
            drawScreen();
        }
        longPressHandled = false;
    }
}

void drawScreen() {
    M5.Display.fillScreen(TFT_BLACK);
    M5.Display.setCursor(4, 4);
    M5.Display.setTextSize(1);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    M5.Display.println("IR RAW PRESETS");
    M5.Display.printf("MQTT: %s\n", mqtt.connected() ? "online" : "offline");
    const PresetSlot& selected = presets[presetIndex(selectedPresetId)];
    M5.Display.printf("Slot %u/4: %s\n", selectedPresetId, selected.name.c_str());
    M5.Display.printf("IR: %s\n", selected.rawLength ? "learned" : "not learned");
    M5.Display.println(currentMessage);
    if (learningActive) {
        M5.Display.printf("Learning slot %u\n", learningPresetId);
        M5.Display.printf("%s %.1f C\n", learningPreset.mode.c_str(), learningPreset.tempC);
        M5.Display.printf("Fan %s V %s\n", learningPreset.fan.c_str(), learningPreset.swingV.c_str());
    }
    M5.Display.println("Click: next slot");
    M5.Display.println("Hold 1s: learn (60s)");
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
    loadPresets();

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
    pollButton();
    pollInfrared();
    if (static_cast<int32_t>(millis() - nextCloudRetryMs) >= 0) {
        nextCloudRetryMs = millis() + 10000;
        retryPendingCaptureEvents();
    }

    const bool mqttConnected = mqtt.connected();
    if (mqttConnected != previousMqttConnected) {
        previousMqttConnected = mqttConnected;
        drawScreen();
    }
    static String previousScreenMessage;
    static uint8_t previousScreenPresetId = 0;
    if (previousScreenMessage != currentMessage || previousScreenPresetId != selectedPresetId) {
        previousScreenMessage = currentMessage;
        previousScreenPresetId = selectedPresetId;
        drawScreen();
    }
    delay(5);
}
