// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "polargraph"
#define SCRIPT_NAME "esp32_polargraph"
#define CAPS_PUBLISHES "[\"x\", \"y\", \"left_distance_to_go\", \"right_distance_to_go\", \"queue_len\", \"queue_clears\", \"servo_write\"]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"HOME\",\"ZERO\",\"HALT\",\"WIND\",\"MOVE_ABS\",\"MOVE_REL\",\"SERVO_SET\",\"CAL\",\"QUEUE_ADD\"]"

const char *ZONE = "entrance";

#include "../device_base.h"

#include <ESP32Servo.h>
#include <AccelStepper.h>
#include <Preferences.h>

// 28BYJ-48 motor = 4096 steps per full revolution in HALF4WIRE mode
const long STEPS_PER_REV = 4096;

// AccelStepper pin order for ULN2003 drivers: IN1, IN3, IN2, IN4
AccelStepper left(AccelStepper::HALF4WIRE, 32, 25, 33, 26);
AccelStepper right(AccelStepper::HALF4WIRE, 19, 5, 18, 17);

// Servo
const int SERVO_PIN = 13;
const int SERVO_SLOW_APPROACH = 90;
const int SERVO_STEP_SIZE = 10;
const int SERVO_STEP_DELAY_MS = 100;
Servo servo;
int servoUp = 50;
int servoWrite = 180;
int servoPos = servoUp;

// Geometry Constants (mm)
int invL = 1;
int invR = 1;
// distance between the two string anchors
const float gondolaWidth = 100.0;
// anchors sit this far above the pen tip
const float gondolaHeight = 90.0;
// Motor to motor
const float motorDist = 1700.0;
// Height above origin
const float motorY = 1000.0;
// Horizontal distance from center to motor
const float motorX = motorDist / 2.0;

float curX = 0, curY = 0;
float targetX = 0, targetY = 0;
float stepsPerMm = 65.189;

float maxSpeedWind = 1500;
float maxSpeed = 800;  // 28BYJ-48 limits
float accel = 400;

bool isMoving = false;
float segmentDist = 2.0;

bool isWinding = false;
int windL = 0;
int windR = 0;

// ── calibration state ───────────────────────────────────────────────────
// Single-point calibration: jog to one fixed, repeatable physical
// reference (e.g. top-middle, directly between the two motors) and send
// ZERO — that spot becomes (0,0), and HOME always returns to it. Simpler
// and far more robust than the old 4-corner scheme, which recomputed an
// averaged origin on every corner touch (including re-touches) and wasn't
// idempotent — each recalibration compounded a fresh shift on top of the
// last, so the origin silently drifted every time you re-calibrated.
//
// Not persisted to flash on purpose: an open-loop stepper's believed
// position is never verified against reality, so trusting a saved value
// blindly after a power cycle could be actively wrong (skipped steps,
// gondola bumped while off, etc.) — re-zero fresh each boot instead.
Preferences prefs;
bool positionKnown = false;

void loadStepsPerMm() {
  prefs.begin("polargraph", true);
  stepsPerMm = prefs.getFloat("stepsPerMm", stepsPerMm);
  prefs.end();
}

void saveStepsPerMm() {
  prefs.begin("polargraph", false);
  prefs.putFloat("stepsPerMm", stepsPerMm);
  prefs.end();
}

// ── point queue (for continuous multi-point drawings) ─────────────────────
// Small ring buffer of upcoming targets. QUEUE_ADD appends a batch; once the
// current move finishes, updatePath() pulls the next point straight from
// here instead of going idle — no MQTT round trip between points, which is
// what keeps a drawing moving continuously. The backend owns the full point
// list for a drawing and refills this as it drains (see the queue_len
// telemetry field + low-water-mark refill logic backend-side), so this only
// ever needs to hold a small lookahead, not the whole drawing.
#define QUEUE_CAPACITY 40
float queueX[QUEUE_CAPACITY];
float queueY[QUEUE_CAPACITY];
int queueHead = 0;  // next point to consume
int queueTail = 0;  // next free slot
int queueLen = 0;

