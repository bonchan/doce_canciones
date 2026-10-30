#ifndef ORGANISMO_COMPORTAMIENTO_H
#define ORGANISMO_COMPORTAMIENTO_H

#include <Arduino.h>
#include <math.h>
#include <strings.h>

// ============================================================
// ORGANISMO CUIR 001
// comportamiento común de las voces
// ============================================================

// ---------- Identidad --------------------------------------------------------

enum TipoVoz {
    VOZ_DESCONOCIDA,
    LLAMA,
    INTENTA,
    RESOPLA,
    CRUJE,
    VOZSEMILLA,
    SALPICA,
    ACARICIA,
    CANTA
};

static TipoVoz vozActual = VOZ_DESCONOCIDA;
static char ultimoNombreIdentificado[64] = "";


// ---------- Territorio -------------------------------------------------------

struct EstadoTerritorio {
    float ciclo = 0.0f;
    float presencia = 0.0f;
    float proximidad = 0.0f;
    float tacto = 0.0f;
    float actividad = 0.0f;
    float biodata = 0.0f;
};

static EstadoTerritorio territorio;


// ============================================================
// SENSOR CAPACITIVO DE COBRE
//
// GPIO7 ---- 1 MΩ ----+---- ESCULTURA
//                     |
// GPIO4 ---------------+
//
// La escultura NO va a GND ni a 3.3V.
// ============================================================

#define COBRE_PIN_ENVIO   7
#define COBRE_PIN_LECTURA 4

static float cobreBaseline = 0.0f;
static float cobreTactoSuave = 0.0f;
static bool cobreCalibrado = false;
static unsigned long cobreUltimaLecturaMs = 0;


// ---------- Medición RC ------------------------------------------------------

static unsigned long medirCobre() {

    pinMode(COBRE_PIN_LECTURA, OUTPUT);
    digitalWrite(COBRE_PIN_LECTURA, LOW);

    pinMode(COBRE_PIN_ENVIO, OUTPUT);
    digitalWrite(COBRE_PIN_ENVIO, LOW);

    delayMicroseconds(10);

    pinMode(COBRE_PIN_LECTURA, INPUT);

    digitalWrite(COBRE_PIN_ENVIO, HIGH);

    unsigned long inicio = micros();

    while (digitalRead(COBRE_PIN_LECTURA) == LOW) {

        if (micros() - inicio > 10000) {
            break;
        }
    }

    unsigned long tiempo = micros() - inicio;

    digitalWrite(COBRE_PIN_ENVIO, LOW);

    pinMode(COBRE_PIN_LECTURA, OUTPUT);
    digitalWrite(COBRE_PIN_LECTURA, LOW);

    return tiempo;
}


// ---------- Promedio ---------------------------------------------------------

static float medirCobreFiltrado() {

    const int muestras = 20;

    unsigned long suma = 0;

    for (int i = 0; i < muestras; i++) {

        suma += medirCobre();

        delayMicroseconds(120);
    }

    return suma / (float)muestras;
}


// ---------- Calibración ------------------------------------------------------

static void iniciarSensorCobre() {

    Serial.println();
    Serial.println("COBRE: calibrando reposo...");
    Serial.println("NO TOCAR LA ESCULTURA");

    float suma = 0.0f;

    for (int i = 0; i < 40; i++) {

        suma += medirCobreFiltrado();

        delay(80);
    }

    cobreBaseline = suma / 40.0f;

    cobreTactoSuave = 0.0f;
    territorio.tacto = 0.0f;

    cobreCalibrado = true;
    cobreUltimaLecturaMs = millis();

    Serial.print("COBRE: baseline = ");
    Serial.println(cobreBaseline, 1);

    Serial.println("COBRE: sensor activo");
    Serial.println();
}


// ---------- Lectura continua -------------------------------------------------

