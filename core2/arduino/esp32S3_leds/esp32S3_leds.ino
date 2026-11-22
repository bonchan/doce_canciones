// ── doce canciones · leds ────────────────────────────────────────────────
// One ESP32-S3 driving up to 16 PCA9685 boards ("modules") over I2C, 16 LEDs
// per board, 12-bit brightness per LED.
//
// Every LED has a position (x, y in -1..1, origin = centre of the camera
// image, +x right, +y up), so effects are written in space, not in wiring
// order: a sensor fires and light spreads from where it sits; two spreads
// meet and the overlap glows brighter. With nothing going on, the field
// breathes, slowly.
//
// First iteration: talks only over USB serial (esp32S3_leds.html uses Web
// Serial). NOT wired into the installation yet — no WiFi / MQTT /
// device_base.h. handleCommand() takes a line + a Print, so the same
// protocol can later ride on MQTT or a WebSocket.
//
// Cores: the LED task (render + I2C) runs on core 1; core 0 is left for WiFi
// when it comes. Board settings: "USB CDC On Boot: Enabled" when using the
// native USB port. Needs arduino-esp32 core 3.x (rgbLedWrite).
//
// ── wiring ───────────────────────────────────────────────────────────────
//   ESP32-S3 GPIO8 -> SDA of every board     GPIO9 -> SCL of every board
//   3.3V (ATX orange, or ESP 3V3 for a single board) -> VCC of every board
//   5V (ATX red) -> terminal block V+ of each board, one fused wire each
//   GND everywhere (ESP, ATX black, every board)
//   LED: long leg (anode) -> channel V+ pin, short leg (cathode) -> PWM pin
//   Board address = 0x40 + module number: solder A0..A3, leave A4/A5 open.
//   Board-to-board side headers: chain GND, VCC, SDA, SCL — NOT V+.
//
// The outputs run open-drain + inverted (MODE2 = 0x10): a lit LED is the pin
// sinking current through the board's 220 Ω, an off LED is the pin floating,
// so off really is off even though the LEDs sit on 5V and the chip on 3.3V.
//
// ── serial protocol (one command per line, replies end with OK/ERR) ──────
//   hello                          HELLO name=.. fw=.. chip=.. modules=.. ...
//   status                         STATUS mode=.. online=<hex mask> fps=.. ...
//   help                           list of commands
//   scan                           SCAN <hex addresses found on the bus>
//   modules <1..16>                how many boards are connected (saved now)
//   i2c <hz>                       I2C clock, 100000..1000000 (saved now)
//   mode live|off|solid|test       live = breathing + ripples, test = chase
//   mode solid <0..1>              everything at one level
//   calib <led>|-1|off             only that LED full on (-1 = all dark);
//                                  replies once the LEDs really changed
//   ident <module>                 blink one board for 4 s
//   params                         PARAM <name> <value> <min> <max> <help>
//   set <param> <value>            change a look parameter
//   get <param>                    PARAM line for one parameter
//   pos <led> <x> <y>              place a LED      pos <led> clear
//   posclear                       forget every LED position
//   positions                      POS <led> <x> <y> <placed 0|1> per LED
//   sensor <n> <x> <y> [pin] [low|high]   define sensor n (pin -1 = virtual)
//   sensor <n> clear
//   sensors                        SENSOR <n> <x> <y> <pin> <low|high> <down>
//   trig <n>                       one pulse from sensor n
//   hold <n> 0|1                   press / release sensor n (virtual)
//   touch <x> <y> [amp]            a ripple anywhere
//   stream on [fps] | stream off   F <hex brightness per LED>, 1..30 fps;
//                                  stops by itself after 10 s without any
//                                  command (the page polls status)
//   ping
//   save | load | factory | reboot
// Unprompted lines: BOOT, EV sensor <n> 0|1, EV module <m> online|offline,
// LOG <text>, F <frame>.
//
// Positions, sensors and parameters live in RAM until "save" (NVS flash).
// Module count and I2C clock are saved as soon as they're set.

#define SCRIPT_NAME "esp32S3_leds"
#define FW_VERSION "0.1.0"

#include <Arduino.h>
#include <Wire.h>
#include <Preferences.h>
#include <math.h>

// ── hardware ─────────────────────────────────────────────────────────────
const int PIN_SDA = 8;
const int PIN_SCL = 9;
const uint32_t SERIAL_BAUD = 921600;  // ignored on native USB, used by UART bridges
const uint32_t I2C_DEFAULT_HZ = 400000;

// Onboard RGB LED as a status light. Most S3 DevKits: GPIO48 (v1.1: 38).
#ifndef RGB_BUILTIN
#define RGB_BUILTIN 48
#endif
// RGB_BUILTIN can be an offset "virtual" pin number; this is the real GPIO.
#ifdef PIN_RGB_LED
const int STATUS_RGB_GPIO = PIN_RGB_LED;
#else
const int STATUS_RGB_GPIO = RGB_BUILTIN;
#endif
const bool USE_STATUS_RGB = true;

const int MAX_MODULES = 16;
const int LEDS_PER_MODULE = 16;
const int MAX_LEDS = MAX_MODULES * LEDS_PER_MODULE;
const int MAX_SENSORS = 16;
const int MAX_RIPPLES = 32;
const uint32_t DEBOUNCE_MS = 25;

#if CONFIG_FREERTOS_UNICORE
const int LED_CORE = 0;
#else
const int LED_CORE = 1;
#endif

// ── PCA9685 ──────────────────────────────────────────────────────────────
const uint8_t PCA_BASE_ADDR = 0x40;
const uint8_t REG_MODE1 = 0x00;
const uint8_t REG_MODE2 = 0x01;
const uint8_t REG_LED0 = 0x06;  // LED0_ON_L, then 4 bytes per channel
const uint8_t REG_ALL_OFF_H = 0xFD;
const uint8_t REG_PRESCALE = 0xFE;
const uint8_t MODE1_AI = 0x20;     // register auto-increment
const uint8_t MODE1_SLEEP = 0x10;  // oscillator off (needed to set prescale)
const uint8_t MODE2_SINK = 0x10;   // INVRT=1, OUTDRV=0: on = sink, off = float
const uint8_t PRESCALE = 3;        // 25 MHz / (4096 * 4) = 1526 Hz, the max

// ── look parameters ──────────────────────────────────────────────────────
// Everything the page shows as a slider. Order must match the enum.
struct Param {
  const char* name;
  float def, mn, mx;
  const char* help;
  float value;
};

enum {
  P_MASTER, P_LIMIT, P_GAMMA, P_FPS, P_ASPECT,
  P_IDLE, P_BREATH, P_DEPTH, P_DRIFT, P_SWAY, P_TWINKLE, P_WAKE, P_CALM,
  P_SPEED, P_WIDTH, P_LIFE, P_AMP, P_TRAIL, P_COLLIDE, P_HOLD,
  P_SOLID,
  P_COUNT
};

