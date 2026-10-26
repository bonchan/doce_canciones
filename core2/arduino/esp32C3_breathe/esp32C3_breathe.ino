// ── device identity ─────────────────────────────────────────────────────
#define DEVICE_TYPE "breathe"
#define SCRIPT_NAME "esp32C3_breathe"
#define CAPS_PUBLISHES "[\"inhale\",\"exhale\",\"t\",\"running\"]"
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"CURVE\",\"PAUSE\",\"RESUME\",\"RATE\",\"DEPTH\",\"MIN\"]"

// The curves travel as JSON in both directions (CURVE command in, retained
// config out) and don't fit in the default 512-byte MQTT buffer.
#define MQTT_BUFFER_SIZE 2048

const char* ZONE = "entrance";

#include "../device_base.h"
#include <Preferences.h>

// ── wiring (L298N) ──────────────────────────────────────────────────────
// Both motors only ever spin one way, so each one needs a single PWM pin:
//   GPIO5 -> IN1  (inhale motor, OUT1/OUT2)   IN2 -> GND
//   GPIO6 -> IN3  (exhale motor, OUT3/OUT4)   IN4 -> GND
// Leave the ENA/ENB jumpers on. ESP32 GND must be tied to L298N GND.
// If a motor blows the wrong way, swap its two wires on the L298N output.
const int PIN_INHALE = 5;
const int PIN_EXHALE = 6;
const int PWM_FREQ = 5000;  // L298N is slow, keep it in the low kHz
const int PWM_BITS = 8;     // duty 0..255

// ── the breath ──────────────────────────────────────────────────────────
// One breath = `periodMs` long, looped forever. Each motor has its own
// curve: n speed samples (0..255) spread evenly over the period. Playback
// interpolates between samples, and the last one blends back into the first
// so the loop has no seam. The curves are drawn on the device's page in the
// dashboard and sent with CURVE; they're saved in flash and published
// (retained) on .../config so the page always shows what's on the chip.
const int MAX_SAMPLES = 128;
const int DEFAULT_SAMPLES = 64;

struct Curve {
  uint8_t v[MAX_SAMPLES];
  int n;
};

Curve curveIn, curveOut;

// The page edits each curve as a few control points and turns them into the
// samples above itself. The device never plays the points; it just keeps
// them so the page can reopen the curve exactly as it was drawn.
// t = 0..999 (thousandths of the breath), v = 0..255.
const int MAX_POINTS = 32;

struct Points {
  uint8_t raw[MAX_POINTS * 3];  // per point: t high byte, t low byte, v
  int n;
};

Points pointsIn, pointsOut;
uint32_t periodMs = 8000;

// Below this duty the motors hum but don't turn. Any non-zero curve value
// is remapped into minDuty..255 so low speeds still move air.
int minDuty = 70;

float rate  = 1.0;  // time multiplier: 2.0 = breathes twice as fast
float depth = 1.0;  // speed multiplier: 0.5 = half as strong
bool running = true;

float phaseMs = 0;  // where we are inside the breath, 0..periodMs
unsigned long lastTickMs = 0;

int dutyInhale = 0;
int dutyExhale = 0;

Preferences prefs;

// ── defaults ────────────────────────────────────────────────────────────
// Inhale in the first 40% of the breath, exhale from 50% to 90%.
void bump(Curve& c, float from, float to, int peak) {
  c.n = DEFAULT_SAMPLES;
  for (int i = 0; i < c.n; i++) {
    float t = (float)i / c.n;
    float x = (t - from) / (to - from);
    c.v[i] = (x > 0 && x < 1) ? (uint8_t)(peak * sinf(PI * x)) : 0;
  }
}

void setDefaults() {
  bump(curveIn, 0.0, 0.4, 200);
  bump(curveOut, 0.5, 0.9, 180);
  pointsIn.n = 0;   // no points: the page makes some up from the samples
  pointsOut.n = 0;
  periodMs = 8000;
  minDuty = 70;
  rate = 1.0;
  depth = 1.0;
}

// ── persistence ─────────────────────────────────────────────────────────
void loadCurve(const char* key, Curve& c) {
  size_t n = prefs.getBytesLength(key);
  if (n >= 2 && n <= MAX_SAMPLES) {
    prefs.getBytes(key, c.v, n);
    c.n = n;
  }
}

void loadPoints(const char* key, Points& p) {
  size_t n = prefs.getBytesLength(key);
  if (n % 3 == 0 && n <= sizeof(p.raw)) {
    prefs.getBytes(key, p.raw, n);
    p.n = n / 3;
  }
}

void loadSettings() {
  setDefaults();
  prefs.begin("breathe", false);
  loadCurve("in", curveIn);
  loadCurve("out", curveOut);
  loadPoints("pin", pointsIn);
  loadPoints("pout", pointsOut);
  periodMs = prefs.getUInt("period", periodMs);
  minDuty  = prefs.getUChar("min", minDuty);
  rate     = prefs.getFloat("rate", rate);
  depth    = prefs.getFloat("depth", depth);
}

