// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "polargraph"
#define SCRIPT_NAME "esp32_polargraph"

// Telemetry/meta field names are short on purpose — the full announce
// payload (this list + CAPS_SUBSCRIBES + the extra motor_* fields below)
// was overflowing device_base.h's publishAnnounce() buffer and getting
// silently truncated ("WARNING: announce payload truncated") once enough
// capabilities/fields piled up. Command names (CAPS_SUBSCRIBES) and
// command params (e.g. SET_MOTOR_Y's "steps") are untouched — they're not
// part of the retained announce payload, only sent per-command, so they
// weren't contributing to the overflow and shortening them would only
// have made the CommandPanel/logs harder to read for no size benefit.
//
//   short  -> long (what it means)
//   ldtg   -> left_distance_to_go  (AccelStepper left.distanceToGo())
//   rdtg   -> right_distance_to_go (AccelStepper right.distanceToGo())
//   qlen   -> queue_len            (points left in the on-device point queue)
//   qclr   -> queue_clears         (queueClear() call count — interruption detection)
//   swr    -> servo_write          (bool: is the pen currently in the "write" position)
//   lend   -> left_endstop         (bool: left limit switch currently triggered)
//   rend   -> right_endstop        (bool: right limit switch currently triggered)
//   temp   -> chip_temp            (ESP32 internal temperature sensor)
//   my     -> motor_y   (meta, announce-only) (derived mm height — see motorY/motorYSteps)
//   md     -> motor_dist (meta, announce-only) (mm between the two motors)
//   mys    -> motor_y_steps (meta, announce-only) (the actual persisted value — see motorYSteps)
#define CAPS_PUBLISHES "[\"x\",\"y\",\"ldtg\",\"rdtg\",\"qlen\",\"qclr\",\"swr\",\"lend\",\"rend\"]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"HOME\",\"ZERO\",\"HALT\",\"WIND\",\"MOVE_ABS\",\"MOVE_REL\",\"SERVO_SET\",\"CAL\",\"QUEUE_ADD\",\"SET_MOTOR_Y\",\"SET_BOTTOM\"]"

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
enum HomePhase { HOME_SEEK, HOME_SEEK_DONE, HOME_BACKOFF, HOME_TOUCH, HOME_DONE, HOME_FAILED };

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
const float HOME_BACKOFF_MM = 10.0;    // pulled off the switch before the slow re-approach,
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

// Height above origin (mm) — NOT the source of truth anymore, just a
// derived value. What's actually persisted is motorYSteps: a raw step
// count is a fact about this specific installation's physical rig (how
// many steps of winding it takes to reach the bottom of its travel from
// the endstop-established origin), independent of stepsPerMm calibration
// accuracy. That's the point of storing it in steps rather than mm: move
// the same rig to a new location with a different drop height, and the
// step count for THAT drop is what changes — it's not something
// stepsPerMm calibration (a motor/pulley property, not an installation
// property) should silently invalidate, and it's not something you'd want
// to remeasure-and-hardcode-recompile for every new install either.
// recomputeMotorY() is what keeps this float in sync with motorYSteps
// (and with stepsPerMm, so a later CAL recalibration doesn't leave it
// stale) — see there, loadMotorYSteps(), and onCommand()'s SET_MOTOR_Y.
float motorY = 1000.0;  // placeholder; recomputeMotorY() overwrites this in setup()
long motorYSteps = 0;   // placeholder; loadMotorYSteps() overwrites this in setup()
const float DEFAULT_MOTOR_Y_MM = 1000.0;  // fallback only, for the very first boot before SET_MOTOR_Y has ever been sent

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

// No latch/disableOutputs() flags here on purpose — see the runtime safety
// check in loop(). Disabling outputs the instant a switch trips seemed
// like the obvious move, but it blocks EVERY direction, including backing
// away from the switch — with the motor de-energized, nothing can ever
// move it off the switch again, so it stays "triggered" and stays
// blocked, forever, even though backing off is exactly what should be
// allowed. The fix is direction-aware blocking computed fresh each tick,
// not a persistent halted state — see wouldWindToward() below.

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