Param params[] = {
  { "master", 0.80f, 0.00f, 1.00f, "overall brightness" },
  { "limit", 0.45f, 0.05f, 1.00f, "max average duty, caps the power draw" },
  { "gamma", 2.20f, 1.00f, 3.00f, "brightness curve, higher = deeper darks" },
  { "fps", 50.0f, 10.0f, 60.0f, "frames per second target" },
  { "aspect", 1.00f, 0.25f, 4.00f, "camera width/height, keeps ripples round" },
  { "idle", 0.10f, 0.00f, 0.50f, "how bright the field breathes at rest" },
  { "breath", 9.00f, 2.00f, 40.0f, "seconds per breath" },
  { "depth", 0.60f, 0.00f, 1.00f, "how deep each breath goes" },
  { "drift", 0.50f, 0.00f, 1.00f, "slow drifting patches of light" },
  { "sway", 0.35f, 0.00f, 1.00f, "the breath travelling across the space" },
  { "twinkle", 0.25f, 0.00f, 3.00f, "slow fireflies per second" },
  { "wake", 0.60f, 0.00f, 2.00f, "how much activity brightens the field" },
  { "calm", 8.00f, 1.00f, 60.0f, "seconds for the field to settle again" },
  { "speed", 0.55f, 0.05f, 3.00f, "ripple speed, units per second" },
  { "width", 0.10f, 0.02f, 0.60f, "ripple ring width" },
  { "life", 4.00f, 0.50f, 15.0f, "ripple lifetime, seconds" },
  { "amp", 0.90f, 0.00f, 1.50f, "ripple brightness" },
  { "trail", 0.25f, 0.00f, 1.00f, "glow left behind the ring" },
  { "collide", 1.50f, 0.00f, 4.00f, "extra glow where ripples overlap" },
  { "hold", 0.80f, 0.15f, 5.00f, "seconds between ripples while a sensor is held" },
  { "solid", 0.30f, 0.00f, 1.00f, "level for mode solid" },
};
static_assert(sizeof(params) / sizeof(params[0]) == P_COUNT, "params[] and the enum are out of sync");

#define PV(i) (params[i].value)

// ── state ────────────────────────────────────────────────────────────────
enum : uint8_t { MODE_LIVE, MODE_OFF, MODE_SOLID, MODE_TEST, MODE_CALIB };
const char* MODE_NAMES[] = { "live", "off", "solid", "test", "calib" };

volatile uint8_t mode = MODE_LIVE;
uint8_t modeBeforeCalib = MODE_LIVE;
volatile int calibLed = -1;
volatile int identModule = -1;
volatile float identLeft = 0;  // seconds of blinking left

volatile int numModules = 1;
uint32_t i2cHz = I2C_DEFAULT_HZ;
bool dirty = false;  // something changed since the last save

// LED layout. posX/posY/placed are what the camera (or a click) said;
// lx/ly is what the effects use: the placed position, or a default grid
// (one row per board) so everything already works before calibration.
float posX[MAX_LEDS], posY[MAX_LEDS];
bool placed[MAX_LEDS];
float lx[MAX_LEDS], ly[MAX_LEDS];

struct Sensor {
  bool used;
  float x, y;
  int8_t pin;  // -1 = virtual, only triggered over serial
  bool activeLow;
};
struct SensorRt {
  bool raw, stable;
  uint32_t changedMs;
  bool virtHeld;
  bool pressed;
  float emitIn;  // seconds until the next ripple while held
};
Sensor sensors[MAX_SENSORS];
SensorRt sensorRt[MAX_SENSORS];

struct Ripple {
  bool alive;
  float x, y, age, amp;
};
Ripple ripples[MAX_RIPPLES];
int nActive = 0;  // ripples alive this frame, see stepRipples()
int activeIdx[MAX_RIPPLES];
float activeEnv[MAX_RIPPLES], activeRad[MAX_RIPPLES];

// the resting world
float excite = 0;       // 0..1, rises with every ripple, settles over `calm`
float breathPhase = 0;  // 0..1
float swayAngle = 0;    // direction the breath travels, turns very slowly
float noiseT = 0;       // time axis of the drifting patches, wraps seamlessly
float testT = 0;
float twAge[MAX_LEDS], twDur[MAX_LEDS];  // fireflies, twDur 0 = none here

// output
float level[MAX_LEDS];          // working buffer, 0..1
uint16_t duty[MAX_LEDS];        // 12-bit, what goes to the chips
volatile uint8_t preview[MAX_LEDS];  // perceived brightness for the page

struct ModuleRt {
  bool online;
  uint8_t fails;
  uint32_t retryAt;
  uint16_t sent[LEDS_PER_MODULE];  // last values written, 0xFFFF = unknown
  uint32_t errors;
};
ModuleRt mods[MAX_MODULES];
volatile uint32_t onlineMask = 0;

// requests from the command side, served by the LED task (it owns Wire)
volatile bool reqScan = false;
volatile uint32_t reqI2cHz = 0;
uint32_t scanBits[4];

volatile uint32_t framesWritten = 0;
volatile float fpsMeasured = 0;
volatile float dutyAvg = 0;

// sensor edges, set by the LED task, printed by loop()
uint32_t evPressed = 0, evReleased = 0;

// serial side
bool streamOn = false;
int streamFps = 15;
uint32_t lastCmdMs = 0, lastStreamMs = 0;

Preferences prefs;
SemaphoreHandle_t lock;

// Holds the state lock for one scope: render on one side, edits on the other.
struct Locker {
  Locker() { xSemaphoreTake(lock, portMAX_DELAY); }
  ~Locker() { xSemaphoreGive(lock); }
};

// ── small helpers ────────────────────────────────────────────────────────
static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

uint32_t rngState = 0x9e3779b9u;
static inline uint32_t rnd() {
  rngState ^= rngState << 13;
  rngState ^= rngState >> 17;
  rngState ^= rngState << 5;
  return rngState;
}
static inline float rndf() {
  return (rnd() >> 8) * (1.0f / 16777216.0f);
}