static void actualizarSensorCobre() {

    if (!cobreCalibrado) {
        return;
    }

    unsigned long ahora = millis();

    if (ahora - cobreUltimaLecturaMs < 25) {
        return;
    }

    cobreUltimaLecturaMs = ahora;

    float lectura = medirCobreFiltrado();

    // ========================================================
    // ESCULTURA GRANDE
    // ========================================================
    // La escultura produce picos altos incluso sin contacto.
    // Por eso no decidimos tacto a partir de una lectura aislada.
    // Observamos el nivel medio durante aproximadamente 0.5 s.

    static const int VENTANA = 20;
    static float historial[VENTANA] = {0};
    static int indice = 0;
    static int cantidad = 0;
    static float sumaVentana = 0.0f;

    sumaVentana -= historial[indice];
    historial[indice] = lectura;
    sumaVentana += lectura;

    indice = (indice + 1) % VENTANA;

    if (cantidad < VENTANA) {
        cantidad++;
    }

    float promedioVentana =
        sumaVentana / (float)cantidad;

    // Valores obtenidos de la escultura real:
    // sin tocar: predominio bajo con picos aislados hasta ~278
    // tocando: predominio alto, frecuentemente ~200–520
    //
    // Usamos dos umbrales (histéresis):
    // entra en contacto sólo si el promedio sostenido supera 210
    // y sale cuando vuelve por debajo de 145.

    static bool contactoDetectado = false;

    const float UMBRAL_ENTRADA = 210.0f;
    const float UMBRAL_SALIDA  = 145.0f;

    if (cantidad >= VENTANA) {

        if (!contactoDetectado &&
            promedioVentana > UMBRAL_ENTRADA) {

            contactoDetectado = true;
        }

        if (contactoDetectado &&
            promedioVentana < UMBRAL_SALIDA) {

            contactoDetectado = false;
        }
    }

    float tactoObjetivo = 0.0f;

    if (contactoDetectado) {

        tactoObjetivo =
            (promedioVentana - UMBRAL_SALIDA) /
            (360.0f - UMBRAL_SALIDA);

if (tactoObjetivo < 0.18f) tactoObjetivo = 0.18f;
if (tactoObjetivo > 1.0f) tactoObjetivo = 1.0f;

    }

    // Entrada relativamente rápida; retirada más lenta.
    if (tactoObjetivo > cobreTactoSuave) {

        cobreTactoSuave +=
            (tactoObjetivo - cobreTactoSuave) *
            0.22f;

    } else {

        cobreTactoSuave +=
            (tactoObjetivo - cobreTactoSuave) *
            0.08f;
    }

    if (cobreTactoSuave < 0.015f) {
        cobreTactoSuave = 0.0f;
    }

 territorio.tacto = cobreTactoSuave;

if (territorio.tacto < 0.0f) territorio.tacto = 0.0f;
if (territorio.tacto > 1.0f) territorio.tacto = 1.0f;

    // Monitor: ahora muestra también el promedio que realmente
    // decide si hay contacto.
    static unsigned long ultimoPrint = 0;

    if (ahora - ultimoPrint >= 150) {

        ultimoPrint = ahora;

        Serial.print("COBRE ");
        Serial.print(lectura, 1);

        Serial.print("  promedio ");
        Serial.print(promedioVentana, 1);

        Serial.print("  contacto ");
        Serial.print(contactoDetectado ? "SI" : "NO");

        Serial.print("  tacto ");
        Serial.println(territorio.tacto, 2);
    }
}


// ============================================================
// ESTADO INTERNO
// ============================================================

struct EstadoComportamiento {

    bool organismoActivo = false;
    bool vozActiva = false;
    bool audioContinuoDeseado = false;

    unsigned long inicioOrganismoMs = 0;
    unsigned long inicioAparicionMs = 0;
    unsigned long proximaAparicionMs = 0;

    float rateActual = 1.0f;
    float volumenCalculado = 0.0f;

    uint32_t apariciones = 0;
};

static EstadoComportamiento estado;


// ============================================================
// UTILIDADES
// ============================================================

static inline float vozClamp(float x, float lo, float hi) {

    return x < lo ? lo : (x > hi ? hi : x);
}


static inline float vozMix(float a, float b, float t) {

    t = vozClamp(t, 0.0f, 1.0f);

    return a + (b - a) * t;
}


static inline float vozRandom(float lo, float hi) {

    float u =
        (float)random(0, 10001) /
        10000.0f;

    return lo + (hi - lo) * u;
}


static inline float valorO(float actual, float defecto) {

    return isnan(actual) ? defecto : actual;
}


static inline unsigned long segundosAMillis(float s) {

    if (s <= 0.0f) {
        return 0;
    }

    return (unsigned long)(s * 1000.0f);
}


static float factorEntradaComun(
    float tiempoSeg,
    float entradaSeg,
    float duracionSeg,
    float presenciaInicial
) {

    float factorEntrada = 0.0f;

    if (tiempoSeg >= entradaSeg) {

        factorEntrada =
            vozClamp(
                (tiempoSeg - entradaSeg) /
                fmaxf(0.1f, duracionSeg),
                0.0f,
                1.0f
            );
    }

    return
        presenciaInicial +
        (1.0f - presenciaInicial) *
        factorEntrada;
}


// ============================================================
// PARÁMETROS
// ============================================================

struct ParametrosPagina {

    float volumen;
    float movimiento;
    float presenciaInicial;
    float latente;
    float entrada;
    float duracion;
    float irregularidad;
    float expansion;
    float contacto;
    float presencia;
    float movimientoAire;
    float encuentro;
    float apertura;
    float aparicion;
    float respuesta;
    float duda;
    float gananciaCuerpo;
};


