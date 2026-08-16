# prop-control-gui

Vue 3 + Vite frontend for the QRET propulsion test stand, built from one
codebase into two shapes.

| Target | Command | Output | Where it runs |
|---|---|---|---|
| **desktop** | `npm run tauri dev` / `npm run build` | `dist/` (bundled by Tauri) | Launch control. Full command authority. |
| **web** | `npm run dev:web` / `npm run build:web` | `dist-web/` (served by nginx) | Tablets at the pad. **View only.** |

## The view-only web build

Engineers at the pad need to see pressures and control states without radioing
launch control for every reading. The web build gives them that and very little
else: all stand commanding stays at launch control. The narrow exceptions —
device discovery and the camera panel — are spelled out below.

`src/lib/platform.js` owns the distinction. Every capability is derived from
`mode()` there rather than checked ad hoc, so what the pad can do is answerable
by reading one file. `src/lib/desktop.js` is the only module permitted to import
`@tauri-apps/api` — it wraps every Rust command with a web-mode fallback, which
also keeps Tauri code (which throws on load outside a webview) out of the web
bundle.

**Command authority is gated in two places, and both matter.**
`useServerApi.js` is the choke point that rejects mutating calls. But the
guards in `App.vue` are what actually protect a live test: stream setup, the
re-arm watchdog and the 5 s status poll all run off App.vue's own lifecycle
rather than any button, and QLCP `STREAM`/`STOP` are *broadcast*. Without those
guards a tablet would re-arm the stream rate for the whole stand just by being
open, and `STOP`+`STREAM` carries a deliberate telemetry gap.

The permitted writes are `POST /v1/discover`, so someone who just powered a
device on can pull it in without a radio call, and the camera panel's own calls
(below). Discovery is safe because the server already broadcasts that exact
multicast every 30 s on its own — the button only skips the wait. Kasa discovery
is deliberately *not* included: it is a broadcast-and-wait scan that occupies
the server's event loop for seconds.

### The camera exception

The camera panel is available at the pad with PTZ and reconnect, gated by
`CAPS.cameraControl` in `platform.js` rather than `CAPS.commands`. Neither call
touches the stand: PTZ aims one camera and reconnect only re-dials the server's
own camera connections, and the engineer standing at the pad is the person best
placed to aim a camera. The panel talks to the server and to mediamtx with its
own `fetch` calls rather than through `useServerApi.js`, which is why the
permission is a flag of its own — revoking it is one line in `platform.js`.

Streams are opt-in: nothing is requested until **Load** is pressed, and every
stream is torn down when the panel is navigated away from. A tablet that never
opens the panel costs the wifi link nothing.

### Verifying it stays read-only

Serve `dist-web/` against a server (or a request-logging stub) and watch the
network traffic. Across a whole session with the camera panel closed, including
a device disconnect and rejoin, the only non-GET request may be
`POST /v1/discover`, and only in direct response to the discover button.
Anything else is a regression.

With the camera panel open and loaded, four more are expected, and only these:
WHEP `POST`/`DELETE` to mediamtx on 8889, `POST /v1/camera` (PTZ) and
`POST /v1/cameras/reconnect`.

### Known gaps

- **Tares** live in Rust and are applied to displayed values, so the web build
  shows *raw* readings while launch control shows tared ones. The two can
  disagree for the same sensor over the radio. Fixing it properly means moving
  tares into server state on `/ws/state`.
- **The pad cannot tell a test is running.** `testActive` is synced only via
  `BroadcastChannel` (same browser, same origin), so the discover button cannot
  be disabled during a hot fire.
- **Flight and Sessions panels are hidden** in the web build — the offline
  basemap has no browser equivalent (`tileSource.js` falls back to online OSM
  tiles, which are unavailable at a launch site), and pulling a session ZIP
  would compete with the telemetry the test depends on.
- **Touch ergonomics**: the nav, Control and Camera panels are sized and
  pointer-driven for tablets; the Data (graph) and Debug panels are not, and
  the graph's popovers still close on `mousedown` only
  (`graph_panel.vue:214`).

## Deployment

`Dockerfile.web` builds the web target into an nginx image listening on **8080**
(8000, 8189, 8558, 8889, 9997 and 64738 are taken by the server stack). It
serves static files only — the browser talks to the API and mediamtx directly,
so the server needs no changes to host it.

`PROP_SERVER_IP` optionally pins the API target. Leaving it unset is the normal
case: the SPA then falls back to whichever host served the page, which is
correct when the container runs alongside the server.

In `prop-teststand/compose.prod.yml` the `gui` service is behind a profile, so
it is off unless explicitly enabled:

```sh
COMPOSE_PROFILES=gui docker compose -f compose.prod.yml up -d
# or set COMPOSE_PROFILES=gui in .env
```

`.github/workflows/release.yml` publishes both shapes on a GitHub Release:
desktop installers attached to the release, and a multi-arch image pushed to
`ghcr.io/<repo>-web` tagged with the release tag and `latest`. Pin `GUI_TAG` on
the server so what pad tablets load is a deliberate choice.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