// 3D value noise. The z axis repeats every NOISE_ZP cells, so noiseT can
// wrap around forever without a visible jump.
const int NOISE_ZP = 64;
static inline float hash3(int x, int y, int z) {
  uint32_t h = (uint32_t)x * 0x8da6b343u ^ (uint32_t)y * 0xd8163841u ^ (uint32_t)z * 0xcb1ab31fu;
  h ^= h >> 15;
  h *= 0x2c1b3c6du;
  h ^= h >> 12;
  h *= 0x297a2d39u;
  h ^= h >> 15;
  return (h >> 8) * (1.0f / 16777216.0f);
}
static inline float smooth01(float t) {
  return t * t * (3.0f - 2.0f * t);
}
static inline float lerpf(float a, float b, float t) {
  return a + (b - a) * t;
}
float noise3(float x, float y, float z) {
  int xi = (int)floorf(x), yi = (int)floorf(y), zi = (int)floorf(z);
  float u = smooth01(x - xi), v = smooth01(y - yi), w = smooth01(z - zi);
  int z0 = zi & (NOISE_ZP - 1), z1 = (zi + 1) & (NOISE_ZP - 1);
  float a = lerpf(lerpf(hash3(xi, yi, z0), hash3(xi + 1, yi, z0), u),
                  lerpf(hash3(xi, yi + 1, z0), hash3(xi + 1, yi + 1, z0), u), v);
  float b = lerpf(lerpf(hash3(xi, yi, z1), hash3(xi + 1, yi, z1), u),
                  lerpf(hash3(xi, yi + 1, z1), hash3(xi + 1, yi + 1, z1), u), v);
  return lerpf(a, b, w);
}

// One breath, 0..1: inhale over 40% of the cycle, exhale over 60%, soft at
// both ends so it never "clicks" at the top or bottom.
float breathCurve(float u) {
  u -= floorf(u);
  float s = (u < 0.4f) ? u / 0.4f * 0.5f : 0.5f + (u - 0.4f) / 0.6f * 0.5f;
  return 0.5f - 0.5f * cosf(TWO_PI * s);
}

bool pinAllowed(int pin) {
  if (pin < 0 || !digitalPinIsValid(pin)) return false;
  if (pin == PIN_SDA || pin == PIN_SCL) return false;
  if (USE_STATUS_RGB && pin == STATUS_RGB_GPIO) return false;
#if CONFIG_IDF_TARGET_ESP32S3
  if (pin == 19 || pin == 20) return false;   // native USB
  if (pin >= 26 && pin <= 37) return false;   // flash / octal PSRAM
#elif CONFIG_IDF_TARGET_ESP32C3
  if (pin == 18 || pin == 19) return false;   // native USB
  if (pin >= 11 && pin <= 17) return false;   // flash
#endif
  return true;
}

// ── PCA9685 driver ───────────────────────────────────────────────────────
// Only the LED task touches Wire.
bool pcaWrite8(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool pcaRead8(uint8_t addr, uint8_t reg, uint8_t& val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr, (size_t)1, true) != 1) return false;
  val = Wire.read();
  return true;
}

// Outputs safe first (so a freshly powered board stops glowing), then the
// PWM frequency, then wake up with auto-increment on and ALLCALL off.
bool pcaInit(int m) {
  uint8_t a = PCA_BASE_ADDR + m;
  if (!pcaWrite8(a, REG_MODE2, MODE2_SINK)) return false;
  bool ok = pcaWrite8(a, REG_ALL_OFF_H, 0x10)
            && pcaWrite8(a, REG_MODE1, MODE1_AI | MODE1_SLEEP)
            && pcaWrite8(a, REG_PRESCALE, PRESCALE)
            && pcaWrite8(a, REG_MODE1, MODE1_AI);
  delayMicroseconds(600);  // oscillator start-up
  for (int c = 0; c < LEDS_PER_MODULE; c++) mods[m].sent[c] = 0xFFFF;
  return ok;
}

// One board, all 16 channels, one I2C transaction (65 bytes). Each channel
// starts its pulse at a different point of the PWM cycle so the 16 LEDs
// don't all switch on together — smoother load on the supply.
bool pcaWriteFrame(int m, const uint16_t* v) {
  uint8_t buf[LEDS_PER_MODULE * 4];
  for (int c = 0; c < LEDS_PER_MODULE; c++) {
    uint8_t* p = buf + c * 4;
    uint16_t val = v[c];
    if (val == 0) {  // full off
      p[0] = 0; p[1] = 0; p[2] = 0; p[3] = 0x10;
    } else if (val >= 4095) {  // full on, no PWM at all
      p[0] = 0; p[1] = 0x10; p[2] = 0; p[3] = 0;
    } else {
      uint16_t on = (uint16_t)(c * 256) & 0x0FFF;
      uint16_t off = (on + val) & 0x0FFF;
      p[0] = on & 0xFF; p[1] = on >> 8; p[2] = off & 0xFF; p[3] = off >> 8;
    }
  }
  Wire.beginTransmission(PCA_BASE_ADDR + m);
  Wire.write(REG_LED0);
  Wire.write(buf, sizeof(buf));
  return Wire.endTransmission() == 0;
}

void doScan() {
  memset(scanBits, 0, sizeof(scanBits));
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) scanBits[a >> 5] |= 1u << (a & 31);
  }
}

// ── layout ───────────────────────────────────────────────────────────────
// Call with the lock held.
void rebuildLayout() {
  int n = numModules;
  for (int i = 0; i < MAX_LEDS; i++) {
    if (placed[i]) {
      lx[i] = posX[i];
      ly[i] = posY[i];
      continue;
    }
    int m = i / LEDS_PER_MODULE, c = i % LEDS_PER_MODULE;
    lx[i] = -0.9f + 1.8f * c / (LEDS_PER_MODULE - 1);
    ly[i] = (n <= 1) ? 0.0f : 0.9f - 1.8f * m / (n - 1);
  }
}

// ── ripples ──────────────────────────────────────────────────────────────
// Call with the lock held. A full pool replaces the oldest ripple.
void spawnRipple(float x, float y, float amp) {
  int slot = 0;
  float oldest = -1;
  for (int k = 0; k < MAX_RIPPLES; k++) {
    if (!ripples[k].alive) {
      slot = k;
      break;
    }
    if (ripples[k].age > oldest) {
      oldest = ripples[k].age;
      slot = k;
    }
  }
  ripples[slot] = { true, x, y, 0.0f, amp };
  excite = fminf(1.0f, excite + 0.25f);
}

void stepRipples(float dt) {
  float life = PV(P_LIFE), speed = PV(P_SPEED);
  nActive = 0;
  for (int k = 0; k < MAX_RIPPLES; k++) {
    Ripple& r = ripples[k];
    if (!r.alive) continue;
    r.age += dt;
    if (r.age >= life) {
      r.alive = false;
      continue;
    }
    float f = 1.0f - r.age / life;
    activeIdx[nActive] = k;
    activeEnv[nActive] = r.amp * f * f;
    activeRad[nActive] = speed * r.age;
    nActive++;
  }
}

