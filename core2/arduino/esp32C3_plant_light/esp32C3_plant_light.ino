// ── device identity ─────────────────────────────────────────────────────
#define DEVICE_TYPE "plant_light"
#define SCRIPT_NAME "esp32C3_plant_light"
#define CAPS_PUBLISHES "[\"state\",\"dir\",\"duty\",\"end_l\",\"end_r\",\"trips\",\"pos\",\"cyc\",\"err\"]"
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"MOVE\",\"CYCLE\",\"STOP\",\"SPEED\",\"CONFIG\",\"RESET\"]"

// The speed profile travels as JSON both ways (CONFIG in, retained config
// out) and doesn't fit in the default 512-byte MQTT buffer.
#define MQTT_BUFFER_SIZE 1024

const char* ZONE = "entrance";

#include "../device_base.h"
#include <Preferences.h>

// ── pins ────────────────────────────────────────────────────────────────
// Motor: L298N channel A, ENA jumper on, speed = PWM on the driving IN pin.
// ESP32 GND must be tied to L298N GND.
const int MOTOR_IN1 = 5;   // PWM here = toward RIGHT (unless "reversed")
const int MOTOR_IN2 = 6;   // PWM here = toward LEFT

// Optical endstops: IR LED (150 ohm to 3V3) + phototransistor (collector
// to the GPIO, 10k pull-up to 3V3, emitter to GND). Beam clear = LOW,
// blocked = HIGH. With the pull-up a disconnected sensor reads "blocked",
// so the motor refuses to drive into it (fail safe).
//   GPIO9  avoided: BOOT strapping pin, LOW at power-up = flash mode.
//   GPIO21 avoided: UART TX, the chip prints its boot log on it.
const int ENDSTOP_LEFT  = 10;
const int ENDSTOP_RIGHT = 20;

// Lights (second L298N channel) — not implemented yet.
// GPIO8 is the status LED (LED_PIN in device_base.h) and a strapping pin,
// so lights on 7+8 would fight the status blink. 3+4 (or 0+1) are free.

const int      MOTOR_PWM_FREQ = 5000;  // L298N is slow, keep it in the low kHz
const int      MOTOR_PWM_BITS = 8;     // duty 0..255
const uint32_t BRAKE_MS       = 150;   // short brake on arrival / stop
const int      DEBOUNCE_TICKS = 3;     // consecutive 1 ms reads to accept a change

// ── settings (saved in flash, published retained on .../config) ─────────
// Speed profile: how fast to go at each point of the rail, left -> right,
// as PROFILE_N samples (0..255 = 0..100% of `speed`), used in both
// directions. Position is estimated from speed x time and re-learned on
// every full endstop-to-endstop trip (`len`), so the profile only kicks in
// after the first full trip; until then the carriage runs at flat `speed`.
// The page edits the profile as a few points and sends both; the device
// plays the samples and keeps the points so the page can reopen them.
const int PROFILE_N  = 32;
const int MAX_POINTS = 16;
const uint8_t CFG_VERSION = 1;

struct Settings {
  uint8_t  version;
  uint8_t  speed;      // base speed 0..255
  uint8_t  minDuty;    // below this the motor hums without turning
  bool     reversed;   // swap motor direction
  bool     invertEnd;  // endstops active LOW instead of HIGH
  bool     autoRun;    // start cycling on power-up
  uint16_t cycles;     // round trips per CYCLE, 0 = forever
  uint32_t pauseL;     // ms wait at the left end while cycling
  uint32_t pauseR;     // ms wait at the right end
  uint32_t rampMs;     // soft start: ms from min duty to full speed
  uint32_t timeoutMs;  // fault if an endstop isn't reached in this long, 0 = off
  float    len;        // learned rail length in full-speed ms, 0 = unknown
  uint8_t  prof[PROFILE_N];
  uint8_t  pts[MAX_POINTS * 3];  // per point: t high, t low (0..999), v
  uint8_t  nPts;
};

Settings cfg;
Preferences prefs;
float savedLen = 0;  // cfg.len as last written to flash