static ParametrosPagina defaultsVoz(TipoVoz v) {

    ParametrosPagina p = {

        0.05f,
        0.0f,
        1.0f,
        0.0f,
        0.0f,
        10.0f,
        0.3f,

        0.0f,
        0.0f,
        1.0f,
        0.0f,
        0.0f,
        0.0f,
        0.0f,
        0.0f,
        0.0f,
        1.0f
    };


    switch (v) {

        case LLAMA:

            p.volumen = 0.085f;
            p.movimiento = 0.0f;
            p.presenciaInicial = 1.0f;
            p.latente = 0.0f;
            p.entrada = 34.0f;
            p.duracion = 6.4f;
            p.irregularidad = 0.5f;
            p.gananciaCuerpo = 1.0f;

            break;


        case INTENTA:

            p.volumen = 0.035f;
            p.movimiento = 0.0f;
            p.presenciaInicial = 1.0f;
            p.latente = 0.0f;
            p.entrada = 0.0f;
            p.duracion = 10.0f;
            p.irregularidad = 0.3f;
            p.gananciaCuerpo = 2.0f;

            break;


        case RESOPLA:

            p.volumen = 0.055f;
            p.movimiento = 0.0f;
            p.presenciaInicial = 0.0f;
            p.latente = 0.0f;
            p.entrada = 7.0f;
            p.duracion = 22.0f;
            p.irregularidad = 0.2f;
            p.gananciaCuerpo = 0.5f;

            break;


        case CRUJE:

            p.volumen = 0.018f;
            p.movimiento = 0.0f;
            p.presenciaInicial = 1.0f;
            p.latente = 0.0f;
            p.entrada = 0.0f;
            p.duracion = 10.0f;
            p.irregularidad = 0.4f;
            p.gananciaCuerpo = 3.5f;

            break;


        case VOZSEMILLA:

            p.volumen = 0.028f;
            p.movimiento = 0.0f;
            p.presenciaInicial = 1.0f;
            p.latente = 0.0012f;
            p.entrada = 0.0f;
            p.duracion = 0.55f;
            p.irregularidad = 0.7f;
            p.expansion = 0.12f;
            p.contacto = 1.0f;
            p.gananciaCuerpo = 3.0f;

            break;


        case SALPICA:

            p.volumen = 0.032f;
            p.presencia = 0.62f;
            p.movimientoAire = 0.35f;
            p.gananciaCuerpo = 1.0f;

            break;


        case ACARICIA:

            p.volumen = 0.060f;
            p.encuentro = 0.58f;
            p.apertura = 0.55f;
            p.gananciaCuerpo = 1.0f;

            break;


        case CANTA:

            p.volumen = 0.075f;
            p.aparicion = 0.46f;
            p.respuesta = 0.24f;
            p.apertura = 0.52f;
            p.duda = 0.68f;
            p.gananciaCuerpo = 1.0f;

            break;


        default:

            break;
    }

    return p;
}


// ============================================================
// IDENTIFICACIÓN
// ============================================================

static void identificarVoz() {

    if (strcmp(ultimoNombreIdentificado, name) == 0) {
        return;
    }


    strncpy(
        ultimoNombreIdentificado,
        name,
        sizeof(ultimoNombreIdentificado) - 1
    );

    ultimoNombreIdentificado[
        sizeof(ultimoNombreIdentificado) - 1
    ] = '\0';


    if (strcasecmp(name, "LLAMA") == 0)

        vozActual = LLAMA;

    else if (strcasecmp(name, "INTENTA") == 0)

        vozActual = INTENTA;

    else if (strcasecmp(name, "RESOPLA") == 0)

        vozActual = RESOPLA;

    else if (strcasecmp(name, "CRUJE") == 0)

        vozActual = CRUJE;

    else if (
        strcasecmp(name, "VOZSEMILLA") == 0 ||
        strcasecmp(name, "VOZ SEMILLA") == 0
    )

        vozActual = VOZSEMILLA;

    else if (
        strcasecmp(name, "SALPICA") == 0 ||
        strcasecmp(name, "TEXTURA") == 0
    )

        vozActual = SALPICA;

    else if (strcasecmp(name, "ACARICIA") == 0)

        vozActual = ACARICIA;

    else if (strcasecmp(name, "CANTA") == 0)

        vozActual = CANTA;

    else

        vozActual = VOZ_DESCONOCIDA;


    Serial.print("VOZ identificada: ");
    Serial.println(
        name[0] ? name : "(sin nombre)"
    );
}


// ============================================================
// AUDIO
// ============================================================

static inline void aplicarVolumen(float v) {

    audioBehaviorSetGain(
        vozClamp(v, 0.0f, 1.0f)
    );
}


// ============================================================
// CICLO DE VIDA
// ============================================================

static void iniciarOrganismo() {

    identificarVoz();

    estado = EstadoComportamiento();

    estado.organismoActivo = true;
    estado.inicioOrganismoMs = millis();
    estado.rateActual = 1.0f;


    // VOZSEMILLA necesita calibrar el cobre.
    if (
        vozActual == VOZSEMILLA &&
        !cobreCalibrado
    ) {

        iniciarSensorCobre();
    }


    if (
        vozActual == INTENTA ||
        vozActual == CRUJE ||
        vozActual == VOZSEMILLA ||
        vozActual == SALPICA ||
        vozActual == ACARICIA
    ) {

        estado.audioContinuoDeseado = true;

        audioBehaviorStartFromBeginning();

        estado.vozActiva =
            audioBehaviorIsPlaying();
    }


    if (vozActual == RESOPLA) {

        estado.proximaAparicionMs =
            millis() + 700;
    }


    if (vozActual == LLAMA) {

        estado.proximaAparicionMs = 0;
    }


    if (vozActual == CANTA) {

        estado.proximaAparicionMs =
            millis() +
            (unsigned long)
            vozRandom(
                22000.0f,
                36000.0f
            );
    }


    Serial.println("ORGANISMO: activo");
}


static void detenerOrganismo() {

    estado.organismoActivo = false;
    estado.vozActiva = false;
    estado.audioContinuoDeseado = false;

    audioBehaviorStop();

    aplicarVolumen(0.0f);

    Serial.println("ORGANISMO: detenido");
}


