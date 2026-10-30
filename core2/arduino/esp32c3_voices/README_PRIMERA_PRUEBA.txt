ORGANISMO CUIR 001 — firmware común v2

Esta carpeta ya reúne en un mismo sketch:
- esp32C3_speaker.ino
- device_base.h
- config.h
- organismo_config.h
- organismo_audio.h
- organismo_comportamiento.h

La inclusión de device_base.h se cambió de ../device_base.h a device_base.h para que
la carpeta sea autocontenida al abrir esp32C3_speaker.ino en Arduino IDE.

PRIMERA PRUEBA RECOMENDADA
1. Abrir esp32C3_speaker/esp32C3_speaker.ino en Arduino IDE.
2. Seleccionar la misma placa ESP32-C3 y el mismo esquema de particiones que usa el proyecto estable.
3. Confirmar que están instaladas las librerías usadas por el proyecto original:
   - PubSubClient
   - ArduinoJson
   - ESP8266Audio
   - Preferences/WiFi/HTTPClient/HTTPUpdate (incluidas con ESP32 Arduino Core)
4. Compilar antes de cargar.
5. Probar primero un solo nodo, idealmente LLAMA.
6. Si compila, cargar al nodo y observar el monitor serie a 115200.

IMPORTANTE
- config.h contiene credenciales de red/MQTT: no subir esta carpeta a un repositorio público.
- El pinout MAX98357A se conserva como estaba en la versión recibida del proyecto común.
- AUDIO_PLAY activa/desactiva el organismo; cada voz decide cuándo reproducir su WAV.
- ACARICIA y CANTA siguen siendo traducciones parciales en esta v2.
