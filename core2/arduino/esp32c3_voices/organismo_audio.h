#ifndef ORGANISMO_AUDIO_H
#define ORGANISMO_AUDIO_H

#include <LittleFS.h>
#include <HTTPClient.h>
#include <AudioFileSourceLittleFS.h>
#include <AudioGeneratorWAV.h>
#include <AudioOutputI2S.h>
#include <AudioOutputMixer.h>

#define AUDIO_PATH "/audio.wav"

// Los WAV de nodo que venimos usando están preparados a 44.1 kHz.
// Cambiar este valor si más adelante el pipeline genera otra frecuencia.
#ifndef AUDIO_BASE_SAMPLE_RATE
#define AUDIO_BASE_SAMPLE_RATE 44100
#endif

char topicAudioAck[80];

static AudioOutputI2S *i2sOut = nullptr;

// Mezclador A/B para VOZSEMILLA.
// Dos reproducciones del mismo WAV pueden solaparse al cerrar el ciclo.
static AudioOutputMixer *audioMixer = nullptr;
static AudioOutputMixerStub *mixA = nullptr;
static AudioOutputMixerStub *mixB = nullptr;

static AudioFileSourceLittleFS *wavSource = nullptr;
static AudioGeneratorWAV *wavGen = nullptr;

static AudioFileSourceLittleFS *wavSourceB = nullptr;
static AudioGeneratorWAV *wavGenB = nullptr;

static bool vozSemillaAEsPrincipal = true;
static bool vozSemillaCrossfade = false;

// 1.5 s de solapamiento para PCM mono 16-bit / 44.1 kHz.
// Se calcula por bytes restantes del archivo; el encabezado WAV es despreciable.
static const uint32_t VOZSEMILLA_CROSSFADE_BYTES = 132300UL;

static float behaviorGain = 0.0f;
static float behaviorRate = 1.0f;
static bool audioFinishedEvent = false;

// true mientras suena un AUDIO_PLAY directo: el WAV completo, una vez,
// sin comportamiento encima. El comportamiento se pausa hasta que termina.
static bool audioDirectPlaying = false;

// Aplica la altura actual al reloj I2S. Se llama también después de cada
// begin() del WAV, porque arrancar un archivo puede resetear el rate al del
// archivo (44.1 kHz) y perder el cambio de altura pedido antes de empezar.
static void aplicarRateI2S() {
    if (i2sOut) i2sOut->SetRate((int)(AUDIO_BASE_SAMPLE_RATE * behaviorRate));
}

static void audioDestroyPlayback() {
    audioDirectPlaying = false;

    if (wavGen) {
        if (wavGen->isRunning()) wavGen->stop();
        delete wavGen;
        wavGen = nullptr;
    }
    if (wavSource) {
        delete wavSource;
        wavSource = nullptr;
    }

    if (wavGenB) {
        if (wavGenB->isRunning()) wavGenB->stop();
        delete wavGenB;
        wavGenB = nullptr;
    }
    if (wavSourceB) {
        delete wavSourceB;
        wavSourceB = nullptr;
    }

    if (mixA) {
        delete mixA;
        mixA = nullptr;
    }
    if (mixB) {
        delete mixB;
        mixB = nullptr;
    }

    vozSemillaAEsPrincipal = true;
    vozSemillaCrossfade = false;
}