// Bumped every time queueClear() runs — which only happens from an explicit
// manual command (HOME/ZERO/HALT/WIND/MOVE_ABS/MOVE_REL), never from normal
// draining (queuePop() returning false just leaves the queue at 0, it
// doesn't call this). Published in telemetry so the backend drawing job can
// reliably detect "something outside this job interrupted it" regardless of
// which UI control (or raw MQTT publish) sent that command — inferring the
// same thing from queue_len alone can't tell an external clear apart from
// ordinary draining.
unsigned long queueClearCount = 0;

// Clamps a target to the physically reachable working rectangle
// (-motorDist/2..+motorDist/2 horizontally, 0..motorY vertically). This is
// the one place that actually matters for preventing corrupted position
// tracking: with no limit switches or encoders, commanding the gondola
// past where the strings can really reach doesn't produce an error, it
// just stalls the motor(s) and silently loses steps — and since
// curX/curY are derived purely from commanded step counts (see
// updateCurrentPosition()), that loss is invisible until the numbers stop
// matching reality, and stays wrong until the next ZERO. The webapp
// canvas also clamps clicks client-side, but MQTT commands can bypass
// that entirely, so this is the real backstop.
void clampToWorkArea(float &x, float &y) {
  float halfDist = motorDist / 2.0;
  if (x < -halfDist) x = -halfDist;
  if (x > halfDist) x = halfDist;
  if (y < 0) y = 0;
  if (y > motorY) y = motorY;
}

bool queuePush(float x, float y) {
  if (queueLen >= QUEUE_CAPACITY) return false;
  queueX[queueTail] = x;
  queueY[queueTail] = y;
  queueTail = (queueTail + 1) % QUEUE_CAPACITY;
  queueLen++;
  return true;
}

bool queuePop(float &x, float &y) {
  if (queueLen == 0) return false;
  x = queueX[queueHead];
  y = queueY[queueHead];
  queueHead = (queueHead + 1) % QUEUE_CAPACITY;
  queueLen--;
  return true;
}

void queueClear() {
  queueHead = queueTail = queueLen = 0;
  queueClearCount++;
}

// optional: override onCommand for capabilities beyond the defaults
// (IDENTIFY / ALTER / UPDATE are already handled in device_base.h)
// void onCommand(const char* cmd, JsonObject params) {
//     if (strcmp(cmd, "MY_CAPABILITY") == 0) {
//         // your logic
//     }
// }

// Advertises motorY and motorDist in the announce payload so the webapp can
// size/scale its canvas to the real working rectangle instead of guessing —
// the origin sits at the top-middle reference point (see ZERO), motorY is
// the vertical distance from there down to the motors' mounting height, and
// motorDist is the full horizontal distance between the two motors.
const char *announceExtraFields() {
  static char buf[64];
  snprintf(buf, sizeof(buf), "\"motor_y\":%.2f,\"motor_dist\":%.2f", motorY, motorDist);
  return buf;
}

