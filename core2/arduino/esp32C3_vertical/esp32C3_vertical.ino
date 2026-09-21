#define FASTLED_RMT_MAX_CHANNELS 1
#define FASTLED_ESP32_DRIVER RMT
#include <driver/i2s.h>
#include <math.h>

// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "unknown"
// human-readable name for this sketch
#define SCRIPT_NAME "bichito_vertical"
// what this device reports in telemetry, e.g. "[\"light_level\"]"
#define CAPS_PUBLISHES "[\"light_level1\",\"light_level2\",\"light_max\"]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\"]"

const char* ZONE = "entrance";

#include "../device_base.h"


int ALTER_FREQ = 1900000;

const bool sound = true;

#define LDR_PIN_1 2
#define LDR_PIN_2 4
#define I2S_BCLK 0
#define I2S_LRC 1
#define I2S_DOUT 3

#define NUM_LEDS 7
const uint8_t ledPins[NUM_LEDS] = {
  5, 6, 7, 9, 10, 20, 21
};

#define SAMPLE_RATE 22050
#define AMPLITUDE 6000
#define TABLE_SIZE 256  // must stay a power of two

// --- Reverb config ---
#define REVERB_LEN 2048
#define REVERB_FB 0.4f
#define REVERB_MIX 0.25f

#define LIGHT_THRESHOLD 800

// --- harmonic oscillator bank (1st..6th harmonic, ~1/n amplitudes) ---
#define NUM_HARMONICS 6
static float phases[NUM_HARMONICS] = { 0 };  // position inside sineTable
static const float harmAmp[NUM_HARMONICS] = {
  1.0f, 0.50f, 0.33f, 0.25f, 0.20f, 0.16f
};

static float sineTable[TABLE_SIZE];

// A-minor pentatonic, ~3 octaves — the pitch can only land on these
static const float SCALE[] = {
  110.00f, 130.81f, 146.83f, 164.81f, 196.00f,
  220.00f, 261.63f, 293.66f, 329.63f, 392.00f,
  440.00f, 523.25f, 587.33f, 659.25f, 783.99f, 880.00f
};
#define SCALE_LEN (sizeof(SCALE) / sizeof(SCALE[0]))

static float currentHz = 110.0f;  // glided, never jumped
static float currentAmp = 0.0f;

#define AUDIO_BLOCK 128
static int16_t audioBuf[AUDIO_BLOCK];

static int16_t reverbBuf[REVERB_LEN] = { 0 };
static int reverbIdx = 0;

void setupI2S() {
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 64,
    .use_apll = false,
    .tx_desc_auto_clear = true,
  };
  i2s_pin_config_t pins = {
    .bck_io_num = I2S_BCLK,
    .ws_io_num = I2S_LRC,
    .data_out_num = I2S_DOUT,
    .data_in_num = I2S_PIN_NO_CHANGE,
  };
  i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pins);
}

inline int16_t applyReverb(int16_t in) {
  int16_t delayed = reverbBuf[reverbIdx];
  int16_t wet = (int16_t)(in + delayed * REVERB_FB);
  reverbBuf[reverbIdx] = wet;
  reverbIdx = (reverbIdx + 1) % REVERB_LEN;
  return (int16_t)(in * (1.0f - REVERB_MIX) + delayed * REVERB_MIX);
}

// interpolated wavetable oscillator — cheap enough to run 6 of them
inline float tableOsc(float& ph, float hz) {
  float inc = hz * TABLE_SIZE / (float)SAMPLE_RATE;
  int i0 = (int)ph;
  float frac = ph - i0;
  int i1 = (i0 + 1) & (TABLE_SIZE - 1);
  float s = sineTable[i0 & (TABLE_SIZE - 1)] * (1.0f - frac) + sineTable[i1] * frac;
  ph += inc;
  while (ph >= TABLE_SIZE) ph -= TABLE_SIZE;
  return s;
}

void renderAudio(float targetHz, float targetAmp) {
  size_t written;
  for (int i = 0; i < AUDIO_BLOCK; i++) {
    // one-pole glide: no clicks when jumping between scale notes
    currentHz += (targetHz - currentHz) * 0.0015f;
    currentAmp += (targetAmp - currentAmp) * 0.0020f;

    float s = 0.0f, norm = 0.0f;
    for (int h = 0; h < NUM_HARMONICS; h++) {
      float f = currentHz * (h + 1);
      if (f > SAMPLE_RATE * 0.45f) break;  // anti-alias guard
      s += harmAmp[h] * tableOsc(phases[h], f);
      norm += harmAmp[h];
    }
    if (norm > 0.0f) s /= norm;

    int16_t sample = (int16_t)(s * AMPLITUDE * currentAmp);
    audioBuf[i] = applyReverb(sample);
  }
  i2s_write(I2S_NUM_0, audioBuf, sizeof(audioBuf), &written, portMAX_DELAY);
}

// optional: override onCommand for capabilities beyond the defaults
// (IDENTIFY / ALTER / UPDATE are already handled in device_base.h)
// void onCommand(const char* cmd, JsonObject params) {
//     if (strcmp(cmd, "MY_CAPABILITY") == 0) {
//         // your logic
//     }
// }

void setup() {
  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce

  for (int i = 0; i < TABLE_SIZE; i++)
    sineTable[i] = sinf(2.0f * (float)M_PI * i / TABLE_SIZE);

  setupI2S();
  pinMode(LDR_PIN_1, INPUT);
  pinMode(LDR_PIN_2, INPUT);

  for (int i = 0; i < NUM_LEDS; i++) {
    pinMode(ledPins[i], OUTPUT);
    digitalWrite(ledPins[i], LOW);
  }
}

void loop() {
  tickNetwork();
  tickCommands();

  if (!wifiConnected || !mqttConnected) {
    digitalWrite(LED_PIN, (millis() / 500) % 2);
  }

  int lightValue1 = analogRead(LDR_PIN_1);
  int lightValue2 = analogRead(LDR_PIN_2);

  lightValue1 = map(lightValue1, 2200, 3600, 0, 4095);
  lightValue2 = map(lightValue2, 50, 4095, 0, 4095);

  lightValue1 = constrain(lightValue1, 0, 4095);
  lightValue2 = constrain(lightValue2, 0, 4095);

  // the MAX of the two sensors drives the voice: more light -> louder + higher
  int light = max(lightValue1, lightValue2);

  float amp = 0.0f;
  float hz = currentHz;

  if (light > LIGHT_THRESHOLD) {
    float t = (float)(light - LIGHT_THRESHOLD) / (4095.0f - LIGHT_THRESHOLD);
    t = constrain(t, 0.0f, 1.0f);
    amp = t * t;                              // louder with more light
    int idx = (int)(t * (SCALE_LEN - 1) + 0.5f);
    hz = SCALE[idx];                          // quantized -> always in key
  }

  if (sound) renderAudio(hz, amp);

  // LED bar as a level meter for the same value
  int lit = (int)(amp * NUM_LEDS + 0.5f);
  for (int i = 0; i < NUM_LEDS; i++)
    digitalWrite(ledPins[i], i < lit ? HIGH : LOW);

  // telemetry throttled — the loop now runs at audio-block rate (~170 Hz)
  static uint32_t lastPub = 0;
  if (millis() - lastPub > 200) {
    lastPub = millis();
    JsonDocument doc;
    doc["light_level1"] = lightValue1;
    doc["light_level2"] = lightValue2;
    doc["light_max"] = light;
    doc["chip_temp"] = temperatureRead();
    publishTelemetry(doc);
  }
}