#ifndef NETWORK_H
#define NETWORK_H

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "./config.h"

static unsigned long lastStatePub = 0;

#if defined(CONFIG_IDF_TARGET_ESP32C3)
#define LED_PIN 8
#define LED_ON LOW
#define LED_OFF HIGH
#else
#define LED_PIN 2
#define LED_ON HIGH
#define LED_OFF LOW
#endif

// ---------- GLOBALS ----------
WiFiClient espClient;
PubSubClient client(espClient);
char chipIDStr[20];
char statusTopic[64];
char ledTopic[64];
char stateTopic[64];

// Global status variable so your main script can react to MQTT commands
bool externalTrigger = false;

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }

  // Example: Use an incoming MQTT command to change satellite behavior
  if (strcmp(topic, ledTopic) == 0) {
    if (msg == "1" || msg == "on" || msg == "ON") {
      digitalWrite(LED_PIN, LED_ON);
      externalTrigger = true;
    } else if (msg == "0" || msg == "off" || msg == "OFF") {
      digitalWrite(LED_PIN, LED_OFF);
      externalTrigger = false;
    }
  }
}

void reconnectMQTT() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection... ");
    if (client.connect(chipIDStr, mqtt_user, mqtt_pass)) {
      Serial.println("connected!");
      client.publish(statusTopic, "alive");
      client.subscribe(ledTopic);
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" retrying in 5 seconds...");

      for (int i = 0; i < 50; i++) {
        delay(100);
        yield();
      }
    }
  }
}

void setupNetwork() {
  // Get unique chip ID
  uint64_t chipid = ESP.getEfuseMac();
  snprintf(chipIDStr, sizeof(chipIDStr), "%04X%08X", (uint16_t)(chipid >> 32), (uint32_t)chipid);
  Serial.print("Chip ID: ");
  Serial.println(chipIDStr);

  // Dynamic Topics based on unique Chip ID
  snprintf(statusTopic, sizeof(statusTopic), "esp32/chipid/%s/status", chipIDStr);
  snprintf(ledTopic, sizeof(ledTopic), "esp32/chipid/%s/builtin_led", chipIDStr);
  snprintf(stateTopic, sizeof(stateTopic), "esp32/chipid/%s/state", chipIDStr);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LED_OFF);

  // Hidden Network Connection Sequence
  WiFi.begin(ssid, password, 0, NULL, true);
  Serial.print("Connecting to Hidden WiFi...");
  while (WiFi.status() != WL_CONNECTED) {
#if defined(CONFIG_IDF_TARGET_ESP32C3)
    delay(500);
#else
    vTaskDelay(500 / portTICK_PERIOD_MS);
#endif
    Serial.print(".");
  }
  Serial.println("\nConnected!");

  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);
}

void tickNetwork() {
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop();
}

void publishState(int ldrValue, int ledBrightness, int speakerFreq) {
  if (!client.connected()) return;

  if (millis() - lastStatePub > 500) {
    // Allocate a JSON document
    JsonDocument doc;

    // Stuff your satellite data into it
    doc["ldr"] = ldrValue;
    doc["led_bright"] = ledBrightness;
    doc["speaker_hz"] = speakerFreq;
    doc["wifi_rssi"] = WiFi.RSSI();

    // Serialize JSON to a char array buffer
    char jsonBuffer[128];
    serializeJson(doc, jsonBuffer);

    // Publish to the unique state topic
    client.publish(stateTopic, jsonBuffer);
    lastStatePub = millis();
  }
}

#endif