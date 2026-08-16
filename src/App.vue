<script setup>
import { computed, onMounted, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import { CAPS } from "./lib/platform.js";
import {
  fetchServerIp,
  submitIp,
  startRecording,
  stopRecording,
  updateControlStates,
  localRecordingActive as fetchLocalRecordingActive,
  setServerSessionLock,
} from "./lib/desktop.js";
import {
  noteDeviceRegistered,
  noteDevicesPresent,
  noteStateDisconnected,
} from "./composables/useSwitchSync.js";
import { useControlLayer } from "./composables/useControlLayer.js";
import { useServerApi, PREVIEW_STREAM_HZ } from "./composables/useServerApi.js";
import { useStateStream } from "./composables/useStateStream.js";
import { useTelemetryStream, normalizeDownsampleAlgorithm, TELEMETRY_WINDOW_SEC, TELEMETRY_WINDOW_OPTIONS } from "./composables/useTelemetryStream.js";
import { useFlightTrack } from "./composables/useFlightTrack.js";
import { useLogStream } from "./composables/useLogStream.js";
import "primeicons/primeicons.css";

import NavBar from "./components/nav_bar.vue";

import CameraPanel from "./windows/camera_panel.vue";
import GraphPanel from "./windows/graph_panel.vue";
import ControlPanel from "./windows/control_panel.vue";
import DebugPanel from "./windows/debug_panel.vue";
import FlightPanel from "./windows/flight_panel.vue";

import SettingsModal from "./components/settings_modal.vue";
import AboutModal from "./components/about_modal.vue";
import SwitchSyncModal from "./components/switch_sync_modal.vue";

const window_content = shallowRef(ControlPanel);
function setActive(component) {
  window_content.value = component;
  requestStatusSnapshot('window-switch');
}

// ── Command authority ────────────────────────────────────────────────────────
// The web build served to the pad is view-only. Guarding here as well as in
// useServerApi is what actually matters: everything below runs off App.vue's
// own lifecycle rather than any button, so without these guards a tablet at the
// pad would broadcast STOP/STREAM to the whole stand just by being open.
// The one exception is device discovery — see CAPS.espDiscovery.
const canCommand = CAPS.commands;

const navbarWidth = ref(180);
function onNavResize(w) {
  navbarWidth.value = w;
}

// ── Server connection ────────────────────────────────────────────────────────

const server_ip = ref("");
provide('serverIp', server_ip);

const pidConfig = ref(localStorage.getItem('qret-pid-config') || 'rocket-launch');
provide('pidConfig', pidConfig);

const testFrequency = ref(parseInt(localStorage.getItem('qret-test-frequency') ?? '', 10) || 190);
provide('testFrequency', testFrequency);

// Server-side downsampling for the display stream. Fixed per connection, so
// changing it reconnects /ws/telemetry/display — see useTelemetryStream.
const downsampleAlgorithm = ref(
  normalizeDownsampleAlgorithm(localStorage.getItem('qret-downsample-algorithm')),
);
provide('downsampleAlgorithm', downsampleAlgorithm);

// Flight map: every downloaded site is shown by default, layered by max zoom
// (nested high-res boxes draw over wide low-res ones). The persisted state is
// the *disabled* list (manifest `file` strings) so freshly downloaded sites
// appear without any bookkeeping.
function loadDisabledSites() {
  try {
    const parsed = JSON.parse(localStorage.getItem('qret-map-sites-disabled') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f === 'string') : [];
  } catch {
    return [];
  }
}
const mapSitesDisabled = ref(loadDisabledSites());
provide('mapSitesDisabled', mapSitesDisabled);

// Directory holding manifest.json + the .mbtiles files.
const mapsDir = ref(localStorage.getItem('qret-maps-dir') || '');
provide('mapsDir', mapsDir);

// Bumped whenever the set of downloaded maps changes on disk (a delete from
// settings). The flight panel watches it and rebuilds its layers — neither
// mapsDir nor mapSitesDisabled changes in that case, so there is nothing else
// for it to notice.
const mapsVersion = ref(0);
provide('mapsVersion', mapsVersion);

// A request to point the flight map at a site: { name, bbox, ts }. The ts makes
// repeat requests for the same site distinct so the panel re-applies them.
const mapFlyTo = ref(null);
provide('mapFlyTo', mapFlyTo);

function flyToSite({ name, bbox }) {
  if (!Array.isArray(bbox)) return;
  mapFlyTo.value = { name, bbox, ts: Date.now() };
  window_content.value = FlightPanel; // otherwise the jump happens off-screen
  settingsOpen.value = false;
}

const {
  stopStream,
  setStream,
  primeStream,
  setControl,
  requestStatus,
  discoverDevices,
  discoverKasaDevices,
  controlKasaDevice,
  sendEstop,
  setTare: apiSetTare,
  clearTare: apiClearTare,
  startSession,
  stopSession,
  listSessions,
  getSession,
  sessionDownloadUrl,
} = useServerApi(server_ip);

function requestStatusSnapshot(reason = 'manual') {
  if (!canCommand) return Promise.resolve();
  if (!server_ip.value) return Promise.resolve();
  return requestStatus().catch((err) =>
    console.error(`[App] STATUS request failed (${reason}):`, err)
  );
}
provide('requestStatusSnapshot', requestStatusSnapshot);

const STATUS_REFRESH_MS = 5_000;
let statusRefreshTimer = null;

function stopStatusRefresh() {
  if (statusRefreshTimer === null) return;
  clearInterval(statusRefreshTimer);
  statusRefreshTimer = null;
}

function startStatusRefresh() {
  stopStatusRefresh();
  if (!canCommand) return;
  if (!server_ip.value) return;
  statusRefreshTimer = setInterval(() => {
    requestStatusSnapshot('interval');
  }, STATUS_REFRESH_MS);
}

// ── Stream re-arm on device rejoin ───────────────────────────────────────────
// STREAM is a broadcast command with no per-device targeting, so a device that
// rejoins is never told to stream again and its charts stay blank until
// something re-issues it (which is why a page refresh "fixed" it — the IP watch
// below re-broadcasts). The idle-preview bootstrap only fires once per
// connection, so it does not cover a device that joins mid-session; this does.
//
// STOP first, then STREAM: a bare STREAM at the already-active rate is a no-op
// server-side (confirmed on hardware — re-arming without the STOP did nothing),
// which is why every path that does restore the stream (startTest, stopTest, IP
// change) stops it first. The cost is a brief gap for every device, so this is
// deliberately only triggered by a rejoin, not polled.
//
// QLCP supports targeted streams — swap this for a per-device command, with no
// STOP and no gap, if the server ever exposes one.

const STREAM_PREVIEW_HZ = 30;
const STREAM_REARM_DEBOUNCE_MS = 500;
let streamRearmTimer = null;
let streamRearmInFlight = false;
let streamRearmQueued   = false;

// Derived rather than tracked in its own ref: the recording lifecycle below
// owns every other setStream() call, so reading the rate back off that same
// state is what keeps a re-arm from resurrecting a rate the lifecycle has since
// moved on from. A server session or a laptop backup runs at the test
// frequency; an otherwise-connected server sits at the idle preview rate.
// 0 means nothing should be streaming — including for a client that cannot
// command: re-arming issues STOP+STREAM, a broadcast that would re-rate the
// whole stand, exactly what the view-only build must never do. Gating here
// rather than at each call site covers every consumer of the rate, the silence
// watchdog included.
//
// A computed rather than a plain function because the stream watchdog below
// watches it as a reactive source. The getter is lazy, so the forward
// references to the lifecycle state declared further down are safe — nothing
// reads it until well after setup.
const currentStreamHz = computed(() => {
  if (!canCommand || !server_ip.value) return 0;
  if (testActive.value || localRecordingActive.value) return testFrequency.value;
  return STREAM_PREVIEW_HZ;
});

function cancelStreamRearm() {
  if (streamRearmTimer === null) return;
  clearTimeout(streamRearmTimer);
  streamRearmTimer = null;
}

// A request arriving mid-flight is queued rather than dropped: the device that
// asked for it may have registered *after* the in-flight round already sent its
// STREAM, in which case that round did nothing for it and discarding the
// request would leave it silent for good.
async function rearmStream(reason) {
  // Skip while a start/stop transition is in flight — it is already issuing its
  // own STREAM, and racing it would leave the devices at the wrong rate.
  if (currentStreamHz.value <= 0 || lifecycleBusy.value) return;
  if (streamRearmInFlight) {
    streamRearmQueued = true;
    return;
  }

  streamRearmInFlight = true;
  try {
    do {
      streamRearmQueued = false;
      // Re-read each round: a queued request may have arrived after the
      // lifecycle moved to a different rate.
      const hz = currentStreamHz.value;
      if (hz <= 0) break;
      console.log(`[App] STREAM re-arm (${reason}) → STOP + ${hz} Hz`);
      await stopStream();
      await setStream(hz);
    } while (streamRearmQueued);
  } catch (err) {
    console.error(`[App] STREAM re-arm (${reason}) failed:`, err);
  } finally {
    streamRearmInFlight = false;
    streamRearmQueued   = false;
  }
}

// Debounced so several devices rejoining together produce one re-arm.
function scheduleStreamRearm(reason) {
  if (currentStreamHz.value <= 0) return;
  cancelStreamRearm();
  streamRearmTimer = setTimeout(() => {
    streamRearmTimer = null;
    rearmStream(reason);
  }, STREAM_REARM_DEBOUNCE_MS);
}

// ── State stream (/ws/state → devices, kasa, commands) ──────────────────────

// A device that just joined has never been told to stream, so however far
// priming has backed off, it backed off against a stand that no longer looks
// like this one. Retry promptly instead of sitting out the widened gap.
function onDeviceRegistered(deviceName) {
  resetPrimingBudget();          // no-ops outside the view-only build
  // A device comes up in its controls' default states while the physical
  // switches are wherever they were left. The control panel prompts the
  // operator to reconcile the two — see useSwitchSync.js.
  noteDeviceRegistered(deviceName);
  // STREAM is a broadcast with no per-device targeting, so a device that joins
  // after the rate was set is never told to stream. No-ops in the view-only
  // build via currentStreamHz, which reports 0 for a client that cannot
  // command — priming above is that build's one narrow exception.
  scheduleStreamRearm('device registered');
}

const {
  devices,
  kasaDevices,
  commandsById,
  tares,
  session,
  sessionWarning,
  stateVersion,
  status: stateStatus,
  resyncState,
} = useStateStream(server_ip, { onDeviceRegistered });
// Connecting to a server that already has devices on it produces no
// device.registered delta — they arrive in the /ws/state snapshot instead — so
// the prompt above would never be raised for the devices most likely to have
// been running longest. Presence counts as much as the announcement; the
// dedupe that keeps this from firing on every republish lives in useSwitchSync.
watch(devices, () => {
  noteDevicesPresent(server_ip.value, devices.value);
}, { immediate: true });

provide('devices',      devices);
provide('kasaDevices',  kasaDevices);
provide('commandsById', commandsById);
provide('session',      session);
provide('sessionWarning', sessionWarning);
provide('stateStreamStatus', stateStatus);

// A device that rejoined while the state socket was down arrives in the resync
// snapshot rather than as a `device.registered` delta, so re-arm on reconnect
// too. No-ops before a server IP is set, where the derived rate is still 0.
//
// That same blind spot is why the socket dropping is reported to useSwitchSync:
// a device may rejoin while we cannot hear the `device.registered` delta, and
// come up in its controls' defaults with nothing to announce it. Marking the
// outage here is all this has to do — the comparison happens on the resync
// snapshot's device publish, and a blip that moved nothing raises no prompt.
watch(stateStatus, (status, previous) => {
  if (previous === 'connected' && status !== 'connected') noteStateDisconnected();
  if (status === 'connected' && previous !== 'connected') scheduleStreamRearm('state resync');
});

// ── Tare offsets ─────────────────────────────────────────────────────────────
// { [sensorName]: offset } — owned by the server, mirrored here from /ws/state.
// The server applies offsets before fanning telemetry out, so every value that
// reaches this app is *already* tared: this map exists only to show which
// sensors are tared. Never subtract it from a reading.
//
// Consequences of server ownership: every connected GUI (including the web/pad
// build) stays in sync automatically, offsets survive a device disconnect —
// deliberate, so flight handoff keeps the offset — and they are lost on a
// server restart, since the server holds them in memory only.

provide('tares', tares);

// Capture a tare. The server averages its own recent raw samples, so no value
// is passed. Returns the TareInfo promise so callers can surface `applies_to`
// or recover from the 409 raised when two devices report the same sensor name.
function setTare(name, opts) {
  return apiSetTare(name, opts);
}
provide('setTare', setTare);

function clearTare(name) {
  return apiClearTare(name);
}
provide('clearTare', clearTare);

// ── Test state ───────────────────────────────────────────────────────────────

const testActive = computed(() => session.value !== null);
const testStartTime = computed(() => {
  const startedUnix = Number(session.value?.started_unix);
  return Number.isFinite(startedUnix) ? startedUnix * 1000 : null;
});
// The laptop CSV recorder lives in Rust, so only the desktop build has one.
// Deriving this from CAPS rather than checking for Tauri directly is what makes
// every guard below — arm, disarm, poll, session lock — fall away on the pad
// without a second gate at each site.
const localRecorderAvailable = ref(CAPS.recording);
const localRecordingActive = ref(false);
const lifecycleBusy = ref(false);
const lifecycleError = ref('');

const recordingMode = computed(() => {
  if (testActive.value && localRecordingActive.value) return 'redundant';
  if (testActive.value) return 'server-only';
  if (localRecordingActive.value) return 'local-only';
  return 'idle';
});

provide('testActive',    testActive);
provide('testStartTime', testStartTime);
provide('localRecorderAvailable', localRecorderAvailable);
provide('localRecordingActive', localRecordingActive);
provide('recordingMode', recordingMode);
provide('lifecycleBusy', lifecycleBusy);
provide('lifecycleError', lifecycleError);

watch(
  [() => session.value?.id ?? null, stateStatus],
  ([sessionId, status]) => {
    if (!localRecorderAvailable.value || status !== 'connected') return;
    setServerSessionLock(sessionId).catch((err) => {
      console.error('[App] set_server_session_lock failed:', err);
    });
  },
  { immediate: true },
);

// ── Telemetry streams (display→charts; raw→CSV is ingested on the Rust side) ─

// Rolling window shown on the charts. Owned here rather than in the graph panel
// because it also drives how much history the stream retains — the panel writes
// to it through the provided ref.
const TELEMETRY_WINDOW_KEY = 'qret-telemetry-window-sec';

function loadTelemetryWindow() {
  const stored = Number(localStorage.getItem(TELEMETRY_WINDOW_KEY));
  return TELEMETRY_WINDOW_OPTIONS.includes(stored) ? stored : TELEMETRY_WINDOW_SEC;
}

const telemetryWindowSec = ref(loadTelemetryWindow());
provide('telemetryWindowSec', telemetryWindowSec);
watch(telemetryWindowSec, (sec) => localStorage.setItem(TELEMETRY_WINDOW_KEY, String(sec)));

const { sensorData, telemetryStats, streamAlgorithm, clearSensorData, setUnchartedStreams, msSinceLastTelemetry } =
  useTelemetryStream(server_ip, downsampleAlgorithm, telemetryWindowSec);
provide('sensorData', sensorData);
provide('telemetryStats', telemetryStats);
provide('streamAlgorithm', streamAlgorithm);
provide('setUnchartedStreams', setUnchartedStreams);

// ── Stream supervision ───────────────────────────────────────────────────────
// STREAM is broadcast-only — QLCP exposes no per-device targeting (the server's
// StreamCommand schema carries nothing but frequency_hz) — so a device that is
// not ready to act on the broadcast when it goes out stays silent indefinitely,
// and nothing in the protocol reports that it happened.
//
// The re-arm above is a single fire-and-forget attempt 500 ms after
// `device.registered`. That is enough for a device the server already knows,
// which is ready the moment it re-registers, but not for one connecting for the
// first time: its registration and its readiness to stream are further apart,
// the lone broadcast lands in that gap, and the device never streams.
//
// So don't trust the re-arm — verify it. A connected device that produces no
// telemetry gets another re-arm, up to a bounded number of attempts. This also
// covers devices arriving in a state.snapshot rather than as a delta, which the
// `device.registered` hook never sees. Verifying costs no commands: a device
// that is streaming is confirmed on its first check and left alone afterwards.

const STREAM_VERIFY_MS = 2_500;
const STREAM_VERIFY_MAX_ATTEMPTS = 3;

// deviceName → { verified: boolean, attempts: number, marker: number|null, timer }
// An entry (verified or not) suppresses re-arming; it is dropped when the device
// disconnects or streaming stops, so a rejoin is verified afresh.
const streamWatchdogs = new Map();

function deviceSensorNames(dev) {
  return (dev?.sensors ?? [])
    .map((sensor) => String(sensor?.name ?? '').trim())
    .filter(Boolean);
}

// Chart-independent liveness marker. The ts/vs history is deliberately not
// retained for streams nobody is charting (see setUnchartedStreams), so a hidden
// stream would read as silent; `lastSourceT` — the device's own timestamp on the
// newest reading — keeps updating either way. It is a device clock, not
// comparable with any local time, so liveness means "advanced since last look".
// null = no telemetry has ever arrived for this device.
function deviceStreamMarker(dev) {
  let marker = null;
  for (const name of deviceSensorNames(dev)) {
    const sourceT = sensorData.value[name]?.lastSourceT;
    if (typeof sourceT !== 'number') continue;
    marker = marker === null ? sourceT : Math.max(marker, sourceT);
  }
  return marker;
}

function clearStreamWatchdog(deviceName) {
  const watchdog = streamWatchdogs.get(deviceName);
  if (!watchdog) return;
  if (watchdog.timer !== null) clearTimeout(watchdog.timer);
  streamWatchdogs.delete(deviceName);
}

function clearAllStreamWatchdogs() {
  for (const deviceName of [...streamWatchdogs.keys()]) clearStreamWatchdog(deviceName);
}

function armStreamWatchdog(deviceName, dev) {
  if (streamWatchdogs.has(deviceName)) return;
  const watchdog = {
    verified: false,
    attempts: 0,
    marker:   deviceStreamMarker(dev),
    timer:    null,
  };
  streamWatchdogs.set(deviceName, watchdog);

  function check() {
    watchdog.timer = null;
    const current = devices.value.find((d) => d.name === deviceName);

    // Gone, dropped, or nothing is meant to be streaming — stop supervising.
    if (!current || current.connected === false || currentStreamHz.value <= 0) {
      clearStreamWatchdog(deviceName);
      return;
    }

    const marker = deviceStreamMarker(current);
    if (marker !== null && marker !== watchdog.marker) {
      watchdog.verified = true;   // streaming; keep the slot so we stop checking
      return;
    }

    if (watchdog.attempts >= STREAM_VERIFY_MAX_ATTEMPTS) {
      console.warn(
        `[App] ${deviceName} still silent after ${watchdog.attempts} STREAM re-arms — giving up`
      );
      return;
    }

    watchdog.attempts += 1;
    watchdog.marker    = marker;
    rearmStream(`${deviceName} silent (attempt ${watchdog.attempts})`);
    watchdog.timer = setTimeout(check, STREAM_VERIFY_MS);
  }

  watchdog.timer = setTimeout(check, STREAM_VERIFY_MS);
}

watch([devices, currentStreamHz], () => {
  if (currentStreamHz.value <= 0) {
    clearAllStreamWatchdogs();   // nothing should be streaming — no silence to detect
    return;
  }

  for (const dev of devices.value) {
    if (dev.connected === false) {
      clearStreamWatchdog(dev.name);
      continue;
    }
    // Control-only boards publish no telemetry — there is nothing to verify.
    if (deviceSensorNames(dev).length === 0) continue;
    armStreamWatchdog(dev.name, dev);
  }
});

// ── View-only stream priming ─────────────────────────────────────────────────
// The view-only build cannot command the stand, but it also cannot show
// anything if nothing is streaming — the normal state before launch control's
// ground station is up. Devices appear in the list and produce no data, which
// reads as a fault rather than as "nobody has started the stream yet".
//
// So the pad gets one narrow exception: a *bare* STREAM at the preview rate,
// only while the whole stand is silent. Each guard is load-bearing.
//
//   • Never STOP. Changing an already-active rate needs STOP+STREAM, which
//     carries a deliberate data gap (see the re-arm notes above). Priming
//     cannot interrupt a running stream because it never sends STOP.
//   • Never a caller-chosen rate. primeStream() hard-codes the preview rate, so
//     a pad client cannot set the stand's frequency even by mistake.
//   • Only while nothing is flowing *anywhere*. The server forwards
//     STREAM_START to every registered device unconditionally, so a STREAM at a
//     rate different from the active one would re-rate the whole stand and drop
//     a 190 Hz test to 30. Telemetry arriving at all proves someone else owns
//     the rate, and the pad then stays quiet. This is why the check is global
//     rather than per-device: a broadcast STREAM could not fix one silent
//     device without re-rating every other one.
//
// Liveness comes from msSinceLastTelemetry(), which is stamped when a batch
// lands on the socket. Do not substitute anything derived from sensorData or
// telemetryStats: those are published inside requestAnimationFrame, which
// Chrome throttles to zero in a hidden or backgrounded tab. A tablet with the
// GUI open behind another app would read its own stalled render as "the stand
// is silent" and re-rate a running test. This was observed, not theorised.

// Priming never gives up: a silent stand is the normal state before launch
// control is up, and the engineer who opens the page an hour later deserves the
// same attempt as the one who opened it at boot. What it does instead is widen
// the gap between tries, because a stand that has stayed silent through several
// attempts is almost always one nobody has started yet rather than one a fourth
// STREAM would wake. Backing off keeps that case from becoming a POST every
// 5 s for hours across every tablet at the pad.
//
// The delay resets to the floor on anything that makes the earlier silence
// stale: telemetry arriving, or a device joining.
const PRIME_SILENCE_MS   = 5_000;    // silence threshold, and the first retry gap
const PRIME_MAX_DELAY_MS = 60_000;   // ceiling on the widened gap

let primeDelayMs = PRIME_SILENCE_MS;
let primeTimer   = null;

function scheduleNextPrime() {
  // Jitter so several tablets opening together don't all fire on the same tick.
  primeTimer = setTimeout(maybePrimeStream, primeDelayMs + Math.random() * 1_000);
}

// The stand no longer looks the way it did when the gap was widened, so start
// over at the floor. Re-arms an in-flight timer too — otherwise a 60 s wait
// already ticking would swallow the very retry this reset exists to trigger.
function resetPrimingBudget() {
  primeDelayMs = PRIME_SILENCE_MS;
  if (primeTimer !== null) {
    clearTimeout(primeTimer);
    scheduleNextPrime();
  }
}

function stopStreamPriming() {
  if (primeTimer === null) return;
  clearTimeout(primeTimer);
  primeTimer = null;
}

function startStreamPriming() {
  stopStreamPriming();
  if (!CAPS.streamPriming || !server_ip.value) return;
  primeDelayMs = PRIME_SILENCE_MS;
  scheduleNextPrime();
}

async function maybePrimeStream() {
  primeTimer = null;
  // Torn down while this tick was pending — do not reschedule.
  if (!CAPS.streamPriming || !server_ip.value) return;

  // Something is already streaming — leave the rate alone. Telemetry arriving
  // also means any widening so far describes a stand that no longer exists.
  if (msSinceLastTelemetry() < PRIME_SILENCE_MS) {
    resetPrimingBudget();
    scheduleNextPrime();
    return;
  }

  // Nothing that could stream is connected; a STREAM would just fail with 400.
  // Not a failed attempt — it never left the tab, so the gap stays put.
  const hasLiveSensors = devices.value.some(
    (dev) => dev.connected !== false && (dev.sensors ?? []).length > 0
  );
  if (!hasLiveSensors) {
    scheduleNextPrime();
    return;
  }

  try {
    await primeStream();
    console.log(`[App] primed preview stream at ${PREVIEW_STREAM_HZ} Hz`);
  } catch (err) {
    console.error('[App] stream priming failed:', err);
  }

  // Whether the POST succeeded says nothing about whether the stand woke up —
  // only telemetry does, and that resets this. So widen after every real try.
  primeDelayMs = Math.min(primeDelayMs * 2, PRIME_MAX_DELAY_MS);
  scheduleNextPrime();
}

// Unpruned GPS trail for the flight panel (sensorData history only spans the
// rolling telemetry window; the trail must span the whole flight).
const flightTrack = useFlightTrack(sensorData, { testActive });
provide('flightTrack', flightTrack);

// ── Control state bits → Rust (used by the raw-telemetry CSV recorder) ───────
// The raw /ws/telemetry/raw stream is consumed entirely in Rust and only
// carries sensor readings, so valve/auxiliary/kasa state bits — derived here
// from /ws/state — are pushed separately whenever they change. Tare offsets
// need no such push: the server applies them before the stream is sent.

function _normalizeId(id) { return id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() }

// Only log states the device has actually confirmed. The server's
// reported_status tells us which those are:
//   'confirmed' — reported_state is the device's real current state → log it.
//   'pending'   — reported_state is the target being actuated toward, not the
//                 actual state → unknown, don't log.
//   'error'     — device faulted; reported_state is a stale last-known-good
//                 value → unknown, don't log.
//   null        — no STATUS report ever received; accepted_state is only what
//                 the server accepted, never device-confirmed → unknown.
// Controls omitted here are written as an empty cell by the Rust recorder, not
// as 0 — see flush_pending()/record_batch() in src-tauri/src/lib.rs.
// A control with no reported_status field at all predates this server contract;
// fall back to the old behaviour so an older server still records something.
function isConfirmedState(ctrl) {
  return ctrl.reported_status === undefined || ctrl.reported_status === 'confirmed';
}

function pushControlStates() {
  if (!CAPS.recording) return;   // no Rust-side CSV recorder to feed
  const valveStateBits     = {};
  const auxiliaryStateBits = {};
  for (const dev of devices.value) {
    for (const c of (dev.controls ?? [])) {
      if (!isConfirmedState(c)) continue;
      const st = c.reported_state ?? c.accepted_state;
      if (!st) continue;
      if (_normalizeId(c.name).startsWith('av')) {
        valveStateBits[c.name]     = st === 'OPEN' ? 1 : 0;
      } else {
        auxiliaryStateBits[c.name] = st === 'CLOSED' ? 1 : 0;
      }
    }
  }

  const kasaStateBits    = {};
  const kasaAliasCounts  = {};
  for (const device of kasaDevices.value) {
    const aliasBase     = String(device?.alias ?? '').trim();
    const fallback      = String(device?.host  ?? '').trim();
    const rawBase       = aliasBase || fallback;
    const sanitizedBase = rawBase.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '');
    if (!sanitizedBase) continue;

    const count  = (kasaAliasCounts[sanitizedBase] ?? 0) + 1;
    kasaAliasCounts[sanitizedBase] = count;
    const key    = count === 1 ? sanitizedBase : `${sanitizedBase}_${count}`;

    kasaStateBits[key] = device?.active ? 1 : 0;
  }

  updateControlStates({
    valveStates:      valveStateBits,
    auxiliaryStates:  auxiliaryStateBits,
    kasaStates:       kasaStateBits,
  }).catch((err) => console.error('[App] update_control_states failed:', err));
}

