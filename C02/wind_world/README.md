# Wind World

A procedural, wind-driven landscape for an art installation, in the spirit
of *Flower* / *flOw*: rolling hills, swaying grass, flowers and drifting
petals. The **camera is fixed** and the **world scrolls and sways** under
it, driven live by an anemometer (speed + direction).

Everything is generated at runtime from code and shaders — no imported
meshes, no textures. Low-poly, GPU-driven, and built to run unattended for
as long as the installation needs it to.

## Requirements

- Godot 4.3+ (Forward+ renderer, the default for desktop)
- Python 3 + `paho-mqtt` for the wind bridge (`pip install paho-mqtt`)

## Opening it

Open `project.godot` in Godot and press Play (or F5). With no anemometer
connected it runs a simulated gusty breeze automatically, so you can look
at it immediately. You can also steer it by hand: arrow keys / WASD change
wind direction, `+`/`-` change wind speed — useful for testing the look
without any hardware in the loop.

Debug keys:

- `F1` — wireframe on/off
- `F2` — hide/show grass, flowers and petals (to read the terrain clearly)
- `F3` — HUD with wind, travel speed, heading, scroll offset and FPS
- `1`–`9` — blend into preset `configs/<n>_name.tres` (top row or keypad; see Presets below)
- `F4` — blend into the next preset
- `0` — auto-cycle through the presets on/off (every `auto_cycle_seconds` on the World node)

Mouse:

- left-click + drag — turn the heading (where you travel and look)
- wheel — travel speed multiplier (×1.15 per notch, up to ×20; wheel all
  the way down stops)

## How it works

### The camera always travels forward

The `World` node (`scripts/world.gd`) keeps a single value, `scroll_offset:
Vector2`, that advances along the heading (where the camera looks) every frame, at
`(forward_speed_base + wind_speed * scroll_speed_scale) * speed_multiplier`. That one number is
handed to the terrain, grass and flower shaders as a uniform, and every
visual "movement" you see is those shaders re-reading their own position
against `scroll_offset`. Wind *direction* only bends the grass/flowers and
drives the petals; it never changes where you travel.

The camera floats rather than walks: it glides over a smoothed, look-ahead
version of the terrain: it looks up to 60 m ahead and starts climbing early
enough to clear whatever is coming (tilting its gaze up as it rises), and
comes down only under a weak, moon-like gravity -- so it floats over dips
and sails past crests. It breathes and
drifts slowly, banks into turns, tilts a little with the slope ahead, and
turns its gaze toward the glowing "special" props (never more than one in
view at a time) -- noticing them early, far ahead, and letting go only once
they are well behind -- as it
passes them -- while still travelling forward. It rides the terrain height so
hills and mountains don't swallow it. `scripts/terrain_noise.gd` is an exact
CPU copy of the shader height field (integer hash, so both agree); the
camera and the props use it to know where the ground is.

### Infinite ground, no giant world

Two techniques, both standard for this kind of piece:

- **Terrain**: one plane, always centered on the camera. Its vertex shader
  displaces height using a noise function sampled at `local_position +
  scroll_offset` — so the *shape* scrolls even though the mesh never grows.
  The mesh is snapped to its own grid (it only slides by the sub-cell
  remainder), so each vertex always samples the same world point and the
  land stays rock-steady instead of shimmering as it scrolls.