// ============================================================
// LLAMA
// ============================================================

static void programarProximaLlama(float movimiento) {

    float minS =
        vozMix(
            60.0f,
            7.0f,
            movimiento
        );

    float maxS =
        vozMix(
            120.0f,
            18.0f,
            movimiento
        );


    estado.proximaAparicionMs =
        millis() +
        segundosAMillis(
            vozRandom(minS, maxS)
        );
}


static void comportamientoLlama(
    float t,
    const ParametrosPagina &d
) {

    float mov =
        vozClamp(
            valorO(
                restMovement,
                d.movimiento
            ),
            0.0f,
            1.0f
        );


    float vol =
        valorO(
            volume,
            d.volumen
        ) *
        d.gananciaCuerpo;


    if (
        !estado.vozActiva &&
        estado.proximaAparicionMs == 0
    ) {

        programarProximaLlama(mov);
    }


    if (
        !estado.vozActiva &&
        millis() >=
        estado.proximaAparicionMs
    ) {

        audioBehaviorSetRateMultiplier(1.0f);

        audioBehaviorStartFromBeginning();

        estado.vozActiva =
            audioBehaviorIsPlaying();

        estado.inicioAparicionMs =
            millis();

        estado.apariciones++;
    }


    if (estado.vozActiva) {

        float edad =
            (millis() -
             estado.inicioAparicionMs) /
            1000.0f;


        float fadeIn =
            vozClamp(
                edad / 0.35f,
                0.0f,
                1.0f
            );


        float fadeOut =
            audioBehaviorEndFadeFactor(
                0.80f
            );


        aplicarVolumen(
            vol *
            fminf(
                fadeIn,
                fadeOut
            )
        );


        if (!audioBehaviorIsPlaying()) {

            estado.vozActiva = false;

            aplicarVolumen(0.0f);

            programarProximaLlama(mov);
        }

    } else {

        aplicarVolumen(0.0f);
    }
}


// ============================================================
// INTENTA
// ============================================================

static void comportamientoIntenta(
    float t,
    const ParametrosPagina &d
) {

    float mov =
        vozClamp(
            valorO(
                restMovement,
                d.movimiento
            ),
            0.0f,
            1.0f
        );


    float vol =
        valorO(
            volume,
            d.volumen
        );


    float lat =
        valorO(
            latentVolume,
            d.latente
        );


    float pres0 =
        vozClamp(
            valorO(
                initialPresence,
                d.presenciaInicial
            ),
            0.0f,
            1.0f
        );


    float ent =
        valorO(
            entrance,
            d.entrada
        );


    float dur =
        valorO(
            duration,
            d.duracion
        );


    if (!audioBehaviorIsPlaying()) {

        audioBehaviorStartFromBeginning();
    }


    float velocidad =
        0.75f +
        mov * 7.0f;


    float onda =
        (sinf(
            t * velocidad +
            2.8f
        ) + 1.0f) *
        0.5f;


    float espasmo =
        powf(
            onda,
            12.0f
        );


    float comportamiento =
        0.58f +
        espasmo * 0.82f;


    float factorMov =
        vozMix(
            1.0f,
            comportamiento,
            mov
        );


    float factorPres =
        factorEntradaComun(
            t,
            ent,
            dur,
            pres0
        );


    aplicarVolumen(
        (
            lat +
            vol *
            factorPres *
            factorMov
        ) *
        d.gananciaCuerpo
    );
}


// ============================================================
// RESOPLA
// ============================================================

static float pausaResopla(
    float mov,
    float irr
) {

    float pausa;


    if (mov < 0.5f) {

        pausa =
            vozMix(
                2.8f,
                0.35f,
                mov * 2.0f
            );

    } else {

        pausa =
            vozMix(
                0.35f,
                0.015f,
                (mov - 0.5f) * 2.0f
            );
    }


    pausa *=
        1.0f +
        vozRandom(
            -0.08f,
            0.08f
        ) *
        irr;


    return
        vozClamp(
            pausa,
            0.008f,
            3.0f
        );
}


