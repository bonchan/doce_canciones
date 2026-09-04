// ── device identity — fill these in before flashing ────────────────────
// e.g. "sensor.ldr", "actuator.speaker"
#define DEVICE_TYPE "voice"
// human-readable name for this sketch
#define SCRIPT_NAME "esp32C3_module"
// what this device reports in telemetry, e.g. "[\"light_level\"]"
#define CAPS_PUBLISHES "[\"audio_playing\",\"audio_position_ms\",\"audio_duration_ms\"]"
// + any custom capabilities you add below
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"SET\",\"AUDIO_UPDATE\",\"AUDIO_PLAY\"]"

const char* ZONE = "bichos";

#include "../device_base.h"

// vert
#define LRC 1
#define BLCK 0
#define DIN 3

// // module
// #define LRC 2
// #define BLCK 1
// #define DIN 4

// config (module parameters) — all start unset until a SET command
// configures this device's behavior: NAN for the floats below, "" for the
// two strings (name, audioFile) — same "unset" idea either way, not
// published and (per-field) not acted on until set. Load/publish/SET +
// persistence across reboots live in organismo_config.h, included below
// (organismo-only, not part of the shared device_base.h).
char name[64] = "";  // this organism's own display name — settable via SET, same as any other config field

float volume = NAN;
float initialPresence = NAN;
float entrance = NAN;
float irregularity = NAN;
float restMovement = NAN;
float latentVolume = NAN;
float duration = NAN;
float expansion = NAN;
float contact = NAN;
float airMovement = NAN;
float presence = NAN;
float aperture = NAN;
float meeting = NAN;
float answer = NAN;
float doubt = NAN;
float appearance = NAN;

// Original uploaded audio filename, e.g. "birdsong.wav" — set by
// organismo_audio.h's AUDIO_UPDATE handler. Purely bookkeeping: the ESP32
// itself always plays whatever's at AUDIO_PATH (see organismo_audio.h),
// this is just so a human looking at the config knows which file that is.
// Distinct from `name` above (this device's own display name).
char audioFile[64] = "";

#include "organismo_config.h"
#include "organismo_audio.h"

// "SET" is this sketch's own capability (beyond IDENTIFY/ALTER/UPDATE,
// which device_base.h always handles) — route it to organismo_config.h.
void onCommand(const char* cmd, JsonObject params) {
    if (strcmp(cmd, "SET") == 0) {
        handleSetCommand(params);
    } else if (strcmp(cmd, "AUDIO_UPDATE") == 0) {
        handleAudioUpdate(params);
    } else if (strcmp(cmd, "AUDIO_PLAY") == 0) {
        handleAudioPlay();
    }
}

// Fires after every successful (re)connect (device_base.h's weak hook) —
// republishes our retained config too, same as it already does for
// announce/status, so it comes back even if the broker itself restarted.
void onConnected() {
    publishConfig();
}

void setup() {
  setupNetwork();  // Serial + wifi + MQTT connect, LWT, retained status/announce
  setupConfig();   // opens NVS flash + builds the config topic
  setupAudio();    // mounts LittleFS + builds the audio-ack topic + restores audioFile
  loadConfig();    // restore any previously-SET values (else stay NAN)
  publishConfig(); // push the restored config now — setupNetwork()'s own
                   // connect already happened before loadConfig() ran
}

void loop() {
  tickNetwork();
  tickCommands();
  tickAudio();  // pumps AUDIO_PLAY playback, if any is in progress

  JsonDocument doc;
  doc["chip_temp"] = temperatureRead();
  // doc["ip"] = WiFi.localIP().toString();

  doc["audio_playing"] = (wavGen != nullptr && wavGen->isRunning());
//   doc["audio_duration_ms"] = audioDurationMs;
//   doc["audio_position_ms"] = audioPositionMs();

  publishTelemetry(doc);

  delay(1);
}
