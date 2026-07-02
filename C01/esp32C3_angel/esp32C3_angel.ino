#include "../../core/arduino/node_wifi.h"

const int ldr1Pin = 2;     // LDR 1
const int ldr2Pin = 10;    // LDR 2
const int speakerPin = 3;  // Speaker
const int ledPin = 9;  // Led

const int voltpin = 7;

const bool debugLdrSpeaker = true;
const bool sound = true;

void setup() {
  setupNetwork();

  pinMode(ldr1Pin, INPUT);
  pinMode(ldr2Pin, INPUT);
  pinMode(ledPin, OUTPUT);

  pinMode(voltpin, OUTPUT);
  digitalWrite(voltpin, HIGH);

  Serial.begin(115200);
}

void loop() {
  tickNetwork();
  tickCommands();

  int ldr1 = analogRead(ldr1Pin);
  int ldr2 = analogRead(ldr2Pin);

  int combined = (ldr1 + ldr2) / 2;

  int freq = map(combined, 0, 1023, 20, 2000);

  int disp = map(combined, 0, 1023, 1990, 9999);

  freq += random(-20, 20);


  // Play the tone
  if (freq > 100) {
    if (debugLdrSpeaker)
      Serial.print("  TONE ");
    if (sound) {
      tone(speakerPin, freq);
    }
    yield();
  } else {
    if (debugLdrSpeaker)
      Serial.print("NOTONE ");
    noTone(speakerPin);
    yield();
  }

  // TODO remove this
  Serial.print("  LDR1: ");
  Serial.print(ldr1);
  Serial.print("  LDR2: ");
  Serial.print(ldr2);
  Serial.print("  Freq: ");
  Serial.println(freq);


  JsonDocument doc;
  doc["ldr1"] = ldr1;
  doc["ldr2"] = ldr2;
  doc["freq"] = freq;

  publishTelemetry(doc);
  delay(1);
}