watch([devices, kasaDevices], pushControlStates, { deep: true });

// ── Log stream (/ws/logs → debug panel) ──────────────────────────────────────

const { logLines, wsStatus: logStatus, clearLogs } = useLogStream(server_ip);
provide('logLines',  logLines);
provide('clearLogs', clearLogs);

// Aggregate WS status: state socket is primary; 'connecting' if either is connecting.
const wsStatus = computed(() => {
  const st = stateStatus.value;
  const ls = logStatus.value;
  if (st === 'connected' && ls === 'connected') return 'connected';
  if (st === 'connecting' || ls === 'connecting') return 'connecting';
  if (st === 'error'      || ls === 'error')      return 'error';
  return 'disconnected';
});
provide('wsStatus', wsStatus);

// ── Kasa smart plugs ──────────────────────────────────────────────────────────
// kasaDevices is now owned by useStateStream; kasa.* deltas keep it current.

// ESP discovery is a fire-and-forget UDP multicast the server already sends
// every 30 s, so the view-only build keeps it — an engineer at the pad who just
// powered a device on can pull it in without radioing launch control.
//
// Kasa discovery is deliberately excluded there: it is a broadcast-and-wait
// scan that occupies the server's event loop for seconds, and Kasa plugs are
// launch-control-side power management the pad has no reason to scan for.
async function discover() {
  const tasks = [
    discoverDevices()
      .catch((err) => console.error('[App] discoverDevices failed:', err)),
  ];

  if (canCommand) {
    tasks.push(
      discoverKasaDevices()
        .catch((err) => console.error('[App] discoverKasa failed:', err)),
    );
  }

  await Promise.allSettled(tasks);
}
provide('discover', discover);

