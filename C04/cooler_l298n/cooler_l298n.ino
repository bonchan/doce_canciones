const int TACH_PIN = 4;
const int ENA = 5;
const int IN1 = 6;
const int IN2 = 7;

const int PWM_FREQ = 25000;
const int PWM_RES = 8;

volatile uint32_t pulseCount = 0;

int speedPercent = 0;
int duty = 0;

void setMotorSpeed(int speed) {
  speed = constrain(speed, -100, 100);

  duty = map(abs(speed), 0, 100, 0, 255);

  if (speed > 0) {
    digitalWrite(IN1, HIGH);
    digitalWrite(IN2, LOW);
  } else if (speed < 0) {
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, HIGH);
  } else {
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, LOW);
    duty = 0;
  }

  ledcWrite(ENA, duty);
}

void IRAM_ATTR tachISR() {
  pulseCount++;
}

void setup() {
  Serial.begin(115200);

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);

  pinMode(TACH_PIN, INPUT_PULLUP);

  attachInterrupt(digitalPinToInterrupt(TACH_PIN), tachISR, FALLING);

  ledcAttach(ENA, PWM_FREQ, PWM_RES);

  setMotorSpeed(0);

  Serial.println("Enter speed -100 to 100");
}

void loop() {
  static uint32_t lastTime = 0;

  if (millis() - lastTime >= 500) {
    noInterrupts();
    uint32_t pulses = pulseCount;
    pulseCount = 0;
    interrupts();

    // 2 pulses per revolution (typical Delta fan)
    float rpm = (pulses / 2.0) * 120.0;  // 500ms window → ×120 not ×60

    // FILTER noise spikes
    // if (rpm > 15000) rpm = 0;
    if (speedPercent > 0) {
      Serial.print("Speed: ");
      Serial.print(speedPercent);
      Serial.print("% PWM=");
      Serial.print(duty);
      Serial.print(" RPM=");
      Serial.println(rpm);
    }

    lastTime = millis();
  }

  if (Serial.available()) {
    String s = Serial.readStringUntil('\n');
    s.trim();

    if (s.length()) {
      speedPercent = s.toInt();
      setMotorSpeed(speedPercent);
    }
  }
}