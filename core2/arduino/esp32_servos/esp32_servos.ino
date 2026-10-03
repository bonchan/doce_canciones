// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "servos"
// human-readable name for this sketch
#define SCRIPT_NAME "esp32_servos"
// what this device reports in telemetry:
//   servo1..servo10  where each servo is being driven right now, degrees
//   spd              current move speed in deg/s, 0 = jump straight to target
//   mode             "idle" | "moving" | "sweep" | "alter"
#define CAPS_PUBLISHES "[\"servo1\",\"servo2\",\"servo3\",\"servo4\",\"servo5\",\"servo6\",\"servo7\",\"servo8\",\"servo9\",\"servo10\",\"spd\",\"mode\"]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"SERVO\",\"CENTER\",\"SWEEP\",\"HALT\"]"

const char* ZONE = "entrance";

#include "../device_base.h"

#include <ESP32Servo.h>

// Commands (payload is the params object, see device_base.h). Servo index i
// is 0-based: i=0 is servo1 in telemetry.
//
//   SERVO   {i: 0-9, pos: deg}        one servo
//           {pos: deg}                every servo to the same angle
//           {pos: [d0, d1, ... d9]}   per servo; null entries are left alone
//           {speed: deg/s}            on its own or alongside any of the above;
//                                     0 = jump straight there
//           Any SERVO with a pos also ends a running SWEEP.
//   CENTER  {}                        every servo to 90
//   SWEEP   {speed?, min?, max?}      ping-pong every servo between min and max
//           {on: false}               stop, holding wherever they are
//   HALT    {}                        stop everything where it is
//   ALTER   {duration: ms}            (device_base.h) the diagnostic sweep below,
//                                     then ease back to whatever they were doing
//
// Nothing in loop() blocks, so MQTT keeps being serviced mid-move.

#define NUM_SERVOS 10
#define SERVO_MIN_US 500
#define SERVO_MAX_US 2400

Servo servos[NUM_SERVOS];
// const int servoPins[NUM_SERVOS] = { 14, 12, 13, 23, 22, 19, 21, 18 };
// All plain output pins on a classic ESP32 (WROOM). Two caveats:
//   5      strapping pin: gets a burst of pulses during boot, so that servo
//          twitches on every power-up/reset. Harmless once running.
//   16,17  wired to PSRAM on WROVER modules — won't work there.
const int servoPins[NUM_SERVOS] = { 27, 26, 25, 33, 32, 19, 18, 5, 17, 16 };

float cur[NUM_SERVOS];     // where each servo is being driven right now, degrees
float target[NUM_SERVOS];  // where it is heading
int lastUs[NUM_SERVOS];    // last pulse written, so we only write on change
float speedDps = 90;       // degrees/second, 0 = instant

enum Mode { MODE_HOLD, MODE_SWEEP };
Mode mode = MODE_HOLD;
float sweepMin = 0;
float sweepMax = 180;
#define SWEEP_DEFAULT_SPEED 60  // used if SWEEP runs while speed is 0 (instant would just flicker)

unsigned long lastTickUs = 0;

float clampDeg(float d) {
  return constrain(d, 0.0f, 180.0f);
}

// Pulse width rather than write(deg) so slow moves are smooth — write()
// rounds to whole degrees, which steps visibly below ~20 deg/s.
void writeServo(int i, float deg) {
  int us = SERVO_MIN_US + (int)(clampDeg(deg) / 180.0f * (SERVO_MAX_US - SERVO_MIN_US) + 0.5f);
  if (us == lastUs[i]) return;
  servos[i].writeMicroseconds(us);
  lastUs[i] = us;
}

void holdHere() {
  mode = MODE_HOLD;
  for (int i = 0; i < NUM_SERVOS; i++) target[i] = cur[i];
}

// ── ALTER — the diagnostic sweep ─────────────────────────────────────────
// Every servo together, 0 -> 180 -> 0 in 15 deg steps every 40ms, repeated
// for as long as the alter lasts. Same motion as the old blocking
// runSweepTest(), unrolled into a tick so MQTT keeps running during it.
#define ALTER_STEP_DEG 15
#define ALTER_STEP_MS 40

bool wasAltered = false;
int alterPos = 0;
int alterDir = 1;
unsigned long alterLastMs = 0;

void tickAlter() {
  if (!wasAltered) {
    wasAltered = true;
    alterPos = 0;
    alterDir = 1;
    alterLastMs = millis() - ALTER_STEP_MS;
    Serial.println("ALTER: sweep start");
  }
  if (millis() - alterLastMs < ALTER_STEP_MS) return;
  alterLastMs = millis();

  // cur follows the sweep, so once it ends the normal ramp eases each
  // servo back to its own target from wherever the sweep left it.
  for (int i = 0; i < NUM_SERVOS; i++) {
    cur[i] = alterPos;
    writeServo(i, alterPos);
  }

  alterPos += alterDir * ALTER_STEP_DEG;
  if (alterPos >= 180) {
    alterPos = 180;
    alterDir = -1;
  } else if (alterPos <= 0) {
    alterPos = 0;
    alterDir = 1;
  }
}