// Recomputes motorY (mm) from motorYSteps and the current stepsPerMm —
// call this any time either one changes (loading at boot, SET_MOTOR_Y,
// or CAL adjusting stepsPerMm) so motorY never goes stale relative to the
// values it's actually derived from.
void recomputeMotorY() {
  motorY = motorYSteps / stepsPerMm;
}

// Must run AFTER loadStepsPerMm() — the very first boot (nothing saved
// yet) falls back to DEFAULT_MOTOR_Y_MM converted through whatever
// stepsPerMm was just loaded, so a fresh device behaves like the old
// hardcoded 1000mm constant did until SET_MOTOR_Y is sent for the first
// time at this installation.
void loadMotorYSteps() {
  prefs.begin("polargraph", true);
  long defaultSteps = (long)(DEFAULT_MOTOR_Y_MM * stepsPerMm);
  motorYSteps = prefs.getLong("motorYSteps", defaultSteps);
  prefs.end();
  recomputeMotorY();
}

void saveMotorYSteps() {
  prefs.begin("polargraph", false);
  prefs.putLong("motorYSteps", motorYSteps);
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

// Advertises motorY and motorDist in the announce payload (as "my"/"md" —
// see the name-shortening comment above CAPS_PUBLISHES) so the webapp can
// size/scale its canvas to the real working rectangle instead of guessing —
// the origin sits at the top-middle reference point (see ZERO), motorY is
// the vertical distance from there down to the motors' mounting height, and
// motorDist is the full horizontal distance between the two motors.
// motorYSteps (the actual persisted value, as "mys") is included too, so
// the webapp's SET_MOTOR_Y control can show/pre-fill the device's current
// setting instead of the derived mm figure.
const char *announceExtraFields() {
  static char buf[80];
  snprintf(buf, sizeof(buf), "\"my\":%.2f,\"md\":%.2f,\"mys\":%ld", motorY, motorDist, motorYSteps);
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
      recomputeMotorY();  // motorYSteps (the persisted source of truth)
                           // didn't change, but the mm it converts to did
      Serial.print("stepsPerMm updated to ");
      Serial.println(stepsPerMm, 6);
    }
  } else if (strcmp(cmd, "SET_MOTOR_Y") == 0) {
    // Persists the physical drop height of THIS installation, in steps —
    // see the motorYSteps declaration above for why steps rather than mm.
    // Takes effect immediately (canvas-relevant geometry recomputed and
    // re-announced) and survives reboot, so a new install site is just
    // "wind down to the real bottom, read off the step count, send it
    // here" rather than a firmware recompile.
    long steps = params["steps"] | 0;
    if (steps <= 0) {
      Serial.println("SET_MOTOR_Y needs steps > 0");
    } else {
      motorYSteps = steps;
      recomputeMotorY();
      saveMotorYSteps();
      // announce is retained but otherwise only sent once, on (re)connect
      // (see device_base.h) — republish now so the webapp's canvas
      // rescales immediately instead of waiting for the next reboot/
      // reconnect to pick up the new geometry.
      publishAnnounce();
      Serial.print("motorY updated -> ");
      Serial.print(motorYSteps);
      Serial.print(" steps (");
      Serial.print(motorY, 2);
      Serial.println(" mm)");
    }
  } else if (strcmp(cmd, "SET_BOTTOM") == 0) {
    // Same "wherever the gondola physically is becomes the reference"
    // pattern ZERO uses (see there), but for the bottom boundary instead
    // of the origin — no params needed, it reads curY, which
    // updateCurrentPosition() already keeps live every loop from the
    // real step counts.
    //
    // Deliberately NOT tied to any particular x: the geometry model keeps
    // y decoupled from x (a real Cartesian rectangle, not polar), so this
    // works correctly from wherever you send it. That matters here
    // specifically because bottom-middle is NOT the worst case for either
    // motor — the left motor's longest string is needed at bottom-RIGHT,
    // the right motor's at bottom-LEFT — so jog to whichever corner is
    // hardest for that side before sending this, not the middle, or the
    // saved limit won't actually be safe once the gondola visits the
    // corner it wasn't tested at. (Test both corners at your target depth
    // before saving from either one, if you want to be sure both motors
    // are actually happy there.)
    if (!positionKnown) {
      Serial.println("SET_BOTTOM needs a known position — send ZERO or let homing establish one first");
    } else if (curY <= 0) {
      Serial.println("SET_BOTTOM: current Y must be > 0 (below the origin) to mean anything as a bottom limit");
    } else {
      motorYSteps = (long)(curY * stepsPerMm);
      recomputeMotorY();
      saveMotorYSteps();
      publishAnnounce();  // same reasoning as SET_MOTOR_Y — see there
      Serial.print("Bottom set from current position -> ");
      Serial.print(motorYSteps);
      Serial.print(" steps (");
      Serial.print(motorY, 2);
      Serial.println(" mm)");
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
  loadMotorYSteps();  // must come after loadStepsPerMm() — see there

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

// True if this motor's currently-commanded direction (WIND's live speed
// while isWinding, or the moveTo() target while isMoving) matches
// dangerDirection — the sign of "further into the switch", same as
// homing's own HOME_SEEK_DIRECTION*inv. A motor with nothing actively
// commanded (speed 0 / already at its target) returns false — there's
// nothing to block. Used by the runtime safety check in loop() so it can
// block only the dangerous direction and leave the opposite one (backing
// off the switch) free, rather than freezing the motor outright.
bool wouldWindToward(AccelStepper &motor, int dangerDirection) {
  if (isWinding) {
    float spd = motor.speed();
    if (spd == 0) return false;
    return ((spd > 0) ? 1 : -1) == dangerDirection;
  }
  if (isMoving) {
    long dtg = motor.distanceToGo();
    if (dtg == 0) return false;
    return ((dtg > 0) ? 1 : -1) == dangerDirection;
  }
  return false;
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
  // static bool lastLEnd = false, lastREnd = false;
  // if (lEnd != lastLEnd || rEnd != lastREnd) {
  //   Serial.print("L endstop: ");
  //   Serial.print(lEnd ? "TRIGGERED" : "ok");
  //   Serial.print("  R endstop: ");
  //   Serial.println(rEnd ? "TRIGGERED" : "ok");
  //   lastLEnd = lEnd;
  //   lastREnd = rEnd;
  // }

  // Safety backstop, separate from homeAtBoot()'s deliberate seeking: if a
  // switch is triggered, block further motion in the direction that winds
  // further INTO it — but NOT the opposite direction, which is exactly
  // how you back off. This used to disableOutputs() entirely the instant
  // a switch tripped, which seemed safer but actually deadlocked the
  // motor: de-energized, nothing could ever move it off the switch again,
  // so it stayed triggered — and blocked — forever, with no way to even
  // unwind. Direction-aware blocking (via wouldWindToward() above) fixes
  // that: the dangerous direction stays blocked, the safe one (unwind/
  // back off) always works, no latch, no disableOutputs().
  //
  // dangerDirection is the same sign homing's own seek uses — "into the
  // switch" is defined identically in both places.
  int leftDanger = HOME_SEEK_DIRECTION * invL;
  int rightDanger = HOME_SEEK_DIRECTION * invR;
  bool leftBlocked = !homingInProgress && lEnd && wouldWindToward(left, leftDanger);
  bool rightBlocked = !homingInProgress && rEnd && wouldWindToward(right, rightDanger);

  // Print only on change (blocked, not just "triggered" — sitting on a
  // switch while not trying to press further into it is harmless and not
  // worth logging every tick).
  static bool lastLeftBlocked = false, lastRightBlocked = false;
  if (leftBlocked != lastLeftBlocked) {
    Serial.println(leftBlocked ? "LEFT ENDSTOP — blocking further motion into the switch"
                                : "Left motor free to move again");
    lastLeftBlocked = leftBlocked;
  }
  if (rightBlocked != lastRightBlocked) {
    Serial.println(rightBlocked ? "RIGHT ENDSTOP — blocking further motion into the switch"
                                 : "Right motor free to move again");
    lastRightBlocked = rightBlocked;
  }
  // A blocked WIND command is cancelled outright (not just skipped this
  // tick) rather than silently retried forever — the user has to
  // explicitly re-jog (e.g. the opposite direction first, then back)
  // rather than the motor just sitting there re-attempting the same
  // blocked move every tick with no feedback.
  if (leftBlocked && isWinding) { windL = 0; left.setSpeed(0); }
  if (rightBlocked && isWinding) { windR = 0; right.setSpeed(0); }

  tickNetwork();
  tickCommands();

  if (isMoving) {
    if (!leftBlocked) left.runSpeedToPosition();
    if (!rightBlocked) right.runSpeedToPosition();

    // Only treat this as "arrived, advance the path" once both sides are
    // actually free to move and have actually arrived — a blocked motor's
    // distanceToGo() is frozen wherever it was, which isn't "arrived" in
    // any meaningful sense, just stuck.
    if (!leftBlocked && !rightBlocked && left.distanceToGo() == 0 && right.distanceToGo() == 0) {
      updatePath();
    }
  } else if (isWinding) {
    // Continuous manual rotation — blocked side just doesn't step; the
    // other keeps jogging normally, and either side can still jog AWAY
    // from its own triggered switch.
    if (!leftBlocked) left.runSpeed();
    if (!rightBlocked) right.runSpeed();
  }

  JsonDocument doc;
  // Field names are short (ldtg/rdtg/qlen/qclr/swr/lend/rend/temp) — see
  // the name-shortening comment above CAPS_PUBLISHES for the full
  // short->long mapping and why.
  //
  // The backend's drawing-job orchestrator (drawing.py's _stopped()) needs
  // ldtg/rdtg to detect true arrival — qlen==0 alone doesn't mean the
  // last point has been physically reached yet, only that it's no longer
  // queued. Without these two fields, _stopped() can never return true, so
  // neither the solar path job nor the text job can ever detect
  // completion — they just poll until the stall timeout fires and error out.
  doc["ldtg"] = left.distanceToGo();
  doc["rdtg"] = right.distanceToGo();
  doc["qlen"] = queueLen;
  doc["qclr"] = queueClearCount;
  doc["swr"] = servoPos == servoWrite;

  doc["lend"] = lEnd;
  doc["rend"] = rEnd;

  // Position is only meaningful once ZERO has been sent this session -
  // report null,null until then rather than a raw, arbitrary coordinate.
  if (positionKnown) {
    doc["x"] = curX;
    doc["y"] = curY;
  } else {
    doc["x"] = nullptr;
    doc["y"] = nullptr;
  }
  doc["temp"] = temperatureRead();
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

// Promotes a side parked in HOME_SEEK_DONE into HOME_BACKOFF — called from
// homeAtBoot()'s barrier once BOTH sides are settled (found their switch,
// or given up), never by homeStateTick() itself, which is the whole point:
// one side reaching its switch first is expected (they're two independent
// strings), but it shouldn't start moving again — even just backing off —
// until its sibling has stopped seeking too.
void homeStateBeginBackoff(HomeState &s) {
  s.phase = HOME_BACKOFF;
  s.phaseStartPos = s.motor->currentPosition();
  s.motor->setSpeed(-HOME_SEEK_DIRECTION * HOME_SEEK_SPEED * s.inv);
}

// Advances this side by one tick (one motor.runSpeed() call at most, so
// calling this for both sides once per loop iteration is what makes them
// run concurrently). Returns true once this side has reached a terminal
// state (HOME_DONE or HOME_FAILED) — caller stops ticking it at that point.
bool homeStateTick(HomeState &s) {
  switch (s.phase) {
    case HOME_SEEK:
      // Reel string in (toward the switch, see HOME_SEEK_DIRECTION above)
      // until it trips. Doesn't move straight into HOME_BACKOFF on its
      // own — parks in HOME_SEEK_DONE instead, motor stopped, and waits
      // for homeAtBoot()'s barrier to release both sides into backoff
      // together (see there for why: backing one side off while the
      // other is still actively seeking was the reported issue).
      if (digitalRead(s.pin) == HIGH) {
        s.motor->setSpeed(0);
        s.phase = HOME_SEEK_DONE;
      } else if (labs(s.motor->currentPosition() - s.phaseStartPos) > s.maxSteps) {
        Serial.println("WARNING: endstop never triggered during seek — homing aborted for this side");
        s.motor->setSpeed(0);
        s.phase = HOME_FAILED;
      } else {
        s.motor->runSpeed();
      }
      break;

    case HOME_SEEK_DONE:
      // Parked: this side found its switch and is waiting for the other
      // side to either find its own or give up — nothing to do per tick.
      // homeAtBoot() promotes this to HOME_BACKOFF once both sides are
      // settled (see homeStateBeginBackoff()).
      break;

    case HOME_BACKOFF:
      // Pull off the switch (opposite direction) — not for a fixed
      // distance alone, but until it's traveled at least backoffSteps AND
      // the switch has actually released (LOW), whichever takes longer.
      // A fixed distance isn't reliable for a lever/angle-triggered switch
      // (as opposed to a hard mechanical stop) — its trigger zone can be
      // wider than a guessed backoff. Finishing homing with the switch
      // still reading triggered is exactly what makes the runtime safety
      // check in loop() lock the motors immediately afterward (see
      // there): it can't distinguish "still on the switch from homing"
      // from "wound in too far during normal operation".
      if (labs(s.motor->currentPosition() - s.phaseStartPos) >= s.backoffSteps
          && digitalRead(s.pin) == LOW) {
        s.motor->setSpeed(0);
        s.phase = HOME_TOUCH;
        s.phaseStartPos = s.motor->currentPosition();
        s.motor->setSpeed(HOME_SEEK_DIRECTION * HOME_TOUCH_SPEED * s.inv);
      } else if (labs(s.motor->currentPosition() - s.phaseStartPos) > s.maxSteps) {
        Serial.println("WARNING: endstop never released during backoff — homing aborted for this side");
        s.motor->setSpeed(0);
        s.phase = HOME_FAILED;
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

    // Barrier between seek and backoff: a side that found its switch
    // parks in HOME_SEEK_DONE (see homeStateTick) instead of backing off
    // immediately. Only once BOTH sides are "settled" — parked, or failed
    // outright — do the parked one(s) get released into HOME_BACKOFF
    // together. A side that failed its seek is still "settled" (it's not
    // going anywhere), so it doesn't block the other side forever if its
    // own switch is broken/unplugged.
    bool leftSettled = ls.phase == HOME_SEEK_DONE || ls.phase == HOME_FAILED;
    bool rightSettled = rs.phase == HOME_SEEK_DONE || rs.phase == HOME_FAILED;
    if (leftSettled && rightSettled) {
      if (ls.phase == HOME_SEEK_DONE) homeStateBeginBackoff(ls);
      if (rs.phase == HOME_SEEK_DONE) homeStateBeginBackoff(rs);
    }
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

  // Serial.print("SERVO_SET -> ");
  // Serial.println(servoPos);
}
