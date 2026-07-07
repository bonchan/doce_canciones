constexpr const char* SCRIPT_NAME = "bichito_rover";
#include "../../core/arduino/node_wifi.h"


int ALTER_FREQ = 5800;


const bool sound = true;
const bool debugLdrSpeaker = false;

// 0 = normal
// 1 = alien
// 2 = idle
const int defaultPattern = 1;

unsigned int counter = 0;
unsigned long step = 1;
const unsigned long updateInterval = 50;
unsigned long lastUpdate = 0;


// 4-digit 7-segment display (COMMON ANODE)
const int segPins[7] = { 13, 14, 27, 4, 16, 17, 5 };  // A, B, C, D, E, F, G
const int digitPins[5] = { 22, 19, 18, 21, 23 };      // Digit 1–5

const int ldr1Pin = 34;     // LDR 1
const int ldr2Pin = 35;     // LDR 2
const int speakerPin = 25;  // Speaker

const int PIN_R = 33;
const int PIN_G = 26;
const int PIN_B = 32;

// Symbols:
// AUX, ALM, USB, SD, MHz, :, CLOCK

const byte patternSets[3][10] = {
  // 0 = normal digits
  {
    B1111110, B0110000, B1101101, B1111001, B0110011,
    B1011011, B1011111, B1110000, B1111111, B1111011 },
  // 1 = alien
  {
    B1010101, B0101010, B1110001, B0011110, B1100101,
    B0111011, B1001011, B1110100, B0101111, B1010110 },
  // 2 = idle (only 8 defined, rest 0)
  {
    B0000000, B1000000, B0100000, B0010000, B0001000,
    B0000100, B0000010, B0000001, B0000000, B0000000  //last 2 available
  }
};

const int turn[12] = { 1000, 100, 10, 1, 2, 3, 4, 40, 400, 4000, 5000, 6000 };





void setup() {
  setupNetwork();

  for (int i = 0; i < 7; i++) {
    pinMode(segPins[i], OUTPUT);
    digitalWrite(segPins[i], LOW);
  }
  for (int i = 0; i < 5; i++) {
    pinMode(digitPins[i], OUTPUT);
    digitalWrite(digitPins[i], LOW);
  }
  clearAll();

  pinMode(ldr1Pin, INPUT);
  pinMode(ldr2Pin, INPUT);
  pinMode(speakerPin, OUTPUT);

  // strip.begin();
  // strip.show();
  // strip.setBrightness(50);

  pinMode(PIN_R, OUTPUT);
  pinMode(PIN_G, OUTPUT);
  pinMode(PIN_B, OUTPUT);

  digitalWrite(PIN_R, HIGH);
  digitalWrite(PIN_G, HIGH);
  digitalWrite(PIN_B, HIGH);

  Serial.begin(115200);
}

void loop() {
  tickNetwork();
  tickCommands();

  unsigned long now = millis();
  if (now - lastUpdate > updateInterval) {
    lastUpdate = now;
    counter += step;
    if (counter > 11) counter = 0;
  }

  // Read LDR values (0-1023)
  int ldr1 = analogRead(ldr1Pin);
  int ldr2 = analogRead(ldr2Pin);

  // Combine them somehow
  // Option 1: average
  int combined = (ldr1 + ldr2) / 2;

  // Option 2: geometric mean (gives different response)
  // int combined = sqrt(ldr1 * ldr2);

  // Map combined light to a frequency (Hz)
  // Example: 200 Hz (dark) → 2000 Hz (bright)
  int freq = map(combined, 0, 1023, 20, 2000);

  int disp = map(combined, 0, 1023, 1990, 9999);

  // Optional: make it more “alien/futuristic”
  // Add some random modulation
  freq += random(-20, 20);

  int ledBright = 0;

  if (alteredActive) {

    if ((millis() / 60) % 2) {
      setRGB(LOW, HIGH, HIGH);
    } else {
      setRGB(HIGH, HIGH, HIGH);
    }

    freq = random(-20, -1) + ALTER_FREQ;
    if (sound) {
      tone(speakerPin, freq);
    }

  } else {
    // Play the tone
    if (freq > 100) {
      if (debugLdrSpeaker)
        Serial.print("  TONE ");
      if (sound) {
        tone(speakerPin, freq);
      }
      displayNumber(disp, defaultPattern);
      yield();
      setRandomRGB();
      ledBright = 255;
    } else {
      if (debugLdrSpeaker)
        Serial.print("NOTONE ");
      noTone(speakerPin);
      displayNumber(turn[counter], 2);
      yield();
      setRGB(HIGH, HIGH, HIGH);
    }
  }

  // Debug
  if (debugLdrSpeaker) {
    Serial.print("  LDR1: ");
    Serial.print(ldr1);
    Serial.print("  LDR2: ");
    Serial.print(ldr2);
    Serial.print("  Freq: ");
    Serial.print(freq);
    Serial.print("  disp: ");
    Serial.println(disp);
  }

  JsonDocument doc;
  doc["ldr1"] = ldr1;
  doc["ldr2"] = ldr2;  //analogRead(A1);
  doc["freq"] = freq;  // your value

  publishTelemetry(doc);

  if (freq > ALTER_FREQ) {
    publishAlter();
  }

  delay(1);
}





// ---------- Display Control ----------

void displayNumber(int num, int patternSet) {
  int digits[4] = { 0, 0, 0, 0 };  // support all 4 digits
  digits[0] = num / 1000 % 10;
  digits[1] = num / 100 % 10;
  digits[2] = num / 10 % 10;
  digits[3] = num % 10;

  // Count how many digits we actually need to display
  int start = 0;
  if (num < 10) start = 3;         // single digit -> rightmost
  else if (num < 100) start = 2;   // two digits -> last two
  else if (num < 1000) start = 1;  // three digits -> last three
  else start = 0;                  // 4 digits fill all

  for (int i = start; i < 4; i++) {
    showDigit(digits[i], i, patternSet);  // display in natural left→right order
  }
}

void showDigit(int value, int digitIndex, int patternSet) {

  clearDigits();  // disable all digits
  // Set segment states (COMMON ANODE: LOW = ON)
  for (int s = 0; s < 7; s++) {
    // byte pattern = alien ? alienPatterns[value] : digitPatterns[value];
    byte pattern = patternSets[patternSet][value];
    bool on = bitRead(pattern, 6 - s);
    digitalWrite(segPins[s], on ? LOW : HIGH);
  }

  // Enable this digit (COMMON ANODE: HIGH = ON)
  digitalWrite(digitPins[digitIndex], HIGH);

  delay(6);  // brief refresh period
  clearDigits();
}

// ---------- Helpers ----------

void clearDigits() {
  for (int i = 0; i < 5; i++) digitalWrite(digitPins[i], LOW);  // all off
}

void clearAll() {
  clearDigits();
  for (int i = 0; i < 7; i++) digitalWrite(segPins[i], HIGH);  // all segments off
}

void setRGB(int r, int g, int b) {
  digitalWrite(PIN_R, r);
  digitalWrite(PIN_G, g);
  digitalWrite(PIN_B, b);
}

uint8_t randomHL() {
  return random(2) ? LOW : HIGH;
}

void setRandomRGB() {
  setRGB(randomHL(), randomHL(), randomHL());
}
