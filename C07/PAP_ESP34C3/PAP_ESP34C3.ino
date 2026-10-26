#include <Arduino.h>
#include <AccelStepper.h>

#define IN1_PIN 1
#define IN2_PIN 2
#define IN3_PIN 3
#define IN4_PIN 4

// L298N: IN1/IN2 -> OUT1/OUT2 (coil A), IN3/IN4 -> OUT3/OUT4 (coil B).
// AccelStepper wants (coilA_end1, coilA_end2, coilB_end1, coilB_end2).
AccelStepper stepper(AccelStepper::HALF4WIRE, IN1_PIN, IN2_PIN, IN3_PIN, IN4_PIN);

const long TRAVEL = 4000;          // half-steps
long target = TRAVEL;

unsigned long pauseUntil = 0;
unsigned long lastReport = 0;
bool parked = false;

void setup() {
  Serial.begin(115200);

  stepper.setMaxSpeed(1500.0);       // half-steps/s -- see scaling note
  stepper.setAcceleration(1500.0);  // ramp quickly through the resonance band
  stepper.moveTo(target);
}

void loop() {
  // Service the motor first. Nothing below is allowed to block.
  stepper.run();

  if (stepper.distanceToGo() == 0) {
    if (!parked) {
      stepper.disableOutputs();     // stop holding current while idle
      pauseUntil = millis() + 500;
      parked = true;
    } else if ((long)(millis() - pauseUntil) >= 0) {
      stepper.enableOutputs();
      target = -target;
      stepper.moveTo(target);
      parked = false;
    }
  }

  // Telemetry that can never stall the step loop.
  if (millis() - lastReport >= 250 && Serial.availableForWrite() >= 32) {
    lastReport = millis();
    Serial.printf("pos=%ld speed=%.0f\n", stepper.currentPosition(), stepper.speed());
  }
}