static void comportamientoResopla(
    float t,
    const ParametrosPagina &d
) {

    float mov =
        vozClamp(
            valorO(
                restMovement,
                d.movimiento
            ),
            0.0f,
            1.0f
        );


    float irr =
        vozClamp(
            valorO(
                irregularity,
                d.irregularidad
            ),
            0.0f,
            1.0f
        );


    float vol =
        valorO(
            volume,
            d.volumen
        );


    float lat =
        valorO(
            latentVolume,
            d.latente
        );


    float pres0 =
        vozClamp(
            valorO(
                initialPresence,
                d.presenciaInicial
            ),
            0.0f,
            1.0f
        );


    float ent =
        valorO(
            entrance,
            d.entrada
        );


    float dur =
        valorO(
            duration,
            d.duracion
        );


    float factorPres =
        factorEntradaComun(
            t,
            ent,
            dur,
            pres0
        );


    if (
        !estado.vozActiva &&
        millis() >=
        estado.proximaAparicionMs
    ) {

        float rate =
            vozMix(
                0.62f,
                2.40f,
                mov
            ) +
            vozRandom(
                -0.05f,
                0.05f
            ) *
            irr;


        rate =
            vozClamp(
                rate,
                0.58f,
                2.50f
            );


        audioBehaviorSetRateMultiplier(rate);

        audioBehaviorStartFromBeginning();

        estado.vozActiva =
            audioBehaviorIsPlaying();

        estado.inicioAparicionMs =
            millis();
    }


    if (estado.vozActiva) {

        float edad =
            (millis() -
             estado.inicioAparicionMs) /
            1000.0f;


        float fadeIn =
            vozClamp(
                edad / 0.08f,
                0.0f,
                1.0f
            );


        float fadeOut =
            audioBehaviorEndFadeFactor(
                0.08f
            );


        aplicarVolumen(
            (
                lat +
                vol *
                factorPres
            ) *
            d.gananciaCuerpo *
            fminf(
                fadeIn,
                fadeOut
            )
        );


        if (!audioBehaviorIsPlaying()) {

            estado.vozActiva = false;

            aplicarVolumen(0.0f);

            estado.proximaAparicionMs =
                millis() +
                segundosAMillis(
                    pausaResopla(
                        mov,
                        irr
                    )
                );
        }

    } else {

        aplicarVolumen(0.0f);
    }
}


// ============================================================
// CRUJE
// ============================================================

static void comportamientoCruje(
    float t,
    const ParametrosPagina &d
) {

    float mov =
        vozClamp(
            valorO(
                restMovement,
                d.movimiento
            ),
            0.0f,
            1.0f
        );


    float irr =
        vozClamp(
            valorO(
                irregularity,
                d.irregularidad
            ),
            0.0f,
            1.0f
        );


    float vol =
        valorO(
            volume,
            d.volumen
        );


    float lat =
        valorO(
            latentVolume,
            d.latente
        );


    float pres0 =
        vozClamp(
            valorO(
                initialPresence,
                d.presenciaInicial
            ),
            0.0f,
            1.0f
        );


    float ent =
        valorO(
            entrance,
            d.entrada
        );


    float dur =
        valorO(
            duration,
            d.duracion
        );


    if (!audioBehaviorIsPlaying()) {

        audioBehaviorStartFromBeginning();
    }


    float velocidad =
        1.3f +
        mov * 10.0f;


    float f1 =
        sinf(
            t * velocidad -
            0.6f
        );


    float f2 =
        sinf(
            t *
            velocidad *
            1.73f +
            2.1f
        );


    float f3 =
        sinf(
            t *
            velocidad *
            0.61f +
            4.3f
        );


    float textura =
        (
            f1 +
            f2 +
            f3 +
            3.0f
        ) /
        6.0f;


    float umbral =
        mov *
        (
            0.45f +
            irr * 0.35f
        );


    float fragmentacion =
        textura < umbral
        ? 0.03f
        : 0.38f +
          textura * 0.62f;


    float factorMov =
        vozMix(
            1.0f,
            fragmentacion,
            mov
        );


    float factorPres =
        factorEntradaComun(
            t,
            ent,
            dur,
            pres0
        );


    aplicarVolumen(
        (
            lat +
            vol *
            factorPres *
            factorMov
        ) *
        d.gananciaCuerpo
    );
}


// ============================================================
// VOZSEMILLA
// ============================================================