// ── sensors ──────────────────────────────────────────────────────────────
// Physical pins are debounced; a held sensor (or a virtual "hold") keeps
// sending a ripple every `hold` seconds. Call with the lock held.
void updateSensors(float dt, uint32_t nowMs) {
  for (int j = 0; j < MAX_SENSORS; j++) {
    Sensor& s = sensors[j];
    SensorRt& r = sensorRt[j];
    if (!s.used) {
      if (r.pressed) {
        r.pressed = false;
        __atomic_fetch_or(&evReleased, 1u << j, __ATOMIC_RELAXED);
      }
      continue;
    }
    bool phys = false;
    if (s.pin >= 0) {
      bool raw = digitalRead(s.pin) == (s.activeLow ? LOW : HIGH);
      if (raw != r.raw) {
        r.raw = raw;
        r.changedMs = nowMs;
      }
      if (nowMs - r.changedMs >= DEBOUNCE_MS) r.stable = r.raw;
      phys = r.stable;
    }
    bool down = phys || r.virtHeld;
    if (down && !r.pressed) {
      r.pressed = true;
      r.emitIn = PV(P_HOLD);
      spawnRipple(s.x, s.y, PV(P_AMP));
      __atomic_fetch_or(&evPressed, 1u << j, __ATOMIC_RELAXED);
    } else if (!down && r.pressed) {
      r.pressed = false;
      __atomic_fetch_or(&evReleased, 1u << j, __ATOMIC_RELAXED);
    } else if (down) {
      r.emitIn -= dt;
      if (r.emitIn <= 0) {
        r.emitIn += PV(P_HOLD);
        spawnRipple(s.x, s.y, PV(P_AMP) * 0.8f);
      }
    }
  }
}

void applySensorPin(int j) {
  const Sensor& s = sensors[j];
  if (s.used && s.pin >= 0) pinMode(s.pin, s.activeLow ? INPUT_PULLUP : INPUT_PULLDOWN);
}

// ── rendering ────────────────────────────────────────────────────────────
// Clocks of the resting world. They run in every mode so the breath picks
// up where it was when you come back to live.
void stepWorld(float dt) {
  excite *= expf(-dt / PV(P_CALM));
  float rate = 1.0f + 0.6f * excite;  // a stirred field breathes a bit faster
  breathPhase += dt / PV(P_BREATH) * rate;
  breathPhase -= floorf(breathPhase);
  swayAngle += dt * 0.021f;  // one full turn every ~5 minutes
  if (swayAngle > TWO_PI) swayAngle -= TWO_PI;
  noiseT += dt * 0.05f;
  if (noiseT >= NOISE_ZP) noiseT -= NOISE_ZP;
}

// live = breathing field + fireflies + ripples. Ripples add up, and where
// two or more overlap their product adds extra light (`collide`), so
// meeting fronts flare instead of just summing.
void renderLive(int n, float dt) {
  float aspect = PV(P_ASPECT);
  float idleBase = PV(P_IDLE);
  float idle = idleBase * (1.0f + PV(P_WAKE) * excite);
  float depth = PV(P_DEPTH), drift = PV(P_DRIFT), sway = PV(P_SWAY);
  float width = PV(P_WIDTH), trail = PV(P_TRAIL), collide = PV(P_COLLIDE);
  float invW = 1.0f / width, inv4W = 1.0f / (4.0f * width);
  float ca = cosf(swayAngle), sa = sinf(swayAngle);

  float rate = PV(P_TWINKLE);
  if (rate > 0 && rndf() < rate * dt) {
    int i = rnd() % n;
    if (twDur[i] <= 0) {
      twDur[i] = 2.5f + 3.5f * rndf();
      twAge[i] = 0;
    }
  }

  for (int i = 0; i < n; i++) {
    float x = lx[i], y = ly[i];

    // the breath, arriving a little earlier on one side of the room
    float along = x * aspect * ca + y * sa;
    float b = breathCurve(breathPhase - 0.25f * sway * along);
    float w = idle * (1.0f - depth * (1.0f - b));
    if (drift > 0) {
      float nz = noise3(x * aspect * 1.3f + 17.0f, y * 1.3f + 5.0f, noiseT);
      w *= 1.0f - drift + drift * (0.3f + 1.4f * nz);
    }
    if (twDur[i] > 0) {
      twAge[i] += dt;
      float s = twAge[i] / twDur[i];
      if (s >= 1.0f) {
        twDur[i] = 0;
      } else {
        float e = sinf(PI * s);
        w += idleBase * 1.4f * e * e;
      }
    }

    float sum = 0, sq = 0;
    for (int q = 0; q < nActive; q++) {
      const Ripple& r = ripples[activeIdx[q]];
      float dx = (x - r.x) * aspect, dy = y - r.y;
      float off = sqrtf(dx * dx + dy * dy) - activeRad[q];  // + ahead of the ring
      if (off > 3.0f * width) continue;
      float a = 0;
      if (off > -3.0f * width) {
        float z = off * invW;
        a = expf(-z * z);
      }
      if (off < 0 && trail > 0) a += trail * expf(off * inv4W);
      a *= activeEnv[q];
      sum += a;
      sq += a * a;
    }
    level[i] = w + sum + collide * 0.5f * (sum * sum - sq);
  }
}

// Fills level[] for the current mode. Returns true when the values must go
// out raw (calibration: full on, no master / gamma / power limit).
bool render(int n, float dt) {
  bool raw = false;
  switch (mode) {
    case MODE_OFF:
      for (int i = 0; i < n; i++) level[i] = 0;
      break;
    case MODE_SOLID:
      for (int i = 0; i < n; i++) level[i] = PV(P_SOLID);
      break;
    case MODE_TEST: {
      testT += dt;
      if (testT > 1000) testT = 0;
      int k = (int)(testT / 0.12f) % LEDS_PER_MODULE;
      for (int i = 0; i < n; i++) level[i] = (i % LEDS_PER_MODULE == k) ? 1.0f : 0.0f;
      break;
    }
    case MODE_CALIB:
      raw = true;
      for (int i = 0; i < n; i++) level[i] = (i == calibLed) ? 1.0f : 0.0f;
      break;
    default:
      renderLive(n, dt);
      break;
  }
  if (identLeft > 0) {
    identLeft -= dt;
    int m = identModule;
    if (m >= 0 && m < n / LEDS_PER_MODULE) {
      bool on = fmodf(identLeft, 0.4f) < 0.2f;
      for (int c = 0; c < LEDS_PER_MODULE; c++) level[m * LEDS_PER_MODULE + c] = on ? 1.0f : 0.02f;
    }
  }
  return raw;
}

// level[] (perceived 0..1) -> duty[] (12-bit). Gamma, master, then the
// power cap: if the average duty is above `limit`, everything is scaled
// down together so the supply never sees more than that.
void toDuty(int n, bool raw) {
  float g = PV(P_GAMMA), master = PV(P_MASTER), limit = PV(P_LIMIT);
  float sum = 0;
  for (int i = 0; i < n; i++) {
    float v = clampf(level[i], 0.0f, 1.0f);
    float p = raw ? v : v * master;
    preview[i] = (uint8_t)(p * 255.0f + 0.5f);
    float d = raw ? v : powf(p, g);
    level[i] = d;
    sum += d;
  }
  float avg = sum / n;
  float scale = (!raw && avg > limit) ? limit / avg : 1.0f;
  float pscale = (scale < 1.0f) ? powf(scale, 1.0f / g) : 1.0f;
  for (int i = 0; i < n; i++) {
    duty[i] = (uint16_t)(level[i] * scale * 4095.0f + 0.5f);
    if (pscale < 1.0f) preview[i] = (uint8_t)(preview[i] * pscale);
  }
  dutyAvg = avg * scale;
}

