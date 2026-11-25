#include <ESP8266WiFi.h>

// ---- wiring ----
const int SEG[7] = {D1, D2, D3, D4, D5, D6, D7};  // a b c d e f g (through 220 ohm)
const int COM[2] = {D0, D8};                      // left pair (1+2), right pair (3+4), common anode
const int LDR = A0;                               // 3V3 - LDR - A0 - resistor - GND

// segment bits
#define SA (1 << 0)
#define SB (1 << 1)
#define SC (1 << 2)
#define SD (1 << 3)
#define SE (1 << 4)
#define SF (1 << 5)
#define SG (1 << 6)

const uint16_t SLOT_US = 250;   // time each lit segment gets per refresh

uint8_t frame[2] = {0, 0};      // what each side shows
uint8_t level = 255;            // brightness 0..255

// ---- display refresh: only lit segments get a time slot ----
void scan() {
  for (int c = 0; c < 2; c++) {
    for (int s = 0; s < 7; s++) {
      if (!(frame[c] & (1 << s))) continue;   // skip unlit segments
      uint16_t onT = (uint32_t)SLOT_US * level / 255;
      if (onT) {
        digitalWrite(COM[c], HIGH);   // common anode: HIGH = on
        digitalWrite(SEG[s], LOW);    // LOW = segment on
        delayMicroseconds(onT);
        digitalWrite(SEG[s], HIGH);
        digitalWrite(COM[c], LOW);
      }
      delayMicroseconds(SLOT_US - onT);
    }
  }
}

// ---- LDR shadow detection (adapts to the room's light) ----
const uint32_t LDR_EVERY_MS   = 30;     // how often to read the LDR
const float    DROP           = 0.15;   // 15% darker than ambient = shadow
const int      MIN_DROP       = 8;      // minimum drop in counts (for very dark rooms)
const uint32_t ADAPT_AFTER_MS = 10000;  // shadow longer than this = lights changed, adapt

float ambient = -1;
bool shadow = false;
uint32_t shadowSince = 0;

void updateLdr() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < LDR_EVERY_MS) return;
  last = now;

  int v = analogRead(LDR);
  if (ambient < 0) ambient = v;                       // first reading

  float drop = max(ambient * DROP, (float)MIN_DROP);
  if (!shadow) {
    if (v < ambient - drop) {
      shadow = true;
      shadowSince = now;
    } else {
      ambient = ambient * 0.97 + v * 0.03;            // follow slow light changes
    }
  } else {
    if (v > ambient - drop * 0.5) {
      shadow = false;                                 // light is back
    } else if (now - shadowSince > ADAPT_AFTER_MS) {
      ambient = v;                                    // room got darker: new normal
      shadow = false;
    }
  }
}

// ---- normal mode: slow breathe on vertical segments, right side mirrored ----
const uint8_t VERT[4] = {SF | SE, SB | SC, SF | SC, SE | SB};
const uint32_t BREATH_MS = 4000;

uint8_t mirror(uint8_t m) {     // swap left/right columns: f<->b, e<->c
  uint8_t r = m & (SA | SD | SG);
  if (m & SF) r |= SB;
  if (m & SB) r |= SF;
  if (m & SE) r |= SC;
  if (m & SC) r |= SE;
  return r;
}

void breathe(uint32_t now) {
  float ph = (now % BREATH_MS) / (float)BREATH_MS;   // 0..1
  float b = (1 - cos(2 * PI * ph)) / 2;              // 0..1..0, smooth
  level = b * b * 255;                               // gamma: looks even to the eye
  uint8_t p = VERT[(now / BREATH_MS) % 4];           // next pattern each breath
  frame[0] = p;
  frame[1] = mirror(p);
}

// ---- shadow mode: fast random horizontal segments ----
const uint8_t HORIZ[3] = {SA, SG, SD};
const uint32_t SHADOW_STEP_MS = 70;

void shadowMove(uint32_t now) {
  static uint32_t last = 0;
  static int l = 0, r = 2;
  if (now - last >= SHADOW_STEP_MS) {
    last = now;
    l = (l + 1 + random(2)) % 3;    // always jump to a different one
    r = (r + 1 + random(2)) % 3;
  }
  level = 255;
  frame[0] = HORIZ[l];
  frame[1] = HORIZ[r];
}

void setup() {
  WiFi.mode(WIFI_OFF);          // remove this line when you add Wi-Fi
  for (int i = 0; i < 7; i++) { pinMode(SEG[i], OUTPUT); digitalWrite(SEG[i], HIGH); }  // segments off
  for (int i = 0; i < 2; i++) { pinMode(COM[i], OUTPUT); digitalWrite(COM[i], LOW); }   // commons off
  randomSeed(ESP.random());     // hardware random (A0 is the LDR now)
}

void loop() {
  uint32_t now = millis();
  updateLdr();
  if (shadow) shadowMove(now);
  else        breathe(now);
  scan();
}