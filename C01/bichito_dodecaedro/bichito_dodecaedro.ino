#include <FastLED.h>
constexpr const char* SCRIPT_NAME = "bichito_dodecaedro";
#include "../../core/arduino/node_wifi.h"


int ALTER_FREQ = 1400;


#define NUM_LEDS 5
#define LED_TYPE PL9823
#define COLOR_ORDER GRB

#define LDR_PIN 2
#define SPEAKER_PIN 3
#define DATA_PIN 4

#define LIGHT_THRESHOLD 800

CRGB leds[NUM_LEDS];

uint8_t hue = 0;

void setup() {
  setupNetwork();

  FastLED.addLeds<LED_TYPE, DATA_PIN, COLOR_ORDER>(leds, NUM_LEDS);
  FastLED.setBrightness(0);
  pinMode(LDR_PIN, INPUT);
}

void loop() {
  tickNetwork();
  tickCommands();

  int lightValue = analogRead(LDR_PIN);

  if (lightValue < LIGHT_THRESHOLD) {
    FastLED.setBrightness(0);
  }

  int freq = random(-20, 20) + map(lightValue, 0, 4095, 2000, 20);

  int brightness = map(lightValue, 0, 4095, 255, 25);

  if (alteredActive) {
    if ((millis() / 60) % 2) {
      fill_solid(leds, NUM_LEDS, CRGB::Red);
    } else {
      fill_solid(leds, NUM_LEDS, CRGB::Black);
    }
    freq = random(-20, -1) + ALTER_FREQ;
  } else {
    hue = hue % 256;
    fill_rainbow(leds, NUM_LEDS, hue, 50);
  }

  // play the pitch:
  if (freq > 100) {
    tone(SPEAKER_PIN, freq, 20);
    int hueSpeed = map(lightValue, 0, 4095, 20, 1);
    hue += hueSpeed;
  } else {
    noTone(SPEAKER_PIN);
    hue += 1;
    brightness = 15;
    delay(5);
  }




  FastLED.setBrightness(brightness);
  FastLED.show();

  JsonDocument doc;
  doc["ldr1"] = 4095 - lightValue;
  doc["ldr2"] = 0;
  doc["freq"] = freq;

  publishTelemetry(doc);

  if (freq > ALTER_FREQ) {
    publishAlter();
  }

  delay(1);
}