void saveSettings() {
  prefs.putBytes("in", curveIn.v, curveIn.n);
  prefs.putBytes("out", curveOut.v, curveOut.n);
  // putBytes with 0 length fails, so empty point lists are removed instead
  if (pointsIn.n)  prefs.putBytes("pin", pointsIn.raw, pointsIn.n * 3);   else prefs.remove("pin");
  if (pointsOut.n) prefs.putBytes("pout", pointsOut.raw, pointsOut.n * 3); else prefs.remove("pout");
  prefs.putUInt("period", periodMs);
  prefs.putUChar("min", minDuty);
  prefs.putFloat("rate", rate);
  prefs.putFloat("depth", depth);
}

void addPoints(JsonDocument& doc, const char* key, const Points& p) {
  JsonArray arr = doc[key].to<JsonArray>();
  for (int i = 0; i < p.n; i++) {
    JsonArray pt = arr.add<JsonArray>();
    pt.add((p.raw[i * 3] << 8) | p.raw[i * 3 + 1]);
    pt.add(p.raw[i * 3 + 2]);
  }
}

// ── config topic (retained) ─────────────────────────────────────────────
// installation/<zone>/<chip>/config, built off topicStatus so it's valid as
// soon as setupNetwork() has filled that in.
void publishConfig() {
  if (!mqttClient.connected()) return;

  JsonDocument doc;
  doc["period"]  = periodMs;
  doc["min"]     = minDuty;
  doc["rate"]    = rate;
  doc["depth"]   = depth;
  doc["running"] = running;
  JsonArray a = doc["in"].to<JsonArray>();
  for (int i = 0; i < curveIn.n; i++) a.add(curveIn.v[i]);
  JsonArray b = doc["out"].to<JsonArray>();
  for (int i = 0; i < curveOut.n; i++) b.add(curveOut.v[i]);
  addPoints(doc, "pin", pointsIn);
  addPoints(doc, "pout", pointsOut);

  static char buf[MQTT_BUFFER_SIZE - 128];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (n >= sizeof(buf) - 1) {
    Serial.println("WARNING: config too big to publish");
    return;
  }

  char topic[96];
  snprintf(topic, sizeof(topic), "%.*sconfig", (int)(strlen(topicStatus) - strlen("status")), topicStatus);
  mqttClient.publish(topic, (const uint8_t*)buf, n, true);  // retained
}

// device_base.h calls this after every (re)connect
void onConnected() {
  publishConfig();
}

// ── motors ──────────────────────────────────────────────────────────────
int toDuty(float speed) {
  if (speed < 1) return 0;
  speed = constrain(speed, 0, 255);
  return minDuty + (int)((255 - minDuty) * speed / 255.0);
}

void setMotors(int inhale, int exhale) {
  dutyInhale = inhale;
  dutyExhale = exhale;
  ledcWrite(PIN_INHALE, dutyInhale);
  ledcWrite(PIN_EXHALE, dutyExhale);
}

// value of a curve at t = 0..1 through the breath (wraps around)
float sampleCurve(const Curve& c, float t) {
  float p = t * c.n;
  int i = (int)p;
  float f = p - i;
  int a = c.v[i % c.n];
  int b = c.v[(i + 1) % c.n];
  return a + (b - a) * f;
}

// ── breath loop ─────────────────────────────────────────────────────────
void tickBreath() {
  unsigned long now = millis();
  unsigned long dt = now - lastTickMs;
  lastTickMs = now;
  if (!running) return;

  phaseMs = fmodf(phaseMs + dt * rate, (float)periodMs);
  float t = phaseMs / periodMs;
  setMotors(toDuty(sampleCurve(curveIn, t) * depth),
            toDuty(sampleCurve(curveOut, t) * depth));
}

void pauseBreath() {
  running = false;
  setMotors(0, 0);
  publishConfig();
  Serial.println("breath: paused");
}

void resumeBreath() {
  running = true;
  publishConfig();
  Serial.println("breath: running");
}

// ── commands (MQTT) ─────────────────────────────────────────────────────
//   CURVE  {"period":8000, "in":[0..255,...], "out":[0..255,...],
//           "pin":[[t,v],...], "pout":[[t,v],...]}
//          any subset; 2..128 samples per curve, up to 32 points. Saved.
//          Sending samples without their points clears the stored points
//          (they'd no longer match).
//   PAUSE {}   RESUME {}
//   RATE  {"value":1.5}   DEPTH {"value":0.7}   MIN {"value":70}   (saved)
bool readCurve(JsonVariant v, Curve& c) {
  JsonArray arr = v.as<JsonArray>();
  if (arr.isNull()) return false;
  int n = arr.size();
  if (n < 2 || n > MAX_SAMPLES) {
    Serial.printf("CURVE: need 2..%d samples, got %d\n", MAX_SAMPLES, n);
    return false;
  }
  int i = 0;
  for (JsonVariant x : arr) c.v[i++] = constrain(x.as<int>(), 0, 255);
  c.n = n;
  return true;
}