void setupAudio() {
    if (!LittleFS.begin(false)) {
        Serial.println("LittleFS mount failed — formatting...");
        if (LittleFS.format() && LittleFS.begin(false)) {
            Serial.println("LittleFS formatted and mounted OK");
        } else {
            Serial.println("WARNING: LittleFS format/mount failed — audio download will not work. "
                           "Check Tools > Partition Scheme reserves a SPIFFS/LittleFS region.");
        }
    }
    Serial.printf("LittleFS: %u/%u bytes used\n", (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes());

    snprintf(topicAudioAck, sizeof(topicAudioAck), "installation/%s/%s/audio_ack", ZONE, chipIDStr);

    String stored = configPrefs.getString("audioFile", "");
    stored.toCharArray(audioFile, sizeof(audioFile));

    i2sOut = new AudioOutputI2S();
    i2sOut->SetPinout(BLCK, LRC, DIN);
    i2sOut->SetGain(1.0f);

    // El mixer recibe dos streams y entrega una única salida al MAX98357A.
    audioMixer = new AudioOutputMixer(256, i2sOut);
}

void handleAudioUpdate(JsonObject params) {
    const char* url = params["url"] | "";
    const char* filename = params["filename"] | "audio";
    if (strlen(url) == 0) {
        Serial.println("AUDIO_UPDATE: no url");
        return;
    }

    Serial.print("Audio download from: "); Serial.println(url);

    HTTPClient http;
    http.begin(url);
    int code = http.GET();
    if (code != HTTP_CODE_OK) {
        Serial.printf("AUDIO_UPDATE failed: HTTP %d\n", code);
        http.end();
        return;
    }

    int contentLength = http.getSize();
    if (contentLength > 0 && (size_t)contentLength + 4096 > LittleFS.totalBytes()) {
        Serial.printf("AUDIO_UPDATE: file is %d bytes but LittleFS is only %u bytes total.\n",
                      contentLength, (unsigned)LittleFS.totalBytes());
        http.end();
        return;
    }

    // No sobrescribir un audio que está sonando.
    audioDestroyPlayback();

    File f = LittleFS.open(AUDIO_PATH, "w");
    if (!f) {
        Serial.println("AUDIO_UPDATE: failed to open " AUDIO_PATH " for writing");
        http.end();
        return;
    }

    WiFiClient* stream = http.getStreamPtr();
    uint8_t buf[512];
    size_t written = 0;
    int remaining = contentLength;
    bool outOfSpace = false;
    while (http.connected() && (remaining > 0 || remaining == -1)) {
        size_t avail = stream->available();
        if (avail == 0) { delay(1); continue; }
        int n = stream->readBytes(buf, avail > sizeof(buf) ? sizeof(buf) : avail);
        if (n <= 0) break;
        size_t w = f.write(buf, n);
        written += w;
        if (remaining > 0) remaining -= n;
        if (w != (size_t)n) { outOfSpace = true; break; }
    }
    f.close();
    http.end();

    if (outOfSpace) {
        LittleFS.remove(AUDIO_PATH);
        Serial.printf("AUDIO_UPDATE: ran out of space after %u bytes — partial file removed.\n", (unsigned)written);
        return;
    }

    Serial.printf("Audio saved: %u bytes -> %s\n", (unsigned)written, AUDIO_PATH);

    strncpy(audioFile, filename, sizeof(audioFile) - 1);
    audioFile[sizeof(audioFile) - 1] = '\0';
    configPrefs.putString("audioFile", audioFile);
    publishConfig();

    if (mqttConnected) {
        char ackBuf[96];
        snprintf(ackBuf, sizeof(ackBuf), "{\"filename\":\"%s\"}", audioFile);
        mqttClient.publish(topicAudioAck, ackBuf);
    }
}

// -----------------------------------------------------------------------------
// API interna para organismo_comportamiento.h
// -----------------------------------------------------------------------------
void audioBehaviorSetGain(float gain) {
    behaviorGain = gain < 0.0f ? 0.0f : (gain > 1.0f ? 1.0f : gain);

    if (audioDirectPlaying || strcmp(name, "VOZSEMILLA") != 0) {
        if (mixA) mixA->SetGain(behaviorGain);
    } else if (!vozSemillaCrossfade) {
        if (vozSemillaAEsPrincipal) {
            if (mixA) mixA->SetGain(behaviorGain);
            if (mixB) mixB->SetGain(0.0f);
        } else {
            if (mixB) mixB->SetGain(behaviorGain);
            if (mixA) mixA->SetGain(0.0f);
        }
    }
}
bool audioBehaviorIsPlaying() {
    bool a = wavGen != nullptr && wavGen->isRunning();
    bool b = wavGenB != nullptr && wavGenB->isRunning();
    return a || b;
}
void audioBehaviorStop() {
    audioDestroyPlayback();
    audioBehaviorSetGain(0.0f);
}
void audioBehaviorSetRateMultiplier(float multiplier) {

    float nuevoRate =
        multiplier < 0.50f ? 0.50f :
        (multiplier > 2.50f ? 2.50f : multiplier);

    // No reconfigurar si la altura no cambió realmente.
    if (fabsf(nuevoRate - behaviorRate) < 0.0005f) {
        return;
    }

    behaviorRate = nuevoRate;

    // Se aplica siempre (también antes de arrancar el WAV) y se vuelve a
    // aplicar después de cada begin() — ver aplicarRateI2S().
    aplicarRateI2S();
}

bool audioBehaviorStartFromBeginning() {
    if (!audioFile[0] || !LittleFS.exists(AUDIO_PATH)) {
        Serial.println("AUDIO: no audio uploaded yet");
        return false;
    }

    audioDestroyPlayback();
    audioFinishedEvent = false;

    mixA = audioMixer->NewInput();
    if (!mixA) {
        Serial.println("AUDIO: mixer input A unavailable");
        return false;
    }

    mixA->SetGain(behaviorGain);
    mixA->SetRate(AUDIO_BASE_SAMPLE_RATE);

    wavSource = new AudioFileSourceLittleFS(AUDIO_PATH);
    wavGen = new AudioGeneratorWAV();

    if (!wavGen->begin(wavSource, mixA)) {
        Serial.println("AUDIO: failed to start playback");
        audioDestroyPlayback();
        return false;
    }

    aplicarRateI2S();

    vozSemillaAEsPrincipal = true;
    vozSemillaCrossfade = false;
    return true;
}
// La librería usada no expone de forma portable duración/posición WAV desde este
// wrapper. Por ahora devuelve 1; LLAMA/RESOPLA conservan el fade-in y el WAV
// termina naturalmente. El punto queda aislado para mejorarlo después.
float audioBehaviorEndFadeFactor(float seconds) {
    (void)seconds;
    return 1.0f;
}

bool audioBehaviorConsumeFinishedEvent() {
    bool e = audioFinishedEvent;
    audioFinishedEvent = false;
    return e;
}

// AUDIO_PLAY: reproduce el WAV completo una vez, tal cual — altura normal, a
// `volume` (o AUDIO_PLAY_DEFAULT_GAIN si no está seteado, para no saturar).
// No respeta MUTE ni el comportamiento: el comportamiento queda en pausa
// mientras suena y retoma solo cuando termina. Un segundo AUDIO_PLAY
// reinicia desde el principio.
#define AUDIO_PLAY_DEFAULT_GAIN 0.4f

void handleAudioPlay() {
    float gain = isnan(volume) ? AUDIO_PLAY_DEFAULT_GAIN : volume;
    audioBehaviorSetGain(gain);
    audioBehaviorSetRateMultiplier(1.0f);
    if (!audioBehaviorStartFromBeginning()) return;
    audioDirectPlaying = true;
    Serial.printf("AUDIO_PLAY directo: %s at gain %.3f\n", AUDIO_PATH, gain);
}

void tickAudio() {

    // --------------------------------------------------------
    // VOZSEMILLA: loop A/B con crossfade real
    // --------------------------------------------------------
    if (!audioDirectPlaying && strcmp(name, "VOZSEMILLA") == 0) {

        AudioFileSourceLittleFS *principalSource =
            vozSemillaAEsPrincipal ? wavSource : wavSourceB;

        AudioGeneratorWAV *principalGen =
            vozSemillaAEsPrincipal ? wavGen : wavGenB;

        AudioOutputMixerStub *principalMix =
            vozSemillaAEsPrincipal ? mixA : mixB;

        AudioOutputMixerStub *entranteMix =
            vozSemillaAEsPrincipal ? mixB : mixA;

        if (principalGen && principalGen->isRunning()) {
            principalGen->loop();
        }

        if (vozSemillaCrossfade) {
            AudioGeneratorWAV *entranteGen =
                vozSemillaAEsPrincipal ? wavGenB : wavGen;

            if (entranteGen && entranteGen->isRunning()) {
                entranteGen->loop();
            }
        }

        if (audioMixer) audioMixer->loop();

        if (principalSource && principalGen && principalGen->isRunning()) {

            uint32_t size = principalSource->getSize();
            uint32_t pos  = principalSource->getPos();
            uint32_t restantes = size > pos ? size - pos : 0;

            // Arrancar la segunda copia antes de que termine la primera.
            if (!vozSemillaCrossfade &&
                restantes <= VOZSEMILLA_CROSSFADE_BYTES) {

                if (vozSemillaAEsPrincipal) {
                    mixB = audioMixer->NewInput();
                    if (mixB) {
                        mixB->SetGain(0.0f);
                        mixB->SetRate(AUDIO_BASE_SAMPLE_RATE);
                        wavSourceB = new AudioFileSourceLittleFS(AUDIO_PATH);
                        wavGenB = new AudioGeneratorWAV();

                        if (wavGenB->begin(wavSourceB, mixB)) {
                            vozSemillaCrossfade = true;
                            aplicarRateI2S();
                        }
                    }
                } else {
                    mixA = audioMixer->NewInput();
                    if (mixA) {
                        mixA->SetGain(0.0f);
                        mixA->SetRate(AUDIO_BASE_SAMPLE_RATE);
                        wavSource = new AudioFileSourceLittleFS(AUDIO_PATH);
                        wavGen = new AudioGeneratorWAV();

                        if (wavGen->begin(wavSource, mixA)) {
                            vozSemillaCrossfade = true;
                            aplicarRateI2S();
                        }
                    }
                }
            }

            // Durante el solapamiento: uno baja y el otro sube.
            if (vozSemillaCrossfade) {
                float x =
                    1.0f -
                    ((float)restantes /
                     (float)VOZSEMILLA_CROSSFADE_BYTES);

                if (x < 0.0f) x = 0.0f;
                if (x > 1.0f) x = 1.0f;

                // Curva lineal inicial. Luego podemos afinarla si hace falta.
                if (principalMix) principalMix->SetGain(behaviorGain * (1.0f - x));
                if (entranteMix) entranteMix->SetGain(behaviorGain * x);
            }
        }

        // Cuando termina la principal, la entrante pasa a ser principal.
        if (principalGen && !principalGen->isRunning()) {

            if (vozSemillaCrossfade) {

                if (vozSemillaAEsPrincipal) {
                    delete wavGen;
                    wavGen = nullptr;
                    delete wavSource;
                    wavSource = nullptr;
                    delete mixA;
                    mixA = nullptr;

                    if (mixB) mixB->SetGain(behaviorGain);

                } else {
                    delete wavGenB;
                    wavGenB = nullptr;
                    delete wavSourceB;
                    wavSourceB = nullptr;
                    delete mixB;
                    mixB = nullptr;

                    if (mixA) mixA->SetGain(behaviorGain);
                }

                vozSemillaAEsPrincipal = !vozSemillaAEsPrincipal;
                vozSemillaCrossfade = false;
            }
        }

        return;
    }

    // --------------------------------------------------------
    // RESTO DE VOCES: comportamiento anterior
    // --------------------------------------------------------
    if (wavGen && wavGen->isRunning()) {
        if (!wavGen->loop()) {
            wavGen->stop();
            delete wavGen;
            wavGen = nullptr;

            delete wavSource;
            wavSource = nullptr;

            if (mixA) {
                delete mixA;
                mixA = nullptr;
            }

            audioFinishedEvent = true;
            if (audioDirectPlaying) {
                audioDirectPlaying = false;
                Serial.println("AUDIO_PLAY directo: finished — vuelve el comportamiento");
            } else {
                Serial.println("AUDIO: finished");
            }
        }
    }

    if (audioMixer) audioMixer->loop();
}

#endif
