// ── device identity ─────────────────────────────────────────────────────
#define DEVICE_TYPE "time_interval"
#define SCRIPT_NAME "esp32C3_time_interval"
#define CAPS_PUBLISHES "[\"digits\",\"running\"]"
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"INTERVALS\",\"RATE\",\"PAUSE\",\"RESUME\",\"RESET\"]"

const char* ZONE = "47";

#include "../device_base.h"
#include <Preferences.h>
#include <esp_timer.h>

// ── what it does ────────────────────────────────────────────────────────
// Three 7-segment digits, each counting 0..9 and wrapping on its own clock.
// Every digit has its own step interval (ms per number); the leftmost is the
// fastest by default. A global rate multiplies all three at once, so the
// whole thing can be sped up or slowed down without changing the ratios.
//
// ── wiring (ESP32-C3 SuperMini, no driver chip, multiplexed) ────────────
// The 7 segment lines (a..g) are shared by the three digits; each digit's
// common pin goes to its own GPIO. Only one digit is lit at a time, switching
// every 2 ms, fast enough to look steady. Decimal point is not used.
//
//   segment a b c d e f g  ->  GPIO 0 1 3 4 5 6 7   (each through a resistor)
//   digit   left mid right ->  GPIO 10 20 21        (the common pin, direct)
//
//        a
//      f   b
//        g
//      e   c
//        d
//
// GPIO 2, 8 and 9 are avoided: they're boot strapping pins (8 is also the
// status LED, 9 the BOOT button). GPIO 20/21 are UART0, so build with
// "USB CDC On Boot: Enabled" (Serial over USB) or the display will fight
// the serial port.
//
// Current: a digit's common pin carries the current of every lit segment
// (up to 7 for an "8"). A C3 pin shouldn't go much past ~20 mA, so with no
// transistors use >= 470 ohm per segment (~3 mA each, ~20 mA on the common).
// If that's too dim, put a transistor on each common pin (NPN for common
// cathode, PNP for common anode) and drop the resistors to ~150 ohm; the
// digit's "on" level may then flip, see DIGIT_ON below.
const bool COMMON_ANODE = false;  // true if the digits share the + side

const int NUM_DIGITS = 3;
const int SEG_PINS[7] = {0, 1, 3, 4, 5, 6, 7};      // a b c d e f g
const int DIGIT_PINS[NUM_DIGITS] = {10, 20, 21};    // left, middle, right

const int SEG_ON    = COMMON_ANODE ? LOW : HIGH;
const int SEG_OFF   = COMMON_ANODE ? HIGH : LOW;
const int DIGIT_ON  = COMMON_ANODE ? HIGH : LOW;
const int DIGIT_OFF = COMMON_ANODE ? LOW : HIGH;

// bit 0 = a ... bit 6 = g
const uint8_t SEGMENTS[10] = {
  0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F,
};
const uint8_t ALL_SEGMENTS = 0x7F;

const uint32_t REFRESH_US = 2000;  // time each digit stays lit

// ── counting state ──────────────────────────────────────────────────────
// Shared between loop() (commands) and the display timer, guarded by countMux.
const uint32_t MIN_MS = 10;
const uint32_t MAX_MS = 600000;  // 10 minutes per step
const float MIN_RATE = 0.05;
const float MAX_RATE = 20.0;

uint32_t intervalMs[NUM_DIGITS] = {100, 1000, 10000};
float rate = 1.0;
bool running = true;

uint8_t digits[NUM_DIGITS] = {0, 0, 0};
float phaseMs[NUM_DIGITS] = {0, 0, 0};  // progress towards the next step
int64_t lastTickUs = 0;
int litDigit = 0;

portMUX_TYPE countMux = portMUX_INITIALIZER_UNLOCKED;
esp_timer_handle_t displayTimer;

Preferences prefs;

