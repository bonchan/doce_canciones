// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "sensor.anemometer"
// human-readable name for this sketch
#define SCRIPT_NAME "esp32C3_anemometer"
// what this device reports in telemetry, e.g. "[\"light_level\"]"
#define CAPS_PUBLISHES "[\"wind_speed\",\"wind_direction\",\"roll\",\"pitch\",\"heading\",\"temperature\",\"pressure\"]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\"]"

const char* ZONE = "outdoor";

#include "../device_base.h"

#include <WiFiUdp.h>

// anemometer broadcasts to 192.168.200.255: 7779 = SignalK (JSON), 7780 = NMEA0183 (text)
// only the rows ticked in the SignalK column of its setup page are sent
const unsigned int localPort = 7779;
char packetBuffer[1024];  // SignalK JSON packets are bigger than 255 bytes
WiFiUDP udp;

// set to true to dump every raw UDP packet to Serial
#define DEBUG_UDP false

// readings older than this are left out of telemetry (sensor unticked / gone)
#define READING_STALE_MS 5000UL

// SignalK path → telemetry key. Anything not listed here is still published,
// under the last segment of its path (e.g. "environment.foo.bar" → "bar").
struct PathKey { const char* path; const char* key; };
const PathKey PATH_KEYS[] = {
  { "environment.wind.speedApparent",  "wind_speed" },      // sent in knots, published in m/s
  { "environment.wind.angleApparent",  "wind_direction" },  // sent in radians, published in degrees
  { "navigation.attitude.roll",        "roll" },
  { "navigation.attitude.pitch",       "pitch" },
  { "navigation.headingMagnetic",      "heading" },
  { "navigation.headingTrue",          "heading" },
  { "environment.outside.temperature", "temperature" },     // converted K → °C below
  { "environment.outside.pressure",    "pressure" },        // SignalK: Pa
};

// latest value per key, filled from UDP, read when publishing telemetry
struct Reading {
  char key[32];
  float value;
  unsigned long at;
};
#define MAX_READINGS 16
Reading readings[MAX_READINGS];
int numReadings = 0;

const char* keyForPath(const char* path) {
  for (const PathKey& pk : PATH_KEYS) {
    if (strcmp(path, pk.path) == 0) return pk.key;
  }
  const char* dot = strrchr(path, '.');
  return dot ? dot + 1 : path;
}

void storeReading(const char* key, float value) {
  for (int i = 0; i < numReadings; i++) {
    if (strcmp(readings[i].key, key) == 0) {
      readings[i].value = value;
      readings[i].at = millis();
      return;
    }
  }
  if (numReadings >= MAX_READINGS) return;
  strlcpy(readings[numReadings].key, key, sizeof(readings[numReadings].key));
  readings[numReadings].value = value;
  readings[numReadings].at = millis();
  numReadings++;
}

// {"updates":[{"values":[{"path":"...","value":1.23}, ...]}]}
void parseSignalK(char* payload) {
  JsonDocument sk;
  DeserializationError err = deserializeJson(sk, payload);
  if (err) {
    Serial.print("SignalK parse error: "); Serial.println(err.c_str());
    return;
  }

  for (JsonObject update : sk["updates"].as<JsonArray>()) {
    for (JsonObject v : update["values"].as<JsonArray>()) {
      const char* path = v["path"];
      if (!path || !v["value"].is<float>()) continue;  // skip object values (e.g. position)

      const char* key = keyForPath(path);
      float value = v["value"];
      if (strcmp(key, "temperature") == 0)    value -= 273.15f;           // Kelvin → °C
      if (strcmp(key, "wind_speed") == 0)     value *= 0.514444f;         // knots → m/s
      if (strcmp(key, "wind_direction") == 0) value *= 180.0f / PI;       // radians → degrees (0–360)

      storeReading(key, value);
    }
  }
}

// optional: override onCommand for capabilities beyond the defaults
// (IDENTIFY / ALTER / UPDATE are already handled in device_base.h)
// void onCommand(const char* cmd, JsonObject params) {
//     if (strcmp(cmd, "MY_CAPABILITY") == 0) {
//         // your logic
//     }
// }

void setup() {
  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce

  // modem sleep makes the ESP32 miss most broadcast UDP packets
  WiFi.setSleep(false);

  // anemometer broadcasts to 192.168.200.255, so this must be 192.168.200.x
  Serial.print("Local IP: "); Serial.print(WiFi.localIP());
  Serial.print(" | listening UDP port "); Serial.println(localPort);

  udp.begin(localPort);
}

void loop() {
  tickNetwork();
  tickCommands();

  // drain every packet that arrived since the last loop
  while (int packetSize = udp.parsePacket()) {
    int len = udp.read(packetBuffer, sizeof(packetBuffer) - 1);
    if (len <= 0) continue;
    packetBuffer[len] = '\0';

    if (DEBUG_UDP) {
      Serial.printf("[UDP %d bytes from %s] %s\n",
                    packetSize, udp.remoteIP().toString().c_str(), packetBuffer);
    }

    parseSignalK(packetBuffer);
  }

  JsonDocument doc;
  unsigned long now = millis();
  for (int i = 0; i < numReadings; i++) {
    if (now - readings[i].at > READING_STALE_MS) continue;
    doc[readings[i].key] = readings[i].value;
  }
  doc["chip_temp"] = temperatureRead();
  publishTelemetry(doc);

  delay(1);
}
