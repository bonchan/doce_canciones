#ifndef NODE_WIFI_H
#define NODE_WIFI_H

#include <WiFi.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "config.h"

constexpr const char* FW_VERSION = "0.0.4";


// ── timing ────────────────────────────────────────────────────────────────────
static unsigned long lastTelemetryPub = 0;
static unsigned long lastRetryMs      = 0;
#define RETRY_INTERVAL_MS    10000UL
#define PUBLISH_INTERVAL_MS  100UL

// ── LED pin ───────────────────────────────────────────────────────────────────
#if defined(CONFIG_IDF_TARGET_ESP32C3)
  #define LED_PIN 8
  #define LED_ON  LOW
  #define LED_OFF HIGH
#else
  #define LED_PIN 2
  #define LED_ON  HIGH
  #define LED_OFF LOW
#endif

// ── command state ─────────────────────────────────────────────────────────────
static bool ledActive         = false;
static unsigned long ledUntil = 0;

// ── globals ───────────────────────────────────────────────────────────────────
WiFiClient   espClient;
PubSubClient mqttClient(espClient);

char chipIDStr[20];

char topicTelemetry[64];
char topicStartup[64];
char topicCommand[64];
char topicCommandAll[64];

bool wifiConnected = false;
bool mqttConnected = false;

// ── tick commands (call in loop BEFORE publishTelemetry) ──────────────────────
void tickCommands() {
    if (ledActive && millis() >= ledUntil) {
        digitalWrite(LED_PIN, LED_OFF);
        ledActive = false;
    }
}

void publishStartup() {
    JsonDocument doc;
    doc["fw"] = FW_VERSION;
    doc["sn"] = SCRIPT_NAME;
    char buf[128];
    serializeJson(doc, buf);
    mqttClient.publish(topicStartup, buf);
}

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

// ── command handler (override in main sketch) ─────────────────────────────────
// Define this in your .ino to handle commands:
//   void onCommand(const char* cmd, JsonObject& params) { ... }
void onCommand(const char* cmd, JsonObject params) __attribute__((weak));
void onCommand(const char* cmd, JsonObject params) {
    Serial.print("onCommand");Serial.println(cmd);

    if (strcmp(cmd, "ALIVE") == 0) {
        publishStartup();
    } else if (strcmp(cmd, "IDENTIFY") == 0) {
        unsigned long duration = params["duration"] | 2000;
        digitalWrite(LED_PIN, LED_ON);
        ledActive = true;
        ledUntil  = millis() + duration;
    } else if (strcmp(cmd, "UPDATE") == 0) {
        const char* url = params["url"] | "";
        if (strlen(url) == 0) {
            Serial.println("OTA: no url");
            return;
        }
        updateFirmware(url);
    }
}

// ── MQTT callback ─────────────────────────────────────────────────────────────
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    // only handle command topics
    if (strcmp(topic, topicCommand) != 0 && strcmp(topic, topicCommandAll) != 0) return;

    // parse JSON
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (err) {
        Serial.print("CMD parse error: ");
        Serial.println(err.c_str());
        return;
    }

    const char* cmd = doc["cmd"] | "";
    JsonObject params = doc["params"].isNull() ? doc.createNestedObject("params") : doc["params"].as<JsonObject>();

    Serial.print("CMD: "); Serial.println(cmd);
    onCommand(cmd, params);
}

// ── WiFi ──────────────────────────────────────────────────────────────────────
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

// ── MQTT ──────────────────────────────────────────────────────────────────────
bool tryConnectMQTT() {
    if (!wifiConnected) return false;
    if (mqttClient.connected()) return true;

    Serial.print("MQTT connecting...");
    if (mqttClient.connect(chipIDStr, MQTT_USER, MQTT_PASS)) {
        Serial.println(" ok");
        mqttClient.subscribe(topicCommand);
        mqttClient.subscribe(topicCommandAll);
        publishStartup();
        return true;
    }

    Serial.print(" failed rc=");
    Serial.println(mqttClient.state());
    return false;
}

// ── setup ─────────────────────────────────────────────────────────────────────
void setupNetwork() {
    uint64_t chipid = ESP.getEfuseMac();
    snprintf(chipIDStr,      sizeof(chipIDStr),      "%04X%08X",
             (uint16_t)(chipid >> 32), (uint32_t)chipid);

    snprintf(topicTelemetry, sizeof(topicTelemetry), "esp32/chipid/%s/telemetry", chipIDStr);
    snprintf(topicStartup, sizeof(topicStartup), "esp32/chipid/%s/startup", chipIDStr);
    snprintf(topicCommand,   sizeof(topicCommand),   "esp32/chipid/%s/command", chipIDStr);
    snprintf(topicCommandAll,sizeof(topicCommandAll),"esp32/chipid/all/command");

    Serial.print("Chip ID: "); Serial.print(chipIDStr);
    Serial.print(" | FW Version: "); Serial.println(FW_VERSION);

    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LED_OFF);

    mqttClient.setBufferSize(512);
    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);

    wifiConnected = tryConnectWiFi();
    mqttConnected = tryConnectMQTT();
    lastRetryMs   = millis();
}

// ── tick (call in loop()) ────────────────────────────────────────────────────
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

// ── publish telemetry ─────────────────────────────────────────────────────────
void publishTelemetry(JsonDocument& doc) {
    if (!mqttConnected) return;
    if (millis() - lastTelemetryPub < PUBLISH_INTERVAL_MS) return;

    doc["wifi_rssi"] = WiFi.RSSI();
    doc["millis"] = millis();
    doc["status_led"] = ledActive ? 1 : 0;

    char buf[128];
    serializeJson(doc, buf);
    mqttClient.publish(topicTelemetry, buf);
    delay(1);
    lastTelemetryPub = millis();
}



#endif