// ── output ───────────────────────────────────────────────────────────────
void setOffline(int m, uint32_t nowMs) {
  mods[m].online = false;
  mods[m].fails = 0;
  mods[m].retryAt = nowMs + 1000;
}

// Sends every board whose values changed (all of them when `force`).
// Missing boards are retried every second; boards beyond the configured
// count are switched off once and then left alone.
void writeModules(int n, uint32_t nowMs, bool force) {
  uint32_t mask = 0;
  for (int m = 0; m < MAX_MODULES; m++) {
    ModuleRt& M = mods[m];
    if (m >= n) {
      if (M.online) {
        pcaWrite8(PCA_BASE_ADDR + m, REG_ALL_OFF_H, 0x10);
        M.online = false;
      }
      continue;
    }
    if (!M.online) {
      if ((int32_t)(nowMs - M.retryAt) < 0) continue;
      M.retryAt = nowMs + 1000;
      if (!pcaInit(m)) continue;
      M.online = true;
      M.fails = 0;
    }
    const uint16_t* v = &duty[m * LEDS_PER_MODULE];
    bool changed = force;
    for (int c = 0; c < LEDS_PER_MODULE && !changed; c++) changed = v[c] != M.sent[c];
    if (changed) {
      if (pcaWriteFrame(m, v)) {
        memcpy(M.sent, v, sizeof(M.sent));
        M.fails = 0;
      } else {
        M.errors++;
        for (int c = 0; c < LEDS_PER_MODULE; c++) M.sent[c] = 0xFFFF;
        if (++M.fails >= 3) setOffline(m, nowMs);
      }
    }
    if (M.online) mask |= 1u << m;
  }
  onlineMask = mask;
}

// A board whose 3.3V dropped comes back with factory registers (outputs
// low = every LED on). Read MODE2 back now and then and set it up again.
void healthCheck(int m, uint32_t nowMs) {
  ModuleRt& M = mods[m];
  if (!M.online) return;
  uint8_t v;
  if (!pcaRead8(PCA_BASE_ADDR + m, REG_MODE2, v)) {
    if (++M.fails >= 3) setOffline(m, nowMs);
    return;
  }
  if (v != MODE2_SINK && !pcaInit(m)) setOffline(m, nowMs);
}

// ── LED task (core 1) ────────────────────────────────────────────────────
void ledTask(void*) {
  uint32_t prevUs = micros();
  uint32_t lastForce = 0, lastHealth = 0, fpsT = millis(), fpsN = 0;
  uint32_t healthIdx = 0;
  for (;;) {
    uint32_t frameStart = millis();
    uint32_t nowUs = micros();
    float dt = (nowUs - prevUs) * 1e-6f;
    prevUs = nowUs;
    if (dt > 0.1f) dt = 0.1f;

    if (reqI2cHz) {
      Wire.setClock(reqI2cHz);
      reqI2cHz = 0;
    }
    if (reqScan) {
      doScan();
      reqScan = false;
    }

    int n;
    {
      Locker l;
      n = numModules * LEDS_PER_MODULE;
      updateSensors(dt, frameStart);
      stepRipples(dt);
      stepWorld(dt);
      bool raw = render(n, dt);
      toDuty(n, raw);
    }

    bool force = frameStart - lastForce > 3000;  // heal any missed write
    if (force) lastForce = frameStart;
    writeModules(n / LEDS_PER_MODULE, frameStart, force);
    if (frameStart - lastHealth > 100) {  // each board checked every n × 100 ms
      lastHealth = frameStart;
      healthCheck(healthIdx++ % (n / LEDS_PER_MODULE), frameStart);
    }
    framesWritten++;

    fpsN++;
    if (frameStart - fpsT >= 1000) {
      fpsMeasured = fpsN * 1000.0f / (frameStart - fpsT);
      fpsN = 0;
      fpsT = frameStart;
    }

    uint32_t frameMs = (uint32_t)(1000.0f / PV(P_FPS));
    uint32_t spent = millis() - frameStart;
    vTaskDelay(pdMS_TO_TICKS(spent + 1 < frameMs ? frameMs - spent : 1));
  }
}

// Wait until the LED task has pushed `frames` complete frames, so a reply
// means the change is really on the LEDs.
void waitFrames(uint32_t frames, uint32_t timeoutMs) {
  uint32_t f0 = framesWritten, t0 = millis();
  while (framesWritten - f0 < frames && millis() - t0 < timeoutMs) delay(1);
}

// ── storage ──────────────────────────────────────────────────────────────
struct __attribute__((packed)) SensorSave {
  int16_t x, y;
  int8_t pin;
  uint8_t flags;  // bit0 used, bit1 active low
};
const int16_t POS_NONE = INT16_MIN;
const float POS_SCALE = 30000.0f;

void paramKey(char* key, size_t len, int p) {
  snprintf(key, len, "p_%s", params[p].name);
}

void setDefaults() {
  for (int p = 0; p < P_COUNT; p++) params[p].value = params[p].def;
  numModules = 1;
  i2cHz = I2C_DEFAULT_HZ;
  for (int i = 0; i < MAX_LEDS; i++) {
    placed[i] = false;
    posX[i] = posY[i] = 0;
    twDur[i] = 0;
  }
  for (int j = 0; j < MAX_SENSORS; j++) {
    sensors[j] = { false, 0.0f, 0.0f, -1, true };
    sensorRt[j] = SensorRt();
  }
}

void saveAll() {
  static int16_t pos[MAX_LEDS * 2];
  static SensorSave ss[MAX_SENSORS];
  float pv[P_COUNT];
  {
    Locker l;
    for (int i = 0; i < MAX_LEDS; i++) {
      pos[i * 2] = placed[i] ? (int16_t)lroundf(posX[i] * POS_SCALE) : POS_NONE;
      pos[i * 2 + 1] = placed[i] ? (int16_t)lroundf(posY[i] * POS_SCALE) : POS_NONE;
    }
    for (int j = 0; j < MAX_SENSORS; j++) {
      const Sensor& s = sensors[j];
      ss[j].x = (int16_t)lroundf(s.x * POS_SCALE);
      ss[j].y = (int16_t)lroundf(s.y * POS_SCALE);
      ss[j].pin = s.pin;
      ss[j].flags = (s.used ? 1 : 0) | (s.activeLow ? 2 : 0);
    }
    for (int p = 0; p < P_COUNT; p++) pv[p] = params[p].value;
  }
  prefs.begin("leds", false);
  prefs.putUChar("nmod", (uint8_t)numModules);
  prefs.putUInt("i2c", i2cHz);
  prefs.putBytes("pos", pos, sizeof(pos));
  prefs.putBytes("sens", ss, sizeof(ss));
  char key[16];
  for (int p = 0; p < P_COUNT; p++) {
    paramKey(key, sizeof(key), p);
    prefs.putFloat(key, pv[p]);
  }
  prefs.end();
  dirty = false;
}