- **Grass / flowers**: `MultiMeshInstance3D` fields of a few thousand
  blades/flowers, seeded once in a fixed tile (`field_tile_size`, default
  90m) around the origin. Each instance's shader computes `wrap(seed_position
  - scroll_offset, tile_size)` — so as the wind blows, instances stream past
  the camera and recycle to the opposite edge of the tile, each time
  representing a *new* patch of the (conceptually) infinite field. Their
  height is sampled from the exact same noise function as the terrain, at
  the position they currently represent, so grass always sits correctly on
  the hills.
- **Petals**: a `GPUParticles3D` emitter around the camera, direction and
  velocity driven by wind each frame. Particles are naturally infinite —
  they're recycled by lifetime, not position — so no special-casing needed.

### Floating point over long runs — solved by construction

You asked about this directly, so to be precise about what's actually
happening: `scroll_offset` is **wrapped every frame** to `[0, 8192)`
(`WRAP_PERIOD` in `world.gd`, must match `W_WRAP_PERIOD` in
`shaders/common.gdshaderinc`). It never grows unbounded, so the float32
values sent to the GPU never lose precision, no matter how many days the
installation runs.

The wrap itself is invisible because the noise function the terrain and
fields are built on is made periodic with that exact same period (see
`w_terrain_height` in `common.gdshaderinc`) — so `noise(x) == noise(x +
8192)` and the moment `scroll_offset` wraps from ~8192 back to 0, nothing
visibly jumps. At realistic gallery wind speeds that repeat is many hours
away, and because it's unstructured noise rather than a recognizable
landmark, the repeat itself isn't something a viewer would ever notice.

No double-precision engine build is needed for any of this.

### Wind mood

Sky color, fog density and sun brightness all drift slightly with wind
speed (`_update_mood` in `world.gd`) — calm air reads soft and pastel,
strong wind reads a bit more saturated and dramatic. Same live value driving
everything else, so it's automatically in sync.

## Wiring up the real anemometer (MQTT)

Godot's `WindInput` autoload (`scripts/wind_input.gd`) only ever speaks
UDP — plain text packets `"speed,direction_deg"`, e.g. `"3.4,225.0"`, on
port 9000 by default. It knows nothing about MQTT on purpose, so the
transport can change without touching the Godot project at all.

`tools/mqtt_bridge.py` is the translator: it subscribes to your broker and
forwards each reading as that UDP packet.

```
pip install paho-mqtt
python3 tools/mqtt_bridge.py --broker <broker-ip> --topic sensors/wind \
    --speed-field speed --direction-field direction