async function setKasaState(host, active) {
  try {
    await controlKasaDevice(host, active);
    // kasa.updated delta on /ws/state will update kasaDevices automatically
  } catch (err) {
    console.error(`[App] setKasaState ${host} failed:`, err);
  }
}
provide('setKasaState', setKasaState);

// ── Server-side sessions ──────────────────────────────────────────────────────
provide('listSessions', listSessions);
provide('getSession', getSession);
provide('sessionDownloadUrl', sessionDownloadUrl);

// ── Test lifecycle ────────────────────────────────────────────────────────────

function formatDatetime() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}-${time}`;
}

function describeError(err) {
  if (typeof err === 'string') return err;
  if (err?.message) return String(err.message);
  try { return JSON.stringify(err); } catch { return String(err); }
}

const _localRecorderChannel = new BroadcastChannel('qret-local-recorder-state');

async function refreshLocalRecordingStatus() {
  if (!localRecorderAvailable.value) {
    localRecordingActive.value = false;
    return false;
  }
  try {
    localRecordingActive.value = !!(await fetchLocalRecordingActive());
  } catch (err) {
    console.error('[App] local_recording_active failed:', err);
  }
  return localRecordingActive.value;
}

function publishLocalRecorderChange() {
  _localRecorderChannel.postMessage({ type: 'refresh' });
}

_localRecorderChannel.onmessage = () => {
  void refreshLocalRecordingStatus();
};

async function armLocalRecorder() {
  if (!localRecorderAvailable.value) return;
  await startRecording(pidConfig.value, formatDatetime());
  localRecordingActive.value = true;
  publishLocalRecorderChange();
  await refreshLocalRecordingStatus();
}

async function disarmLocalRecorder() {
  if (!localRecorderAvailable.value) return;
  await stopRecording();
  localRecordingActive.value = false;
  publishLocalRecorderChange();
  await refreshLocalRecordingStatus();
}

async function refreshServerSession(reason) {
  try {
    await resyncState();
    return true;
  } catch (err) {
    console.warn(`[App] state resync failed (${reason}):`, err);
    return false;
  }
}

// ── Desktop preview stream ───────────────────────────────────────────────────
// Launch control owns the stand's stream rate outright, so the desktop build
// simply sets it: the preview rate whenever nothing is recording, the test rate
// while something is. The pad reaches the same end by a much narrower route —
// see the priming block above — and must not run any of this, hence the
// canCommand guard on each entry point rather than one at the call sites.

let previewRestorePending = false;
let previewRestoreInFlight = false;
let previewBootstrapTarget = null;
let previewBootstrapReady = false;

async function maybeRestorePreview() {
  if (
    !canCommand ||
    !previewRestorePending ||
    previewRestoreInFlight ||
    testActive.value ||
    localRecordingActive.value ||
    !server_ip.value
  ) return;

  previewRestorePending = false;
  if (previewBootstrapTarget === server_ip.value) {
    previewBootstrapTarget = null;
    previewBootstrapReady = false;
  }
  previewRestoreInFlight = true;
  try {
    await setStream(PREVIEW_STREAM_HZ);
  } catch (err) {
    previewRestorePending = true;
    lifecycleError.value = `Recorders stopped, but preview could not restart: ${describeError(err)}`;
  } finally {
    previewRestoreInFlight = false;
  }
}

async function maybeStartIdlePreview() {
  if (
    !canCommand ||
    !previewBootstrapTarget ||
    !previewBootstrapReady ||
    previewBootstrapTarget !== server_ip.value ||
    stateVersion.value < 0 ||
    lifecycleBusy.value ||
    testActive.value ||
    localRecordingActive.value
  ) return;

  const target = previewBootstrapTarget;
  previewBootstrapTarget = null;
  previewBootstrapReady = false;
  try {
    await setStream(PREVIEW_STREAM_HZ);
  } catch (err) {
    if (server_ip.value === target) previewBootstrapTarget = target;
    if (server_ip.value === target) previewBootstrapReady = true;
    console.error('[App] preview STREAM failed:', err);
  }
}

async function restoreTestStreamForPartialStop() {
  if (!canCommand) return;
  if (!server_ip.value || (!testActive.value && !localRecordingActive.value)) return;
  try {
    await setStream(testFrequency.value);
  } catch (err) {
    lifecycleError.value = `A recorder is still active and the test stream could not restart: ${describeError(err)}`;
  }
}

async function startTest() {
  if (!canCommand) return;
  if (lifecycleBusy.value || testActive.value || localRecordingActive.value) return;
  lifecycleBusy.value = true;
  lifecycleError.value = '';
  previewRestorePending = false;
  previewBootstrapTarget = null;
  previewBootstrapReady = false;
  try {
    await stopStream();
    await setStream(testFrequency.value);
    await armLocalRecorder();

    try {
      await startSession(pidConfig.value);
    } catch (err) {
      lifecycleError.value = localRecordingActive.value
        ? `Server session failed; laptop CSV recording continues: ${describeError(err)}`
        : `Server session failed: ${describeError(err)}`;
      const serverStateConfirmed = await refreshServerSession('failed-start');
      if (
        serverStateConfirmed &&
        !testActive.value &&
        !localRecordingActive.value &&
        server_ip.value
      ) {
        try { await setStream(PREVIEW_STREAM_HZ); } catch { /* keep the server-session error */ }
      }
      return;
    }
    if (!(await refreshServerSession('start'))) {
      lifecycleError.value = 'Server session start returned, but live recording state could not be confirmed.';
    }
  } catch (err) {
    console.error('[App] startTest failed:', err);
    lifecycleError.value = `Test start failed: ${describeError(err)}`;
    if (!testActive.value && !localRecordingActive.value && server_ip.value) {
      try { await setStream(PREVIEW_STREAM_HZ); } catch { /* keep the original start error */ }
    }
  } finally {
    lifecycleBusy.value = false;
  }
}

async function stopTest() {
  if (!canCommand) return;
  if (lifecycleBusy.value || (!testActive.value && !localRecordingActive.value)) return;
  lifecycleBusy.value = true;
  lifecycleError.value = '';
  previewRestorePending = true;
  const failures = [];

  try { await stopStream(); } catch (err) {
    failures.push(`device STOP: ${describeError(err)}`);
  }
  try { await disarmLocalRecorder(); } catch (err) {
    failures.push(`laptop CSV: ${describeError(err)}`);
  }
  try { await stopSession(); } catch (err) {
    failures.push(`server session: ${describeError(err)}`);
  }

  await refreshLocalRecordingStatus();
  await refreshServerSession('stop');

  if (failures.length) lifecycleError.value = `Stop incomplete — ${failures.join('; ')}`;
  if (testActive.value || localRecordingActive.value) {
    await restoreTestStreamForPartialStop();
  } else {
    await maybeRestorePreview();
  }
  lifecycleBusy.value = false;
  await maybeRestorePreview();
}

async function retryServerSession() {
  if (!canCommand) return;
  if (lifecycleBusy.value || testActive.value || !localRecordingActive.value) return;
  lifecycleBusy.value = true;
  lifecycleError.value = '';
  try {
    await startSession(pidConfig.value);
    await refreshServerSession('retry-start');
  } catch (err) {
    lifecycleError.value = `Server session retry failed; laptop CSV recording continues: ${describeError(err)}`;
  } finally {
    lifecycleBusy.value = false;
  }
}

async function startLocalBackup() {
  if (!canCommand) return;
  if (
    lifecycleBusy.value ||
    !localRecorderAvailable.value ||
    !testActive.value ||
    localRecordingActive.value
  ) return;
  lifecycleBusy.value = true;
  lifecycleError.value = '';
  previewRestorePending = false;
  previewBootstrapTarget = null;
  previewBootstrapReady = false;
  try {
    await stopStream();
    await setStream(testFrequency.value);
    await armLocalRecorder();
  } catch (err) {
    lifecycleError.value = `Laptop backup failed: ${describeError(err)}`;
    await restoreTestStreamForPartialStop();
  } finally {
    lifecycleBusy.value = false;
  }
}

async function stopLocalBackup() {
  if (!canCommand) return;
  if (lifecycleBusy.value || !localRecordingActive.value) return;
  lifecycleBusy.value = true;
  lifecycleError.value = '';
  const failures = [];
  previewRestorePending = !testActive.value;

  if (!testActive.value) {
    try { await stopStream(); } catch (err) {
      failures.push(`device STOP: ${describeError(err)}`);
    }
  }
  try { await disarmLocalRecorder(); } catch (err) {
    failures.push(`laptop CSV: ${describeError(err)}`);
  }
  await refreshLocalRecordingStatus();

  if (failures.length) lifecycleError.value = `Laptop stop incomplete — ${failures.join('; ')}`;
  if (localRecordingActive.value) await restoreTestStreamForPartialStop();
  lifecycleBusy.value = false;
  await maybeRestorePreview();
}

provide('startTest', startTest);
provide('stopTest',  stopTest);
provide('retryServerSession', retryServerSession);
provide('startLocalBackup', startLocalBackup);
provide('stopLocalBackup', stopLocalBackup);

watch([session, localRecordingActive], () => {
  if (localRecorderAvailable.value) void refreshLocalRecordingStatus();
  if (!lifecycleBusy.value) void maybeRestorePreview();
  if (!lifecycleBusy.value) void maybeStartIdlePreview();
});

watch(stateVersion, () => {
  if (!lifecycleBusy.value) void maybeStartIdlePreview();
});

// Panels bind this to :disabled so a control that cannot act also cannot be
// pressed — a live-looking button that silently fails is worse than a dead one.
provide('readOnly', !canCommand);

// ── Control layer ────────────────────────────────────────────────────────────
// Commanding the stand lives here rather than in control_panel.vue because the
// keyboard has to outlive the panel: the switch panel is a keyboard-emulating
// HID, and window_content below swaps the panel out the moment the operator
// looks at a chart. One instance per window, injected by the Control panel so a
// keystroke and a click share the same pending/NACK bookkeeping. The keydown
// listener is registered on this component's lifecycle — see useControlLayer.js.

const controlLayer = useControlLayer({
  serverIp: server_ip,
  devices,
  kasaDevices,
  commandsById,
  pidConfig,
  requestStatusSnapshot,
  setKasaState,
});
provide('controlLayer', controlLayer);

const {
  showEstopConfirm,
  estopPending,
  confirmEstop,
  syncOpen,
  syncRows,
  pendingDevices: syncPendingDevices,
  onSyncConfirm,
  onSyncDismiss,
} = controlLayer;

// ── Config fetch on connect ──────────────────────────────────────────────────
// The /ws/state socket auto-resyncss on connect, so no manual config fetching is
// needed — the snapshot brings devices, kasa, commands and tares. We just manage
// the stream rate.

watch(server_ip, async (ip) => {
  stopStatusRefresh();
  stopStreamPriming();
  // A re-arm queued for the previous server would fire against the new one.
  cancelStreamRearm();
  clearAllStreamWatchdogs();   // devices belong to the old server

  clearSensorData();
  clearLogs();

  // The view-only build stops here: it neither owns the stream rate nor may
  // change it. Everything below issues broadcast commands that would affect
  // every client of this server, including a test in progress. The one thing it
  // may do is prime a preview stream on a stand that is wholly silent.
  if (!canCommand) {
    if (ip) startStreamPriming();
    return;
  }

  previewBootstrapTarget = ip || null;
  previewBootstrapReady = false;

  if (!ip) return;

  // Resolve authoritative recording state before touching stream rate. This is
  // essential when a new monitor window opens during an existing session.
  await Promise.all([
    refreshServerSession('connect'),
    refreshLocalRecordingStatus(),
  ]);
  if (server_ip.value !== ip) return;
  previewBootstrapReady = true;
  await maybeStartIdlePreview();
  requestStatusSnapshot('connect');
  startStatusRefresh();
});

// ── Cross-window IP sync via BroadcastChannel ─────────────────────────────────

const _ipChannel = new BroadcastChannel('qret-server-ip');
let _receivingBroadcast = false;

watch(server_ip, (ip) => {
  if (!_receivingBroadcast) _ipChannel.postMessage(ip);
});

_ipChannel.onmessage = (e) => {
  if (server_ip.value === e.data) return;
  if (localRecordingActive.value || (testActive.value && stateStatus.value === 'connected')) {
    lifecycleError.value = 'Stop active recording before changing the server.';
    return;
  }
  _receivingBroadcast = true;
  server_ip.value = e.data;
  _receivingBroadcast = false;
};

// ── Settings sync (pidConfig, testFrequency) across windows ──────────────────

const _settingsChannel = new BroadcastChannel('qret-settings');

watch(pidConfig, (cfg) => {
  localStorage.setItem('qret-pid-config', cfg);
  _settingsChannel.postMessage({ type: 'pidConfig', value: cfg });
});

watch(testFrequency, (hz) => {
  localStorage.setItem('qret-test-frequency', String(hz));
  _settingsChannel.postMessage({ type: 'testFrequency', value: hz });
});

watch(downsampleAlgorithm, (algorithm) => {
  localStorage.setItem('qret-downsample-algorithm', algorithm);
  _settingsChannel.postMessage({ type: 'downsampleAlgorithm', value: algorithm });
});

watch(mapSitesDisabled, (files) => {
  localStorage.setItem('qret-map-sites-disabled', JSON.stringify(files));
  _settingsChannel.postMessage({ type: 'mapSitesDisabled', value: [...files] });
});

// A map was deleted: refresh this window's layers and tell the others, whose
// own manifests are now stale too.
function onMapsChanged() {
  mapsVersion.value++;
  _settingsChannel.postMessage({ type: 'mapsChanged' });
}

watch(mapsDir, (dir) => {
  localStorage.setItem('qret-maps-dir', dir);
  _settingsChannel.postMessage({ type: 'mapsDir', value: dir });
});

_settingsChannel.onmessage = (e) => {
  if (e.data.type === 'pidConfig')     pidConfig.value     = e.data.value;
  if (e.data.type === 'testFrequency') testFrequency.value = e.data.value;
  // Re-validate on the way in: another window is no more trustworthy a source
  // than localStorage, and an unknown value would reach the socket URL.
  if (e.data.type === 'downsampleAlgorithm') {
    downsampleAlgorithm.value = normalizeDownsampleAlgorithm(e.data.value);
  }
  if (e.data.type === 'mapSitesDisabled') mapSitesDisabled.value = e.data.value;
  if (e.data.type === 'mapsDir')       mapsDir.value       = e.data.value;
  if (e.data.type === 'mapsChanged')   mapsVersion.value++;
  // darkMode messages are handled by settings_modal.vue's own channel instance
};

// Keep the Rust tile server pointed at the maps directory. The tile scheme
// opens per-site MBTiles lazily, so no per-site setup call is needed.
// Idempotent, so multiple windows racing through this watcher is harmless
// (same rationale as the test-state sync below).
watch(mapsDir, async (dir) => {
  try {
    if (dir) await invoke('set_maps_dir', { newDir: dir });
  } catch (err) {
    console.error('[App] maps dir setup failed:', err);
  }
}, { immediate: true });

// ── Test state sync across windows via BroadcastChannel ──────────────────────
// Each window runs its own App.vue instance with its own testActive/testStartTime
// refs. startTest()/stopTest() perform the actual backend calls (idempotent, so
// harmless if triggered from more than one window); this channel just keeps every
// window's Start/Stop Test button and timer in sync with whichever window acted.

const _testChannel = new BroadcastChannel('qret-test-state');
let _receivingTestBroadcast = false;

watch([testActive, testStartTime], ([active, startTime]) => {
  if (_receivingTestBroadcast) return;
  _testChannel.postMessage({ active, startTime });
});

_testChannel.onmessage = (e) => {
  const { active, startTime } = e.data;
  if (testActive.value === active && testStartTime.value === startTime) return;
  _receivingTestBroadcast = true;
  testActive.value    = active;
  testStartTime.value = startTime;
  _receivingTestBroadcast = false;
};

// ── Settings ─────────────────────────────────────────────────────────────────

async function get_ip(new_ip) {
  if (localRecordingActive.value || (testActive.value && stateStatus.value === 'connected')) {
    lifecycleError.value = 'Stop active recording before changing the server.';
    return;
  }
  // Rust owns the persisted IP and refuses to move it while it holds a session
  // lock, so a rejection here is authoritative — surface it rather than
  // switching anyway. No-ops on the web build, which never persists an IP.
  try {
    await submitIp(new_ip);
  } catch (err) {
    lifecycleError.value = `Server change blocked: ${describeError(err)}`;
    return;
  }
  server_ip.value = new_ip;
}

const settingsOpen = ref(false);
const aboutOpen    = ref(false);

onMounted(() => {
  // Tares need no bootstrap: the /ws/state snapshot that arrives on connect
  // carries the full map, and tare.updated/tare.cleared deltas keep it current.
  void refreshLocalRecordingStatus();
  // Unconditional, unlike the recorder poll above: on desktop this reads the IP
  // Rust persisted, and on web it is how the address is derived from the URL
  // that served the page. Gating it on the local recorder would leave the pad
  // with no server at all.
  fetchServerIp()
    .then((ip) => { if (ip) server_ip.value = ip; })
    .catch(() => {});
});

onUnmounted(() => {
  stopStatusRefresh();
  stopStreamPriming();
  cancelStreamRearm();
  clearAllStreamWatchdogs();
  _ipChannel.close();
  _settingsChannel.close();
  _localRecorderChannel.close();
});
</script>

<template>
  <main class="container">
    <div
      id="grid-container"
      :style="{ gridTemplateColumns: navbarWidth + 'px 1fr' }"
    >
      <nav-bar
        @navigate="setActive"
        @open-settings="settingsOpen = true"
        @open-about="aboutOpen = true"
        @resize="onNavResize"
      ></nav-bar>

      <!-- KeepAlive preserves CameraPanel's WebRTC streams and FlightPanel's
           map (WebGL context + viewport) across SPA navigation -->
      <KeepAlive include="CameraPanel,FlightPanel">
        <component :is="window_content" class="swap-container"></component>
      </KeepAlive>
    </div>

    <settings-modal
      :is-open="settingsOpen"
      :current-ip="server_ip"
      :pid-config="pidConfig"
      :test-frequency="testFrequency"
      :downsample-algorithm="downsampleAlgorithm"
      :test-active="testActive"
      :server-session-active-connected="testActive && stateStatus === 'connected'"
      :local-recording-active="localRecordingActive"
      :map-sites-disabled="mapSitesDisabled"
      :maps-dir="mapsDir"
      @close="settingsOpen = false"
      @update-ip="get_ip"
      @update-pid-config="pidConfig = $event"
      @update-test-frequency="testFrequency = $event"
      @update-downsample-algorithm="downsampleAlgorithm = $event"
      @update-map-sites-disabled="mapSitesDisabled = $event"
      @update-maps-dir="mapsDir = $event"
      @fly-to-site="flyToSite"
      @maps-changed="onMapsChanged"
    ></settings-modal>

    <about-modal
      :is-open="aboutOpen"
      @close="aboutOpen = false"
    ></about-modal>

    <!-- ── Physical switch reconciliation prompt ── -->
    <!-- Above the view swap, not inside the Control panel: a device registering
         while the operator is watching a chart owes the same prompt, and the
         keys it wants are now handled up here too. -->
    <switch-sync-modal
      :is-open="syncOpen"
      :rows="syncRows"
      :devices="syncPendingDevices"
      @confirm="onSyncConfirm"
      @dismiss="onSyncDismiss"
    />

    <!-- ── E-STOP confirmation dialog ── -->
    <!-- The E-STOP *button* stays on the Control panel; the dialog lives here so
         the bound key can raise it from any view. -->
    <Teleport to="body">
      <div v-if="showEstopConfirm" class="estop-overlay" @click.self="showEstopConfirm = false">
        <div class="estop-dialog">
          <div class="estop-dialog-title">EMERGENCY STOP</div>
          <div class="estop-dialog-body">
            This will immediately send an emergency stop command to the server. <br>
            All actuated valves will reset to their default state and data streaming will stop. <br>
            Are you sure?
          </div>
          <div class="estop-dialog-actions">
            <button
              class="estop-confirm-btn"
              :disabled="estopPending"
              @click="confirmEstop"
            >{{ estopPending ? 'SENDING…' : 'CONFIRM E-STOP' }}</button>
            <button
              class="estop-cancel-btn"
              :disabled="estopPending"
              @click="showEstopConfirm = false"
            >Cancel</button>
          </div>
        </div>
      </div>
    </Teleport>
  </main>
</template>

<style scoped>
.container {
  margin: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
}

#grid-container {
  display: grid;
  gap: 0;
  flex: 1;
  min-height: 0;
}

.swap-container {
  background-color: var(--bg-primary);
  border: var(--border-color) 2px solid;
  border-radius: 0 10px 10px 0;
  padding: 10px;
  text-align: left;
}

/* ── E-STOP confirmation dialog ── */
/* Moved here with the dialog itself. Scoped styles still reach it through the
   Teleport: the nodes belong to this component's render, wherever they land. */

.estop-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
}

.estop-dialog {
  background: var(--bg-secondary);
  border: 2px solid #e74c3c;
  border-radius: 6px;
  padding: 24px 28px;
  min-width: 320px;
  box-shadow: 0 0 32px rgba(231, 76, 60, 0.4);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.estop-dialog-title {
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 1px;
  color: #e74c3c;
  text-align: center;
}

.estop-dialog-body {
  font-size: 13px;
  color: var(--text-primary);
  text-align: center;
  line-height: 1.5;
}

.estop-dialog-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.estop-confirm-btn {
  background: #c0392b;
  color: #fff;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 1px;
  border: none;
  border-radius: 4px;
  padding: 8px 0;
  cursor: pointer;
  transition: background 0.15s;
}

.estop-confirm-btn:hover:not(:disabled) {
  background: #e74c3c;
}

.estop-confirm-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.estop-cancel-btn {
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 0;
  cursor: pointer;
  transition: background 0.15s;
}

.estop-cancel-btn:hover:not(:disabled) {
  background: var(--bg-surface);
}

.estop-cancel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