void loadAll() {
  static int16_t pos[MAX_LEDS * 2];
  static SensorSave ss[MAX_SENSORS];
  Locker l;
  setDefaults();
  if (prefs.begin("leds", true)) {  // false when nothing was ever saved
    numModules = constrain(prefs.getUChar("nmod", 1), 1, MAX_MODULES);
    i2cHz = prefs.getUInt("i2c", I2C_DEFAULT_HZ);
    char key[16];
    for (int p = 0; p < P_COUNT; p++) {
      paramKey(key, sizeof(key), p);
      params[p].value = clampf(prefs.getFloat(key, params[p].def), params[p].mn, params[p].mx);
    }
    if (prefs.getBytesLength("pos") == sizeof(pos) && prefs.getBytes("pos", pos, sizeof(pos)) == sizeof(pos)) {
      for (int i = 0; i < MAX_LEDS; i++) {
        placed[i] = pos[i * 2] != POS_NONE;
        if (placed[i]) {
          posX[i] = pos[i * 2] / POS_SCALE;
          posY[i] = pos[i * 2 + 1] / POS_SCALE;
        }
      }
    }
    if (prefs.getBytesLength("sens") == sizeof(ss) && prefs.getBytes("sens", ss, sizeof(ss)) == sizeof(ss)) {
      for (int j = 0; j < MAX_SENSORS; j++) {
        sensors[j].used = ss[j].flags & 1;
        sensors[j].activeLow = ss[j].flags & 2;
        sensors[j].pin = pinAllowed(ss[j].pin) ? ss[j].pin : -1;
        sensors[j].x = ss[j].x / POS_SCALE;
        sensors[j].y = ss[j].y / POS_SCALE;
      }
    }
    prefs.end();
  }
  rebuildLayout();
  for (int j = 0; j < MAX_SENSORS; j++) applySensorPin(j);
  dirty = false;
}

void saveOne(const char* what) {
  prefs.begin("leds", false);
  if (!strcmp(what, "nmod")) prefs.putUChar("nmod", (uint8_t)numModules);
  if (!strcmp(what, "i2c")) prefs.putUInt("i2c", i2cHz);
  prefs.end();
}

// ── commands ─────────────────────────────────────────────────────────────
static bool toInt(const char* s, long& v) {
  if (!s) return false;
  char* e;
  v = strtol(s, &e, 10);
  return e != s && *e == 0;
}
static bool toFloat(const char* s, float& v) {
  if (!s) return false;
  char* e;
  v = strtof(s, &e);
  return e != s && *e == 0 && isfinite(v);
}
static int findParam(const char* name) {
  if (!name) return -1;
  for (int p = 0; p < P_COUNT; p++)
    if (!strcasecmp(name, params[p].name)) return p;
  return -1;
}
static void printParam(Print& out, int p) {
  out.printf("PARAM %s %.4f %.4f %.4f %s\n", params[p].name, params[p].value, params[p].mn, params[p].mx, params[p].help);
}
static void ok(Print& out, const char* cmd) {
  out.printf("OK %s\n", cmd);
}
static void fail(Print& out, const char* cmd, const char* why) {
  out.printf("ERR %s %s\n", cmd, why);
}

const char* HELP_TEXT =
  "hello | status | scan | modules <n> | i2c <hz>\n"
  "mode live|off|test|solid [v] | calib <led>|-1|off | ident <module>\n"
  "params | get <p> | set <p> <v>\n"
  "pos <led> <x> <y> | pos <led> clear | posclear | positions\n"
  "sensor <n> <x> <y> [pin] [low|high] | sensor <n> clear | sensors\n"
  "trig <n> | hold <n> 0|1 | touch <x> <y> [amp]\n"
  "stream on [fps] | stream off | ping | save | load | factory | reboot\n";