void setDefaults() {
  memset(&cfg, 0, sizeof(cfg));
  cfg.version   = CFG_VERSION;
  cfg.speed     = 180;
  cfg.minDuty   = 60;
  cfg.pauseL    = 2000;
  cfg.pauseR    = 2000;
  cfg.rampMs    = 500;
  cfg.timeoutMs = 60000;
  memset(cfg.prof, 255, sizeof(cfg.prof));  // flat: full speed everywhere
}

void loadSettings() {
  setDefaults();
  prefs.begin("plantlight", false);
  Settings s;
  if (prefs.getBytesLength("cfg") == sizeof(s)) {
    prefs.getBytes("cfg", &s, sizeof(s));
    if (s.version == CFG_VERSION) cfg = s;
  }
  savedLen = cfg.len;
}

void saveSettings() {
  prefs.putBytes("cfg", &cfg, sizeof(cfg));
  savedLen = cfg.len;
}

// ── shared state ────────────────────────────────────────────────────────
// The motor runs in its own task (1 ms tick) so the endstops are watched
// even while loop() is blocked in a WiFi/MQTT reconnect. Commands from
// loop() go through `pendingReq`; only the motor task touches the pins.
// It reads `cfg` directly — single-field writes, worst case one tick sees
// a half-updated profile.
enum State : uint8_t { ST_IDLE, ST_RUNNING, ST_BRAKING, ST_PAUSED, ST_FAULT };
const char* STATE_NAMES[] = { "idle", "moving", "braking", "paused", "fault" };

enum ReqType : uint8_t { REQ_NONE, REQ_STOP, REQ_MOVE, REQ_CYCLE };
struct Request {
  ReqType type;
  int8_t  dir;  // -1 left, +1 right, 0 = auto (cycle only)
};

portMUX_TYPE reqMux = portMUX_INITIALIZER_UNLOCKED;
Request pendingReq = { REQ_NONE, 0 };

volatile State    state  = ST_IDLE;
volatile int8_t   runDir = 0;
volatile uint8_t  duty = 0;
volatile bool     endL = false, endR = false;
volatile bool     cycling = false;
volatile uint32_t trips = 0;      // one-way trips finished
volatile int      posPermil = -1; // 0..1000 left..right, -1 unknown
volatile bool     lenLearned = false;  // loop() saves cfg.len to flash
const char* volatile errMsg = "";
const char* volatile event  = nullptr; // printed by loop()

void sendRequest(ReqType type, int8_t dir = 0) {
  portENTER_CRITICAL(&reqMux);
  pendingReq = { type, dir };
  portEXIT_CRITICAL(&reqMux);
}

// ── motor task internals (only touched by the motor task) ──────────────
uint32_t phaseStart = 0, phaseUntil = 0, lastTick = 0;
uint32_t pauseAfterBrake = 0;
State    afterBrake = ST_IDLE;
int8_t   nextDir = 0;
bool     behindAtStart = false;  // started sitting on the endstop behind us
bool     fullTrip = false;       // this trip started on the opposite endstop
float    pos = 0;                // full-speed ms from the left end
bool     posKnown = false;
float    travelled = 0;
int      debL = 0, debR = 0;

void motorOut(int8_t dir, uint8_t d) {
  if (cfg.reversed) dir = -dir;
  if (dir > 0)      { ledcWrite(MOTOR_IN1, d); ledcWrite(MOTOR_IN2, 0); }
  else if (dir < 0) { ledcWrite(MOTOR_IN1, 0); ledcWrite(MOTOR_IN2, d); }
  else              { ledcWrite(MOTOR_IN1, 0); ledcWrite(MOTOR_IN2, 0); }
  duty = dir ? d : 0;
}

// both INs high = L298N shorts the motor -> fast stop
void motorBrake() {
  ledcWrite(MOTOR_IN1, 255);
  ledcWrite(MOTOR_IN2, 255);
  duty = 0;
}

bool endAt(int8_t dir) { return dir > 0 ? endR : endL; }

bool readEnd(int pin) { return digitalRead(pin) == (cfg.invertEnd ? LOW : HIGH); }