static void comportamientoVozsemilla(
    float t,
    const ParametrosPagina &d
) {
    float con = vozClamp(valorO(contact, d.contacto), 0.0f, 1.0f);

    if (!audioBehaviorIsPlaying()) {
        audioBehaviorStartFromBeginning();
    }

    // El sensor decide solamente CONTACTO / NO CONTACTO.
    // La intensidad física del tacto no modifica la expresión.
    bool hayContacto = (territorio.tacto * con) > 0.10f;

    static bool contactoAnterior = false;
    static unsigned long inicioContactoMs = 0;
    static unsigned long proximoSaltoMs = 0;
    static unsigned long finSaltoMs = 0;

    // Expansión heredada de organismo_cuir:
    // crece mientras se sostiene el contacto y cae lentamente al soltar.
    static float expansionTiempo = 0.0f;
    static unsigned long ultimoMs = 0;

    // Estado del salto tonal actual.
    static bool saltoActivo = false;
    static float rateActual = 1.0f;
    static float volumenSalto = 0.0f;

    // Transición tonal anti-fritura:
    // 1 = micro fade-out, 2 = micro fade-in.
    static float ratePendiente = 1.0f;
    static int faseCambioTono = 0;
    static unsigned long inicioCambioTonoMs = 0;

    // Memoria de salida de 3 segundos.
    static unsigned long inicioSalidaMs = 0;
    static float volumenAlSoltar = 0.0f;
    static float ultimoVolumenObjetivo = 0.0f;
    static unsigned long proximoSaltoSalidaMs = 0;

    unsigned long ahora = millis();

    float dt =
        ultimoMs == 0
        ? 0.0f
        : (ahora - ultimoMs) / 1000.0f;

    ultimoMs = ahora;
    if (dt > 0.10f) dt = 0.10f;

    if (hayContacto) {
        if (!contactoAnterior) {
            inicioContactoMs = ahora;
            proximoSaltoMs = ahora + 1500;
        }

        // Igual que en la página: primero escucha/espera.
        if (ahora - inicioContactoMs >= 1500) {
            expansionTiempo += 0.07f * dt;
        }
    } else {
        expansionTiempo -= 0.016f * dt;
    }

    expansionTiempo = vozClamp(expansionTiempo, 0.0f, 1.0f);

    bool acabaDeSoltar =
        contactoAnterior && !hayContacto;

    contactoAnterior = hayContacto;

    // --------------------------------------------------------
    // REZO -> CHISME
    // --------------------------------------------------------
    // Saltos discretos. No recorremos una escala ordenada.
    // Incluye descensos y ascensos cercanos/lejanos.
    static const float rates[] = {
        0.7492f, 0.8409f, 0.8909f, 0.9439f,
        1.0000f,
        1.0595f, 1.1225f, 1.1892f,
        1.2599f, 1.3348f, 1.4142f, 1.4983f
    };
    static const int cantidadRates =
        sizeof(rates) / sizeof(rates[0]);

    static int ultimoIndice = 4;

    // Al principio: saltos espaciados.
    // Al sostener mucho: cada vez más rápidos y verborrágicos.
    if (hayContacto &&
        ahora - inicioContactoMs >= 1500 &&
        !saltoActivo &&
        (long)(ahora - proximoSaltoMs) >= 0) {

        int indice;

        // Con poca expansión privilegiamos cambios cercanos al centro.
        if (expansionTiempo < 0.25f) {
            static const int suaves[] = {3, 4, 5, 6};
            indice = suaves[random(0, 4)];
        }
        // En zona media abrimos el registro.
        else if (expansionTiempo < 0.60f) {
            static const int medios[] = {2, 3, 4, 5, 6, 7, 8, 9};
            indice = medios[random(0, 8)];
        }
        // Con mucha expansión puede saltar por todo el registro.
        else {
            indice = random(0, cantidadRates);
        }

        // Evitar repetir exactamente el mismo tono.
        if (indice == ultimoIndice) {
            indice = (indice + 1 + random(0, cantidadRates - 1))
                     % cantidadRates;
        }

        ultimoIndice = indice;
        rateActual = rates[indice];

        // El cambio de altura se hará dentro de una micro-retirada
        // de volumen para ocultar el artefacto del cambio de reloj I2S.
        // (ver bloque TRANSICIÓN TONAL más abajo)
        ratePendiente = rateActual;
        faseCambioTono = 1;       // fade-out muy breve
        inicioCambioTonoMs = ahora;

        // Los gestos se acortan con el tiempo de contacto.
        unsigned long durMin =
            (unsigned long)vozMix(
                300.0f,
                38.0f,
                expansionTiempo
            );

        unsigned long durMax =
            (unsigned long)vozMix(
                560.0f,
                145.0f,
                expansionTiempo
            );

        // Algún énfasis más largo evita una metralla uniforme.
        if (expansionTiempo > 0.45f && random(100) < 13) {
            durMax += random(120, 300);
        }

        finSaltoMs =
            ahora + random(durMin, durMax + 1);

        // También aumenta el volumen de los gestos a medida que
        // la voz "se entusiasma", pero depende del TIEMPO, no de la presión.
        volumenSalto =
            vozRandom(
                vozMix(0.030f, 0.16f, expansionTiempo),
                vozMix(0.070f, 0.34f, expansionTiempo)
            );

        saltoActivo = true;
    }

    if (saltoActivo &&
        (long)(ahora - finSaltoMs) >= 0) {

        saltoActivo = false;

        // Vuelve al murmullo central entre gestos, también ocultando
        // el cambio de reloj dentro de una micro-retirada.
        ratePendiente = 1.0f;
        faseCambioTono = 1;
        inicioCambioTonoMs = ahora;

        // Frecuencia de aparición:
        // organismo_cuir llegaba aprox. 1.6 -> 0.65 s.
        // Aquí prolongamos la curva hasta ~0.12 s para que,
        // con contacto largo, aparezca la verdadera verborragia.
        float intervaloBase =
            vozMix(
                1.60f,
                0.12f,
                expansionTiempo
            );

        float irregular =
            vozRandom(0.70f, 1.30f);

        proximoSaltoMs =
            ahora +
            segundosAMillis(
                intervaloBase * irregular
            );
    }

    // Si se suelta, dejamos de generar nuevos saltos.
    // El que ya estaba sonando puede cerrar su gesto.
    if (!hayContacto && saltoActivo &&
        (long)(ahora - finSaltoMs) >= 0) {
        saltoActivo = false;
        ratePendiente = 1.0f;
        faseCambioTono = 1;
        inicioCambioTonoMs = ahora;
    }

    // --------------------------------------------------------
    // TRANSICIÓN TONAL ANTI-FRITURA
    // --------------------------------------------------------
    // Antes de cambiar el rate bajamos casi a cero durante 18 ms.
    // Cambiamos el reloj mientras está oculto y volvemos en 28 ms.
    float factorTransicionTono = 1.0f;

    if (faseCambioTono == 1) {
        float p = vozClamp(
            (ahora - inicioCambioTonoMs) / 18.0f,
            0.0f,
            1.0f
        );

        factorTransicionTono = 1.0f - p;

        if (p >= 1.0f) {
            audioBehaviorSetRateMultiplier(ratePendiente);
            faseCambioTono = 2;
            inicioCambioTonoMs = ahora;
            factorTransicionTono = 0.0f;
        }
    }
    else if (faseCambioTono == 2) {
        float p = vozClamp(
            (ahora - inicioCambioTonoMs) / 28.0f,
            0.0f,
            1.0f
        );

        factorTransicionTono = p;

        if (p >= 1.0f) {
            faseCambioTono = 0;
            factorTransicionTono = 1.0f;
        }
    }

    // Murmullo de fondo: más bajo que en la versión anterior.
    // La expansión residual conserva algo de excitación al retirarse.
    float volumenBase =
        0.00035f +
        expansionTiempo * 0.010f;

    float volumenExpresivo =
        volumenBase +
        (saltoActivo ? volumenSalto : 0.0f);

    // Al retirar la mano, conservar el nivel que había en ese instante
    // y llevarlo suavemente al latente durante 3 segundos.
    if (acabaDeSoltar) {
        inicioSalidaMs = ahora;
        volumenAlSoltar = ultimoVolumenObjetivo;

        // La voz no queda congelada en el ultimo tono:
        // programa una primera "ultima frase" poco despues de soltar.
        proximoSaltoSalidaMs =
            ahora + random(140, 360);
    }

    float volumenObjetivo = volumenExpresivo;

    if (!hayContacto && inicioSalidaMs > 0) {
        float salida =
            vozClamp(
                (ahora - inicioSalidaMs) / 3000.0f,
                0.0f,
                1.0f
            );

        // ----------------------------------------------------
        // RETIRADA CONVERSACIONAL
        // ----------------------------------------------------
        // Durante la retirada la voz todavia dice algunas cosas:
        // pocos saltos, irregulares, cada vez mas separados y suaves.
        // Asi no queda congelada en una nota continua.

        if (!saltoActivo &&
            faseCambioTono == 0 &&
            salida < 0.86f &&
            (long)(ahora - proximoSaltoSalidaMs) >= 0) {

            // Al principio de la salida conserva algo de amplitud tonal;
            // hacia el final vuelve cerca del centro.
            int indice;

            if (salida < 0.35f) {
                static const int salidaAbierta[] = {2, 3, 5, 6, 7, 8};
                indice = salidaAbierta[random(0, 6)];
            } else {
                static const int salidaSuave[] = {3, 4, 5, 6};
                indice = salidaSuave[random(0, 4)];
            }

            if (indice == ultimoIndice) {
                indice = (indice == 4) ? 5 : 4;
            }

            ultimoIndice = indice;
            rateActual = rates[indice];
            ratePendiente = rateActual;
            faseCambioTono = 1;
            inicioCambioTonoMs = ahora;

            unsigned long duracionSalida =
                (unsigned long)vozMix(
                    330.0f,
                    120.0f,
                    salida
                );

            finSaltoMs =
                ahora + random(
                    (unsigned long)(duracionSalida * 0.70f),
                    duracionSalida + 1
                );

            volumenSalto =
                vozMix(
                    0.075f,
                    0.012f,
                    salida
                ) * vozRandom(0.75f, 1.0f);

            saltoActivo = true;

            unsigned long pausaSalida =
                (unsigned long)vozMix(
                    260.0f,
                    820.0f,
                    salida
                );

            proximoSaltoSalidaMs =
                ahora + pausaSalida + random(0, 240);
        }

        // Cuando termina un fragmento de salida, vuelve al centro
        // antes de la siguiente frase.
        if (saltoActivo &&
            (long)(ahora - finSaltoMs) >= 0) {

            saltoActivo = false;
            ratePendiente = 1.0f;
            faseCambioTono = 1;
            inicioCambioTonoMs = ahora;
        }

        float envolventeSalida =
            1.0f - salida;

        float baseSalida =
            vozMix(
                0.00035f,
                volumenAlSoltar,
                envolventeSalida
            );

        float gestoSalida =
            saltoActivo
            ? volumenSalto * envolventeSalida
            : 0.0f;

        volumenObjetivo =
            baseSalida + gestoSalida;

        if (salida >= 1.0f) {
            inicioSalidaMs = 0;
            saltoActivo = false;
            ratePendiente = 1.0f;
            faseCambioTono = 1;
            inicioCambioTonoMs = ahora;
            volumenObjetivo = 0.00035f;
        }
    }

    if (hayContacto) {
        inicioSalidaMs = 0;
    }

    volumenObjetivo *= factorTransicionTono;
    ultimoVolumenObjetivo = volumenObjetivo;

    aplicarVolumen(
        volumenObjetivo *
        d.gananciaCuerpo
    );
}

