String inputString = "";

// --- MOTOR PIN CONFIGURATION ---
const int pinENA = 5; // Speed pin (PWM)
const int pinIN1 = 6; // Direction pin 1
const int pinIN2 = 7; // Direction pin 2

// --- PWM SETTINGS FOR ESP32-C3 ---
const int pwmFreq = 5000;    // 5 kHz frequency
const int pwmResolution = 8; // 8-bit resolution (values from 0 to 255)

// --- CONTROL VARIABLES ---
int maxVehicleCount = 0;     // Starts at 0 on boot and holds the all-time peak
const int maxSpeed = 255;    // Maximum speed limit (0 to 255)
const int CONST_FORWARD_SPEED = 200; 

// --- TIMING VARIABLES FOR BREATHING EFFECT ---
unsigned long lastVehicleTime = 0; // Tracks the last millisecond we saw a vehicle
unsigned long breatheTimer = 0;    // Handles the steps inside the breathing cycle
int breatheStage = 0;              // 0: Forward, 1: Pause, 2: Reverse, 3: Pause

void setup() {
  Serial.begin(115200); 
  
  unsigned long start = millis();
  while (!Serial && (millis() - start < 3000)) { delay(10); }
  Serial.println("\r\n--- ESP32-C3 Vehicle Motor Controller Ready ---");
  
  inputString.reserve(200);

  pinMode(pinIN1, OUTPUT);
  pinMode(pinIN2, OUTPUT);
  
  ledcAttach(pinENA, pwmFreq, pwmResolution);
  ledcWrite(pinENA, 0);
  
  lastVehicleTime = millis(); // Initialize timer
}

void loop() {
  // --- PART 1: PARSE SERIAL DATA FROM TOUCHDESIGNER ---
  while (Serial.available()) {
    char inChar = (char)Serial.read();
    
    if (inChar == '\n' || inChar == '\r') {
      if (inputString.length() > 0) {
        
        int currentVehicles = 0;
        int startSemi = 0;
        int endSemi = inputString.indexOf(';');
        
        while (startSemi < inputString.length()) {
          String pair;
          if (endSemi == -1) {
            pair = inputString.substring(startSemi);
            startSemi = inputString.length();
          } else {
            pair = inputString.substring(startSemi, endSemi);
            startSemi = endSemi + 1;
            endSemi = inputString.indexOf(';', startSemi);
          }
          
          pair.trim();
          if (pair.length() == 0) continue;

          int commaIndex = pair.indexOf(',');
          if (commaIndex != -1) {
            String className = pair.substring(0, commaIndex);
            int classTotal = pair.substring(commaIndex + 1).toInt();
            className.trim(); 

            if (className == "car" || className == "truck" || className == "bus" || className == "motorcycle" || className == "bicycle") {
              currentVehicles += classTotal;
            }
          }
        }

        if (currentVehicles > maxVehicleCount) {
          maxVehicleCount = currentVehicles;
          Serial.print("[NEW RECORD] Max Vehicles updated to: ");
          Serial.println(maxVehicleCount);
        }

        // --- TRAFFIC LOAD ENGINE ---
        if (currentVehicles > 0) {
          // Reset the idle timer because we have traffic!
          lastVehicleTime = millis(); 
          breatheStage = 0; // Reset breathing state
          
          // RUN REVERSE (Traffic Mode)
          digitalWrite(pinIN1, LOW);
          digitalWrite(pinIN2, HIGH);
          
          int targetPWM = map(currentVehicles, 1, maxVehicleCount, 50, maxSpeed); 
          targetPWM = constrain(targetPWM, 0, maxSpeed); 
          
          ledcWrite(pinENA, targetPWM);
          Serial.print("Current: "); Serial.print(currentVehicles);
          Serial.print(" | Reverse PWM Speed: "); Serial.println(targetPWM);
        } else {
          Serial.print("Current: 0 | Idle Time: ");
          Serial.print((millis() - lastVehicleTime) / 1000);
          Serial.println("s");
        }
        
        inputString = ""; 
      }
    } else {
      inputString += inChar;
    }
  }

  // --- PART 2: IDLE MANAGEMENT (NO VEHICLES) ---
  // This section evaluates constantly, completely independent of serial arrival rates.
  if (millis() - lastVehicleTime <= 4000) {
    // We are still under the 4-second threshold. Maintain standard CONST non-reverse.
    // If currentVehicles > 0, Part 1 completely overrides this anyway.
    if (ledcRead(pinENA) != CONST_FORWARD_SPEED && digitalRead(pinIN1) == HIGH) {
      digitalWrite(pinIN1, HIGH);
      digitalWrite(pinIN2, LOW);
      ledcWrite(pinENA, CONST_FORWARD_SPEED);
    }
  } 
  else {
    // --- 4 SECONDS HAVE PASSED: START TO BREATHE ---
    // Uses a simple, non-blocking step engine (no delay() used so serial stays responsive)
    unsigned long currentMillis = millis();
    
    switch (breatheStage) {
      case 0: // Step 1: CONST Non-Reverse (Forward)
        digitalWrite(pinIN1, HIGH);
        digitalWrite(pinIN2, LOW);
        ledcWrite(pinENA, CONST_FORWARD_SPEED);
        
        breatheTimer = currentMillis;
        breatheStage = 1; 
        Serial.println("--> Breathing: CONST Forward");
        break;
        
      case 1: // Step 2: Wait for a moment (e.g., 1.5 seconds)
        if (currentMillis - breatheTimer >= 1500) {
          ledcWrite(pinENA, 0); // Stop motor during pause
          breatheTimer = currentMillis;
          breatheStage = 2;
          Serial.println("--> Breathing: Pause");
        }
        break;
        
      case 2: // Step 3: CONST Reverse
        digitalWrite(pinIN1, LOW);
        digitalWrite(pinIN2, HIGH);
        ledcWrite(pinENA, CONST_FORWARD_SPEED); // Uses same constant speed but backwards
        
        breatheTimer = currentMillis;
        breatheStage = 3;
        Serial.println("--> Breathing: CONST Reverse");
        break;
        
      case 3: // Step 4: Wait for a moment before looping back to Step 1
        if (currentMillis - breatheTimer >= 1500) {
          ledcWrite(pinENA, 0);
          breatheStage = 0; // Go back to start of breathing loop
        }
        break;
    }
  }
}