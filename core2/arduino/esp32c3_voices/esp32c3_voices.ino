// ── device identity ───────────────────────────────────────────────────────────
#define DEVICE_TYPE "voice"
#define SCRIPT_NAME "esp32C3_voices"
#define CAPS_PUBLISHES "[\"audio_playing\",\"muted\"]"
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"SET\",\"AUDIO_UPDATE\",\"AUDIO_PLAY\",\"MUTE\"]"

const char* ZONE = "fitofonias";

#include "../device_base.h"

// MAX98357A
#define LRC  1
#define BLCK 0
#define DIN  3

// Config común. NAN = todavía no SETeado por MQTT.
char name[64] = "";

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

char audioFile[64] = "";

#include "organismo_config.h"
#include "organismo_audio.h"
#include "organismo_comportamiento.h"


// ============================================================
// COMANDOS MQTT
// ============================================================

void onCommand(const char* cmd, JsonObject params) {

    if (strcmp(cmd, "SET") == 0) {

        TipoVoz anterior = vozActual;

        handleSetCommand(params);

        identificarVoz();

        // Cambió el tipo: cortar lo que sonaba y arrancar el comportamiento
        // nuevo desde cero (NONE queda en silencio).
        if (vozActual != anterior) {
            audioBehaviorStop();
            iniciarOrganismo();
        }
    }

    else if (strcmp(cmd, "AUDIO_UPDATE") == 0) {

        handleAudioUpdate(params);
    }

    // Reproduce el WAV una vez, tal cual (ver handleAudioPlay en
    // organismo_audio.h). El organismo sigue activo y retoma al terminar.
    else if (strcmp(cmd, "AUDIO_PLAY") == 0) {

        handleAudioPlay();
    }

    // {"muted": true|false} — sin parámetro, alterna.
    else if (strcmp(cmd, "MUTE") == 0) {

        bool m = params["muted"].is<bool>()
            ? params["muted"].as<bool>()
            : !organismoMuted;

        setMuted(m);

        lastTelemetryPub = 0;  // publicar el nuevo estado ya, sin esperar 1 s
    }
}


void onConnected() {

    publishConfig();
}


// Lista de tipos de voz para el dropdown de VoicePage (llega a node.meta.voices).
const char* announceExtraFields() {

    return "\"voices\":" VOCES_JSON;
}


// ============================================================
// SETUP
// ============================================================

void setup() {

    Serial.begin(115200);

    delay(1200);

    Serial.println();
    Serial.println();
    Serial.println("================================");
    Serial.println("ORGANISMO CUIR 001");
    Serial.println("================================");
    Serial.println();


    // --------------------------------------------------------
    // Configuración local
    // --------------------------------------------------------

    setupNetwork();

setupConfig();

setupAudio();

loadConfig();

    // Nodo sin tipo guardado: arranca como NONE (en silencio) hasta que se
    // elija un tipo con SET {"name": ...}. No se guarda en flash.
    if (!name[0]) {
        strncpy(name, "NONE", sizeof(name) - 1);
        name[sizeof(name) - 1] = '\0';
    }

publishConfig();  // la conexión de setupNetwork() ocurrió antes de loadConfig()


    identificarVoz();


    randomSeed(
        (uint32_t)ESP.getEfuseMac() ^
        micros()
    );


    Serial.print("VOZ: ");
    Serial.println(name);

    Serial.print("AUDIO: ");
    Serial.println(audioFile);

    // --------------------------------------------------------
    // Arranque automático. Si la voz es VOZSEMILLA,
    // iniciarOrganismo() calibra el sensor de cobre (no tocar).
    // NONE arranca en silencio.
    // --------------------------------------------------------

    iniciarOrganismo();
}


// ============================================================
// LOOP
// ============================================================

void loop() {

    // MQTT: sin esto el dispositivo no recibe SET / AUDIO_PLAY / MUTE /
    // AUDIO_UPDATE / UPDATE y el brain lo ve offline.
    tickNetwork();
    tickCommands();

    // Mantener reproducción WAV activa.
    tickAudio();

    // Aquí organismo_comportamiento.h:
    //
    // 1. lee GPIO7/GPIO4
    // 2. calcula territorio.tacto
    // 3. modifica volumen
    // 4. modifica altura/rate de VOZSEMILLA
    //
    actualizarVoz();

    JsonDocument doc;
    doc["chip_temp"] = temperatureRead();
    doc["audio_playing"] = audioBehaviorIsPlaying();
    doc["muted"] = organismoMuted;
    publishTelemetry(doc);  // limitado internamente a 1 por segundo

    delay(1);
}