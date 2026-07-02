constexpr const char* SCRIPT_NAME = "esp32C3_module";
#include "../../core/arduino/node_wifi.h"


// optional: override onCommand for custom behavior
// void onCommand(const char* cmd, JsonObject params) {
//     if (strcmp(cmd, "IDENTIFY") == 0) {
//         digitalWrite(LED_PIN, LED_ON);
//         delay(params["duration"] | 2000);
//         digitalWrite(LED_PIN, LED_OFF);
//     }
//     else if (strcmp(cmd, "GO_SILENT") == 0) {
//         // your logic
//     }
// }

void setup() {
  Serial.begin(115200);
  setupNetwork();
}

void loop() {
  tickNetwork();
  tickCommands();

  JsonDocument doc;
  doc["ldr1"] = 1;  //analogRead(A0);
  doc["ldr2"] = 2;  //analogRead(A1);
  doc["freq"] = 0;  // your value

  publishTelemetry(doc);

  delay(1);
}