void readEndstops() {
  bool l = readEnd(ENDSTOP_LEFT);
  bool r = readEnd(ENDSTOP_RIGHT);
  if (l != endL) { if (++debL >= DEBOUNCE_TICKS) { endL = l; debL = 0; } } else debL = 0;
  if (r != endR) { if (++debR >= DEBOUNCE_TICKS) { endR = r; debR = 0; } } else debR = 0;
}

void updatePos() {
  if (endL) { pos = 0; posKnown = true; }
  else if (endR && cfg.len > 0) { pos = cfg.len; posKnown = true; }
  if (!posKnown) posPermil = -1;
  else if (cfg.len > 0) posPermil = constrain((int)(pos / cfg.len * 1000), 0, 1000);
  else posPermil = endL ? 0 : -1;
}

// profile value (0..1) at x = 0..1 along the rail
float profileAt(float x) {
  float p = constrain(x, 0.0f, 1.0f) * (PROFILE_N - 1);
  int i = min((int)p, PROFILE_N - 2);
  float f = p - i;
  return (cfg.prof[i] + (cfg.prof[i + 1] - cfg.prof[i]) * f) / 255.0f;
}

// speed (0..255) we want right now
float targetSpeed(uint32_t now) {
  float out = cfg.speed;
  if (out < 1) return 0;
  if (posKnown && cfg.len > 0) out *= profileAt(pos / cfg.len);
  if (cfg.rampMs > 0) out *= min(1.0f, (float)(now - phaseStart) / cfg.rampMs);
  return max(out, 1.0f);  // never stall mid-rail: at least min duty
}

uint8_t toDuty(float speed) {
  if (speed < 1) return 0;
  return cfg.minDuty + (uint8_t)((255 - cfg.minDuty) * min(speed, 255.0f) / 255.0f);
}

void beginBrake(State after, uint32_t pauseMs = 0) {
  motorBrake();
  state = ST_BRAKING;
  afterBrake = after;
  pauseAfterBrake = pauseMs;
  phaseUntil = millis() + BRAKE_MS;
}

void fault(const char* why) {
  errMsg = why;
  event = why;
  cycling = false;
  beginBrake(ST_FAULT);
}

void startRun(int8_t dir) {
  if (endL && endR) { fault("both endstops active"); return; }
  if (endAt(dir)) {
    if (!cycling) { motorOut(0, 0); state = ST_IDLE; runDir = 0; event = "already there"; return; }
    dir = -dir;  // cycling and already at that end: head the other way
  }
  runDir = dir;
  behindAtStart = endAt(-dir);
  fullTrip = behindAtStart;
  travelled = 0;
  phaseStart = lastTick = millis();
  motorOut(dir, toDuty(targetSpeed(phaseStart)));
  state = ST_RUNNING;
  event = dir > 0 ? "moving right" : "moving left";
}

// go `dir`; if currently moving the other way, brake first
void goTo(int8_t dir) {
  errMsg = "";
  if ((state == ST_RUNNING || state == ST_BRAKING) && runDir != dir) {
    nextDir = dir;
    beginBrake(ST_PAUSED, 0);
  } else if (state != ST_RUNNING) {
    startRun(dir);
  }
}

void applyRequest() {
  Request r;
  portENTER_CRITICAL(&reqMux);
  r = pendingReq;
  pendingReq.type = REQ_NONE;
  portEXIT_CRITICAL(&reqMux);

  switch (r.type) {
    case REQ_NONE: return;
    case REQ_STOP:
      cycling = false;
      errMsg = "";
      if (state == ST_RUNNING || state == ST_BRAKING) beginBrake(ST_IDLE);
      else { motorOut(0, 0); state = ST_IDLE; }
      runDir = 0;
      event = "stop";
      break;
    case REQ_MOVE:
      cycling = false;
      trips = 0;
      goTo(r.dir);
      break;
    case REQ_CYCLE: {
      cycling = true;
      trips = 0;
      int8_t dir = r.dir;
      if (dir == 0) dir = (state == ST_RUNNING) ? runDir : (endR ? -1 : 1);
      goTo(dir);
      break;
    }
  }
}

