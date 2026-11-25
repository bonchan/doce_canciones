# SatNOGS installation

Several full-screen displays showing the same simulated pass at the same moment. One local
server keeps the timeline (which pass is on air, which come next, their AOS/LOS times) and
sends it to every display over a WebSocket; each display syncs its clock with the server
and draws "now" from that timeline. A display that reloads picks up exactly where the others
are. Passes come from `../downloads` (listener.py) and new ones join the rotation by themselves.

## Run

```
pnpm install
pnpm build    # the displays; again after changing the code
pnpm start    # the server, on http://<this computer>:5180
```

On the installation's Linux computers `../agent/install.sh --server` sets this up as a service,
and each computer's agent opens the displays full screen, one per screen (`agent.ini`).

Operator page, in a normal browser tab: http://127.0.0.1:5180/?view=control
(skip / restart the pass, identify which monitor is which, reload all displays, play a pass next).

Development: `pnpm dev`, then http://127.0.0.1:5180/ lists every view with hot reload.

## Views

| view | shows |
|---|---|
| `globe` | the recording station seen from space, the orbit, the track and the satellite |
| `globe` + `camera=follow` | the camera riding along behind the satellite |
| `image` | the image arriving line by line (`view=image&audio=1` plays the sound) |
| `schedule` | received, on air and upcoming passes with their status and countdowns |
| `telemetry` | sky plot from the station, Doppler curve, azimuth / elevation / range / downlink |
| `signal` | the APT recording's spectrum as a waterfall; for METEOR a (simulated) QPSK constellation |
| `control` | operator page |
| `grid` | six views on one screen (2 columns × 3 rows): pick a view per cell, × on hover closes it |

Every display has the same top bar (pass, phase, clock, progress line) and flashes its border
at AOS and LOS at the same instant.

## Languages

The displays' text is in `src/lang/en.json` and `src/lang/es.json`; pick one on the operator
page (Settings, "display language") and every display switches right away. Each display also
remembers it in localStorage, so it starts in that language after a reload. To add a language,
copy `en.json` to e.g. `pt.json`, translate the values (keep the `{placeholders}`), add it to
`LANGUAGES` in `src/i18n.ts` and run `pnpm build`. The operator page stays in English.

## Phrases

With "phrase" on (Settings), the words of the language file float around the Earth on both
globes, standing upright, at the same places on both. A few of them (the phrase) lie on the
satellite's path; when it flies over one, the word lights up and starts arriving in the
received image, at that row, left or right as it lies beside the track. When the pass changes,
the same words drift to new places. Everything comes from the pass on the timeline, so every
display agrees.

On the signal display the same words show up as the satellite reaches them: written into the
spectrum on the NOAA waterfall (left or right as in the image), and spelled by the
constellation's dots for METEOR, which then go back to the signal.

