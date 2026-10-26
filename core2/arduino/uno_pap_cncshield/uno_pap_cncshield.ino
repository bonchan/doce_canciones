#include <AccelStepper.h>

// Serial protocol, 115200 baud, one command per line:
//   S<n>  max speed, steps/sec          A<n>  acceleration, steps/sec²
//   D<n>  direction, 1 = forward, 0 = reverse
//   R     run continuously              X     stop (ramps down)
//   M<n>  move n steps (signed)         Z     set position to 0 (only when stopped)
//   E<n>  driver 1 = on, 0 = off        T<n>  telemetry 1 = on, 0 = off
//   ?     report once
//   !     PANIC: instant stop + driver off (no newline needed)
// Go and return:
//   L     learn: remember this spot, spin in the current direction
//   K     mark: ramp down, the spot where it stops is the far end
//   G<n>  shuttle between the two spots n round trips, 0 = forever (X stops)
// Replies: "ok <cmd>", "err <reason>", "PANIC", "ready",
//          "mark <steps>", "trip <done>/<total>", "done"
// Telemetry: "T <position> <speed> <enabled>"

const int EN_PIN = 8;
const int STEP_PIN = 2;
const int DIR_PIN  = 5;

const long FAR_AWAY = 1000000000L;      // a target it never reaches = spin forever
const unsigned long REPORT_MS = 200;

AccelStepper stepper(AccelStepper::DRIVER, STEP_PIN, DIR_PIN);  // STEP, DIR

char line[16];
byte lineLen = 0;

bool forward = true;
bool spinning = false;    // continuous run, as opposed to a fixed move
bool enabled = true;
bool telemetry = true;
bool dirty = true;        // something changed, send one more report
unsigned long lastReport = 0;

enum Mode { MANUAL, LEARNING, MARKING, SHUTTLING };
Mode mode = MANUAL;
long origin = 0;          // where L was pressed
long endPos = 0;          // where it stopped after K
bool haveMark = false;
long tripsTotal = 0;      // 0 = forever
long tripsDone = 0;
byte legs = 0;            // legs of the current round trip, 2 = one trip

void setEnabled(bool on) {
  enabled = on;
  digitalWrite(EN_PIN, on ? LOW : HIGH);   // LOW = driver enabled
}

void killMotion() {
  spinning = false;
  mode = MANUAL;
  stepper.setCurrentPosition(stepper.currentPosition());  // speed 0, no ramp
}

void panic() {
  killMotion();
  setEnabled(false);
  Serial.println("PANIC");
  dirty = true;
}

void report() {
  Serial.print("T ");
  Serial.print(stepper.currentPosition());
  Serial.print(' ');
  Serial.print((long)stepper.speed());
  Serial.print(' ');
  Serial.println(enabled ? 1 : 0);
}

void handleLine() {
  char cmd = toupper(line[0]);
  long val = atol(line + 1);

  switch (cmd) {
    case 'S':
      stepper.setMaxSpeed(max(val, 1L));
      break;
    case 'A':
      stepper.setAcceleration(max(val, 1L));
      break;
    case 'D':
      forward = (val != 0);
      if (spinning) stepper.moveTo(forward ? FAR_AWAY : -FAR_AWAY);  // ramps down and reverses
      break;
    case 'R':
      if (!enabled) { Serial.println("err driver off"); return; }
      mode = MANUAL;
      spinning = true;
      stepper.moveTo(forward ? FAR_AWAY : -FAR_AWAY);
      break;
    case 'M':
      if (!enabled) { Serial.println("err driver off"); return; }
      mode = MANUAL;
      spinning = false;
      stepper.move(val);
      break;
    case 'X':
      mode = MANUAL;
      spinning = false;
      stepper.stop();              // ramps down to a stop
      break;
    case 'Z': {
      if (stepper.isRunning()) { Serial.println("err still moving"); return; }
      long here = stepper.currentPosition();
      origin -= here;              // keep the learned spots where they are
      endPos -= here;
      stepper.setCurrentPosition(0);
      break;
    }
    case 'L':
      if (!enabled) { Serial.println("err driver off"); return; }
      origin = stepper.currentPosition();
      haveMark = false;
      mode = LEARNING;
      spinning = true;
      stepper.moveTo(forward ? FAR_AWAY : -FAR_AWAY);
      break;
    case 'K':
      if (mode != LEARNING) { Serial.println("err not learning, press L first"); return; }
      mode = MARKING;              // loop() records the spot once it has stopped
      spinning = false;
      stepper.stop();
      break;
    case 'G':
      if (!haveMark) { Serial.println("err no mark, do L then K first"); return; }
      if (!enabled) { Serial.println("err driver off"); return; }
      tripsTotal = max(val, 0L);
      tripsDone = 0;
      legs = 0;
      spinning = false;
      mode = SHUTTLING;
      // start toward whichever spot is farther away
      if (labs(stepper.currentPosition() - origin) > labs(stepper.currentPosition() - endPos))
        stepper.moveTo(origin);
      else
        stepper.moveTo(endPos);
      break;
    case 'E':
      if (val == 0) killMotion();
      setEnabled(val != 0);
      break;
    case 'T':
      telemetry = (val != 0);
      break;
    case '?':
      report();
      return;
    default:
      Serial.print("err unknown ");
      Serial.print(line);
      Serial.print(" (first byte 0x");   // shows bytes that don't print
      Serial.print((byte)line[0], HEX);
      Serial.println(")");
      return;
  }
  Serial.print("ok ");
  Serial.println(line);
  dirty = true;
}

void setup() {
  Serial.begin(115200);
  pinMode(EN_PIN, OUTPUT);
  setEnabled(true);
  stepper.setMinPulseWidth(5);   // DRV8825 needs ~2 µs; matters on the faster R4
  stepper.setMaxSpeed(1000);     // steps/sec
  stepper.setAcceleration(500);  // steps/sec²
  Serial.println("ready");
}

void loop() {
  // read one character at a time so the motor never waits on serial
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '!') {
      panic();
      lineLen = 0;
    } else if (c == '\n' || c == '\r') {
      if (lineLen > 0) {
        line[lineLen] = 0;
        handleLine();
        lineLen = 0;
      }
    } else if ((byte)c < 0x20 || (byte)c > 0x7E) {
      // control or garbage byte: never part of a command
    } else if (c == ' ' && lineLen == 0) {
      // leading space
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = c;
    }
  }

  bool moving = stepper.run();   // call as often as possible, never use delay()

  if (mode == MARKING && !moving) {
    endPos = stepper.currentPosition();
    haveMark = (endPos != origin);
    mode = MANUAL;
    Serial.print("mark ");
    Serial.println(endPos - origin);
    dirty = true;
  }

  if (mode == SHUTTLING && !moving) {   // arrived at one end
    if (++legs == 2) {
      legs = 0;
      tripsDone++;
      Serial.print("trip ");
      Serial.print(tripsDone);
      Serial.print('/');
      Serial.println(tripsTotal);
      if (tripsTotal > 0 && tripsDone >= tripsTotal) {
        mode = MANUAL;
        Serial.println("done");
      }
    }
    if (mode == SHUTTLING)
      stepper.moveTo(stepper.targetPosition() == endPos ? origin : endPos);
  }

  if (telemetry && (moving || dirty) && millis() - lastReport >= REPORT_MS) {
    report();
    lastReport = millis();
    dirty = moving;              // one last report after it stops
  }
}