// ============================================================
// SALPICA
// ============================================================

static void comportamientoSalpica(
    float t,
    const ParametrosPagina &d
) {

    float vol =
        valorO(
            volume,
            d.volumen
        );


    float pres =
        vozClamp(
            valorO(
                presence,
                d.presencia
            ),
            0.0f,
            1.0f
        );


    if (!audioBehaviorIsPlaying()) {

        audioBehaviorStartFromBeginning();
    }


    float lenta =
        (
            sinf(
                t * 0.105f
            ) +
            1.0f
        ) *
        0.5f;


    float segunda =
        (
            sinf(
                t * 0.061f +
                2.7f
            ) +
            1.0f
        ) *
        0.5f;


    float respiracion =
        0.58f +
        0.42f *
        (
            lenta * 0.65f +
            segunda * 0.35f
        );


    float factor =
        pres +
        (
            1.0f -
            pres
        ) *
        respiracion;


    aplicarVolumen(
        vol *
        factor *
        d.gananciaCuerpo
    );
}


// ============================================================
// ACARICIA
// ============================================================

static void comportamientoAcaricia(
    float t,
    const ParametrosPagina &d
) {

    float vol =
        valorO(
            volume,
            d.volumen
        );


    float enc =
        vozClamp(
            valorO(
                meeting,
                d.encuentro
            ),
            0.0f,
            1.0f
        );


    if (!audioBehaviorIsPlaying()) {

        audioBehaviorStartFromBeginning();
    }


    float onda1 =
        (
            sinf(
                t * 0.070f +
                0.2f
            ) +
            1.0f
        ) *
        0.5f;


    float onda2 =
        (
            sinf(
                t * 0.058f +
                2.15f
            ) +
            1.0f
        ) *
        0.5f;


    float piso =
        0.80f +
        enc * 0.12f;


    float respiracion =
        piso +
        (
            1.0f -
            piso
        ) *
        (
            onda1 * 0.52f +
            onda2 * 0.48f
        );


    aplicarVolumen(
        vol *
        respiracion
    );
}