void handleCommand(char* line, Print& out) {
  char* sv = nullptr;
  char* cmd = strtok_r(line, " \t\r\n", &sv);
  if (!cmd) return;
  for (char* p = cmd; *p; p++) *p = tolower(*p);
  char* a1 = strtok_r(nullptr, " \t\r\n", &sv);
  char* a2 = strtok_r(nullptr, " \t\r\n", &sv);
  char* a3 = strtok_r(nullptr, " \t\r\n", &sv);
  char* a4 = strtok_r(nullptr, " \t\r\n", &sv);
  char* a5 = strtok_r(nullptr, " \t\r\n", &sv);
  int nLeds = numModules * LEDS_PER_MODULE;
  long iv;
  float fx, fy;

  if (!strcmp(cmd, "hello")) {
    out.printf("HELLO name=%s fw=%s chip=%s modules=%d maxmodules=%d per=%d leds=%d maxsensors=%d sda=%d scl=%d\n",
               SCRIPT_NAME, FW_VERSION, ESP.getChipModel(), (int)numModules, MAX_MODULES, LEDS_PER_MODULE,
               nLeds, MAX_SENSORS, PIN_SDA, PIN_SCL);
    ok(out, cmd);

  } else if (!strcmp(cmd, "status")) {
    out.printf("STATUS mode=%s modules=%d online=%lx fps=%.1f i2c=%lu duty=%.3f excite=%.2f ripples=%d calib=%d dirty=%d stream=%d uptime=%lu heap=%lu\n",
               MODE_NAMES[mode], (int)numModules, (unsigned long)onlineMask, (float)fpsMeasured,
               (unsigned long)i2cHz, (float)dutyAvg, excite, nActive, (int)calibLed, dirty ? 1 : 0,
               streamOn ? 1 : 0, (unsigned long)(millis() / 1000), (unsigned long)ESP.getFreeHeap());
    ok(out, cmd);

  } else if (!strcmp(cmd, "help")) {
    out.print(HELP_TEXT);
    ok(out, cmd);

  } else if (!strcmp(cmd, "ping")) {
    ok(out, cmd);

  } else if (!strcmp(cmd, "scan")) {
    reqScan = true;
    uint32_t t0 = millis();
    while (reqScan && millis() - t0 < 1500) delay(2);
    if (reqScan) return fail(out, cmd, "bus busy");
    out.print("SCAN");
    for (int a = 1; a < 127; a++)
      if (scanBits[a >> 5] & (1u << (a & 31))) out.printf(" %02x", a);
    out.print("\n");
    ok(out, cmd);

  } else if (!strcmp(cmd, "modules")) {
    if (!a1) {
      out.printf("MODULES %d\n", (int)numModules);
      return ok(out, cmd);
    }
    if (!toInt(a1, iv) || iv < 1 || iv > MAX_MODULES) return fail(out, cmd, "use modules 1..16");
    {
      Locker l;
      numModules = iv;
      if (calibLed >= iv * LEDS_PER_MODULE) calibLed = -1;
      rebuildLayout();
      for (int i = 0; i < MAX_LEDS; i++) twDur[i] = 0;
    }
    saveOne("nmod");
    ok(out, cmd);

  } else if (!strcmp(cmd, "i2c")) {
    if (!a1) {
      out.printf("I2C %lu\n", (unsigned long)i2cHz);
      return ok(out, cmd);
    }
    if (!toInt(a1, iv) || iv < 50000 || iv > 1000000) return fail(out, cmd, "use 50000..1000000");
    i2cHz = iv;
    reqI2cHz = iv;
    saveOne("i2c");
    ok(out, cmd);

  } else if (!strcmp(cmd, "mode")) {
    if (!a1) {
      out.printf("MODE %s\n", MODE_NAMES[mode]);
      return ok(out, cmd);
    }
    int m = -1;
    for (int k = 0; k < MODE_CALIB; k++)
      if (!strcasecmp(a1, MODE_NAMES[k])) m = k;
    if (m < 0) return fail(out, cmd, "use live|off|solid|test");
    if (m == MODE_SOLID && toFloat(a2, fx)) params[P_SOLID].value = clampf(fx, 0, 1);
    {
      Locker l;
      calibLed = -1;
      mode = m;
    }
    ok(out, cmd);

  } else if (!strcmp(cmd, "calib")) {
    if (a1 && !strcasecmp(a1, "off")) {
      {
        Locker l;
        if (mode == MODE_CALIB) mode = modeBeforeCalib;
        calibLed = -1;
      }
      waitFrames(2, 400);
      return ok(out, cmd);
    }
    if (!toInt(a1, iv) || iv < -1 || iv >= nLeds) return fail(out, cmd, "use calib <led>|-1|off");
    {
      Locker l;
      if (mode != MODE_CALIB) {
        modeBeforeCalib = mode;
        mode = MODE_CALIB;
      }
      calibLed = iv;
    }
    waitFrames(2, 400);
    ok(out, cmd);

  } else if (!strcmp(cmd, "ident")) {
    if (!toInt(a1, iv) || iv < 0 || iv >= numModules) return fail(out, cmd, "no such module");
    identModule = iv;
    identLeft = 4.0f;
    ok(out, cmd);

  } else if (!strcmp(cmd, "params")) {
    for (int p = 0; p < P_COUNT; p++) printParam(out, p);
    ok(out, cmd);

  } else if (!strcmp(cmd, "get")) {
    int p = findParam(a1);
    if (p < 0) return fail(out, cmd, "unknown param");
    printParam(out, p);
    ok(out, cmd);

  } else if (!strcmp(cmd, "set")) {
    int p = findParam(a1);
    if (p < 0 || !toFloat(a2, fx)) return fail(out, cmd, "use set <param> <value>");
    params[p].value = clampf(fx, params[p].mn, params[p].mx);
    dirty = true;
    ok(out, cmd);

  } else if (!strcmp(cmd, "pos")) {
    if (!toInt(a1, iv) || iv < 0 || iv >= MAX_LEDS) return fail(out, cmd, "use pos <led> <x> <y> | pos <led> clear");
    if (a2 && !strcasecmp(a2, "clear")) {
      Locker l;
      placed[iv] = false;
      rebuildLayout();
    } else {
      if (!toFloat(a2, fx) || !toFloat(a3, fy)) return fail(out, cmd, "use pos <led> <x> <y>");
      Locker l;
      posX[iv] = lx[iv] = clampf(fx, -1, 1);
      posY[iv] = ly[iv] = clampf(fy, -1, 1);
      placed[iv] = true;
    }
    dirty = true;
    ok(out, cmd);

  } else if (!strcmp(cmd, "posclear")) {
    {
      Locker l;
      for (int i = 0; i < MAX_LEDS; i++) placed[i] = false;
      rebuildLayout();
    }
    dirty = true;
    ok(out, cmd);

  } else if (!strcmp(cmd, "positions")) {
    for (int i = 0; i < nLeds; i++) out.printf("POS %d %.4f %.4f %d\n", i, lx[i], ly[i], placed[i] ? 1 : 0);
    ok(out, cmd);

  } else if (!strcmp(cmd, "sensor")) {
    if (!toInt(a1, iv) || iv < 0 || iv >= MAX_SENSORS) return fail(out, cmd, "use sensor <n> <x> <y> [pin] [low|high] | sensor <n> clear");
    int j = iv;
    if (a2 && !strcasecmp(a2, "clear")) {
      Locker l;
      sensors[j].used = false;
      sensorRt[j].virtHeld = false;
    } else {
      if (!toFloat(a2, fx) || !toFloat(a3, fy)) return fail(out, cmd, "use sensor <n> <x> <y> [pin] [low|high]");
      long pin = -1;
      if (a4 && !toInt(a4, pin)) return fail(out, cmd, "pin must be a number");
      if (pin >= 0 && !pinAllowed(pin)) return fail(out, cmd, "that pin can't be used");
      bool low = !(a5 && !strcasecmp(a5, "high"));
      Locker l;
      sensors[j] = { true, clampf(fx, -1, 1), clampf(fy, -1, 1), (int8_t)pin, low };
      bool held = sensorRt[j].virtHeld, wasDown = sensorRt[j].pressed;
      sensorRt[j] = SensorRt();
      sensorRt[j].virtHeld = held;
      sensorRt[j].pressed = wasDown;
      applySensorPin(j);
    }
    dirty = true;
    ok(out, cmd);

  } else if (!strcmp(cmd, "sensors")) {
    for (int j = 0; j < MAX_SENSORS; j++) {
      const Sensor& s = sensors[j];
      if (!s.used) continue;
      out.printf("SENSOR %d %.4f %.4f %d %s %d\n", j, s.x, s.y, s.pin, s.activeLow ? "low" : "high", sensorRt[j].pressed ? 1 : 0);
    }
    ok(out, cmd);

  } else if (!strcmp(cmd, "trig")) {
    if (!toInt(a1, iv) || iv < 0 || iv >= MAX_SENSORS || !sensors[iv].used) return fail(out, cmd, "no such sensor");
    {
      Locker l;
      spawnRipple(sensors[iv].x, sensors[iv].y, PV(P_AMP));
    }
    __atomic_fetch_or(&evPressed, 1u << iv, __ATOMIC_RELAXED);
    __atomic_fetch_or(&evReleased, 1u << iv, __ATOMIC_RELAXED);
    ok(out, cmd);

  } else if (!strcmp(cmd, "hold")) {
    long v;
    if (!toInt(a1, iv) || iv < 0 || iv >= MAX_SENSORS || !sensors[iv].used || !toInt(a2, v))
      return fail(out, cmd, "use hold <sensor> 0|1");
    sensorRt[iv].virtHeld = v != 0;
    ok(out, cmd);

  } else if (!strcmp(cmd, "touch")) {
    if (!toFloat(a1, fx) || !toFloat(a2, fy)) return fail(out, cmd, "use touch <x> <y> [amp]");
    float amp = PV(P_AMP), fa;
    if (toFloat(a3, fa)) amp = clampf(fa, 0, 2);
    {
      Locker l;
      spawnRipple(fx, fy, amp);
    }
    ok(out, cmd);

  } else if (!strcmp(cmd, "stream")) {
    if (a1 && !strcasecmp(a1, "on")) {
      if (toInt(a2, iv)) streamFps = constrain(iv, 1, 30);
      streamOn = true;
      lastStreamMs = 0;
    } else if (a1 && !strcasecmp(a1, "off")) {
      streamOn = false;
    } else {
      return fail(out, cmd, "use stream on [fps] | stream off");
    }
    ok(out, cmd);

  } else if (!strcmp(cmd, "save")) {
    saveAll();
    ok(out, cmd);

  } else if (!strcmp(cmd, "load")) {
    loadAll();
    reqI2cHz = i2cHz;
    ok(out, cmd);

  } else if (!strcmp(cmd, "factory")) {
    prefs.begin("leds", false);
    prefs.clear();
    prefs.end();
    {
      Locker l;
      setDefaults();
      rebuildLayout();
    }
    reqI2cHz = i2cHz;
    ok(out, cmd);

  } else if (!strcmp(cmd, "reboot")) {
    ok(out, cmd);
    Serial.flush();
    delay(100);
    ESP.restart();

  } else {
    fail(out, cmd, "unknown command, try help");
  }
}