// ── display + counting, every REFRESH_US ────────────────────────────────
// Runs on the esp_timer task, not in loop(): device_base.h's network retry
// blocks loop() for seconds while wifi is down, and the display (and the
// count) must keep going through that.
void onDisplayTick(void*) {
  int64_t now = esp_timer_get_time();
  float dt = (now - lastTickUs) / 1000.0f;
  lastTickUs = now;

  uint8_t shown[NUM_DIGITS];
  portENTER_CRITICAL(&countMux);
  if (running) {
    for (int i = 0; i < NUM_DIGITS; i++) {
      phaseMs[i] += dt * rate;
      float iv = intervalMs[i];
      if (phaseMs[i] >= iv) {
        uint32_t steps = (uint32_t)(phaseMs[i] / iv);
        phaseMs[i] -= steps * iv;
        digits[i] = (digits[i] + steps) % 10;
      }
    }
  }
  memcpy(shown, digits, sizeof(shown));
  portEXIT_CRITICAL(&countMux);

  // IDENTIFY (handled in device_base.h) also lights every segment, so the
  // device can be found even with the status LED hidden inside a box.
  digitalWrite(DIGIT_PINS[litDigit], DIGIT_OFF);  // off first: no ghosting
  litDigit = (litDigit + 1) % NUM_DIGITS;
  uint8_t pattern = ledActive ? ALL_SEGMENTS : SEGMENTS[shown[litDigit]];
  for (int s = 0; s < 7; s++) {
    digitalWrite(SEG_PINS[s], (pattern >> s) & 1 ? SEG_ON : SEG_OFF);
  }
  digitalWrite(DIGIT_PINS[litDigit], DIGIT_ON);
}

void setupDisplay() {
  for (int s = 0; s < 7; s++) {
    pinMode(SEG_PINS[s], OUTPUT);
    digitalWrite(SEG_PINS[s], SEG_OFF);
  }
  for (int d = 0; d < NUM_DIGITS; d++) {
    pinMode(DIGIT_PINS[d], OUTPUT);
    digitalWrite(DIGIT_PINS[d], DIGIT_OFF);
  }

  lastTickUs = esp_timer_get_time();
  esp_timer_create_args_t args = {};
  args.callback = onDisplayTick;
  args.name = "display";
  esp_timer_create(&args, &displayTimer);
  esp_timer_start_periodic(displayTimer, REFRESH_US);
}

// ── changing the count ──────────────────────────────────────────────────
// A new interval keeps the digit's progress as a fraction, so going from
// 10 s to 0.1 s halfway through a step doesn't make it jump 50 numbers.
void setInterval(int i, uint32_t ms) {
  ms = constrain(ms, MIN_MS, MAX_MS);
  portENTER_CRITICAL(&countMux);
  phaseMs[i] = phaseMs[i] / intervalMs[i] * ms;
  intervalMs[i] = ms;
  portEXIT_CRITICAL(&countMux);
}

void setRate(float r) {
  portENTER_CRITICAL(&countMux);
  rate = constrain(r, MIN_RATE, MAX_RATE);
  portEXIT_CRITICAL(&countMux);
}

void setRunning(bool on) {
  portENTER_CRITICAL(&countMux);
  running = on;
  portEXIT_CRITICAL(&countMux);
}

void resetCount() {
  portENTER_CRITICAL(&countMux);
  for (int i = 0; i < NUM_DIGITS; i++) {
    digits[i] = 0;
    phaseMs[i] = 0;
  }
  portEXIT_CRITICAL(&countMux);
}

// ── persistence ─────────────────────────────────────────────────────────
// Intervals and rate survive a reboot; the count itself and pause don't.
void loadSettings() {
  prefs.begin("interval", false);
  if (prefs.getBytesLength("ms") == sizeof(intervalMs)) {
    uint32_t ms[NUM_DIGITS];
    prefs.getBytes("ms", ms, sizeof(ms));
    for (int i = 0; i < NUM_DIGITS; i++) intervalMs[i] = constrain(ms[i], MIN_MS, MAX_MS);
  }
  rate = constrain(prefs.getFloat("rate", rate), MIN_RATE, MAX_RATE);
}

void saveSettings() {
  prefs.putBytes("ms", intervalMs, sizeof(intervalMs));
  prefs.putFloat("rate", rate);
}

