#define FASTLED_RMT_MAX_CHANNELS 1
#define FASTLED_ESP32_DRIVER RMT
#include <driver/i2s.h>
#include <math.h>
#include "../../core/arduino/node_wifi.h"

#define LDR_PIN_1 2
#define LDR_PIN_2 4
#define DATA_PIN 10
#define I2S_BCLK 0
#define I2S_LRC 1
#define I2S_DOUT 3

#define NUM_LEDS 7
const uint8_t ledPins[NUM_LEDS] = {
  5, 6, 7, 9, 10, 20, 21
};

#define SAMPLE_RATE 22050
#define AMPLITUDE 3000
#define TABLE_SIZE 256

// --- Reverb config ---
#define REVERB_LEN 2048
#define REVERB_FB 0.4f
#define REVERB_MIX 0.25f

#define LIGHT_THRESHOLD 800

// Two oscillator phases
static float phase1 = 0.0f;  // main tone oscillator (LDR1 = pitch)
static float phase2 = 0.0f;  // chopper oscillator  (LDR2 = chop rate)

static float currentHz1 = 200.0f;
static float currentHz2 = 4.0f;  // chop rate in Hz, will go much higher

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

void setup() {
  setupNetwork();
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

  int lightValue1 = analogRead(LDR_PIN_1);  // pitch
  int lightValue2 = analogRead(LDR_PIN_2);  // chop rate

  // LDR1 → pitch: 40Hz–800Hz, portamento smoothed
  float targetHz1 = map(4095 - lightValue1, 0, 4095, 40, 800);
  currentHz1 += (targetHz1 - currentHz1) * 0.04f;

  // LDR2 → chop rate: 2Hz–200Hz — low = slow gate, high = buzzy ring-mod feel
  float targetHz2 = map(4095 - lightValue2, 0, 4095, 2, 200);
  currentHz2 += (targetHz2 - currentHz2) * 0.08f;  // chop responds faster

  float phaseInc1 = currentHz1 * TABLE_SIZE / (float)SAMPLE_RATE;
  float phaseInc2 = currentHz2 * TABLE_SIZE / (float)SAMPLE_RATE;

  const int BUF = 64;
  int16_t buf[BUF];

  for (int i = 0; i < BUF; i++) {
    // Oscillator 1: square wave (pulse) for that APC harshness
    int16_t osc1 = (phase1 < TABLE_SIZE / 2) ? AMPLITUDE : -AMPLITUDE;

    // Oscillator 2: chops osc1 — also square, acts as a gate/divider
    int16_t gate = (phase2 < TABLE_SIZE / 2) ? 1 : 0;

    int16_t sample = applyReverb(osc1 * gate);

    buf[i] = sample;

    phase1 += phaseInc1;
    if (phase1 >= TABLE_SIZE) phase1 -= TABLE_SIZE;

    phase2 += phaseInc2;
    if (phase2 >= TABLE_SIZE) phase2 -= TABLE_SIZE;
  }

  size_t written;
  i2s_write(I2S_NUM_0, buf, sizeof(buf), &written, portMAX_DELAY);

  int brightness = map(lightValue1, 0, 4095, 255, 25);

  int16_t peak = 0;
  for (int i = 0; i < BUF; i++) {
    int16_t s = abs(buf[i]);
    if (s > peak) peak = s;
  }

  int ledsOn = map(peak, 0, AMPLITUDE, 0, NUM_LEDS);
  ledsOn = constrain(ledsOn, 0, NUM_LEDS);

  for (int i = 0; i < NUM_LEDS; i++) {
    digitalWrite(ledPins[i], i < ledsOn ? HIGH : LOW);
  }

  yield();
  publishState(4095 - lightValue1, brightness, currentHz2);
  delay(1);
}