bool readPoints(JsonVariant v, Points& p) {
  JsonArray arr = v.as<JsonArray>();
  if (arr.isNull()) return false;
  if ((int)arr.size() > MAX_POINTS) {
    Serial.printf("CURVE: max %d points, got %d\n", MAX_POINTS, (int)arr.size());
    return false;
  }
  int i = 0;
  for (JsonVariant x : arr) {
    int t = constrain(x[0].as<int>(), 0, 999);
    p.raw[i * 3]     = t >> 8;
    p.raw[i * 3 + 1] = t & 0xFF;
    p.raw[i * 3 + 2] = constrain(x[1].as<int>(), 0, 255);
    i++;
  }
  p.n = i;
  return true;
}

void onCommand(const char* cmd, JsonObject params) {
  bool changed = false;

  if (strcmp(cmd, "CURVE") == 0) {
    if (readCurve(params["in"], curveIn)) {
      if (!readPoints(params["pin"], pointsIn)) pointsIn.n = 0;
      changed = true;
    }
    if (readCurve(params["out"], curveOut)) {
      if (!readPoints(params["pout"], pointsOut)) pointsOut.n = 0;
      changed = true;
    }
    if (params["period"].is<int>()) {
      periodMs = constrain(params["period"].as<int>(), 500, 120000);
      phaseMs = fmodf(phaseMs, (float)periodMs);
      changed = true;
    }
  } else if (strcmp(cmd, "PAUSE") == 0) {
    pauseBreath();
  } else if (strcmp(cmd, "RESUME") == 0) {
    resumeBreath();
  } else if (strcmp(cmd, "RATE") == 0) {
    rate = constrain((float)(params["value"] | 1.0), 0.1, 10.0);
    changed = true;
  } else if (strcmp(cmd, "DEPTH") == 0) {
    depth = constrain((float)(params["value"] | 1.0), 0.0, 1.0);
    changed = true;
  } else if (strcmp(cmd, "MIN") == 0) {
    minDuty = constrain(params["value"] | 70, 0, 254);
    changed = true;
  }

  if (changed) {
    saveSettings();
    publishConfig();
  }
}

// ── commands (Serial, newline terminated) ───────────────────────────────
//   pause | resume | rate x | depth x | min x | show | reset
char serialLine[64];
int serialLen = 0;

void printCurve(const char* name, const Curve& c) {
  Serial.print(name);
  for (int i = 0; i < c.n; i++) { Serial.print(' '); Serial.print(c.v[i]); }
  Serial.println();
}

void handleSerialLine(char* line) {
  if      (strcmp(line, "pause") == 0)       pauseBreath();
  else if (strcmp(line, "resume") == 0)      resumeBreath();
  else if (strncmp(line, "rate ", 5) == 0)   { rate = constrain(atof(line + 5), 0.1, 10.0); saveSettings(); publishConfig(); }
  else if (strncmp(line, "depth ", 6) == 0)  { depth = constrain(atof(line + 6), 0.0, 1.0); saveSettings(); publishConfig(); }
  else if (strncmp(line, "min ", 4) == 0)    { minDuty = constrain(atoi(line + 4), 0, 254); saveSettings(); publishConfig(); }
  else if (strcmp(line, "reset") == 0)       { setDefaults(); saveSettings(); publishConfig(); Serial.println("back to defaults"); }
  else if (strcmp(line, "show") == 0) {
    Serial.printf("period %lu ms  rate %.2f  depth %.2f  min %d  %s\n",
                  (unsigned long)periodMs, rate, depth, minDuty, running ? "running" : "paused");
    printCurve("in: ", curveIn);
    printCurve("out:", curveOut);
  }
  else Serial.println("? use: pause | resume | rate x | depth x | min x | show | reset");
}

void tickSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      serialLine[serialLen] = '\0';
      if (serialLen > 0) handleSerialLine(serialLine);
      serialLen = 0;
    } else if (serialLen < (int)sizeof(serialLine) - 1) {
      serialLine[serialLen++] = c;
    }
  }
}

void setup() {
  // motors off first, before wifi can take a few seconds
  ledcAttach(PIN_INHALE, PWM_FREQ, PWM_BITS);
  ledcAttach(PIN_EXHALE, PWM_FREQ, PWM_BITS);
  setMotors(0, 0);

  loadSettings();  // before setupNetwork, so the first config publish is right
  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce/config

  lastTickMs = millis();
}

void loop() {
  tickNetwork();
  tickCommands();
  tickSerial();
  tickBreath();

  JsonDocument doc;
  doc["inhale"]  = dutyInhale;
  doc["exhale"]  = dutyExhale;
  doc["t"]       = (int)phaseMs;
  doc["running"] = running ? 1 : 0;
  publishTelemetry(doc);

  delay(1);
}