// ── config topic (retained) ─────────────────────────────────────────────
// installation/<zone>/<chip>/config — shows up as node.config on the page.
//   {"ms":[100,1000,10000], "rate":1.0, "running":true}
void publishConfig() {
  if (!mqttClient.connected()) return;

  JsonDocument doc;
  JsonArray ms = doc["ms"].to<JsonArray>();
  for (int i = 0; i < NUM_DIGITS; i++) ms.add(intervalMs[i]);
  doc["rate"] = rate;
  doc["running"] = running;

  char buf[128];
  size_t n = serializeJson(doc, buf, sizeof(buf));

  char topic[96];
  snprintf(topic, sizeof(topic), "%.*sconfig", (int)(strlen(topicStatus) - strlen("status")), topicStatus);
  mqttClient.publish(topic, (const uint8_t*)buf, n, true);  // retained
}

// device_base.h calls this after every (re)connect
void onConnected() {
  publishConfig();
}

// ── commands (MQTT) ─────────────────────────────────────────────────────
//   INTERVALS {"ms":[left, middle, right]}  ms per step, 10..600000. A null
//             (or missing) entry leaves that digit alone. Saved.
//   RATE      {"value":1.0}  0.05..20, multiplies every digit's speed. Saved.
//   PAUSE {}  RESUME {}  RESET {} (all digits back to 0)
void onCommand(const char* cmd, JsonObject params) {
  if (strcmp(cmd, "INTERVALS") == 0) {
    JsonArray ms = params["ms"].as<JsonArray>();
    if (ms.isNull()) return;
    int i = 0;
    for (JsonVariant v : ms) {
      if (i >= NUM_DIGITS) break;
      if (v.is<float>()) setInterval(i, (uint32_t)v.as<float>());
      i++;
    }
    saveSettings();
    publishConfig();
  } else if (strcmp(cmd, "RATE") == 0) {
    setRate(params["value"] | 1.0f);
    saveSettings();
    publishConfig();
  } else if (strcmp(cmd, "PAUSE") == 0) {
    setRunning(false);
    publishConfig();
  } else if (strcmp(cmd, "RESUME") == 0) {
    setRunning(true);
    publishConfig();
  } else if (strcmp(cmd, "RESET") == 0) {
    resetCount();
  }
}

// ── commands (Serial, newline terminated) — for testing on the bench ────
//   ms <left> <middle> <right> | rate x | pause | resume | reset | show
char serialLine[64];
int serialLen = 0;

void handleSerialLine(char* line) {
  unsigned long a, b, c;
  if (sscanf(line, "ms %lu %lu %lu", &a, &b, &c) == 3) {
    setInterval(0, a); setInterval(1, b); setInterval(2, c);
    saveSettings(); publishConfig();
  }
  else if (strncmp(line, "rate ", 5) == 0) { setRate(atof(line + 5)); saveSettings(); publishConfig(); }
  else if (strcmp(line, "pause") == 0)     { setRunning(false); publishConfig(); }
  else if (strcmp(line, "resume") == 0)    { setRunning(true); publishConfig(); }
  else if (strcmp(line, "reset") == 0)     resetCount();
  else if (strcmp(line, "show") == 0) {
    Serial.printf("ms %lu %lu %lu  rate %.2f  %s  showing %d%d%d\n",
                  (unsigned long)intervalMs[0], (unsigned long)intervalMs[1], (unsigned long)intervalMs[2],
                  rate, running ? "running" : "paused", digits[0], digits[1], digits[2]);
  }
  else Serial.println("? use: ms <l> <m> <r> | rate x | pause | resume | reset | show");
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
  loadSettings();  // before the display starts counting and before the first config publish
  setupDisplay();  // counting from the moment it powers up, wifi or not
  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce/config
}

void loop() {
  tickNetwork();
  tickCommands();
  tickSerial();

  char shown[NUM_DIGITS + 1];
  portENTER_CRITICAL(&countMux);
  for (int i = 0; i < NUM_DIGITS; i++) shown[i] = '0' + digits[i];
  bool on = running;
  portEXIT_CRITICAL(&countMux);
  shown[NUM_DIGITS] = '\0';

  JsonDocument doc;
  doc["digits"] = shown;  // left to right, e.g. "407"
  doc["running"] = on ? 1 : 0;
  publishTelemetry(doc);

  delay(1);
}