void arrive(uint32_t now) {
  trips++;
  event = runDir > 0 ? "arrived right" : "arrived left";

  // a full endstop-to-endstop trip measures the rail
  if (fullTrip && travelled > 100) {
    cfg.len = travelled;
    lenLearned = true;
  }
  pos = runDir > 0 ? cfg.len : 0;
  posKnown = runDir < 0 || cfg.len > 0;

  uint32_t target = (uint32_t)cfg.cycles * 2;
  if (cycling && (target == 0 || trips < target)) {
    nextDir = -runDir;
    beginBrake(ST_PAUSED, runDir > 0 ? cfg.pauseR : cfg.pauseL);
  } else {
    cycling = false;
    beginBrake(ST_IDLE);
  }
}

void motorTick() {
  readEndstops();
  applyRequest();
  uint32_t now = millis();

  switch (state) {
    case ST_RUNNING: {
      uint32_t dt = now - lastTick;
      lastTick = now;
      float v = (duty > 0) ? targetSpeed(now) / 255.0f : 0;  // speed proxy
      travelled += v * dt;
      if (posKnown) pos = constrain(pos + runDir * v * dt, 0.0f, cfg.len > 0 ? cfg.len : 1e9f);

      if (behindAtStart && !endAt(-runDir)) behindAtStart = false;  // left it behind

      if (endAt(runDir)) {
        arrive(now);
      } else if (endAt(-runDir) && !behindAtStart) {
        fault("wrong way: check reversed setting");
      } else {
        if (cfg.speed == 0) phaseStart = now;  // parked at 0 speed, not travelling
        if (cfg.timeoutMs > 0 && now - phaseStart > cfg.timeoutMs) {
          fault("timeout: endstop never reached");
        } else {
          uint8_t d = toDuty(targetSpeed(now));
          if (d != duty) motorOut(runDir, d);
        }
      }
      break;
    }

    case ST_BRAKING:
      if ((int32_t)(now - phaseUntil) >= 0) {
        motorOut(0, 0);
        state = afterBrake;
        if (afterBrake == ST_PAUSED) phaseUntil = now + pauseAfterBrake;
        else runDir = 0;
      }
      break;

    case ST_PAUSED:
      if ((int32_t)(now - phaseUntil) >= 0) startRun(nextDir);
      break;

    case ST_IDLE:
    case ST_FAULT:
      break;
  }
  updatePos();
}

void motorTask(void*) {
  for (;;) {
    motorTick();
    vTaskDelay(1);  // 1 ms
  }
}

