// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "unknown"
// human-readable name for this sketch
#define SCRIPT_NAME "esp32C3_module"
// what this device reports in telemetry, e.g. "[\"light_level\"]"
#define CAPS_PUBLISHES "[\"light_level\"]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\"]"

const char* ZONE = "entrance";

#include "../device_base.h"

// optional: override onCommand for capabilities beyond the defaults
// (IDENTIFY / ALTER / UPDATE are already handled in device_base.h)
// void onCommand(const char* cmd, JsonObject params) {
//     if (strcmp(cmd, "MY_CAPABILITY") == 0) {
//         // your logic
//     }
// }

void setup() {
  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce
}

void loop() {
  tickNetwork();
  tickCommands();

  // TODO: read your actual sensors and publish real telemetry, matching
  // whatever you listed in CAPS_PUBLISHES above.
  JsonDocument doc;
  doc["light_level"] = 123;
  doc["chip_temp"] = temperatureRead();
  publishTelemetry(doc);

  delay(1);
}
