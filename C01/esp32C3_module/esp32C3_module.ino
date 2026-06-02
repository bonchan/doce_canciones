#include "../../core/arduino/node_wifi.h"


void setup() {
  setupNetwork();
}

void loop() {
  tickNetwork();
  publishState(0, 0, 0);
}
