# SatNOGS installation

Several full-screen displays showing the same simulated pass at the same moment. One local
server keeps the timeline (which pass is on air, which come next, their AOS/LOS times) and
sends it to every display over a WebSocket; each display syncs its clock with the server
and draws "now" from that timeline. A display that reloads picks up exactly where the others
are. Passes come from `../downloads` (listener.py) and new ones join the rotation by themselves.

## Run

```
pnpm install
powershell -ExecutionPolicy Bypass -File .\launch.ps1 -List       # which screen is which (left to right)
powershell -ExecutionPolicy Bypass -File .\launch.ps1             # server + one kiosk window per display
powershell -ExecutionPolicy Bypass -File .\launch.ps1 -Windowed   # the same in small windows, to try it on one monitor
powershell -ExecutionPolicy Bypass -File .\launch.ps1 -Stop       # close the displays, stop the server
```

The first launch builds the displays (`pnpm build`); after changing the code run `pnpm build`
again, then launch. Kiosk windows have no browser UI: Alt+F4 closes the one in focus.

Operator page, in a normal browser tab: http://127.0.0.1:5180/?view=control
(skip / restart the pass, identify which monitor is which, reload all displays, play a pass next).

Development: `pnpm dev`, then http://127.0.0.1:5180/ lists every view with hot reload.

## Views

| view | shows |
|---|---|
| `globe` | the recording station seen from space, the orbit, the track and the satellite |
| `globe` + `camera=follow` | the camera riding along behind the satellite |
| `image` | the image arriving line by line (put `"audio": true` on this one) |
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

## installation.json

Everything except `server`, `downloads`, `browser` and `displays` can be changed live from the
operator page (Settings), and saving the file by hand applies too; the other four need a restart.

- `displays`: one entry per window: `view`, `screen` (number from `-List`), optional `audio`,
  `params` (extra query, e.g. `camera=follow`) and `position` (`[x, y]` to place a window by hand
  when monitors use different scaling)
- `location`: `station` (each pass over its recording station) or `neuquen`
- `order`: `shuffle` (varies satellite and station) or `chronological`; `satellites`: only these (empty = all)
- `speed`: 1 = real time; `waitSeconds` / `approachSeconds` / `departSeconds`: the gaps around each pass
- `images`: preferred image per satellite family, `volume`, `imagery` (`esri` or offline `natural`)
- `hideCursor`: hide the mouse pointer on the displays; `language`: `en` or `es`
- `phrases`: words float around the Earth; the ones the satellite flies over arrive in the image
- `server.host`: `0.0.0.0` to let displays on other computers connect (open `http://<this pc>:5180/?view=...` there)
