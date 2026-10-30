// ── device identity ───────────────────────────────────────────────────────────
#define DEVICE_TYPE "voice"
#define SCRIPT_NAME "esp32C3_voices"
#define CAPS_PUBLISHES "[\"audio_playing\",\"organism_active\",\"voice_name\"]"
#define CAPS_SUBSCRIBES "[\"IDENTIFY\",\"ALTER\",\"UPDATE\",\"SET\",\"AUDIO_UPDATE\",\"AUDIO_PLAY\"]"

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

        handleSetCommand(params);

        identificarVoz();
    }

    else if (strcmp(cmd, "AUDIO_UPDATE") == 0) {

        handleAudioUpdate(params);
    }

    else if (strcmp(cmd, "AUDIO_PLAY") == 0) {

        if (!estado.organismoActivo) {

            iniciarOrganismo();

        } else {

            detenerOrganismo();
        }
    }
}


void onConnected() {

    publishConfig();
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
    Serial.println("PRUEBA LOCAL VOZSEMILLA + COBRE");
    Serial.println("================================");
    Serial.println();


    // --------------------------------------------------------
    // Configuración local
    // --------------------------------------------------------

    setupNetwork();

setupConfig();

setupAudio();

loadConfig();


    // --------------------------------------------------------
    // LittleFS
    //
    // El WAV ya fue cargado manualmente como /audio.wav.
    // Si no existe metadato audioFile, creamos uno local.
    // --------------------------------------------------------

    if (
        !audioFile[0] &&
        LittleFS.exists(AUDIO_PATH)
    ) {

        strncpy(
            audioFile,
            "vozsemilla_local.wav",
            sizeof(audioFile) - 1
        );

        audioFile[
            sizeof(audioFile) - 1
        ] = '\0';

        Serial.println(
            "PRUEBA LOCAL: /audio.wav encontrado"
        );
    }


    // --------------------------------------------------------
    // Para esta prueba física queremos VOZSEMILLA.
    //
    // Si NVS ya contiene VOZSEMILLA, simplemente se conserva.
    // --------------------------------------------------------

    if (!name[0]) {

        strncpy(
            name,
            "VOZSEMILLA",
            sizeof(name) - 1
        );

        name[
            sizeof(name) - 1
        ] = '\0';

        Serial.println(
            "PRUEBA LOCAL: usando VOZSEMILLA"
        );
    }


    identificarVoz();


    randomSeed(
        (uint32_t)ESP.getEfuseMac() ^
        micros()
    );


    Serial.print("VOZ: ");
    Serial.println(name);

    Serial.print("AUDIO: ");
    Serial.println(audioFile);

    Serial.println();
    Serial.println(
        "NO TOCAR EL COBRE DURANTE LA CALIBRACION"
    );
    Serial.println();


    // --------------------------------------------------------
    // Arranque automático.
    //
    // iniciarOrganismo() detectará VOZSEMILLA y calibrará
    // el sensor de cobre definido en organismo_comportamiento.h
    // --------------------------------------------------------

    iniciarOrganismo();


    Serial.println();
    Serial.println(
        "LISTO — ahora podes tocar el cobre"
    );
    Serial.println();
}


// ============================================================
// LOOP
// ============================================================

void loop() {

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

    delay(1);
}