```

It auto-detects a few payload shapes (JSON with configurable field names,
nested JSON via dotted paths, or plain `"speed,direction"` text), and has
flags for unit conversion (`--speed-unit knots|mph|kmh|ms`) and for
whether your sensor reports the direction wind blows *from* or *to*
(`--direction-mode`). Run `python3 tools/mqtt_bridge.py --help` for the
full list — once you share the actual MQTT topic/payload shape your
anemometer publishes, tell me and I'll pin the flags (or the script) to it
exactly rather than leave it configurable.

Run the bridge on the same machine as Godot, or point `--godot-host` at the
installation machine's IP if it runs elsewhere on the network.

## Presets and tuning

Everything about the look lives in a `WorldConfig` resource
(`scripts/world_config.gd`), saved as `.tres` files in `configs/`:

- `configs/1_meadow.tres` — key `1`: the original green meadow (the default in `Main.tscn`)
- `configs/4_neon.tres` — key `4`: NEON / posthumanism: night, stepped
  ziggurat terrain wired with a pulsing cyan grid and magenta contour lines,
  fibre-optic grass, LED flowers, glowing monoliths / pillars / pods among
  dead black plant silhouettes, huge hovering halos as specials, rising data
  motes and falling sparks; faster and looser camera
- `configs/3_estepa.tres` — key `3`: Patagonian steppe: open plains and mesetas,
  straw grass bent by the wind, zampa / jarilla / alpataco / coirón plants,
  a golden-glowing jarilla as the special prop, dust and floating seeds
- `configs/2_wasteland.tres` — key `2`: post-apocalyptic: terraced mesas, leaning
  concrete/rust ruins, dry grass, dust haze, ash, dust puffs and embers

Press a number key to blend into the preset whose file name starts with that
number (`3` → `3_whatever.tres`), or `F4` for the next one. There is no cut:
over the target's `transition_time` (25 s by default) the land morphs from one
height field into the other, colors / sky / fog / light drift across, grass
and flowers thin or thicken, particle layers crossfade, and props are
swapped out while they are behind you (out of view), so the new look fills
in within a few seconds; the number of props blends too. Pressing another number
mid-blend queues it. Set `auto_cycle_seconds` on the World node (or press
`0`) to let it drift through the presets on its own —
you keep flying the whole time.

To make a new look, duplicate a preset in the FileSystem dock, name it `3_something.tres` (next free number), edit it in the
Inspector, and key `3` picks it up automatically.
To change which one starts, set `config` on the `World` node.

What a config holds:

- **Terrain shape**: `hill_*`, `mountain_*`, `warp_strength`,
  `terrace_step` / `terrace_strength` (0 = smooth, 1 = hard mesas)
- **Terrain colors**: low / high / rock (steep) / peak
- **Grass / Flowers**: counts, sizes, colors, bend strength
- **Props**: count, shapes (repeat a name to weight it), colors, sizes,
  landmark chance, vertical stretch (towers), tilt, how deep they're sunk
- **Sky and light**: calm vs windy sky/fog/sun (blended by live wind), sun angle, glow
- **Particles**: a list of `ParticleLayer`s — amount, size, color over life
  (values above 1.0 glow), emission box, height, gravity (negative falls,
  positive rises), how much the wind pushes them
- **Glow** (all off by default): terrain grid + contour lines + pulse,
  grass tip glow, flower glow, prop glow, bloom amount
- **Plants**: `prop_shapes` also accepts `zampa`, `jarilla`, `alpataco`,
  `coiron` -- procedural low-poly Patagonian steppe plants
  (`scripts/plant_meshes.gd`), each repeat of a name is a new variant
- **Special props**: how often they appear, shapes, glow color/strength,
  size, stretch (monoliths), hover height/bob, spin, the light they cast
- **Travel / Camera**: base speed, speed per m/s of wind, glide height,
  look-ahead, the flight model (moon gravity, climb acceleration, max climb /
  fall speed, how much climbing tilts the gaze up), how floaty (breathing,
  drift, idle roll, banking),
  how much the pitch follows the slope ahead (and its cap), and how the gaze
  turns toward special props (strength, max angle, range, watch time,
  cooldown, how lazily it turns and lets go)
- **Transition**: seconds to blend into this preset

The `World` node itself only keeps the runtime controls:
`speed_multiplier`, `mouse_turn_speed`, `heading_smoothing`.

## What's next (once you're ready)

- Drop `.glb`/`.gltf` props (a tree, a sculpture, whatever else is part of
  the piece) into the scene as ordinary `MeshInstance3D`/scene instances —
  they can read `WindInput.current_speed` / `current_direction` directly if
  you want them to react too, or just sit as static landmarks the field
  scrolls past.
- Point `mqtt_bridge.py` at the real broker/topic once you have it running.
- If the installation runs fullscreen on a dedicated machine, set
  `window/size` and disable the window border in Project Settings, or export
  it as a standalone build.

## Project layout

```
project.godot
icon.svg
scenes/
  Main.tscn            entry scene, just the World node
  default_env.tres      fallback environment (World builds its own at runtime)
scripts/
  wind_input.gd          autoload: UDP listener + simulation/keyboard fallback
  world.gd                builds terrain/grass/flowers/petals/props, drives the scroll
  terrain_noise.gd        CPU copy of the terrain height field (camera + props)
  world_config.gd         WorldConfig resource: one complete look
  particle_layer.gd       ParticleLayer resource: one particle layer
configs/
  1_meadow.tres           original look (key 1)
  2_wasteland.tres        post-apocalyptic look (key 2)
shaders/
  common.gdshaderinc      shared noise + terrain height field
  terrain.gdshader
  grass.gdshader
  flower.gdshader
  petal.gdshader
tools/
  mqtt_bridge.py           MQTT -> UDP translator for the real anemometer
```
