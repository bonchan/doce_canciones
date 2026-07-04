#include "../../core/arduino/config.h"
#include <WiFi.h>
#include <WiFiUdp.h>


// Computer running TouchDesigner
IPAddress udpAddress(192,168,1,96);
const int udpPort = 7780;

WiFiUDP udp;

// =======================
// Pins
// =======================
const int windAnglePin = 3;
const int windSpeedPin = 4;

// =======================
// Calculate NMEA checksum
// =======================
String addChecksum(String sentence) {
  byte checksum = 0;

  // Skip the '$'
  for (int i = 1; i < sentence.length(); i++) {
    checksum ^= sentence[i];
  }

  char cs[3];
  sprintf(cs, "%02X", checksum);

  sentence += "*";
  sentence += cs;

  return sentence;
}

void setup() {
  Serial.begin(115200);

  pinMode(windSpeedPin, INPUT);
  pinMode(windAnglePin, INPUT);

  WiFi.begin(ssid, password);

  Serial.print("Connecting");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("Connected!");

  Serial.print("IP: ");
  Serial.println(WiFi.localIP());

  Serial.print("Subnet: ");
  Serial.println(WiFi.subnetMask());

  Serial.print("Gateway: ");
  Serial.println(WiFi.gatewayIP());

  udp.begin(udpPort);
}

void loop() {
  // Read sensors
  int speedRaw = analogRead(windSpeedPin);
  int angleRaw = analogRead(windAnglePin);

  // Convert to useful values
  // Adjust these mappings for your sensors

  float windSpeed = map(speedRaw, 0, 4095, 100, 0);  // 0-50 knots
  float windAngle = map(angleRaw, 0, 4095, 360, 0);  // 0-360°

  // Build NMEA sentence
  String sentence =
    "$WIMWV," + String(windAngle, 1) + ",R," + String(windSpeed, 1) + ",N,A";

  sentence = addChecksum(sentence);

  udp.beginPacket(udpAddress, udpPort);
  udp.print(sentence);
  udp.endPacket();

  Serial.println(sentence);

  delay(100);  // 10 Hz
}