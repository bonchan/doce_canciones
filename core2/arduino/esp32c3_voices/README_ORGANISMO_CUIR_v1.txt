ORGANISMO CUIR 001 — firmware común de voces v1
=================================================

ARCHIVOS
- esp32C3_speaker.ino
- organismo_config.h          (estructura original del compañero)
- organismo_audio.h           (adaptado: expone API conductual)
- organismo_comportamiento.h  (nuevo: lógica común de todas las voces)

DEPENDENCIA EXTERNA
El proyecto original incluye:
    #include "../device_base.h"
Por eso esta carpeta sigue necesitando el MISMO device_base.h que ya usa el
proyecto de tu compañero, ubicado un nivel arriba. No se incluyó en el ZIP
original recibido, así que no es posible convertir esta carpeta en un proyecto
totalmente autónomo sin ese archivo.

LIBRERÍA
ESP8266Audio (Earle F. Philhower III), igual que en el proyecto original.

USO
1. Subir exactamente este mismo firmware a cada ESP32-C3.
2. Cada nodo conserva su propio audio.wav mediante AUDIO_UPDATE.
3. Asignar `name` por SET: LLAMA, INTENTA, RESOPLA, CRUJE, VOZSEMILLA, SALPICA,
   ACARICIA o CANTA.
4. AUDIO_PLAY activa el organismo. Un segundo AUDIO_PLAY lo detiene durante esta
   etapa de pruebas.
5. Si un parámetro todavía es NAN/unset, comportamiento usa el valor por defecto
   de la página Laboratorio de escucha. Si MQTT envía SET, ese valor gana.

ESTADO DE FIDELIDAD A LA PÁGINA
- LLAMA: aparición espaciada + WAV completo + fade-in. Fade-out final pendiente
  de exponer posición/duración en el wrapper de ESP8266Audio.
- INTENTA: espasmos de amplitud equivalentes a la fórmula web.
- RESOPLA: respiraciones unitarias + pausas de tres puntos + cambio de rate.
  Nota: en ESP el rate cambia también la altura; en navegador RESOPLA preserva
  mejor el pitch. Es una aproximación física, no time-stretch.
- CRUJE: fragmentación de amplitud equivalente.
- VOZSEMILLA: deriva lenta de rate + danza de volumen + puerta preparada para
  tacto/territorio.
- SALPICA: respiración lenta equivalente. Paneo omitido porque cada nodo es mono.
- ACARICIA: traducción parcial; falta doble voz simultánea, filtros y reverb.
- CANTA: traducción parcial; falta reproducción de fragmentos y filtros.

TERRITORIO
EstadoTerritorio ya está en organismo_comportamiento.h pero empieza neutro. Más
adelante puede recibir ciclo, presencia, proximidad, tacto, actividad y biodata
por MQTT o sensores locales sin reescribir las identidades.
