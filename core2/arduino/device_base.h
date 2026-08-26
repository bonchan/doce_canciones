#ifndef DEVICE_BASE_H
#define DEVICE_BASE_H

#include <WiFi.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "config.h"

constexpr const char* FW_VERSION = "0.0.1";

// Each .ino should #define these before #include "device_base.h":
//   #define DEVICE_TYPE     "sensor.ldr"
//   #define SCRIPT_NAME     "bichito_dodecaedro"
//   #define CAPS_PUBLISHES  "[\"light_level\"]"
//   #define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\"]"
// Capabilities are just announce metadata (for the brain's registry / any
// dashboard) — they don't enforce anything on-device, keep them in sync
// with what the sketch actually does by hand.
#ifndef DEVICE_TYPE
#define DEVICE_TYPE "unknown"
#endif
#ifndef SCRIPT_NAME
#define SCRIPT_NAME "unnamed"
#endif
#ifndef CAPS_PUBLISHES
#define CAPS_PUBLISHES "[]"
#endif
#ifndef CAPS_SUBSCRIBES
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\"]"
#endif

// ── timing ───────────────────────────────────────────────────────────────
static unsigned long lastTelemetryPub = 0;
static unsigned long lastRetryMs      = 0;
#define RETRY_INTERVAL_MS    10000UL
#define PUBLISH_INTERVAL_MS  1000UL

// ── LED pin ──────────────────────────────────────────────────────────────
#if defined(CONFIG_IDF_TARGET_ESP32C3)
  #define LED_PIN 8
  #define LED_ON  LOW
  #define LED_OFF HIGH
#else
  #define LED_PIN 2
  #define LED_ON  HIGH
  #define LED_OFF LOW
#endif

// ── command state ────────────────────────────────────────────────────────
static bool ledActive         = false;
static unsigned long ledUntil = 0;

static bool alteredActive         = false;
static unsigned long alteredUntil = 0;

// ── globals ──────────────────────────────────────────────────────────────
WiFiClient   espClient;
PubSubClient mqttClient(espClient);

char chipIDStr[20];

// installation/<zone>/<chip_id>/...
char topicStatus[80];
char topicAnnounce[80];
char topicTelemetry[80];
char topicCmdPrefix[80];        // "installation/<zone>/<chip_id>/cmd/"
char topicBroadcastPrefix[80];  // "installation/broadcast/<DEVICE_TYPE>/cmd/"

bool wifiConnected = false;
bool mqttConnected = false;

// ── tick commands (call in loop BEFORE publishTelemetry) ──────────────────
void tickCommands() {
    if (ledActive && millis() >= ledUntil) {
        digitalWrite(LED_PIN, LED_OFF);
        ledActive = false;
        Serial.println("tickCommands led end");
    }
    if (alteredActive && millis() >= alteredUntil) {
        // digitalWrite(LED_PIN, LED_OFF);
        alteredActive = false;
        Serial.println("tickCommands alter end");
    }
}

// Optional: define this in your sketch to inject extra JSON object members
// into the announce payload — e.g. geometry constants a dashboard page needs
// to scale itself, without hardcoding device-specific field names into this
// shared file. Return raw JSON members WITHOUT surrounding braces, e.g.:
//   const char* announceExtraFields() { return "\"motor_y\":1000.00"; }
// Declared weak with no body here (same pattern as onCommand) so sketches
// that don't need it don't have to define it; guarded by `if
// (announceExtraFields)` before calling since the weak-undefined symbol
// resolves to a null function pointer.
const char* announceExtraFields() __attribute__((weak));

// ── announce / status — both retained ──────────────────────────────────
// Retained so a brain that restarts gets the current picture replayed to it
// immediately by the broker, without any device having to do anything.
void publishAnnounce() {
    char extra[128] = "";
    if (announceExtraFields) {
        const char* fields = announceExtraFields();
        if (fields && fields[0]) {
            snprintf(extra, sizeof(extra), ",%s", fields);
        }
    }

    // Sized generously above what today's longest CAPS_PUBLISHES/SUBSCRIBES
    // list needs — snprintf itself is overflow-safe (truncates + always
    // null-terminates), but a truncated announce is invalid JSON on the
    // wire, so warn if a future capability list ever grows past this.
    char buf[400];
    int n = snprintf(buf, sizeof(buf),
        "{\"type\":\"%s\",\"fw\":\"%s\",\"sn\":\"%s\",\"capabilities\":{\"publishes\":%s,\"subscribes\":%s}%s}",
        DEVICE_TYPE, FW_VERSION, SCRIPT_NAME, CAPS_PUBLISHES, CAPS_SUBSCRIBES, extra);
    if (n < 0 || (size_t)n >= sizeof(buf)) {
        Serial.println("WARNING: announce payload truncated, buf[] too small — increase it in device_base.h");
    }
    mqttClient.publish(topicAnnounce, buf, true);  // retained
}

void publishOnline() {
    mqttClient.publish(topicStatus, "online", true);  // retained
}

