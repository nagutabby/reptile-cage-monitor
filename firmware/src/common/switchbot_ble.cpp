#include "switchbot_ble.h"
#include <NimBLEDevice.h>

namespace SwitchBotBLE {

const char* SERVICE_UUID       = "cba20d00-224d-11e6-9fb8-0002a5d5c51b";
const char* WRITE_CHAR_UUID    = "cba20002-224d-11e6-9fb8-0002a5d5c51b";
const char* NOTIFY_CHAR_UUID   = "cba20003-224d-11e6-9fb8-0002a5d5c51b";

namespace {

// Shared across a single sendCommand() call - NimBLE notify callbacks run on
// the BLE host task, not the calling task, so we hand data back via a
// volatile-ish holder guarded by the fact only one sendCommand runs at a time.
Response* g_pendingResponse = nullptr;

struct AddressTypeEntry {
    char mac[18] = {};
    uint8_t addrType = BLE_ADDR_PUBLIC;
    bool valid = false;
};

AddressTypeEntry g_addressTypes[4];
size_t g_nextAddressTypeEntry = 0;

uint8_t cachedAddressType(const char* mac) {
    for (const auto& entry : g_addressTypes) {
        if (entry.valid && strcmp(entry.mac, mac) == 0) return entry.addrType;
    }
    return BLE_ADDR_PUBLIC;
}

void rememberAddressType(const char* mac, uint8_t addrType) {
    for (auto& entry : g_addressTypes) {
        if (entry.valid && strcmp(entry.mac, mac) == 0) {
            entry.addrType = addrType;
            return;
        }
    }

    AddressTypeEntry& entry = g_addressTypes[g_nextAddressTypeEntry];
    strlcpy(entry.mac, mac, sizeof(entry.mac));
    entry.addrType = addrType;
    entry.valid = true;
    g_nextAddressTypeEntry = (g_nextAddressTypeEntry + 1) % (sizeof(g_addressTypes) / sizeof(g_addressTypes[0]));
}

void notifyCallback(NimBLERemoteCharacteristic* /*chr*/, uint8_t* pData, size_t length, bool /*isNotify*/) {
    if (g_pendingResponse == nullptr) return;
    size_t n = length > sizeof(g_pendingResponse->data) ? sizeof(g_pendingResponse->data) : length;
    memcpy(g_pendingResponse->data, pData, n);
    g_pendingResponse->len = n;
    g_pendingResponse->ok = true;
}

} // namespace

namespace {

// Single connect/write/wait-for-RESP attempt, no retry. Returns true if the
// REQ was sent; resp.ok reflects whether a RESP notification actually arrived.
// `addrType` is BLE_ADDR_PUBLIC or BLE_ADDR_RANDOM - callers don't reliably
// know which a given device uses (some Plug Minis have shown up using a
// random static address instead of public), so sendCommand() tries both.
bool sendCommandOnce(const char* mac, const uint8_t* cmd, size_t cmdLen, Response& resp,
                     uint32_t timeoutMs, uint8_t addrType, uint32_t connectTimeoutSeconds) {
    resp = Response{};

    NimBLEClient* pClient = NimBLEDevice::createClient();
    pClient->setConnectTimeout(connectTimeoutSeconds * 1000UL);

    uint32_t connectStartMs = millis();
    bool connected = pClient->connect(NimBLEAddress(std::string(mac), addrType));
    uint32_t connectDurationMs = millis() - connectStartMs;
    Serial.printf("[BLE] connect %s addrType=%u in %lu ms: %s\n",
                  connected ? "OK" : "FAILED", addrType,
                  static_cast<unsigned long>(connectDurationMs), mac);
    if (!connected) {
        NimBLEDevice::deleteClient(pClient);
        return false;
    }
    rememberAddressType(mac, addrType);

    bool success = false;
    uint32_t discoveryStartMs = millis();
    NimBLERemoteService* pSvc = pClient->getService(SERVICE_UUID);
    uint32_t discoveryDurationMs = millis() - discoveryStartMs;
    Serial.printf("[BLE] service discovery in %lu ms: %s\n",
                  static_cast<unsigned long>(discoveryDurationMs), mac);
    if (pSvc == nullptr) {
        Serial.printf("[BLE] service not found: %s\n", mac);
    } else {
        NimBLERemoteCharacteristic* pWrite = pSvc->getCharacteristic(WRITE_CHAR_UUID);
        NimBLERemoteCharacteristic* pNotify = pSvc->getCharacteristic(NOTIFY_CHAR_UUID);
        if (pWrite == nullptr || pNotify == nullptr) {
            Serial.printf("[BLE] characteristic not found: %s\n", mac);
        } else {
            g_pendingResponse = &resp;
            uint32_t subscribeStartMs = millis();
            if (pNotify->canNotify()) {
                pNotify->subscribe(true, notifyCallback);
            }
            uint32_t subscribeDurationMs = millis() - subscribeStartMs;
            Serial.printf("[BLE] notify subscribe in %lu ms: %s\n",
                          static_cast<unsigned long>(subscribeDurationMs), mac);

            uint32_t writeStartMs = millis();
            if (pWrite->writeValue(cmd, cmdLen, true)) {
                uint32_t writeDurationMs = millis() - writeStartMs;
                Serial.printf("[BLE] request write in %lu ms: %s\n",
                              static_cast<unsigned long>(writeDurationMs), mac);
                uint32_t responseStartMs = millis();
                while (!resp.ok && (millis() - responseStartMs) < timeoutMs) {
                    delay(20);
                }
                Serial.printf("[BLE] response %s in %lu ms: %s\n",
                              resp.ok ? "received" : "timeout",
                              static_cast<unsigned long>(millis() - responseStartMs), mac);
                success = true; // request was sent; resp.ok reflects whether a RESP arrived
            } else {
                Serial.printf("[BLE] write failed: %s\n", mac);
            }

            if (pNotify->canNotify()) {
                pNotify->unsubscribe();
            }
            g_pendingResponse = nullptr;
        }
    }

    pClient->disconnect();
    NimBLEDevice::deleteClient(pClient);
    return success;
}

} // namespace

bool sendCommand(const char* mac, const uint8_t* cmd, size_t cmdLen, Response& resp,
                  uint32_t timeoutMs, uint8_t maxAttempts, uint32_t retryDelayMs,
                  uint32_t connectTimeoutSeconds) {
    // Start with the address type that connected last time, then try the other
    // type. This avoids paying a connection timeout on every command for plugs
    // that use a random static BLE address.
    const uint8_t preferredAddrType = cachedAddressType(mac);
    const uint8_t otherAddrType = preferredAddrType == BLE_ADDR_PUBLIC
        ? BLE_ADDR_RANDOM : BLE_ADDR_PUBLIC;

    for (uint8_t attempt = 1; attempt <= maxAttempts; attempt++) {
        uint8_t addrType = ((attempt - 1) % 2 == 0) ? preferredAddrType : otherAddrType;
        uint32_t attemptStartMs = millis();
        bool sent = sendCommandOnce(mac, cmd, cmdLen, resp, timeoutMs, addrType, connectTimeoutSeconds);
        bool ok = sent && resp.ok;
        Serial.printf("[BLE] attempt %u/%u %s in %lu ms: %s\n",
                      attempt, maxAttempts, ok ? "OK" : "FAILED",
                      static_cast<unsigned long>(millis() - attemptStartMs), mac);
        if (ok) return true;

        if (attempt < maxAttempts) {
            Serial.printf("[BLE] retry %u/%u: %s\n", attempt, maxAttempts, mac);
            delay(retryDelayMs);
        }
    }
    return false;
}

bool plugTurnOn(const char* mac, uint32_t timeoutMs, uint8_t maxAttempts,
                uint32_t retryDelayMs, uint32_t connectTimeoutSeconds) {
    const uint8_t cmd[] = {0x57, 0x0F, 0x50, 0x01, 0x01, 0x80};
    Response resp;
    if (!sendCommand(mac, cmd, sizeof(cmd), resp, timeoutMs, maxAttempts,
                     retryDelayMs, connectTimeoutSeconds)) return false;
    return resp.ok && resp.len >= 2 && resp.data[0] == 0x01 && resp.data[1] == 0x80;
}

bool plugTurnOff(const char* mac, uint32_t timeoutMs, uint8_t maxAttempts,
                 uint32_t retryDelayMs, uint32_t connectTimeoutSeconds) {
    const uint8_t cmd[] = {0x57, 0x0F, 0x50, 0x01, 0x01, 0x00};
    Response resp;
    if (!sendCommand(mac, cmd, sizeof(cmd), resp, timeoutMs, maxAttempts,
                     retryDelayMs, connectTimeoutSeconds)) return false;
    return resp.ok && resp.len >= 2 && resp.data[0] == 0x01 && resp.data[1] == 0x00;
}

bool plugReadState(const char* mac, bool& isOn, uint32_t timeoutMs,
                   uint8_t maxAttempts, uint32_t retryDelayMs,
                   uint32_t connectTimeoutSeconds) {
    const uint8_t cmd[] = {0x57, 0x0F, 0x51, 0x01};
    Response resp;
    if (!sendCommand(mac, cmd, sizeof(cmd), resp, timeoutMs, maxAttempts,
                     retryDelayMs, connectTimeoutSeconds)) return false;
    if (!resp.ok || resp.len < 2 || resp.data[0] != 0x01) return false;
    isOn = (resp.data[1] == 0x80);
    return true;
}

namespace {

bool meterScanOnce(const char* mac, MeterReading& out, uint32_t scanSeconds) {
    NimBLEScan* pScan = NimBLEDevice::getScan();
    pScan->setActiveScan(true);
    pScan->setInterval(100);
    pScan->setWindow(99);

    // Keep the public helper's seconds-based API; NimBLE-Arduino 2.x uses milliseconds.
    NimBLEScanResults results = pScan->getResults(scanSeconds * 1000UL, false);
    const std::string expectedAddress =
        NimBLEAddress(std::string(mac), BLE_ADDR_PUBLIC).toString();

    bool found = false;
    for (int i = 0; i < results.getCount() && !found; i++) {
        const NimBLEAdvertisedDevice* d = results.getDevice(i);
        if (d == nullptr) continue;
        if (d->getAddress().toString() != expectedAddress) continue;

        out = MeterReading{};
        // WoSensorTHO manufacturer-specific data (Type 0xFF), per meter.md "Other" section:
        //   data[10] fractional temp, data[11] sign+integer temp, data[12] humidity
        if (d->haveManufacturerData()) {
            std::string mfg = d->getManufacturerData();
            if (mfg.length() >= 13) {
                const uint8_t* data = reinterpret_cast<const uint8_t*>(mfg.data());
                float fraction = data[10] & 0x0F;
                int sign = (data[11] & 0x80) ? 1 : -1;
                int integer = data[11] & 0x7F;
                out.tempC = sign * (integer + fraction * 0.1f);
                out.humidity = data[12] & 0x7F;
                out.hasTempHumidity = true;
            }
        }
        // Service data (UUID 0xFD3D) payload after the UUID: data[2] bit[6:0] is battery %
        // (meter.md's data[5] counts the 0x16 type byte and UUID too).
        std::string svc = d->getServiceData(NimBLEUUID(static_cast<uint16_t>(0xFD3D)));
        if (svc.length() >= 3) out.batteryPct = static_cast<uint8_t>(svc[2]) & 0x7F;
        found = out.hasTempHumidity || out.batteryPct >= 0;
    }

    pScan->clearResults();
    return found;
}

} // namespace

bool meterScanReadPartial(const char* mac, MeterReading& out, uint32_t scanSeconds,
                          uint8_t maxAttempts) {
    for (uint8_t attempt = 1; attempt <= maxAttempts; attempt++) {
        if (meterScanOnce(mac, out, scanSeconds)) return true;
        if (attempt < maxAttempts) {
            Serial.printf("[Meter] retry %u/%u: %s\n", attempt, maxAttempts, mac);
        }
    }
    return false;
}

bool meterScanRead(const char* mac, float& tempC, uint8_t& humidity, uint32_t scanSeconds,
                   uint8_t maxAttempts, int* batteryPct) {
    for (uint8_t attempt = 1; attempt <= maxAttempts; attempt++) {
        MeterReading reading;
        if (meterScanOnce(mac, reading, scanSeconds) && reading.hasTempHumidity) {
            tempC = reading.tempC;
            humidity = reading.humidity;
            if (batteryPct != nullptr) *batteryPct = reading.batteryPct;
            return true;
        }
        if (attempt < maxAttempts) {
            Serial.printf("[Meter] retry %u/%u: %s\n", attempt, maxAttempts, mac);
        }
    }
    return false;
}

} // namespace SwitchBotBLE