// ── normal motion ────────────────────────────────────────────────────────
void tickServos() {
  unsigned long now = micros();
  float dt = (now - lastTickUs) / 1e6f;
  lastTickUs = now;

  if (alteredActive) {
    tickAlter();
    return;
  }
  if (wasAltered) {
    wasAltered = false;
    Serial.println("ALTER: sweep end, returning");
  }

  float speed = speedDps;
  if (mode == MODE_SWEEP) {
    if (speed <= 0) speed = SWEEP_DEFAULT_SPEED;
    for (int i = 0; i < NUM_SERVOS; i++) {
      if (cur[i] == target[i]) target[i] = (target[i] >= sweepMax) ? sweepMin : sweepMax;
    }
  }

  float step = speed * dt;
  for (int i = 0; i < NUM_SERVOS; i++) {
    float d = target[i] - cur[i];
    if (speed <= 0 || fabsf(d) <= step) cur[i] = target[i];
    else cur[i] += (d > 0) ? step : -step;
    writeServo(i, cur[i]);
  }
}

bool isMoving() {
  for (int i = 0; i < NUM_SERVOS; i++) {
    if (cur[i] != target[i]) return true;
  }
  return false;
}

// ── commands ─────────────────────────────────────────────────────────────
void onCommand(const char* cmd, JsonObject params) {
  if (strcmp(cmd, "SERVO") == 0) {
    if (!params["speed"].isNull()) speedDps = max(0.0f, params["speed"].as<float>());

    JsonVariant pos = params["pos"];
    if (pos.isNull()) return;  // speed-only change, leave the mode alone
    mode = MODE_HOLD;

    if (pos.is<JsonArray>()) {
      JsonArray a = pos.as<JsonArray>();
      for (int i = 0; i < NUM_SERVOS && i < (int)a.size(); i++) {
        if (!a[i].isNull()) target[i] = clampDeg(a[i].as<float>());
      }
    } else if (params["i"].isNull()) {
      float p = clampDeg(pos.as<float>());
      for (int i = 0; i < NUM_SERVOS; i++) target[i] = p;
    } else {
      int i = params["i"].as<int>();
      if (i >= 0 && i < NUM_SERVOS) target[i] = clampDeg(pos.as<float>());
    }
  } else if (strcmp(cmd, "CENTER") == 0) {
    mode = MODE_HOLD;
    for (int i = 0; i < NUM_SERVOS; i++) target[i] = 90;
  } else if (strcmp(cmd, "SWEEP") == 0) {
    if (!(params["on"] | true)) {
      holdHere();
      return;
    }
    if (!params["speed"].isNull()) speedDps = max(0.0f, params["speed"].as<float>());
    sweepMin = clampDeg(params["min"] | 0.0f);
    sweepMax = clampDeg(params["max"] | 180.0f);
    if (sweepMin > sweepMax) {
      float t = sweepMin;
      sweepMin = sweepMax;
      sweepMax = t;
    }
    mode = MODE_SWEEP;
    for (int i = 0; i < NUM_SERVOS; i++) target[i] = sweepMax;
  } else if (strcmp(cmd, "HALT") == 0) {
    holdHere();
  }
}

// Lets the page size itself to the servo count instead of assuming 8.
#define STR_(x) #x
#define STR(x) STR_(x)
const char* announceExtraFields() {
  return "\"n\":" STR(NUM_SERVOS);
}

void setup() {
  // Servos first, so they center on power-up even while wifi is still
  // trying to connect.
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  for (int i = 0; i < NUM_SERVOS; i++) {
    servos[i].setPeriodHertz(50);
    servos[i].attach(servoPins[i], SERVO_MIN_US, SERVO_MAX_US);
    cur[i] = target[i] = 90;
    lastUs[i] = -1;
    writeServo(i, 90);
  }
  lastTickUs = micros();

  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce
}

void loop() {
  tickNetwork();
  tickCommands();
  tickServos();

  // Keys built from NUM_SERVOS so changing the count can't leave a servo
  // without a name (a null key here crashes the board into a reboot loop).
  JsonDocument doc;
  char key[10];
  for (int i = 0; i < NUM_SERVOS; i++) {
    snprintf(key, sizeof(key), "servo%d", i + 1);
    doc[key] = (int)(cur[i] + 0.5f);
  }
  doc["spd"] = speedDps;
  doc["mode"] = alteredActive          ? "alter"
                : mode == MODE_SWEEP   ? "sweep"
                : isMoving()           ? "moving"
                                       : "idle";
  doc["chip_temp"] = temperatureRead();
  publishTelemetry(doc);

  delay(1);
}