The image is only changed on screen (each display's copy in memory); the files in
../downloads are never touched. The words are the `phrases` section of each language file.
`src/art/phrases.ts` picks the phrase (`RandomWords`: 3 to 6 words; any `PhraseGenerator` can
replace it), `src/art/field.ts` places the words, `src/views/globeWords.ts` shows them on the
globes and `src/art/burn.ts` draws them into the image.

## Sky

The satellites look down at the clouds; the photos in `../sky_images` look up at them. The `sky`
setting (a slider on the operator page and on core2's page) is the share of the passes that get
one: 0 none, 100 all, spread evenly along the timeline (at 50% about every other pass). A pass's
photo is the same on every display, and they come in one shuffled order, so all of them show
before any repeats. A pass without a photo looks as before.

- **Every screen, while the pass is on air: ghosts**: now and then the signal breaks up and
  pieces of the photo come through, more the weaker the signal: often with the satellite low
  (AOS, LOS), seldom with it overhead. As the pass's radio would: on NOAA (analog) lines torn
  sideways with their colours split, a faint echo a little to the right, the frame rolling,
  scanlines; on METEOR (digital) runs of 8 x 8 blocks from the wrong place, a row smeared down,
  the photo surfacing in scattered blocks. Every display at the same instant, each its own pieces.
  One at a time: a ghost that would start while another is on doesn't happen.
  Each of the six on its own (`ghosts`, operator page and core2's page): when it appears (`low`:
  the more the lower the satellite, as designed; `high`: the other way round; `steady`; `off`),
  every how many seconds on average (`delay`; for low / high, where there are most) and how
  strongly (`prominence`, %: 100 as designed, 0 to 500: how many pieces, how big, how far out
  of place, how opaque). `ghostsOn` turns them all off and back on, keeping those settings.
  **Test now** (per kind, or all, one after another): that ghost right away on every display at once, at its
  prominence, whatever its settings say about when, even switched off and on a pass without a
  photo (it borrows the one the pass would have had).
- **Every screen but the globes, at the top of the pass**: at the culmination (the satellite as
  high over the station as it gets) the screens look up for about 10 seconds: the photo fills
  the screen under the top bar, each display a different window into it, all drifting with the
  same wind. Not on passes that go by in under 25 s. Its own section of settings (`cenit`,
  operator page and core2's page): on / off, fade in, hold (centred on the top of the pass), fade
  out, opacity, zoom (each display's window into the photo), drift with the wind, the shortest
  pass it stops on; and **Test now**: the moment right away on every display with those settings,
  even switched off and on a pass without a photo (it borrows the one the pass would have had).
- **Reception**: behind the scan line, the photo develops wherever the satellite saw cloud (and
  in the phrase's letters), mirrored, as seen from the other side. That second line sets off a
  while after AOS, reaches the scan line at 92% of the pass and arrives with it from there.
- **Globes** (not on real passes: there the map as it is): the photo wrapped around the Earth like a texture, over the map (80%): a square
  from its middle and its mirror image, so it goes round without a seam, the middle over the
  station. It fades from one pass's sky to the next.
- **Telemetry**: the sky plot becomes an all-sky camera: the photo as a fisheye dome, zenith in
  the middle and horizon at the edge, turning slowly under the track.
- **Signal**: on NOAA the photo is behind the waterfall and shows through its noise (the brighter
  the noise, the more of it), the signal keeps its colours; on METEOR the constellation's dots
  take the photo's colours, each the colour of the photo where it lands.
- **Passes**: each row with a photo over a strip of it; the one on air drifts.

Photos added to the folder join within 30 s. The files are never changed: everything is drawn
on screen.

The photos are big (up to 24 megapixels). With sharp installed the server sends each display a
copy at the size it needs; without it they go full size and every display scales them itself,
which is much heavier for the display computers:

```
pnpm add sharp
```

`src/art/sky.ts` picks the photo, `src/art/skyImages.ts` makes the dome and the strips, `src/components/Cenit.tsx` is the moment the screens look up, `src/components/Ghosts.tsx` the
ghosts (how often, at the top), `server/sky.ts` serves them.

## Live passes (the real receiver)

The server can follow a real receiver: raspberry_sat on a Raspberry Pi (SatDump, Meteor LRPT).
Its own section of settings, `receiver` (operator page and core2's page, "Real passes"; live, no
restart): on / off, its address (`http://rpi4b.local:8000`), the lowest pass that goes live (°),
and how long after AOS the screens switch to it (s). Only the server talks to the Pi
(`server/receiver.ts`), by its own API:

- Every minute its upcoming passes, the ones it will record (`/api/schedule`), with its station
  (`/api/tles`). Each becomes a live slot at its real AOS and LOS, real time whatever the speed.
  Replays go on until its AOS; then the screens switch straight to it, already receiving (no
  approach, no waiting): the replay on air is cut, the ones after the live pass follow on.
- Once a second while a live slot is near or on air, its reading and the pass's samples
  (`/api/live`): where the satellite is, SNR, the decoder's lock, the data so far. Four times a
  second during the pass, its spectrum (`/api/spectrum`). Every display gets them (one that joins
  late gets the pass's samples so far).
- What the screens make of it: the top bar marks it LIVE; the telemetry sky plot paints the track
  green while frames sync and red while not, as raspberry_sat does, with the satellite where the
  receiver says, and the spectrum in place of the doppler curve; the signal screen draws the signal
  over the pass (SNR, the elevation behind it, the sync strip); the reception screen, until the
  image exists, is a waterfall of the receiver's spectrum with the phrase's words written into it
  as the satellite reaches them.
- No ghosts on a live pass (a test still shows).
- Once the receiver has decoded a pass (a few minutes after LOS) it joins the library
  (`server/importer.ts`, `importPasses`): a folder in `downloads/` like listener.py's, with the image
  kind shown for its satellite family (the image setting, else the default) and the receiver's main
  image when it's another, as JPEGs, and its signal (`signal.json`). It's replayed like the others;
  with `playImported` on it plays right after the one on air. Its replays draw the real signal on
  the signal screen and the green / red track on the sky plot. Passes started in the last 6 hours.
- The passes board, top to bottom: the last 3 received; the one on air (live or a replay); the live
  pass past LOS while the Pi processes it, saying how far (its WebSocket topic `processing`:
  decoding, images, finishing, with a percent when it can tell; then importing); the upcoming ones,
  the processed live pass first (imported straight away, it plays right after the one on air when
  `playImported` is on; without an image the row says so till the pass on air ends); the next real
  pass pinned under the list (from the receiver's schedule, with its countdown), not from the live
  pass's AOS till its processed replay is on air. The live pass itself never joins the received:
  its replay does, once played. Real passes (live, or received and imported) in their own colour,
  the live one tagged LIVE. Passes imported that aren't the live one just processed (from before
  the server started) join the end of the list.
- The Pi not answering (switched off, the network down) doesn't stop anything: after 3 requests in
  a row unanswered (3 min, or some 20 s when a live pass is near) its passes leave the timeline, a
  live one on air included, and the replays go on; they come back when it answers again.

## core2 (MQTT)

With `mqtt.enabled` in installation.json the server joins core2's bus as a device of type
`installation.satnogs` (`server/device.ts`, the same contract as the ESP32s): telemetry every 3 s
with the pass on air, the settings, and every display with whether it is showing (connected, on
screen and drawing: each display reports its frames per second every 2 s). Commands: `SKIP`,
`RESTART`, `RELOAD` / `IDENTIFY` (all displays, or `{"ids": [...]}`), `SETTINGS` (the operator
page's settings, e.g. `{"speed": 4}`, `{"sky": 50}` or `{"ghosts": {"tear": {"delay": 6}}}`, only what's in it changing), `QUEUE` (`{"pass_id": ...}`)
`GHOST` (a ghost test, now: `{"kind": "tear"}`, `{"kinds": [...]}`, or `{}` for all) and `CENIT`
(a test of the look-up moment, now). Its
telemetry names the pass's sky photo (`sky_photo`). It's in zone `satnogs`,
like the display computers' agents (`../agent`), so core2's zone filter shows them together.
Fill in `username` / `password` (the broker's, as in wind_world's config.cfg) and restart.

The agents use `GET /api/displays` and `POST /api/command` (`{"action": "identify" | "reload",
"ids": [...]}`) on this server.

## installation.json

Not in git, because it holds the MQTT user and password: `installation.example.json` is the
template, copied to `installation.json` the first time the server runs. Settings
meant for every copy go into the template; the password only into `installation.json`.

Everything except `server`, `downloads`, `skyImages` and `mqtt` can be changed live from the
operator page (Settings), and saving the file by hand applies too; those four need a restart. Which view
each screen shows is set on each computer, in its agent's `agent.ini`.

- `location`: `station` (each pass over its recording station) or `neuquen`
- `order`: `shuffle` (varies satellite and station) or `chronological`; `satellites`: only these (empty = all)
- `speed`: 1 = real time; `waitSeconds` / `approachSeconds` / `departSeconds`: the gaps around each pass
- `images`: preferred image per satellite family, `volume`, `imagery` (`esri` or offline `natural`)
- `hideCursor`: hide the mouse pointer on the displays; `language`: `en` or `es`
- `phrases`: words float around the Earth; the ones the satellite flies over arrive in the image
- `sky`: % of the passes with a sky photo, 0 to 100 (see Sky); `skyImages`: their folder, `../sky_images`
- `cenit`: the look-up moment (see Sky): `{ "on": true, "fadeIn": 1.8, "hold": 5.5, "fadeOut":
  2.6, "opacity": 100, "zoom": 135, "drift": 3, "minPass": 25 }` (seconds; opacity, zoom and drift
  in %); fields left out are as designed
- `receiver`: the real passes (see Live passes): `{ "enabled": true, "url": "http://rpi4b.local:8000",
  "minElevation": 0, "joinDelay": 0, "importPasses": true, "playImported": true }`
- `ghostsOn`: the ghosts at all (`false` keeps their settings below)
- `ghosts`: per kind (`tear`, `echo`, `roll` on NOAA; `blocks`, `smear`, `mosaic` on METEOR),
  `{ "appear": "low" | "high" | "steady" | "off", "delay": seconds, "prominence": % }` (see Sky);
  kinds or fields left out are as designed
- `server.host`: `0.0.0.0` to let displays on other computers connect (open `http://<this pc>:5180/?view=...` there)
