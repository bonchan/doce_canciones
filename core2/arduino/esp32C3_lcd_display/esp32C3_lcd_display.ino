// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "display.lcd"
// human-readable name for this sketch
#define SCRIPT_NAME "esp32C3_lcd_display"
// what this device reports in telemetry, e.g. "[\"light_level\"]"
#define CAPS_PUBLISHES "[]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"TEXT\",\"CLEAR\",\"BACKLIGHT\"]"

const char* ZONE = "entrance";

#include "../device_base.h"

#include <Wire.h>                          // must come before hd44780_I2Cexp.h
#include <hd44780.h>                     // library "hd44780" by Bill Perry
#include <hd44780ioClass/hd44780_I2Cexp.h>

// 20x4 LCD on a PCF8574 I2C adapter. Adapter VCC = 3.3 V, LCD pin 2 (VDD) = 5 V.
// Not GPIO 8 (status LED) or 9 (BOOT button) — both are strapping pins.
#define LCD_SDA 6
#define LCD_SCL 7
#define LCD_COLS 20
#define LCD_ROWS 4
hd44780_I2Cexp lcd;  // finds the adapter's I2C address by itself (0x27 / 0x3F)
bool lcdOk = false;

// what the display should show; redrawn only when dirty
char screen[LCD_ROWS][LCD_COLS + 1];
bool screenDirty = true;
bool backlightOn = true;

// ── MQTT commands (installation/<zone>/<chip_id>/cmd/<CAP>) ─────────────
// TEXT       {"lines":["row 0","row 1","row 2","row 3"]}  sets rows in order, clears the rest
//            {"row":2,"text":"hola"}                      sets one row, leaves the others
//            {"text":"line 0\nline 1"}                    splits on \n, clears the rest
// CLEAR      {}
// BACKLIGHT  {"on":false}

#define DEG ((char)223)  // ° in the LCD's character ROM

// UTF-8 → LCD ROM (A00): accents dropped, ñ / ü / ° kept, anything else '?'
void toLcdChars(const char* in, char* out, size_t outSize) {
  size_t n = 0;
  const uint8_t* p = (const uint8_t*)in;
  while (*p && n < outSize - 1) {
    uint8_t c = *p++;
    if (c < 0x80) { out[n++] = c; continue; }
    if (c == 0xC3 && *p) {
      uint8_t d = *p++;
      const char* from = "\xA1\xA9\xAD\xB3\xBA\x81\x89\x8D\x93\x9A\x91";  // áéíóúÁÉÍÓÚÑ
      const char* to   = "aeiouAEIOUN";
      const char* hit  = strchr(from, d);
      if (hit)            out[n++] = to[hit - from];
      else if (d == 0xB1) out[n++] = (char)0xEE;  // ñ
      else if (d == 0xBC) out[n++] = (char)0xF5;  // ü
      else                out[n++] = '?';
      continue;
    }
    if (c == 0xC2 && *p == 0xB0) { p++; out[n++] = DEG; continue; }
    // skip the continuation bytes of any other multi-byte char
    while ((*p & 0xC0) == 0x80) p++;
    out[n++] = '?';
  }
  out[n] = '\0';
}

void setRow(uint8_t row, const char* text) {
  if (row >= LCD_ROWS) return;
  char conv[64];
  toLcdChars(text ? text : "", conv, sizeof(conv));
  snprintf(screen[row], sizeof(screen[row]), "%-20s", conv);
  screenDirty = true;
}

void clearScreen() {
  for (uint8_t r = 0; r < LCD_ROWS; r++) setRow(r, "");
}

// overwrite a whole row (padded to 20 chars) instead of lcd.clear(), which flickers
void lcdLine(uint8_t row, const char* text) {
  char line[LCD_COLS + 1];
  snprintf(line, sizeof(line), "%-20s", text);
  lcd.setCursor(0, row);
  lcd.print(line);
}

// ALTER (alteredActive, from device_base.h): blink the whole display on/off
void tickAlterBlink() {
  static bool blinkOff = false;
  bool off = alteredActive && (millis() / 50) % 2;
  if (off == blinkOff) return;
  blinkOff = off;
  if (off) { lcd.noBacklight(); lcd.noDisplay(); }
  else     { if (backlightOn) lcd.backlight(); lcd.display(); }
}

// IDENTIFY (ledActive, from device_base.h): show chip id + device type
void showIdentity() {
  lcdLine(0, chipIDStr);
  lcdLine(1, DEVICE_TYPE);
  lcdLine(2, ZONE);
  lcdLine(3, WiFi.localIP().toString().c_str());
}

void updateDisplay() {
  if (!lcdOk) return;
  tickAlterBlink();

  // identity overlay while IDENTIFY runs, then back to the stored text
  static bool showingIdentity = false;
  if (ledActive != showingIdentity) {
    showingIdentity = ledActive;
    if (showingIdentity) showIdentity();
    else screenDirty = true;
  }
  if (showingIdentity || !screenDirty) return;

  for (uint8_t r = 0; r < LCD_ROWS; r++) lcdLine(r, screen[r]);
  screenDirty = false;
}

void onCommand(const char* cmd, JsonObject params) {
  if (strcmp(cmd, "TEXT") == 0) {
    if (params["lines"].is<JsonArray>()) {
      JsonArray lines = params["lines"];
      for (uint8_t r = 0; r < LCD_ROWS; r++) {
        setRow(r, r < lines.size() ? (lines[r] | "") : "");
      }
    } else if (params["row"].is<int>()) {
      setRow(params["row"].as<int>(), params["text"] | "");
    } else {
      // split "text" on \n, one line per row
      const char* text = params["text"] | "";
      for (uint8_t r = 0; r < LCD_ROWS; r++) {
        const char* nl = strchr(text, '\n');
        char line[64];
        size_t len = nl ? (size_t)(nl - text) : strlen(text);
        if (len >= sizeof(line)) len = sizeof(line) - 1;
        memcpy(line, text, len);
        line[len] = '\0';
        setRow(r, line);
        text = nl ? nl + 1 : text + strlen(text);
      }
    }
  } else if (strcmp(cmd, "CLEAR") == 0) {
    clearScreen();
  } else if (strcmp(cmd, "BACKLIGHT") == 0) {
    backlightOn = params["on"] | true;
    if (lcdOk) {
      if (backlightOn) lcd.backlight(); else lcd.noBacklight();
    }
  }
}

void setup() {
  // LCD first, so it shows something while wifi/MQTT connect (can take seconds)
  Wire.begin(LCD_SDA, LCD_SCL);
  int lcdStatus = lcd.begin(LCD_COLS, LCD_ROWS);
  lcdOk = (lcdStatus == 0);
  // this panel maps rows 2/3 like a 16-col display (0x10/0x50), not the usual
  // 20x4 0x14/0x54 — with the default, rows 2 and 3 start 4 chars in
  lcd.setRowOffsets(0x00, 0x40, 0x10, 0x50);
  clearScreen();
  setRow(1, "Conectando...");
  updateDisplay();

  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce

  if (!lcdOk) {
    Serial.print("LCD not found, hd44780 status "); Serial.println(lcdStatus);
  }

  clearScreen();
  setRow(0, chipIDStr);
  setRow(1, wifiConnected ? WiFi.localIP().toString().c_str() : "sin wifi");
  setRow(2, "Esperando texto...");
  setRow(3, "12345");
}

void loop() {
  tickNetwork();
  tickCommands();

  JsonDocument doc;
  doc["chip_temp"] = temperatureRead();
  publishTelemetry(doc);

  updateDisplay();

  delay(1);
}
