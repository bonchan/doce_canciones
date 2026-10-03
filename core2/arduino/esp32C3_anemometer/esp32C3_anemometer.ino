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
#include <Wire.h>
#include <hd44780.h>                       // library "hd44780" by Bill Perry
#include <hd44780ioClass/hd44780_I2Cexp.h>

// 16x2 LCD on a PCF8574 I2C adapter. Adapter VCC = 3.3 V, LCD pin 2 (VDD) = 5 V.
// Not GPIO 8 (status LED) or 9 (BOOT button) — both are strapping pins.
#define LCD_SDA 6
#define LCD_SCL 7
#define LCD_UPDATE_MS 500UL
hd44780_I2Cexp lcd;  // finds the adapter's I2C address by itself (0x27 / 0x3F)
bool lcdOk = false;
unsigned long lastLcdUpdate = 0;

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

// latest value for key, false if never received or stale
bool getReading(const char* key, float& value) {
  for (int i = 0; i < numReadings; i++) {
    if (strcmp(readings[i].key, key) == 0) {
      if (millis() - readings[i].at > READING_STALE_MS) return false;
      value = readings[i].value;
      return true;
    }
  }
  return false;
}

// overwrite a whole row (padded to 16 chars) instead of lcd.clear(), which flickers
void lcdLine(uint8_t row, const char* text) {
  char line[17];
  snprintf(line, sizeof(line), "%-16s", text);
  lcd.setCursor(0, row);
  lcd.print(line);
}

#define DEG ((char)223)  // ° in the LCD's character ROM

// ALTER (alteredActive, from device_base.h): blink the whole display on/off
void tickAlterBlink() {
  static bool blinkOff = false;
  bool off = alteredActive && (millis() / 50) % 2;
  if (off == blinkOff) return;
  blinkOff = off;
  if (off) { lcd.noBacklight(); lcd.noDisplay(); }
  else     { lcd.backlight();   lcd.display(); }
}

// IDENTIFY (ledActive, from device_base.h): show chip id + device type
void showIdentity() {
  // "sensor.anemometer" is 17 chars, too long for 16: drop the "sensor." part
  const char* type = DEVICE_TYPE;
  if (strlen(type) > 16 && strchr(type, '.')) type = strchr(type, '.') + 1;
  lcdLine(0, chipIDStr);
  lcdLine(1, type);
}

// Viento  3.2 m/s
// Dir 198° 22.9°C
void updateDisplay() {
  if (!lcdOk) return;
  tickAlterBlink();

  if (millis() - lastLcdUpdate < LCD_UPDATE_MS) return;
  lastLcdUpdate = millis();

  if (ledActive) {
    showIdentity();
    return;
  }

  char buf[32];
  float speed, dir, temp;
  bool hasSpeed = getReading("wind_speed", speed);
  bool hasDir   = getReading("wind_direction", dir);
  bool hasTemp  = getReading("temperature", temp);

  if (!hasSpeed && !hasDir && !hasTemp) {
    lcdLine(0, "ANEMOMETRO");
    lcdLine(1, wifiConnected ? "Esperando datos" : "Conectando...");
    return;
  }

  if (hasSpeed) snprintf(buf, sizeof(buf), "Viento  %4.1f m/s", speed);
  else          snprintf(buf, sizeof(buf), "Viento    -- m/s");
  lcdLine(0, buf);

  char d[8], t[12];
  if (hasDir)  snprintf(d, sizeof(d), "%3ld%c", lroundf(dir) % 360, DEG); else strcpy(d, " --");
  if (hasTemp) snprintf(t, sizeof(t), "%5.1f%cC", temp, DEG);           else strcpy(t, "   --");
  snprintf(buf, sizeof(buf), "Dir %s %s", d, t);
  lcdLine(1, buf);
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
  // LCD first, so it shows something while wifi/MQTT connect (can take seconds)
  Wire.begin(LCD_SDA, LCD_SCL);
  int lcdStatus = lcd.begin(16, 2);
  lcdOk = (lcdStatus == 0);
  if (lcdOk) {
    lcdLine(0, "ANEMOMETRO");
    lcdLine(1, "Conectando...");
  }

  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce

  if (!lcdOk) {
    Serial.print("LCD not found, hd44780 status "); Serial.println(lcdStatus);
  }

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

  updateDisplay();

  delay(1);
}