// ── config topic (retained) ─────────────────────────────────────────────
// installation/<zone>/<chip>/config, built off topicStatus.
void publishConfig() {
  if (!mqttClient.connected()) return;

  JsonDocument doc;
  doc["speed"]   = cfg.speed;
  doc["min"]     = cfg.minDuty;
  doc["pause_l"] = cfg.pauseL;
  doc["pause_r"] = cfg.pauseR;
  doc["cycles"]  = cfg.cycles;
  doc["ramp"]    = cfg.rampMs;
  doc["timeout"] = cfg.timeoutMs;
  doc["rev"]     = cfg.reversed;
  doc["inv"]     = cfg.invertEnd;
  doc["auto"]    = cfg.autoRun;
  doc["len"]     = (int)cfg.len;
  JsonArray prof = doc["prof"].to<JsonArray>();
  for (int i = 0; i < PROFILE_N; i++) prof.add(cfg.prof[i]);
  JsonArray pts = doc["pts"].to<JsonArray>();
  for (int i = 0; i < cfg.nPts; i++) {
    JsonArray p = pts.add<JsonArray>();
    p.add((cfg.pts[i * 3] << 8) | cfg.pts[i * 3 + 1]);
    p.add(cfg.pts[i * 3 + 2]);
  }

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

// ── commands (MQTT) ─────────────────────────────────────────────────────
// Every command body may also carry settings (see CONFIG); they're applied
// and saved first, so e.g. MOVE {"to":"left","speed":120} works.
//
//   MOVE   {"to": "left"|"right"}   run until that endstop
//   CYCLE  {"to"?: "left"|"right"}  back and forth (first leg default:
//                                   away from the current end)
//   STOP   {}                       brake, cancel cycle
//   SPEED  {"speed": 0..255}        live, also mid-move (= CONFIG speed)
//   CONFIG any subset of:
//     speed 0..255, min 0..254, pause_l / pause_r ms, cycles (0 = forever),
//     ramp ms, timeout ms (0 = off), rev, inv, auto (bools),
//     len (0 = forget the learned rail length),
//     prof [32 x 0..255] + pts [[t 0..999, v 0..255], ...] (up to 16)
//   RESET  {}                       everything back to defaults
bool applyConfig(JsonObject p) {
  bool changed = false;
  if (p["speed"].is<int>())   { cfg.speed = constrain(p["speed"].as<int>(), 0, 255); changed = true; }
  if (p["min"].is<int>())     { cfg.minDuty = constrain(p["min"].as<int>(), 0, 254); changed = true; }
  if (p["pause_l"].is<int>()) { cfg.pauseL = constrain(p["pause_l"].as<long>(), 0L, 3600000L); changed = true; }
  if (p["pause_r"].is<int>()) { cfg.pauseR = constrain(p["pause_r"].as<long>(), 0L, 3600000L); changed = true; }
  if (p["cycles"].is<int>())  { cfg.cycles = constrain(p["cycles"].as<long>(), 0L, 65535L); changed = true; }
  if (p["ramp"].is<int>())    { cfg.rampMs = constrain(p["ramp"].as<long>(), 0L, 20000L); changed = true; }
  if (p["timeout"].is<int>()) { cfg.timeoutMs = constrain(p["timeout"].as<long>(), 0L, 3600000L); changed = true; }
  if (p["rev"].is<bool>())    { cfg.reversed = p["rev"].as<bool>(); changed = true; }
  if (p["inv"].is<bool>())    { cfg.invertEnd = p["inv"].as<bool>(); changed = true; }
  if (p["auto"].is<bool>())   { cfg.autoRun = p["auto"].as<bool>(); changed = true; }
  if (p["len"].is<int>())     { cfg.len = max(0, p["len"].as<int>()); changed = true; }

  JsonArray prof = p["prof"].as<JsonArray>();
  if (!prof.isNull()) {
    if ((int)prof.size() != PROFILE_N) {
      Serial.printf("CONFIG: prof needs %d samples, got %d\n", PROFILE_N, (int)prof.size());
    } else {
      int i = 0;
      for (JsonVariant x : prof) cfg.prof[i++] = constrain(x.as<int>(), 0, 255);
      // points travel with the samples; samples alone clear them
      cfg.nPts = 0;
      JsonArray pts = p["pts"].as<JsonArray>();
      if (!pts.isNull() && (int)pts.size() <= MAX_POINTS) {
        for (JsonVariant x : pts) {
          int t = constrain(x[0].as<int>(), 0, 999);
          cfg.pts[cfg.nPts * 3]     = t >> 8;
          cfg.pts[cfg.nPts * 3 + 1] = t & 0xFF;
          cfg.pts[cfg.nPts * 3 + 2] = constrain(x[1].as<int>(), 0, 255);
          cfg.nPts++;
        }
      }
      changed = true;
    }
  }
  return changed;
}

int8_t parseDir(JsonObject params) {
  const char* to = params["to"] | "";
  if (strcmp(to, "left") == 0)  return -1;
  if (strcmp(to, "right") == 0) return 1;
  return 0;
}

void onCommand(const char* cmd, JsonObject params) {
  if (strcmp(cmd, "RESET") == 0) {
    setDefaults();
    saveSettings();
    publishConfig();
    return;
  }

  if (applyConfig(params)) {
    saveSettings();
    publishConfig();
  }

  if (strcmp(cmd, "MOVE") == 0) {
    int8_t dir = parseDir(params);
    if (dir == 0) { Serial.println("MOVE needs \"to\": \"left\"|\"right\""); return; }
    sendRequest(REQ_MOVE, dir);
  } else if (strcmp(cmd, "CYCLE") == 0) {
    sendRequest(REQ_CYCLE, parseDir(params));
  } else if (strcmp(cmd, "STOP") == 0) {
    sendRequest(REQ_STOP);
  }
  // SPEED / CONFIG: already applied above
}

// ── commands (Serial, newline terminated) ───────────────────────────────
//   l / r     move left / right        c     cycle        s   stop
//   <0..255>  speed                    show  settings     reset
char serialLine[32];
int serialLen = 0;

void handleSerialLine(char* line) {
  if      (strcmp(line, "l") == 0) sendRequest(REQ_MOVE, -1);
  else if (strcmp(line, "r") == 0) sendRequest(REQ_MOVE, 1);
  else if (strcmp(line, "s") == 0) sendRequest(REQ_STOP);
  else if (strcmp(line, "c") == 0) sendRequest(REQ_CYCLE);
  else if (strcmp(line, "reset") == 0) { setDefaults(); saveSettings(); publishConfig(); Serial.println("back to defaults"); }
  else if (strcmp(line, "show") == 0) {
    Serial.printf("speed %d  min %d  pause %lu/%lu ms  cycles %d  ramp %lu  timeout %lu  rev %d  inv %d  auto %d  len %d\n",
                  cfg.speed, cfg.minDuty, (unsigned long)cfg.pauseL, (unsigned long)cfg.pauseR, cfg.cycles,
                  (unsigned long)cfg.rampMs, (unsigned long)cfg.timeoutMs, cfg.reversed, cfg.invertEnd,
                  cfg.autoRun, (int)cfg.len);
    Serial.printf("state %s  end_l %d  end_r %d  pos %d\n", STATE_NAMES[(int)state], (int)endL, (int)endR, (int)posPermil);
  }
  else if (isdigit(line[0])) { cfg.speed = constrain(atoi(line), 0, 255); saveSettings(); publishConfig(); }
  else Serial.println("? use: l | r | s | c | <0..255> | show | reset");
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
  // motor pins first so the L298N inputs aren't floating during WiFi connect
  ledcAttach(MOTOR_IN1, MOTOR_PWM_FREQ, MOTOR_PWM_BITS);
  ledcAttach(MOTOR_IN2, MOTOR_PWM_FREQ, MOTOR_PWM_BITS);
  ledcWrite(MOTOR_IN1, 0);
  ledcWrite(MOTOR_IN2, 0);

  loadSettings();  // before setupNetwork, so the first config publish is right

  pinMode(ENDSTOP_LEFT, INPUT_PULLUP);
  pinMode(ENDSTOP_RIGHT, INPUT_PULLUP);
  endL = readEnd(ENDSTOP_LEFT);
  endR = readEnd(ENDSTOP_RIGHT);

  xTaskCreate(motorTask, "motor", 4096, nullptr, 2, nullptr);
  if (cfg.autoRun) sendRequest(REQ_CYCLE);

  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce/config
}

void loop() {
  tickNetwork();
  tickCommands();
  tickSerial();

  const char* e = event;
  if (e) { event = nullptr; Serial.println(e); }

  // learned rail length: save once per trip at most, and only if it moved
  if (lenLearned) {
    lenLearned = false;
    if (savedLen <= 0 || fabsf(cfg.len - savedLen) > savedLen * 0.03f) {
      saveSettings();
      publishConfig();
    }
  }

  JsonDocument doc;
  doc["state"] = STATE_NAMES[(int)state];
  doc["dir"]   = (int)runDir;
  doc["duty"]  = (int)duty;
  doc["end_l"] = endL ? 1 : 0;
  doc["end_r"] = endR ? 1 : 0;
  doc["trips"] = (uint32_t)trips;
  doc["pos"]   = (int)posPermil;
  doc["cyc"]   = cycling ? 1 : 0;
  const char* err = errMsg;
  if (err[0]) doc["err"] = err;
  doc["chip_temp"] = temperatureRead();
  publishTelemetry(doc);

  delay(1);
}
