<script setup>
import { computed, onMounted, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import { CAPS } from "./lib/platform.js";
import {
  fetchServerIp,
  startRecording,
  stopRecording,
  updateControlStates,
} from "./lib/desktop.js";
import { useServerApi, PREVIEW_STREAM_HZ } from "./composables/useServerApi.js";
import { useStateStream } from "./composables/useStateStream.js";
import { useTelemetryStream } from "./composables/useTelemetryStream.js";
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

const { stopStream, setStream, primeStream, setControl, requestStatus, discoverDevices, discoverKasaDevices, controlKasaDevice, sendEstop, setTare: apiSetTare, clearTare: apiClearTare, startAudio, stopAudio, listAudioFiles, audioFileUrl } = useServerApi(server_ip);

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

// ── State stream (/ws/state → devices, kasa, commands) ──────────────────────

// A device that just joined has never been told to stream, so however far
// priming has backed off, it backed off against a stand that no longer looks
// like this one. Retry promptly instead of sitting out the widened gap.
function onDeviceRegistered() {
  resetPrimingBudget();          // no-ops outside the view-only build
}

const { devices, kasaDevices, commandsById, tares, status: stateStatus } = useStateStream(
  server_ip,
  { onDeviceRegistered },
);
provide('devices',      devices);
provide('kasaDevices',  kasaDevices);
provide('commandsById', commandsById);

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

const testActive    = ref(false);
const testStartTime = ref(null);
provide('testActive',    testActive);
provide('testStartTime', testStartTime);

// ── Telemetry streams (display→charts; raw→CSV is ingested on the Rust side) ─

const { sensorData, telemetryStats, clearSensorData, msSinceLastTelemetry } = useTelemetryStream(server_ip);
provide('sensorData', sensorData);
provide('telemetryStats', telemetryStats);

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

// ── Control state bits → Rust (used by the raw-telemetry CSV recorder) ───────
// The raw /ws/telemetry/raw stream is consumed entirely in Rust and only
// carries sensor readings, so valve/auxiliary/kasa state bits — derived here
// from /ws/state — are pushed separately whenever they change. Tare offsets
// need no such push: the server applies them before the stream is sent.

function _normalizeId(id) { return id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() }

function pushControlStates() {
  if (!CAPS.recording) return;   // no Rust-side CSV recorder to feed
  const valveStateBits     = {};
  const auxiliaryStateBits = {};
  for (const dev of devices.value) {
    for (const c of (dev.controls ?? [])) {
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

// ── Audio ─────────────────────────────────────────────────────────────────────
provide('startAudio',    startAudio);
provide('stopAudio',     stopAudio);
provide('listAudioFiles', listAudioFiles);
provide('audioFileUrl',  audioFileUrl);

// ── Test lifecycle ────────────────────────────────────────────────────────────

function formatDatetime() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}-${time}`;
}

async function startTest() {
  if (!canCommand) return;
  if (testActive.value) return;
  try {
    await stopStream();
    await setStream(testFrequency.value);
    await startRecording(pidConfig.value, formatDatetime());
    testActive.value    = true;
    testStartTime.value = Date.now();
  } catch (err) {
    console.error('[App] startTest failed:', err);
  }
}

async function stopTest() {
  if (!canCommand) return;
  if (!testActive.value) return;
  testActive.value    = false;
  testStartTime.value = null;
  try {
    await stopStream();
    await stopRecording();
  } catch (err) {
    console.error('[App] stopTest failed:', err);
  }
  // Restart preview stream after test ends
  if (server_ip.value) {
    try { await setStream(PREVIEW_STREAM_HZ); } catch { /* ignore */ }
  }
}

provide('startTest', startTest);
provide('stopTest',  stopTest);

// Panels bind this to :disabled so a control that cannot act also cannot be
// pressed — a live-looking button that silently fails is worse than a dead one.
provide('readOnly', !canCommand);

// ── Config fetch on connect ──────────────────────────────────────────────────
// The /ws/state socket auto-resyncss on connect, so no manual config fetching is
// needed — the snapshot brings devices, kasa, commands and tares. We just manage
// the stream rate.

watch(server_ip, async (ip) => {
  stopStatusRefresh();
  stopStreamPriming();

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

  // Stop any active test when IP changes
  if (testActive.value) {
    await stopTest();
  } else {
    // Stop any preview stream running on the old IP
    try { await stopStream(); } catch { /* ignore */ }
  }

  if (!ip) return;

  // Start 30 Hz preview stream so data is visible before a test begins.
  // The /ws/state snapshot will arrive automatically when the socket connects.
  try { await setStream(PREVIEW_STREAM_HZ); } catch (err) {
    console.error('[App] preview STREAM failed:', err);
  }
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

_settingsChannel.onmessage = (e) => {
  if (e.data.type === 'pidConfig')     pidConfig.value     = e.data.value;
  if (e.data.type === 'testFrequency') testFrequency.value = e.data.value;
  // darkMode messages are handled by settings_modal.vue's own channel instance
};

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

function get_ip(new_ip) {
  server_ip.value = new_ip;
}

const settingsOpen = ref(false);
const aboutOpen    = ref(false);
let _unlistenTares = null;

onMounted(async () => {
  try {
    _unlistenTares = await listen('tares-updated', (event) => {
      applyTaresSnapshot(event.payload);
    });
    applyTaresSnapshot(await invoke('get_tares'));
  } catch (err) {
    console.error('[App] tare sync setup failed:', err);
  }
});

onMounted(() => {
  // Tares need no bootstrap: the /ws/state snapshot that arrives on connect
  // carries the full map, and tare.updated/tare.cleared deltas keep it current.
  fetchServerIp()
    .then((ip) => { if (ip) server_ip.value = ip; })
    .catch(() => {});
});

onUnmounted(() => {
  stopStatusRefresh();
  stopStreamPriming();
  _ipChannel.close();
  _settingsChannel.close();
  _testChannel.close();
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

      <!-- KeepAlive preserves CameraPanel's WebRTC streams across SPA navigation -->
      <KeepAlive include="CameraPanel">
        <component :is="window_content" class="swap-container"></component>
      </KeepAlive>
    </div>

    <settings-modal
      :is-open="settingsOpen"
      :current-ip="server_ip"
      :pid-config="pidConfig"
      :test-frequency="testFrequency"
      :test-active="testActive"
      @close="settingsOpen = false"
      @update-ip="get_ip"
      @update-pid-config="pidConfig = $event"
      @update-test-frequency="testFrequency = $event"
    ></settings-modal>

    <about-modal
      :is-open="aboutOpen"
      @close="aboutOpen = false"
    ></about-modal>
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
</style>