void onCommand(const char *cmd, JsonObject params) {
  if (strcmp(cmd, "HOME") == 0) {
    queueClear();  // explicit manual action cancels any pending drawing
    targetX = 0;
    targetY = 0;
    left.enableOutputs();
    right.enableOutputs();
    isMoving = true;

  } else if (strcmp(cmd, "ZERO") == 0) {
    // Wherever the gondola physically is right now becomes (0,0). Touch it
    // to your fixed reference point (top-middle) before sending this.
    queueClear();  // any queued points were computed relative to the old
                   // origin — stale once it moves, so drop them
    curX = 0;
    targetX = 0;
    curY = 0;
    targetY = 0;
    syncMotors();
    positionKnown = true;
    Serial.println("zeroed — (0,0) set to current position");

  } else if (strcmp(cmd, "HALT") == 0) {
    isMoving = false;
    isWinding = false;
    queueClear();  // full stop means forget the rest of any drawing too
    left.disableOutputs();
    right.disableOutputs();
    // HALT sets isMoving=false directly rather than through updatePath()'s
    // arrival branch (see there), so it needs its own pen-up — otherwise
    // cancelling mid-drawing leaves the pen sitting down on the canvas.
    setServoPos(servoUp);

  } else if (strcmp(cmd, "WIND") == 0) {
    queueClear();  // manual jog cancels any pending drawing
    isMoving = false;
    isWinding = true;
    left.enableOutputs();
    right.enableOutputs();
    windL = params["l"] | 0;
    windR = params["r"] | 0;
    left.setSpeed(windL * maxSpeedWind * invL);
    right.setSpeed(windR * maxSpeedWind * invR);

  } else if (strcmp(cmd, "MOVE_ABS") == 0 || strcmp(cmd, "MOVE_REL") == 0) {
    queueClear();  // explicit manual target cancels any pending drawing
    float x = params["x"] | 0.0;
    float y = params["y"] | 0.0;
    if (strcmp(cmd, "MOVE_ABS") == 0) {
      targetX = x;
      targetY = y;
    } else {
      targetX = curX + x;
      targetY = curY + y;
    }
    clampToWorkArea(targetX, targetY);
    left.enableOutputs();
    right.enableOutputs();
    isMoving = true;

  } else if (strcmp(cmd, "QUEUE_ADD") == 0) {
    JsonArray points = params["points"].as<JsonArray>();
    int added = 0;
    for (JsonVariant p : points) {
      JsonArray pair = p.as<JsonArray>();
      if (pair.size() < 2) continue;
      float px = pair[0].as<float>();
      float py = pair[1].as<float>();
      clampToWorkArea(px, py);
      if (queuePush(px, py)) {
        added++;
      } else {
        Serial.println("WARNING: point queue full, dropping rest of this batch");
        break;
      }
    }
    Serial.print("QUEUE_ADD: +");
    Serial.print(added);
    Serial.print(" points (queue_len=");
    Serial.print(queueLen);
    Serial.println(")");

    // Kick off movement immediately if idle — otherwise updatePath() will
    // pick up the next point on its own once the current move finishes.
    if (!isMoving && !isWinding && queueLen > 0) {
      float x, y;
      queuePop(x, y);
      targetX = x;
      targetY = y;
      left.enableOutputs();
      right.enableOutputs();
      isMoving = true;

      // A queue-driven move only ever starts here (a plain MOVE_ABS/
      // MOVE_REL/HOME never goes through the queue), so this is
      // specifically "a drawing is starting" — lower the pen before the
      // gondola takes its first step. Matching raise lives in
      // updatePath()'s queue-empty branch below.
      setServoPos(servoWrite);
    }

  } else if (strcmp(cmd, "CAL") == 0) {
    float commandedMM = params["commanded"] | 0.0;
    float measuredMM = params["measured"] | 0.0;
    if (commandedMM <= 0 || measuredMM <= 0) {
      Serial.println("CAL needs commanded and measured mm, both > 0");
    } else {
      stepsPerMm = stepsPerMm * (commandedMM / measuredMM);
      saveStepsPerMm();
      Serial.print("stepsPerMm updated to ");
      Serial.println(stepsPerMm, 6);
    }
  } else if (strcmp(cmd, "SERVO_SET") == 0) {
    // Takes a raw position again (not a write/bool) — the webapp's toggle
    // sends the extreme values 0 or 1000 for up/write, and the clamp below
    // snaps any sufficiently-extreme value onto whichever of the two
    // presets it's closest to (0 -> servoUp, 1000 -> servoWrite), so the
    // toggle's behavior is unchanged from the boolean version. Anything
    // *within* [servoUp, servoWrite] passes through untouched instead of
    // getting rounded to a preset, which is what a PEN CAL button (sending
    // some specific in-between value) needs. constrain() requires min<=max,
    // so min/max here make it work regardless of which constant is
    // numerically larger.
    int pos = params["pos"] | servoUp;
    setServoPos(pos);
  }
}

void setup() {
  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce

  left.setMaxSpeed(maxSpeed);
  left.setAcceleration(accel);
  right.setMaxSpeed(maxSpeed);
  right.setAcceleration(accel);

  loadStepsPerMm();

  syncMotors();
  Serial.println("System Ready (ESP32).");
  Serial.println("Not zeroed yet. Jog to the reference point (top-middle) and send ZERO.");

  // standard 50Hz servo
  servo.setPeriodHertz(50);
  // tweak min/max pulse widths to your servo's spec if it buzzes/doesn't hit full range
  servo.attach(SERVO_PIN, 500, 2400);
  setServoPos(servoPos);
}

