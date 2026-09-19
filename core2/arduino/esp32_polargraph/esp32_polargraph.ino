// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "polargraph"
#define SCRIPT_NAME "esp32_polargraph"
#define CAPS_PUBLISHES "[\"x\", \"y\", \"left_distance_to_go\", \"right_distance_to_go\", \"queue_len\", \"queue_clears\", \"servo_write\", \"left_endstop\", \"right_endstop\" ]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"HOME\",\"ZERO\",\"HALT\",\"WIND\",\"MOVE_ABS\",\"MOVE_REL\",\"SERVO_SET\",\"CAL\",\"QUEUE_ADD\"]"

const char *ZONE = "entrance";

#include "../device_base.h"

#include <ESP32Servo.h>
#include <AccelStepper.h>
#include <Preferences.h>

// Declared up here, right after the includes, on purpose: the Arduino IDE
// auto-generates function prototypes and inserts them immediately after
// the last #include, above everything else in the file. A prototype for
// homeStateInit()/homeStateTick() referencing HomeState would get inserted
// before HomeState existed if this struct/enum were declared further down
// (where it's actually used) — "HomeState was not declared in this scope"
// even though the real definition further down looks completely fine on
// its own. Keeping type definitions functions depend on up here avoids
// that whole class of auto-prototype ordering issue.
enum HomePhase { HOME_SEEK, HOME_BACKOFF, HOME_TOUCH, HOME_DONE, HOME_FAILED };

struct HomeState {
  AccelStepper *motor;
  int pin;
  int inv;
  HomePhase phase;
  long phaseStartPos;  // currentPosition() at the start of the current phase
  long backoffSteps;
  long maxSteps;
};

// 28BYJ-48 motor = 4096 steps per full revolution in HALF4WIRE mode
const long STEPS_PER_REV = 4096;

// AccelStepper pin order for ULN2003 drivers: IN1, IN3, IN2, IN4
AccelStepper left(AccelStepper::HALF4WIRE, 32, 25, 33, 26);
AccelStepper right(AccelStepper::HALF4WIRE, 19, 5, 18, 17);

// End Stops — normally-closed, wired to GND with the pin pulled up (see
// setup()): idle/untriggered = switch closed = pulled to GND = LOW;
// triggered = switch open = pulled up = HIGH. Which winding direction
// actually reaches the switch is hardware-specific — see
// HOME_SEEK_DIRECTION below, confirmed by testing rather than assumed.
const int LEFT_ENDSTOP_PIN = 27;
const int RIGHT_ENDSTOP_PIN = 16;

// Note there's no ENDSTOP_LEFT/RIGHT_LENGTH_MM constant here — an earlier
// version tried to compute (x,y) from an assumed physical string length at
// the trigger point, which requires knowing that length exactly (a tape-
// measure value, easy to get slightly wrong) and produced nonsense
// (curY > motorY) when left at its 0.0 placeholder. Simpler and more
// robust: wherever both switches trip IS the reference point, full stop —
// homeAtBoot() just declares that position (0,0), the same way manual
// ZERO already does. No physical measurement needed at all.

const float HOME_SEEK_SPEED = 600;    // steps/sec, fast first pass toward the switch
const float HOME_TOUCH_SPEED = 150;   // steps/sec, slow re-approach — a switch's trip point
                                        // can shift slightly with approach speed/momentum, so
                                        // the slow touch (not the fast seek) is what the final
                                        // position is actually trusted from
const float HOME_BACKOFF_MM = 8.0;    // pulled off the switch before the slow re-approach,
                                        // and enough that the seek->backoff->touch sequence
                                        // can't mistake still being on the switch for done
const float HOME_MAX_MM = 1500.0;     // safety cap: if a switch never trips (broken wire,
                                        // unplugged, unconnected), give up after winding this
                                        // much rather than grinding forever

// Sign of the seek direction toward the switch — confirmed empirically on
// the actual hardware (+1 is correct here). The "should be reeling in
// since the switches are near the motors" reasoning turned out backwards
// for this build: the real direction depends on how the string is wound
// onto the spool, not just "closer to the motor = shorter string" gravity
// logic. Trust hardware testing over reasoning about it from the desk —
// if a future rewiring flips it again, this is the one line to change
// rather than re-deriving the sign through the rest of homeStateTick().
const int HOME_SEEK_DIRECTION = +1;

