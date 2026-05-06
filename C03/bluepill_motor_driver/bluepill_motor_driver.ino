#include <AccelStepper.h>

HardwareSerial Serial2(PA3, PA2);

// --- MOTOR CONFIGURATION ---
// 28BYJ-48 usually works best with HALF4WIRE (4096 steps/rev)
AccelStepper left(AccelStepper::HALF4WIRE, PB12, PB14, PB13, PB15);
AccelStepper right(AccelStepper::HALF4WIRE, PB6, PB8, PB7, PB9);

// Polargraphs usually need one motor inverted relative to the other
int invL = -1;
int invR = 1;

// Geometry Constants (mm)
const float motorDist = 520.0;
const float motorY = 230.0;            // Height above origin
const float motorX = motorDist / 2.0;  // Horizontal distance from center to motor

float curX = 0, curY = 0;
float targetX = 0, targetY = 0;
float stepsPerMm = 65.189;

float maxSpeed = 800;  // 28BYJ-48 is slow, 1000 might skip steps
float accel = 400;

bool isMoving = false;
float segmentDist = 2.0;  // Smaller segments for smoother arcs

// static int printCounter = 0;

void setup() {
  __HAL_RCC_AFIO_CLK_ENABLE();
  __HAL_AFIO_REMAP_SWJ_NOJTAG();

  Serial.begin(115200);
  Serial2.begin(115200);

  left.setMaxSpeed(maxSpeed);
  left.setAcceleration(accel);
  right.setMaxSpeed(maxSpeed);
  right.setAcceleration(accel);

  // Initialize: Physical gondola should be at bottom-middle (0,0) on power up
  syncMotors();
  Serial.println("System Ready. Origin at Bottom-Middle. Send ABS X Y or REL X Y.");
}

void loop() {
  if (isMoving) {
    left.runSpeedToPosition();
    right.runSpeedToPosition();

    if (left.distanceToGo() == 0 && right.distanceToGo() == 0) {
      updatePath();
    }
  }

  if (Serial.available()) parseCommand(Serial.readStringUntil('\n'));
  if (Serial2.available()) parseCommand(Serial2.readStringUntil('\n'));
}

void parseCommand(String line) {
  line.trim();
  line.toUpperCase();

  if (line.startsWith("ZERO")) {
    curX = 0;
    targetX = 0;
    curY = 0;
    targetY = 0;

    syncMotors();  // Recalculate step counts for (0,0)

    Serial.println("Origin Set");
  }

  if (line.startsWith("HOME")) {
    targetX = 0;
    targetY = 0;
    isMoving = true;
    Serial.println("Going Home");
  }

  if (line.startsWith("ABS") || line.startsWith("REL")) {
    int xIdx = line.indexOf('X');
    int yIdx = line.indexOf('Y');

    if (xIdx != -1 && yIdx != -1) {
      float valX = line.substring(xIdx + 1, line.indexOf(' ', xIdx)).toFloat();
      float valY = line.substring(yIdx + 1).toFloat();

      if (line.startsWith("ABS")) {
        targetX = valX;
        targetY = valY;
        Serial.print("Moving ABS: ");
      } else {
        targetX = curX + valX;
        targetY = curY + valY;
        Serial.print("Moving REL: ");
      }
      Serial.print("X: ");
      Serial.print(targetX);
      Serial.print(" Y: ");
      Serial.println(targetY);

      isMoving = true;
    }
  }
}

void updatePath() {
  float dx = targetX - curX;
  float dy = targetY - curY;
  float totalDist = sqrt(dx * dx + dy * dy);

  if (totalDist < 0.2) {
    isMoving = false;
    Serial.print("Arrived at POS X: ");
    Serial.print(curX);
    Serial.print(" Y: ");
    Serial.println(curY);
    return;
  }

  float travel = min(segmentDist, totalDist);
  float ratio = travel / totalDist;

  curX += dx * ratio;
  curY += dy * ratio;
  // if (printCounter++ % 10 == 0) {
  //   Serial.print("POS X: ");
  //   Serial.print(curX);
  //   Serial.print(" Y: ");
  //   Serial.println(curY);
  // }

  long sL, sR;
  calculateSteps(curX, curY, sL, sR);
  left.moveTo(sL);
  right.moveTo(sR);

  // Set speeds for runSpeedToPosition
  left.setSpeed(maxSpeed);
  right.setSpeed(maxSpeed);
}

void calculateSteps(float x, float y, long &sL, long &sR) {
  // Distance from Left Motor (-260, 230) to (x, y)
  float lL = sqrt(pow(x + motorX, 2) + pow(motorY - y, 2));
  // Distance from Right Motor (260, 230) to (x, y)
  float lR = sqrt(pow(motorX - x, 2) + pow(motorY - y, 2));

  sL = (long)(lL * stepsPerMm) * invL;
  sR = (long)(lR * stepsPerMm) * invR;
}

void syncMotors() {
  long sL, sR;
  calculateSteps(curX, curY, sL, sR);
  left.setCurrentPosition(sL);
  right.setCurrentPosition(sR);
}