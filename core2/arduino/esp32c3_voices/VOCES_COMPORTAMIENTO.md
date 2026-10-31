# Voces: qué hace cada tipo y qué params usa

El tipo de voz es el campo `name` (SET `{"name": "LLAMA"}`). Cada tipo corre un
algoritmo distinto en `organismo_comportamiento.h`, y **el mismo param puede
significar cosas distintas según la voz**. Un param que una voz no lee no hace
nada en esa voz.

Un nodo sin tipo guardado arranca como `NONE` (en silencio).

## Dos familias

- **Loop continuo, se modula el volumen:** INTENTA, CRUJE, SALPICA, ACARICIA,
  VOZSEMILLA. El WAV se repite sin parar y solo se mueve el volumen.
- **WAV completo y después silencio:** LLAMA, RESOPLA, CANTA. Cada aparición es
  el archivo entero, después una pausa.

## Por voz

| Voz | Params que lee |
|---|---|
| LLAMA | volume, restMovement |
| INTENTA | volume, restMovement, initialPresence, latentVolume, entrance, duration |
| RESOPLA | igual que INTENTA + irregularity |
| CRUJE | igual que INTENTA + irregularity |
| VOZSEMILLA | contact (solo) |
| SALPICA | volume, presence |
| ACARICIA | volume, meeting |
| CANTA | volume, appearance, doubt |

Ninguna voz lee **airMovement, aperture, answer ni expansion**.

### LLAMA
Reproduce el WAV completo con un fade-in corto (0.35 s) y espera.
- `restMovement`: **cada cuánto vuelve**. 0 = cada 60–120 s, 1 = cada 7–18 s.

### INTENTA
Loop continuo con "espasmos" de volumen (seno elevado a la 12: casi plano con
picos bruscos).
- `restMovement`: **velocidad y fuerza de los espasmos**. 0 = sin espasmos.

### RESOPLA
Reproduce el WAV una vez por respiración y hace pausa.
- `restMovement`: **velocidad de reproducción, que también cambia la altura**
  (0.62× a 2.4×), y **la pausa entre respiraciones** (2.8 s a 15 ms).
- `irregularity`: un poco de variación aleatoria en ambas cosas (±5–8 %).

### CRUJE
Loop cortado por tres senos mezclados: cuando bajan de un umbral el sonido casi
se corta.
- `restMovement`: **velocidad y cantidad de cortes**.
- `irregularity`: sube el umbral, así hay más huecos.

### VOZSEMILLA
La única que usa el sensor de cobre. Al tocar, la voz crece con el tiempo y salta
de altura ("rezo → chisme"). Al soltar vuelve en unos 3 s.
- `contact`: solo escala la sensibilidad del sensor.
- El volumen está fijo en el código: **`volume` no hace nada acá**.

### SALPICA
Respiración lenta (dos senos muy lentos, ciclos de ~60–100 s).
- `presence`: profundidad de la respiración. 1 = plano.

### ACARICIA
Oleaje muy suave (dos senos lentos).
- `meeting`: sube el piso, así el oleaje es todavía más chico.

### CANTA
Reproduce el WAV completo cada algunos segundos, cada vez un poco más agudo o
más grave.
- `appearance`: frecuencia (más = más seguido).
- `doubt`: cuánto se puede desafinar cada vez.

## Lo que sí es común

- INTENTA, RESOPLA y CRUJE comparten la misma entrada
  (`entrance` / `duration` / `initialPresence`) y el mismo piso `latentVolume`.
  En esas tres significan lo mismo.
- `volume` **no es comparable entre voces**. Cada voz lo multiplica por una
  ganancia propia (`gananciaCuerpo` en `defaultsVoz()`):

  | Voz | Multiplicador |
  |---|---|
  | CRUJE | ×3.5 |
  | VOZSEMILLA | ×3 (pero ignora `volume`) |
  | INTENTA | ×2 |
  | LLAMA, SALPICA | ×1 |
  | RESOPLA | ×0.5 |
  | ACARICIA, CANTA | no aplican el multiplicador |