void loop() {
  // Keep curX/curY a live mirror of where the motors actually are, however
  // they got there (path-following, WIND jogging, or anything else) — see
  // updateCurrentPosition() below for why this matters.
  updateCurrentPosition();

  tickNetwork();
  tickCommands();

  if (isMoving) {
    left.runSpeedToPosition();
    right.runSpeedToPosition();

    if (left.distanceToGo() == 0 && right.distanceToGo() == 0) {
      updatePath();
    }
  } else if (isWinding) {
    // Continuous manual rotation
    left.runSpeed();
    right.runSpeed();
  }

  JsonDocument doc;
  // The backend's drawing-job orchestrator (drawing.py's _stopped()) needs
  // these to detect true arrival — queue_len==0 alone doesn't mean the
  // last point has been physically reached yet, only that it's no longer
  // queued. Without these two fields, _stopped() can never return true, so
  // neither the solar path job nor the text job can ever detect
  // completion — they just poll until the stall timeout fires and error out.
  doc["left_distance_to_go"] = left.distanceToGo();
  doc["right_distance_to_go"] = right.distanceToGo();
  doc["queue_len"] = queueLen;
  doc["queue_clears"] = queueClearCount;
  doc["servo_write"] = servoPos == servoWrite;
  // Position is only meaningful once ZERO has been sent this session -
  // report null,null until then rather than a raw, arbitrary coordinate.
  if (positionKnown) {
    doc["x"] = curX;
    doc["y"] = curY;
  } else {
    doc["x"] = nullptr;
    doc["y"] = nullptr;
  }
  doc["chip_temp"] = temperatureRead();
  publishTelemetry(doc);
  delay(1);
}

void updatePath() {
  float dx = targetX - curX;
  float dy = targetY - curY;
  float totalDist = sqrt(dx * dx + dy * dy);

  if (totalDist < 0.2) {
    // Arrived. Pull the next queued point straight in — no MQTT round trip
    // needed, which is what keeps a multi-point drawing moving without
    // stopping. Only go idle once the queue is actually empty.
    float nx, ny;
    if (queuePop(nx, ny)) {
      targetX = nx;
      targetY = ny;
      dx = targetX - curX;
      dy = targetY - curY;
      totalDist = sqrt(dx * dx + dy * dy);
      if (totalDist < 0.2) {
        return;  // next queued point is also already here — pick up next tick
      }
    } else {
      isMoving = false;

      // Queue's empty and there's nowhere left to go — whether this was a
      // drawing finishing or just a plain MOVE_ABS/HOME arriving, raise the
      // pen. Harmless if it was already up (MOVE_ABS never lowers it in the
      // first place); this is what guarantees a drawing never ends with the
      // pen left down on the canvas.
      setServoPos(servoUp);

      Serial.print("Arrived at POS X: ");
      Serial.print(curX);
      Serial.print(" Y: ");
      Serial.println(curY);
      return;
    }
  }

  float travel = min(segmentDist, totalDist);
  float ratio = travel / totalDist;

  // Intermediate waypoint, not a position update — curX/curY now get their
  // value from updateCurrentPosition() every loop, reading the steppers'
  // real step count rather than this idealized path integration.
  float nextX = curX + dx * ratio;
  float nextY = curY + dy * ratio;

  long sL, sR;
  calculateSteps(nextX, nextY, sL, sR);
  left.moveTo(sL);
  right.moveTo(sR);

  left.setSpeed(maxSpeed);
  right.setSpeed(maxSpeed);
}

void calculateSteps(float x, float y, long &sL, long &sR) {
  float ax = x - gondolaWidth / 2.0;  // left anchor x
  float bx = x + gondolaWidth / 2.0;  // right anchor x
  // Anchors are physically ABOVE the pen tip (gondolaHeight is the pen
  // hanging down below where the strings actually attach) — and in this
  // convention bigger y = further down the canvas, further from the
  // motors. "Above" therefore means smaller y, so the anchor's y is the
  // pen's y MINUS gondolaHeight, not plus. Getting this backwards doesn't
  // break calculateSteps() itself (still a valid, computable string
  // length either way) but it corrupts updateCurrentPosition() — its
  // inverse only has one valid solution branch, and with the wrong sign
  // here that branch structurally cannot represent y beyond
  // motorY - gondolaHeight: position tracking silently folds back on
  // itself past that point (e.g. commanding y=950 would make tracked
  // position read back as 870, moving the WRONG way), so updatePath()
  // can never detect "arrived" and the gondola just grinds in place. This
  // is what caused it to reliably jam at exactly motorY - gondolaHeight
  // every time, regardless of what motorY was set to.
  float ay = y - gondolaHeight;

  float lL = sqrt(pow(ax + motorX, 2) + pow(motorY - ay, 2));
  float lR = sqrt(pow(motorX - bx, 2) + pow(motorY - ay, 2));

  sL = (long)(lL * stepsPerMm) * invL;
  sR = (long)(lR * stepsPerMm) * invR;
}