// True only while homeAtBoot() is actively seeking a switch — lets the
// runtime safety check in loop() (below) tell "this trigger is the
// deliberate homing move" apart from "something wound in during normal
// operation and needs an emergency stop".
bool homingInProgress = false;


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
// gondola bumped while off, etc.) — re-established fresh each boot
// instead, now automatically via homeAtBoot()'s endstops rather than
// requiring a manual ZERO every power cycle. ZERO is still here as a
// fallback/override — useful if the endstop length constants turn out to
// be off, or you'd rather calibrate to a different physical reference.
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

  pinMode(LEFT_ENDSTOP_PIN, INPUT_PULLUP);
  pinMode(RIGHT_ENDSTOP_PIN, INPUT_PULLUP);

  syncMotors();

  // standard 50Hz servo
  servo.setPeriodHertz(50);
  // tweak min/max pulse widths to your servo's spec if it buzzes/doesn't hit full range
  servo.attach(SERVO_PIN, 500, 2400);
  setServoPos(servoPos);

  homeAtBoot();  // sets positionKnown itself — see there for what happens on failure
  Serial.println("System Ready (ESP32).");
  if (!positionKnown) {
    Serial.println("Not zeroed yet. Jog to the reference point (top-middle) and send ZERO.");
  }
}

void loop() {
  // Keep curX/curY a live mirror of where the motors actually are, however
  // they got there (path-following, WIND jogging, or anything else) — see
  // updateCurrentPosition() below for why this matters.
  updateCurrentPosition();

  bool lEnd = digitalRead(LEFT_ENDSTOP_PIN) == HIGH;
  bool rEnd = digitalRead(RIGHT_ENDSTOP_PIN) == HIGH;

  // Print only on change, not every tick — this loop needs to run at a
  // high, steady rate for AccelStepper's step timing (runSpeedToPosition/
  // runSpeed) to produce smooth motion; Serial.print() on every single
  // iteration (this was happening unconditionally before, with delay(1)
  // right below) burns enough time per call to visibly stutter the motors.
  static bool lastLEnd = false, lastREnd = false;
  if (lEnd != lastLEnd || rEnd != lastREnd) {
    Serial.print("L endstop: ");
    Serial.print(lEnd ? "TRIGGERED" : "ok");
    Serial.print("  R endstop: ");
    Serial.println(rEnd ? "TRIGGERED" : "ok");
    lastLEnd = lEnd;
    lastREnd = rEnd;
  }

  // Safety backstop, separate from homeAtBoot()'s deliberate seeking: if a
  // switch trips at any other time, the string has wound further in than
  // it physically should — winding past this can jam the spool or snap
  // the string. Full stop (same as HALT) rather than trying to save just
  // the one side, since coordinated (x,y) tracking isn't meaningful once
  // one side's real position has diverged from what the steppers believe
  // anyway.
  if (!homingInProgress && (lEnd || rEnd)) {
    if (isMoving || isWinding) {
      Serial.println("ENDSTOP TRIGGERED during motion — emergency stop");
    }
    isMoving = false;
    isWinding = false;
    queueClear();
    left.disableOutputs();
    right.disableOutputs();
    setServoPos(servoUp);
  }

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
  
  doc["left_endstop"] = lEnd;
  doc["right_endstop"] = rEnd;
  
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

// ── homing state machine ────────────────────────────────────────────────
// Both sides seek their endstop AT THE SAME TIME rather than one after the
// other: AccelStepper's runSpeed() only issues a step when its own timer
// says one is due, so ticking left's and right's homing forward in the
// same loop iteration is exactly what normal operation already does
// (loop()'s isMoving branch calls runSpeedToPosition() on both every
// tick) — there's no coupling between the two strings during a seek, so
// there's nothing sequential order was ever protecting against. This also
// roughly halves total homing time versus doing one side fully, then the
// other. (HomePhase/HomeState themselves are declared up near the includes
// — see the comment there for why.)
void homeStateInit(HomeState &s, AccelStepper &motor, int pin, int inv) {
  s.motor = &motor;
  s.pin = pin;
  s.inv = inv;
  s.phase = HOME_SEEK;
  s.phaseStartPos = motor.currentPosition();
  s.backoffSteps = (long)(HOME_BACKOFF_MM * stepsPerMm);
  s.maxSteps = (long)(HOME_MAX_MM * stepsPerMm);
  motor.setSpeed(HOME_SEEK_DIRECTION * HOME_SEEK_SPEED * inv);
}

// Advances this side by one tick (one motor.runSpeed() call at most, so
// calling this for both sides once per loop iteration is what makes them
// run concurrently). Returns true once this side has reached a terminal
// state (HOME_DONE or HOME_FAILED) — caller stops ticking it at that point.
bool homeStateTick(HomeState &s) {
  switch (s.phase) {
    case HOME_SEEK:
      // Reel string in (toward the switch, see HOME_SEEK_DIRECTION above)
      // until it trips.
      if (digitalRead(s.pin) == HIGH) {
        s.motor->setSpeed(0);
        s.phase = HOME_BACKOFF;
        s.phaseStartPos = s.motor->currentPosition();
        s.motor->setSpeed(-HOME_SEEK_DIRECTION * HOME_SEEK_SPEED * s.inv);
      } else if (labs(s.motor->currentPosition() - s.phaseStartPos) > s.maxSteps) {
        Serial.println("WARNING: endstop never triggered during seek — homing aborted for this side");
        s.motor->setSpeed(0);
        s.phase = HOME_FAILED;
      } else {
        s.motor->runSpeed();
      }
      break;

    case HOME_BACKOFF:
      // Pull off the switch (opposite direction) before the slow re-touch.
      if (labs(s.motor->currentPosition() - s.phaseStartPos) >= s.backoffSteps) {
        s.motor->setSpeed(0);
        s.phase = HOME_TOUCH;
        s.phaseStartPos = s.motor->currentPosition();
        s.motor->setSpeed(HOME_SEEK_DIRECTION * HOME_TOUCH_SPEED * s.inv);
      } else {
        s.motor->runSpeed();
      }
      break;

    case HOME_TOUCH:
      // Slow re-approach — this trigger, not the fast seek's, is the one
      // the final position is trusted from (see HOME_TOUCH_SPEED above).
      if (digitalRead(s.pin) == HIGH) {
        s.motor->setSpeed(0);
        s.phase = HOME_DONE;
      } else if (labs(s.motor->currentPosition() - s.phaseStartPos) > s.backoffSteps * 2) {
        Serial.println("WARNING: endstop didn't re-trigger on slow approach — homing aborted for this side");
        s.motor->setSpeed(0);
        s.phase = HOME_FAILED;
      } else {
        s.motor->runSpeed();
      }
      break;

    default:
      break;
  }
  return s.phase == HOME_DONE || s.phase == HOME_FAILED;
}

// Runs once at boot (see setup()) to establish (0,0) without any manual
// ZERO — homes both sides concurrently (see the state-machine comment
// above), and once both switches have tripped, declares that position the
// origin directly (same semantics as onCommand()'s ZERO branch — "wherever
// the gondola physically is right now becomes (0,0)"), rather than trying
// to compute an (x,y) from an assumed physical string length at the
// trigger point. Relies on both switches being mounted so that "both
// tripped" is a repeatable physical spot (nominally top-middle) — the same
// assumption manual ZERO already made about wherever you jogged it to.
//
// Blocking by design, same reasoning as setServoPos()'s slow-landing loop:
// this only runs once, before the device does anything else useful, so
// there's nothing meaningful to block. It does mean telemetry goes quiet
// for the few seconds homing takes — if that exceeds the backend's
// STALE_TIMEOUT (default 15s) the device may show briefly offline right
// after boot before catching up; cosmetic, not a functional problem.
//
// If either side fails to home, positionKnown stays false and outputs are
// disabled — exactly the pre-endstop behavior, so a broken switch degrades
// to "send ZERO manually" rather than homing to a silently-wrong position
// and drawing garbage.
void homeAtBoot() {
  Serial.println("Homing: seeking both endstops at once...");
  homingInProgress = true;
  left.enableOutputs();
  right.enableOutputs();

  HomeState ls, rs;
  homeStateInit(ls, left, LEFT_ENDSTOP_PIN, invL);
  homeStateInit(rs, right, RIGHT_ENDSTOP_PIN, invR);

  bool leftFinished = false, rightFinished = false;
  while (!leftFinished || !rightFinished) {
    if (!leftFinished) leftFinished = homeStateTick(ls);
    if (!rightFinished) rightFinished = homeStateTick(rs);
  }

  homingInProgress = false;

  if (ls.phase == HOME_DONE && rs.phase == HOME_DONE) {
    curX = 0;
    curY = 0;
    targetX = 0;
    targetY = 0;
    syncMotors();
    positionKnown = true;
    Serial.println("Homed — (0,0) set to endstop position.");
  } else {
    left.disableOutputs();
    right.disableOutputs();
    Serial.println("Homing incomplete — send ZERO manually before drawing.");
  }
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