// ── OTA ──────────────────────────────────────────────────────────────────
void updateFirmware(const char* url) {
    Serial.print("OTA from: "); Serial.println(url);
    unsigned long startTime = millis();
    while (millis() - startTime < 5000) {
        digitalWrite(LED_PIN, LED_ON); delay(50);
        digitalWrite(LED_PIN, LED_OFF); delay(50);
    }
    digitalWrite(LED_PIN, LED_OFF);

    // stop MQTT loop interference
    mqttClient.disconnect();

    HTTPClient http;
    http.begin(url);

    t_httpUpdate_return ret = httpUpdate.update(http);

    switch (ret) {
        case HTTP_UPDATE_FAILED:
            Serial.printf("OTA failed: %s\n", httpUpdate.getLastErrorString().c_str());
            digitalWrite(LED_PIN, LED_OFF);
            break;
        case HTTP_UPDATE_NO_UPDATES:
            Serial.println("OTA: no update");
            break;
        case HTTP_UPDATE_OK:
            Serial.println("OTA ok — rebooting");
            // device reboots automatically
            break;
    }
}

// ── built-in capabilities — always run, for every sketch ───────────────────
// Not weak, not meant to be overridden — mqttCallback() below calls this
// unconditionally, so IDENTIFY/ALTER/UPDATE always work regardless of
// whatever a sketch's own onCommand() does (or doesn't) handle.
void handleBaseCommand(const char* cmd, JsonObject params) {
    if (strcmp(cmd, "IDENTIFY") == 0) {
        unsigned long duration = params["duration"] | 2000;
        digitalWrite(LED_PIN, LED_ON);
        ledActive = true;
        ledUntil  = millis() + duration;
    } else if (strcmp(cmd, "ALTER") == 0) {
        unsigned long duration = params["duration"] | 3000;
        alteredActive = true;
        alteredUntil  = millis() + duration;
    } else if (strcmp(cmd, "UPDATE") == 0) {
        const char* url = params["url"] | "";
        if (strlen(url) == 0) {
            Serial.println("OTA: no url");
            return;
        }
        updateFirmware(url);
    }
}

// ── command handler (optional, define in your .ino) ────────────────────────
// Only define this if your device has capabilities beyond IDENTIFY/ALTER/
// UPDATE — those are always handled by handleBaseCommand() above regardless
// of whether you define onCommand at all, so there's nothing to forward to
// it yourself:
//   void onCommand(const char* capability, JsonObject params) {
//       if (strcmp(capability, "MY_CAPABILITY") == 0) { ... }
//   }
// `capability` is read straight off the topic (installation/.../cmd/<capability>
// or installation/broadcast/<type>/cmd/<capability>) — the payload is just
// the params object, no {"cmd":..., "params":...} wrapper.
//
// Declared weak with NO body here on purpose — device_base.h must never
// provide a definition for this one, or any sketch that defines its own
// hits the exact redefinition error this replaces. If no sketch defines it,
// the weak symbol resolves to a null pointer, which is why the call below is
// guarded with `if (onCommand)`.
void onCommand(const char* cmd, JsonObject params) __attribute__((weak));

// ── MQTT callback ────────────────────────────────────────────────────────
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    const char* capability = nullptr;

    if (strncmp(topic, topicCmdPrefix, strlen(topicCmdPrefix)) == 0) {
        capability = topic + strlen(topicCmdPrefix);
    } else if (strncmp(topic, topicBroadcastPrefix, strlen(topicBroadcastPrefix)) == 0) {
        capability = topic + strlen(topicBroadcastPrefix);
    } else {
        return;  // not addressed to us
    }
    if (strlen(capability) == 0) return;

    JsonDocument doc;
    if (length > 0) {
        DeserializationError err = deserializeJson(doc, payload, length);
        if (err) {
            Serial.print("CMD parse error: ");
            Serial.println(err.c_str());
            return;
        }
    }
    JsonObject params = doc.as<JsonObject>();

    Serial.print("CMD: "); Serial.println(capability);
    handleBaseCommand(capability, params);
    if (onCommand) {
        onCommand(capability, params);
    }
}

// ── WiFi ─────────────────────────────────────────────────────────────────
bool tryConnectWiFi() {
    if (WiFi.status() == WL_CONNECTED) return true;

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD, 0, NULL, true);
    Serial.print("WiFi connecting");

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - start > 5000) {
            Serial.println(" timeout.");
            WiFi.disconnect(true);
            return false;
        }
        delay(200);
        yield();
        Serial.print(".");
    }
    Serial.println(" ok");
    return true;
}