// Inverse of calculateSteps(): derives curX/curY from the steppers' actual
// step counts, so position tracking stays correct no matter how the
// gondola got there — previously only updatePath() (MOVE_ABS/MOVE_REL/HOME)
// updated curX/curY, so WIND-jogging (used to reach each physical corner
// during calibration) never moved it. CORNER then recorded a stale point
// (usually still 0,0) for every corner, computeAndApplyOrigin() derived a
// bogus origin from those, and HOME compared against a curX that already
// looked like it was home — so it never moved.
//
// Derivation: calculateSteps() gives
//   lL^2 = (x - w/2 + motorX)^2 + Dy^2
//   lR^2 = (x + w/2 - motorX)^2 + Dy^2
// where Dy = y - gondolaHeight - motorY is common to both. Subtracting
// eliminates Dy and solves linearly for x; substituting back and taking the
// negative root of Dy (gondola hangs below the motors) solves for y.
void updateCurrentPosition() {
  float lL = (left.currentPosition() * invL) / stepsPerMm;
  float lR = (right.currentPosition() * invR) / stepsPerMm;

  float denom = 2.0 * (2.0 * motorX - gondolaWidth);
  float x = (lL * lL - lR * lR) / denom;

  float a1 = x - gondolaWidth / 2.0 + motorX;
  float under = lL * lL - a1 * a1;
  if (under < 0) under = 0;  // guard tiny float error at full string extension
  float dy = -sqrt(under);   // negative branch: gondola hangs below the motors

  float y = dy + gondolaHeight + motorY;

  curX = x;
  curY = y;
}

void syncMotors() {
  long sL, sR;
  calculateSteps(curX, curY, sL, sR);
  left.setCurrentPosition(sL);
  right.setCurrentPosition(sR);
}

void setServoPos(int pos) {
  pos = constrain(pos, min(servoUp, servoWrite), max(servoUp, servoWrite));

  if (pos == servoWrite) {
    // Lowering onto the writing surface — jump most of the way fast, then
    // ease the last SERVO_SLOW_APPROACH units down one step at a time so
    // the pen doesn't hit the plane at full speed. Direction-agnostic
    // (works whether servoWrite is numerically above or below servoUp),
    // same reasoning as the min/max clamp above.
    int direction = (servoWrite > servoUp) ? 1 : -1;
    int approach = servoWrite - direction * SERVO_SLOW_APPROACH;

    servo.write(approach);
    servoPos = approach;
    delay(150);  // let the fast part of the move actually land before stepping

    Serial.print("SERVO_SET approach -> ");
    Serial.println(servoPos);

    // Step size is now SERVO_STEP_SIZE, not 1 — using < / > here instead of
    // != means it still terminates correctly (and lands exactly on
    // servoWrite via the explicit write after the loop) even if
    // SERVO_SLOW_APPROACH isn't an exact multiple of SERVO_STEP_SIZE,
    // instead of stepping past servoWrite and looping forever.
    for (int p = approach;
         (direction > 0) ? (p < servoWrite) : (p > servoWrite);
         p += direction * SERVO_STEP_SIZE) {
      servo.write(p);
      servoPos = p;
      delay(SERVO_STEP_DELAY_MS);
      Serial.print("SERVO_SET loop -> ");
      Serial.println(servoPos);
    }
    servo.write(servoWrite);
    servoPos = servoWrite;

  } else {
    // Lifting, or any non-write position — nothing to hit, full speed is fine.
    servo.write(pos);
    servoPos = pos;
  }

  Serial.print("SERVO_SET -> ");
  Serial.println(servoPos);
}