// ── serial side (loop task) ──────────────────────────────────────────────
char lineBuf[256];
size_t lineLen = 0;
bool lineTooLong = false;

void pollSerial() {
  while (Serial.available()) {
    int ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (lineTooLong) {
        Serial.print("ERR ? line too long\n");
      } else if (lineLen) {
        lineBuf[lineLen] = 0;
        lastCmdMs = millis();
        handleCommand(lineBuf, Serial);
      }
      lineLen = 0;
      lineTooLong = false;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = (char)ch;
    } else {
      lineTooLong = true;
    }
  }
}

void pollEvents() {
  static uint32_t shownMask = 0;
  uint32_t p = __atomic_exchange_n(&evPressed, 0, __ATOMIC_RELAXED);
  uint32_t r = __atomic_exchange_n(&evReleased, 0, __ATOMIC_RELAXED);
  for (int j = 0; j < MAX_SENSORS; j++)
    if (p & (1u << j)) Serial.printf("EV sensor %d 1\n", j);
  for (int j = 0; j < MAX_SENSORS; j++)
    if (r & (1u << j)) Serial.printf("EV sensor %d 0\n", j);
  uint32_t om = onlineMask;
  if (om != shownMask) {
    for (int m = 0; m < MAX_MODULES; m++) {
      uint32_t b = 1u << m;
      if ((om ^ shownMask) & b) Serial.printf("EV module %d %s\n", m, (om & b) ? "online" : "offline");
    }
    shownMask = om;
  }
}

// F <2 hex chars per LED>: what each LED looks like right now (perceived
// brightness, before gamma), so the page can draw a live mirror.
void pollStream() {
  if (!streamOn) return;
  uint32_t now = millis();
  if (now - lastCmdMs > 10000) {
    streamOn = false;
    Serial.print("LOG stream stopped: no command for 10 s\n");
    return;
  }
  if (now - lastStreamMs < 1000u / streamFps) return;
  lastStreamMs = now;
  static char buf[2 + MAX_LEDS * 2 + 1];
  static const char HEX_DIGITS[] = "0123456789abcdef";
  int n = numModules * LEDS_PER_MODULE;
  buf[0] = 'F';
  buf[1] = ' ';
  for (int i = 0; i < n; i++) {
    uint8_t v = preview[i];
    buf[2 + i * 2] = HEX_DIGITS[v >> 4];
    buf[3 + i * 2] = HEX_DIGITS[v & 15];
  }
  buf[2 + n * 2] = '\n';
  Serial.write((const uint8_t*)buf, 3 + n * 2);
}

// Onboard RGB, breathing softly: green = every board answers, amber = some
// missing, red = none, blue = calibrating.
void pollStatusLed() {
  if (!USE_STATUS_RGB) return;
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < 40) return;
  last = now;
  float b = 0.25f + 0.75f * breathCurve(now / 6000.0f);
  int n = numModules;
  uint32_t want = (n >= 32) ? 0xFFFFFFFFu : ((1u << n) - 1);
  uint32_t on = onlineMask & want;
  uint8_t r, g, bl;
  if (mode == MODE_CALIB) { r = 0; g = 4; bl = 24; }
  else if (on == want) { r = 0; g = 14; bl = 2; }
  else if (on) { r = 18; g = 8; bl = 0; }
  else { r = 20; g = 0; bl = 0; }
  rgbLedWrite(RGB_BUILTIN, (uint8_t)(r * b), (uint8_t)(g * b), (uint8_t)(bl * b));
}

void setup() {
  Serial.begin(SERIAL_BAUD);

  // Boards wake up with their outputs pulled low, which lights every LED.
  // Before anything else, tell whatever is on the bus to let go.
  Wire.begin(PIN_SDA, PIN_SCL, I2C_DEFAULT_HZ);
  Wire.setTimeOut(20);
  for (int m = 0; m < MAX_MODULES; m++) pcaWrite8(PCA_BASE_ADDR + m, REG_MODE2, MODE2_SINK);

  rngState = esp_random() | 1;
  lock = xSemaphoreCreateMutex();
  loadAll();
  if (i2cHz != I2C_DEFAULT_HZ) Wire.setClock(i2cHz);
  for (int m = 0; m < MAX_MODULES; m++) {
    mods[m] = ModuleRt();
    for (int c = 0; c < LEDS_PER_MODULE; c++) mods[m].sent[c] = 0xFFFF;
  }

  xTaskCreatePinnedToCore(ledTask, "leds", 8192, nullptr, 3, nullptr, LED_CORE);
  Serial.printf("BOOT %s %s modules=%d\n", SCRIPT_NAME, FW_VERSION, (int)numModules);
}

void loop() {
  pollSerial();
  pollEvents();
  pollStream();
  pollStatusLed();
  delay(1);
}