// ── MQTT ─────────────────────────────────────────────────────────────────
bool tryConnectMQTT() {
    if (!wifiConnected) return false;
    if (mqttClient.connected()) return true;

    Serial.print("MQTT connecting...");
    // LWT: if this device drops without disconnecting cleanly, the broker
    // publishes "offline" (retained) on topicStatus on its behalf — that's
    // what gives the backend near-instant offline detection instead of
    // having to wait on a polling timeout.
    bool ok = mqttClient.connect(
        chipIDStr, MQTT_USER, MQTT_PASS,
        topicStatus, /*willQos=*/1, /*willRetain=*/true, "offline"
    );

    if (ok) {
        Serial.println(" ok");
        mqttClient.subscribe((String(topicCmdPrefix) + "#").c_str());
        mqttClient.subscribe((String(topicBroadcastPrefix) + "#").c_str());
        publishOnline();    // retained — overwrites any stale "offline" from a previous LWT
        publishAnnounce();  // retained — replayed to the brain even if it restarts later
        return true;
    }

    Serial.print(" failed rc=");
    Serial.println(mqttClient.state());
    return false;
}

// ── setup ────────────────────────────────────────────────────────────────
void setupNetwork() {
    Serial.begin(115200);

    uint64_t chipid = ESP.getEfuseMac();
    snprintf(chipIDStr, sizeof(chipIDStr), "%04X%08X", (uint16_t)(chipid >> 32), (uint32_t)chipid);

    snprintf(topicStatus,          sizeof(topicStatus),          "installation/%s/%s/status",    ZONE, chipIDStr);
    snprintf(topicAnnounce,        sizeof(topicAnnounce),        "installation/%s/%s/announce",  ZONE, chipIDStr);
    snprintf(topicTelemetry,       sizeof(topicTelemetry),       "installation/%s/%s/telemetry", ZONE, chipIDStr);
    snprintf(topicCmdPrefix,       sizeof(topicCmdPrefix),       "installation/%s/%s/cmd/", ZONE, chipIDStr);
    snprintf(topicBroadcastPrefix, sizeof(topicBroadcastPrefix), "installation/broadcast/%s/cmd/", DEVICE_TYPE);

    Serial.print("Chip ID: "); Serial.print(chipIDStr);
    Serial.print(" | Zone: "); Serial.print(ZONE);
    Serial.print(" | Type: "); Serial.print(DEVICE_TYPE);
    Serial.print(" | FW: "); Serial.println(FW_VERSION);

    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LED_OFF);

    mqttClient.setBufferSize(512);
    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);

    wifiConnected = tryConnectWiFi();
    mqttConnected = tryConnectMQTT();
    lastRetryMs   = millis();
}

// ── tick (call in loop()) ───────────────────────────────────────────────
void tickNetwork() {
    wifiConnected = (WiFi.status() == WL_CONNECTED);
    mqttConnected = mqttClient.connected();

    if (!wifiConnected) {
        digitalWrite(LED_PIN, (millis() / 200) % 2);
    }

    if (wifiConnected && !mqttConnected) {
        digitalWrite(LED_PIN, (millis() / 500) % 2);
    }

    if (!wifiConnected || !mqttConnected) {
        if (millis() - lastRetryMs >= RETRY_INTERVAL_MS) {
            Serial.println("Retrying network...");
            wifiConnected = tryConnectWiFi();
            mqttConnected = tryConnectMQTT();
            lastRetryMs   = millis();
            if (wifiConnected && mqttConnected) {
               digitalWrite(LED_PIN, LED_OFF);
            }
        }
        return;
    }

    mqttClient.loop();
}

// ── telemetry ────────────────────────────────────────────────────────────
void publishTelemetry(JsonDocument& doc) {
    if (!mqttConnected) return;
    if (millis() - lastTelemetryPub < PUBLISH_INTERVAL_MS) return;

    doc["wifi_rssi"] = WiFi.RSSI();
    doc["millis"] = millis();
    doc["status_led"] = ledActive ? 1 : 0;

    // Sized generously above what today's largest telemetry doc (polargraph:
    // 8 numeric fields + these 3) needs. serializeJson()'s array overload is
    // overflow-safe (never writes past buf, always null-terminates) but will
    // silently produce truncated/invalid JSON if the doc outgrows this —
    // it returns the number of bytes that *would* have been written, so a
    // return >= sizeof(buf) means it happened.
    char buf[320];
    size_t n = serializeJson(doc, buf);
    if (n >= sizeof(buf)) {
        Serial.println("WARNING: telemetry payload truncated, buf[] too small — increase it in device_base.h");
        return;  // don't publish garbage JSON the backend can't parse
    }
    mqttClient.publish(topicTelemetry, buf);  // not retained — changes too fast to be worth it
    delay(1);
    lastTelemetryPub = millis();
}

// ── device-to-device broadcast ──────────────────────────────────────────
// Lets a device trigger every device of a given type directly, without
// going through the brain at all — e.g. an LDR node calling
//   publishBroadcastCommand("actuator.speaker", "play_sound", doc);
// when it reads too much light.
void publishBroadcastCommand(const char* targetType, const char* capability, JsonDocument& paramsDoc) {
    if (!mqttConnected) return;
    char topic[96];
    snprintf(topic, sizeof(topic), "installation/broadcast/%s/cmd/%s", targetType, capability);
    char buf[128];
    serializeJson(paramsDoc, buf);
    mqttClient.publish(topic, buf);
}

#endif
