<script setup>
import { computed, onMounted, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useServerApi } from "./composables/useServerApi.js";
import { useStateStream } from "./composables/useStateStream.js";
import { useTelemetryStream, normalizeDownsampleAlgorithm } from "./composables/useTelemetryStream.js";
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

const {
  stopStream,
  setStream,
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
  if (!server_ip.value) return;
  statusRefreshTimer = setInterval(() => {
    requestStatusSnapshot('interval');
  }, STATUS_REFRESH_MS);
}

// ── State stream (/ws/state → devices, kasa, commands) ──────────────────────

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
} = useStateStream(server_ip);
provide('devices',      devices);
provide('kasaDevices',  kasaDevices);
provide('commandsById', commandsById);
provide('session',      session);
provide('sessionWarning', sessionWarning);
provide('stateStreamStatus', stateStatus);

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
const localRecorderAvailable = ref(isTauri());
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
    invoke('set_server_session_lock', { sessionId }).catch((err) => {
      console.error('[App] set_server_session_lock failed:', err);
    });
  },
  { immediate: true },
);

// ── Telemetry streams (display→charts; raw→CSV is ingested on the Rust side) ─

const { sensorData, telemetryStats, streamAlgorithm, clearSensorData } =
  useTelemetryStream(server_ip, downsampleAlgorithm);
provide('sensorData', sensorData);
provide('telemetryStats', telemetryStats);
provide('streamAlgorithm', streamAlgorithm);

// ── Control state bits → Rust (used by the raw-telemetry CSV recorder) ───────
// The raw /ws/telemetry/raw stream is consumed entirely in Rust and only
// carries sensor readings, so valve/auxiliary/kasa state bits — derived here
// from /ws/state — are pushed separately whenever they change. Tare offsets
// need no such push: the server applies them before the stream is sent.

function _normalizeId(id) { return id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() }

function pushControlStates() {
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

  invoke('update_control_states', {
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

async function discover() {
  await Promise.allSettled([
    discoverKasaDevices()
      .catch((err) => console.error('[App] discoverKasa failed:', err)),
    discoverDevices()
      .catch((err) => console.error('[App] discoverDevices failed:', err)),
  ])
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
    localRecordingActive.value = !!(await invoke('local_recording_active'));
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
  await invoke('start_recording', {
    mode:     pidConfig.value,
    datetime: formatDatetime(),
  });
  localRecordingActive.value = true;
  publishLocalRecorderChange();
  await refreshLocalRecordingStatus();
}

async function disarmLocalRecorder() {
  if (!localRecorderAvailable.value) return;
  await invoke('stop_recording');
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

let previewRestorePending = false;
let previewRestoreInFlight = false;
let previewBootstrapTarget = null;
let previewBootstrapReady = false;

async function maybeRestorePreview() {
  if (
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
    await setStream(30);
  } catch (err) {
    previewRestorePending = true;
    lifecycleError.value = `Recorders stopped, but preview could not restart: ${describeError(err)}`;
  } finally {
    previewRestoreInFlight = false;
  }
}

async function maybeStartIdlePreview() {
  if (
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
    await setStream(30);
  } catch (err) {
    if (server_ip.value === target) previewBootstrapTarget = target;
    if (server_ip.value === target) previewBootstrapReady = true;
    console.error('[App] preview STREAM failed:', err);
  }
}

async function restoreTestStreamForPartialStop() {
  if (!server_ip.value || (!testActive.value && !localRecordingActive.value)) return;
  try {
    await setStream(testFrequency.value);
  } catch (err) {
    lifecycleError.value = `A recorder is still active and the test stream could not restart: ${describeError(err)}`;
  }
}

async function startTest() {
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
        try { await setStream(30); } catch { /* keep the server-session error */ }
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
      try { await setStream(30); } catch { /* keep the original start error */ }
    }
  } finally {
    lifecycleBusy.value = false;
  }
}

async function stopTest() {
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

// ── Config fetch on connect ──────────────────────────────────────────────────
// The /ws/state socket auto-resyncss on connect, so no manual config fetching is
// needed — the snapshot brings devices, kasa, commands and tares. We just manage
// the stream rate.

watch(server_ip, async (ip) => {
  stopStatusRefresh();
  previewBootstrapTarget = ip || null;
  previewBootstrapReady = false;

  clearSensorData();
  clearLogs();

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

_settingsChannel.onmessage = (e) => {
  if (e.data.type === 'pidConfig')     pidConfig.value     = e.data.value;
  if (e.data.type === 'testFrequency') testFrequency.value = e.data.value;
  // Re-validate on the way in: another window is no more trustworthy a source
  // than localStorage, and an unknown value would reach the socket URL.
  if (e.data.type === 'downsampleAlgorithm') {
    downsampleAlgorithm.value = normalizeDownsampleAlgorithm(e.data.value);
  }
  // darkMode messages are handled by settings_modal.vue's own channel instance
};

// ── Settings ─────────────────────────────────────────────────────────────────

async function get_ip(new_ip) {
  if (localRecordingActive.value || (testActive.value && stateStatus.value === 'connected')) {
    lifecycleError.value = 'Stop active recording before changing the server.';
    return;
  }
  if (localRecorderAvailable.value) {
    try {
      await invoke('submit_ip', { newIp: new_ip });
    } catch (err) {
      lifecycleError.value = `Server change blocked: ${describeError(err)}`;
      return;
    }
  }
  server_ip.value = new_ip;
}

const settingsOpen = ref(false);
const aboutOpen    = ref(false);

onMounted(() => {
  // Tares need no bootstrap: the /ws/state snapshot that arrives on connect
  // carries the full map, and tare.updated/tare.cleared deltas keep it current.
  void refreshLocalRecordingStatus();
  if (localRecorderAvailable.value) {
    invoke("fetch_server_ip")
      .then((ip) => { if (ip) server_ip.value = ip; })
      .catch(() => {});
  }
});

onUnmounted(() => {
  stopStatusRefresh();
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
      :downsample-algorithm="downsampleAlgorithm"
      :test-active="testActive"
      :server-session-active-connected="testActive && stateStatus === 'connected'"
      :local-recording-active="localRecordingActive"
      @close="settingsOpen = false"
      @update-ip="get_ip"
      @update-pid-config="pidConfig = $event"
      @update-test-frequency="testFrequency = $event"
      @update-downsample-algorithm="downsampleAlgorithm = $event"
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
