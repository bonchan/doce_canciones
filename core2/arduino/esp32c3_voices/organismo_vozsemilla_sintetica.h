#ifndef ORGANISMO_VOZSEMILLA_SINTETICA_H
#define ORGANISMO_VOZSEMILLA_SINTETICA_H

#include <Arduino.h>
#include <math.h>
#include "AudioOutputI2S.h"

// ============================================================
// VOZSEMILLA SINTETICA
// Salida I2S SIEMPRE fija a 44.1 kHz.
// No usa WAV, LittleFS ni SetRate().
// ============================================================

#ifndef AUDIO_BASE_SAMPLE_RATE
#define AUDIO_BASE_SAMPLE_RATE 44100
#endif

class VozSemillaSintetica {
public:
    bool begin(int bclk, int lrc, int din) {
        if (salida) return true;

        salida = new AudioOutputI2S();
        salida->SetPinout(bclk, lrc, din);
        salida->SetRate(AUDIO_BASE_SAMPLE_RATE);
        salida->SetChannels(2);
        salida->SetGain(1.0f);

        if (!salida->begin()) {
            delete salida;
            salida = nullptr;
            return false;
        }

        ultimoMicros = micros();
        acumuladorTiempo = 0.0f;
        activa = true;
        return true;
    }

    void stop() {
        activa = false;
        if (salida) {
            salida->stop();
            delete salida;
            salida = nullptr;
        }
    }

    void setVolumen(float v) {
        volumenObjetivo = clamp(v, 0.0f, 1.0f);
    }

    void setExpansion(float e) {
        expansion = clamp(e, 0.0f, 1.0f);
    }

    void setContacto(bool c) {
        contacto = c;
    }

    void setExcitacion(float e) {
        excitacion = clamp(e, 0.0f, 1.0f);
    }

    bool isRunning() const {
        return activa && salida;
    }

    void loop() {
        if (!salida || !activa) return;

        // Producimos varias muestras por llamada, pero nunca cambiamos
        // el reloj del I2S.
        for (int n = 0; n < 96; n++) {
            int16_t stereo[2];
            generarMuestra(stereo);

            if (!salida->ConsumeSample(stereo)) {
                break;
            }
        }

        salida->loop();
    }

private:
    AudioOutputI2S *salida = nullptr;
    bool activa = false;
    bool contacto = false;

    float volumenObjetivo = 0.0008f;
    float volumenSuave = 0.0008f;
    float expansion = 0.0f;
    float excitacion = 0.0f;

    float faseFundamental = 0.0f;
    float fase2 = 0.0f;
    float fase3 = 0.0f;
    float faseSub = 0.0f;
    float fasePulso = 0.0f;

    float ruidoAnterior = 0.0f;
    uint32_t rng = 0xA341316Cu;

    unsigned long ultimoMicros = 0;
    float acumuladorTiempo = 0.0f;

    static float clamp(float x, float a, float b) {
        if (x < a) return a;
        if (x > b) return b;
        return x;
    }

    float ruido() {
        // xorshift32: ruido barato y estable para ESP32
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        return ((rng & 0xFFFF) / 32767.5f) - 1.0f;
    }

    static void avanzar(float &fase, float hz) {
        fase += TWO_PI * hz / AUDIO_BASE_SAMPLE_RATE;
        if (fase >= TWO_PI) fase -= TWO_PI;
    }

    void generarMuestra(int16_t out[2]) {
        // Suavizado de volumen: evita clicks sin cortar la conversación.
        float coef =
            volumenObjetivo > volumenSuave
            ? 0.0028f
            : 0.0012f;

        volumenSuave +=
            (volumenObjetivo - volumenSuave) * coef;

        // ----------------------------------------------------
        // CUERPO
        // ----------------------------------------------------
        // Registro deliberadamente no "musical": grave/medio,
        // con componentes levemente inarmónicas.
        float baseHz = 118.0f;

        // La expansión no cambia sample-rate: mueve los osciladores.
        // Pequeña deriva viva, continua.
        float deriva =
            sinf(fasePulso) * (1.2f + expansion * 3.0f);

        // Cuando crece la excitación aparecen saltos discretos,
        // pero son cambios de frecuencia de síntesis, no de I2S.
        static float ratioActual = 1.0f;
        static int muestrasHastaCambio = 0;

        if (muestrasHastaCambio <= 0) {
            static const float ratios[] = {
                0.7492f, 0.8409f, 0.9439f,
                1.0000f, 1.0595f, 1.1225f,
                1.1892f, 1.2599f, 1.3348f
            };

            int maxIndice =
                3 + (int)(excitacion * 5.0f);
            if (maxIndice > 8) maxIndice = 8;

            int idx =
                (int)(fabsf(ruido()) * (maxIndice + 1));
            if (idx > maxIndice) idx = maxIndice;

            // Al comienzo predomina el centro; con tiempo,
            // las excursiones se vuelven más frecuentes.
            if (excitacion < 0.18f && fabsf(ruido()) < 0.78f)
                idx = 3;

            ratioActual = ratios[idx];

            float segundos =
                1.65f -
                excitacion * 1.43f; // ~1.65 s -> ~0.22 s

            segundos *=
                0.72f + fabsf(ruido()) * 0.65f;

            muestrasHastaCambio =
                (int)(segundos * AUDIO_BASE_SAMPLE_RATE);
        }

        muestrasHastaCambio--;

        float f0 =
            (baseHz + deriva) * ratioActual;

        // Fundamental + dos parciales no perfectamente armónicos.
        avanzar(faseFundamental, f0);
        avanzar(fase2, f0 * 2.013f);
        avanzar(fase3, f0 * 3.071f);
        avanzar(faseSub, f0 * 0.503f);
        avanzar(fasePulso, 0.17f + expansion * 0.31f);

        float cuerpo =
            sinf(faseFundamental) * 0.52f +
            sinf(fase2) * 0.19f +
            sinf(fase3) * 0.085f +
            sinf(faseSub) * 0.11f;

        // ----------------------------------------------------
        // AIRE / GRANULACION
        // ----------------------------------------------------
        // Ruido filtrado: más respirado cuando se entusiasma,
        // sin convertirse en fritura digital.
        float r = ruido();
        ruidoAnterior =
            ruidoAnterior * 0.91f +
            r * 0.09f;

        float aire =
            ruidoAnterior *
            (0.035f + excitacion * 0.075f);

        // Pulso irregular muy sutil: da articulación de "habla".
        float articulacion =
            0.82f +
            0.18f *
            sinf(
                fasePulso * (7.0f + excitacion * 13.0f)
            );

        float muestra =
            (cuerpo + aire) *
            articulacion *
            volumenSuave;

        muestra = clamp(muestra, -0.92f, 0.92f);

        int16_t s =
            (int16_t)(muestra * 32767.0f);

        out[0] = s;
        out[1] = s;
    }
};

static VozSemillaSintetica vozSemillaSynth;

#endif
