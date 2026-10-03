// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "actuator.dc_motor"
// human-readable name for this sketch
#define SCRIPT_NAME "esp32C3_dc_motors"
// what this device reports in telemetry, e.g. "[\"light_level\"]"
#define CAPS_PUBLISHES "[\"m1\"]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"MOTOR\",\"STOP\",\"BRAKE\"]"

const char* ZONE = "entrance";

#include "../device_base.h"

// ── motor (L298N channel A) ─────────────────────────────────────────────
// ESP32 GPIO3 -> IN1, GPIO4 -> IN2. Leave the ENA jumper on (always
// enabled); speed comes from PWM on whichever IN pin is driving.
// ESP32 GND must be tied to L298N GND.
const int MOTOR_IN1 = 3;
const int MOTOR_IN2 = 4;
const int MOTOR_PWM_FREQ = 5000;  // L298N is slow, keep it in the low kHz
const int MOTOR_PWM_BITS = 8;     // duty 0..255

int motorSpeed = 0;  // -255..255, sign = direction

void setMotor(int speed) {
  motorSpeed = constrain(speed, -255, 255);
  if (motorSpeed >= 0) {
    ledcWrite(MOTOR_IN1, motorSpeed);
    ledcWrite(MOTOR_IN2, 0);
  } else {
    ledcWrite(MOTOR_IN1, 0);
    ledcWrite(MOTOR_IN2, -motorSpeed);
  }
  Serial.print("motor: "); Serial.println(motorSpeed);
}

// both INs high = L298N shorts the motor -> fast stop
void brakeMotor() {
  motorSpeed = 0;
  ledcWrite(MOTOR_IN1, 255);
  ledcWrite(MOTOR_IN2, 255);
  Serial.println("motor: brake");
}

// ── commands (MQTT) ─────────────────────────────────────────────────────
// MOTOR {"speed": -255..255}   STOP {}   BRAKE {}
void onCommand(const char* cmd, JsonObject params) {
  if (strcmp(cmd, "MOTOR") == 0) {
    setMotor(params["speed"] | 0);
  } else if (strcmp(cmd, "STOP") == 0) {
    setMotor(0);
  } else if (strcmp(cmd, "BRAKE") == 0) {
    brakeMotor();
  }
}

// ── commands (Serial, newline terminated) ───────────────────────────────
//   200 / -150 / 0     set speed (-255..255)
//   stop               coast
//   brake              short brake
char serialLine[32];
int serialLen = 0;

void handleSerialLine(char* line) {
  if (strcmp(line, "stop") == 0) setMotor(0);
  else if (strcmp(line, "brake") == 0) brakeMotor();
  else if (line[0] == '-' || isdigit(line[0])) setMotor(atoi(line));
  else Serial.println("? use: <-255..255> | stop | brake");
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
  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce

  ledcAttach(MOTOR_IN1, MOTOR_PWM_FREQ, MOTOR_PWM_BITS);
  ledcAttach(MOTOR_IN2, MOTOR_PWM_FREQ, MOTOR_PWM_BITS);
  setMotor(0);
}

void loop() {
  tickNetwork();
  tickCommands();
  tickSerial();

  JsonDocument doc;
  doc["m1"] = motorSpeed;
  doc["chip_temp"] = temperatureRead();
  publishTelemetry(doc);

  delay(1);
}