// ============================================================
// CANTA
// ============================================================

static void programarSiguienteCanta(
    float apar
) {

    float minimo =
        3500.0f +
        (
            1.0f -
            apar
        ) *
        9500.0f;


    float variacion =
        3500.0f +
        (
            1.0f -
            apar
        ) *
        9000.0f;


    estado.proximaAparicionMs =
        millis() +
        (unsigned long)(
            minimo +
            vozRandom(
                0.0f,
                variacion
            )
        );
}


static void comportamientoCanta(
    float t,
    const ParametrosPagina &d
) {

    float vol =
        valorO(
            volume,
            d.volumen
        );


    float apar =
        vozClamp(
            valorO(
                appearance,
                d.aparicion
            ),
            0.0f,
            1.0f
        );


    float dud =
        vozClamp(
            valorO(
                doubt,
                d.duda
            ),
            0.0f,
            1.0f
        );


    if (
        !estado.vozActiva &&
        millis() >=
        estado.proximaAparicionMs
    ) {

        float dispersion =
            0.025f +
            dud * 0.19f;


        float direccion =
            random(0, 2) == 0
            ? -1.0f
            : 1.0f;


        float rate =
            vozClamp(
                1.0f +
                direccion *
                (
                    0.008f +
                    vozRandom(
                        0.0f,
                        dispersion
                    )
                ),
                0.76f,
                1.27f
            );


        audioBehaviorSetRateMultiplier(
            rate
        );


        audioBehaviorStartFromBeginning();


        estado.vozActiva =
            audioBehaviorIsPlaying();


        estado.inicioAparicionMs =
            millis();


        estado.apariciones++;


        aplicarVolumen(
            vol *
            vozRandom(
                0.82f,
                1.0f
            )
        );
    }


    if (
        estado.vozActiva &&
        !audioBehaviorIsPlaying()
    ) {

        estado.vozActiva =
            false;


        aplicarVolumen(0.0f);


        programarSiguienteCanta(
            apar
        );
    }
}


// ============================================================
// DISPATCHER
// ============================================================

static void actualizarVoz() {

    identificarVoz();


    if (
        !estado.organismoActivo ||
        vozActual == VOZ_DESCONOCIDA
    ) {

        return;
    }


    // --------------------------------------------------------
    // VOZSEMILLA
    //
    // Aseguramos que el sensor exista aunque el organismo
    // hubiera arrancado antes de identificar correctamente
    // la voz.
    // --------------------------------------------------------

    if (vozActual == VOZSEMILLA) {

        if (!cobreCalibrado) {

            iniciarSensorCobre();
        }

        actualizarSensorCobre();
    }


    float t =
        (
            millis() -
            estado.inicioOrganismoMs
        ) /
        1000.0f;


    ParametrosPagina d =
        defaultsVoz(
            vozActual
        );


    if (vozActual == LLAMA)

        comportamientoLlama(
            t,
            d
        );


    else if (vozActual == INTENTA)

        comportamientoIntenta(
            t,
            d
        );


    else if (vozActual == RESOPLA)

        comportamientoResopla(
            t,
            d
        );


    else if (vozActual == CRUJE)

        comportamientoCruje(
            t,
            d
        );


    else if (vozActual == VOZSEMILLA)

        comportamientoVozsemilla(
            t,
            d
        );


    else if (vozActual == SALPICA)

        comportamientoSalpica(
            t,
            d
        );


    else if (vozActual == ACARICIA)

        comportamientoAcaricia(
            t,
            d
        );


    else if (vozActual == CANTA)

        comportamientoCanta(
            t,
            d
        );
}

#endif