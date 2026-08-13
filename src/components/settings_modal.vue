<script setup>
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import { CAPS } from "../lib/platform.js";
import { useKeyBindings } from "../composables/useKeyBindings.js";
import KeybindsModal from "./keybinds_modal.vue";
import { invoke } from "@tauri-apps/api/core";
import ToggleSwitch from 'primevue/toggleswitch';
import RadioButton from 'primevue/radiobutton';
import { DEFAULT_DOWNSAMPLE_ALGORITHM } from '../composables/useTelemetryStream.js';
import Checkbox from 'primevue/checkbox';

const props = defineProps({
  isOpen:           Boolean,
  currentIp:        String,
  pidConfig:        { type: String,  default: 'rocket-launch' },
  testFrequency:    { type: Number,  default: 190 },
  downsampleAlgorithm: { type: String, default: DEFAULT_DOWNSAMPLE_ALGORITHM },
  testActive:       { type: Boolean, default: false },
  serverSessionActiveConnected: { type: Boolean, default: false },
  localRecordingActive:         { type: Boolean, default: false },
  mapSitesDisabled: { type: Array,   default: () => [] },
  mapsDir:          { type: String,  default: '' },
});

const emit = defineEmits([
  "close",
  "update-ip",
  "update-pid-config",
  "update-test-frequency",
  "update-downsample-algorithm",
  "update-map-sites-disabled",
  "update-maps-dir",
  "fly-to-site",
  "maps-changed",
]);

const ipMode = ref("none");
const customIp = ref("");
const localPidConfig = ref("rocket-launch");
const localTestFreq = ref(190);
const localDownsample = ref(DEFAULT_DOWNSAMPLE_ALGORITHM);
const localMapsDir = ref("");
const mapSites = ref([]);
const overlayRef = ref(null);
const serverIpLocked = computed(
  () => props.serverSessionActiveConnected || props.localRecordingActive,
);
const pendingDelete = ref("");   // site.file awaiting delete confirmation
const deleteError = ref("");

// The web build is served by the host it talks to, so it has no server to pick.
const canSelectServer = CAPS.serverSelection;
// Gates only the settings that issue commands — currently the stream frequency,
// which re-rates the whole stand. Deliberately not the P&ID picker: that just
// selects which diagram this client draws. See the template.
const readOnly = !CAPS.commands;

const _isTauri = '__TAURI_INTERNALS__' in window;

async function resolveDefaultMapsDir() {
  if (!_isTauri) return "";
  try {
    return await invoke("resolve_maps_dir");
  } catch (err) {
    console.error("Failed to resolve maps directory:", err);
    return "";
  }
}

async function refreshMapSites() {
  if (!_isTauri) return;
  try {
    const manifest = await invoke("list_map_sites");
    mapSites.value = manifest?.sites ?? [];
  } catch (err) {
    console.error("Failed to list map sites:", err);
    mapSites.value = [];
  }
}

// ── Dark mode — persisted in localStorage, synced across windows ──────────────
// localStorage is shared across all Tauri windows (same WebView2 data dir),
// so new windows automatically inherit the saved state on mount.

const darkMode = ref(localStorage.getItem('qret-dark-mode') === 'true');

function applyDarkMode(isDark) {
  document.documentElement.classList.toggle('dark-mode', isDark);
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

// Apply saved state immediately when this window opens (before any user action)
onMounted(() => applyDarkMode(darkMode.value));

const _settingsChannel = new BroadcastChannel('qret-settings');
let _applyingBroadcast = false;

watch(darkMode, (isDark) => {
  applyDarkMode(isDark);
  localStorage.setItem('qret-dark-mode', isDark);
  if (!_applyingBroadcast) {
    _settingsChannel.postMessage({ type: 'darkMode', value: isDark });
  }
});

_settingsChannel.onmessage = (e) => {
  if (e.data.type !== 'darkMode') return;
  _applyingBroadcast = true;
  darkMode.value = e.data.value;
  _applyingBroadcast = false;
};

onUnmounted(() => _settingsChannel.close());

watch(
  () => props.isOpen,
  async (open) => {
    if (open) {
      nextTick(() => overlayRef.value?.focus());
      const ip = props.currentIp || "";
      if (!ip) {
        ipMode.value = "none";
      } else if (ip === "localhost" || ip === "127.0.0.1") {
        ipMode.value = "localhost";
      } else {
        ipMode.value = "custom";
        customIp.value = ip;
      }
      localPidConfig.value = props.pidConfig || "rocket-launch";
      localTestFreq.value  = props.testFrequency || 190;
      localDownsample.value = props.downsampleAlgorithm || DEFAULT_DOWNSAMPLE_ALGORITHM;
      pendingDelete.value  = "";
      deleteError.value    = "";
      // Show the directory actually in use: the configured one, or the
      // platform default the backend falls back to when none is set.
      localMapsDir.value   = props.mapsDir || (await resolveDefaultMapsDir());
      refreshMapSites();
    }
  }
);

function siteShown(file) {
  return !props.mapSitesDisabled.includes(file);
}

function toggleSite(file, shown) {
  const disabled = props.mapSitesDisabled.filter((f) => f !== file);
  if (!shown) disabled.push(file);
  emit("update-map-sites-disabled", disabled);
}

// Jump the flight map to a site. App.vue also switches to the flight panel and
// closes this modal, so the result is actually visible.
function goToSite(site) {
  emit("fly-to-site", { name: site.name, bbox: site.bbox });
}

// Deleting a downloaded site throws away a download that may have taken a long
// time, so it takes two clicks: the row swaps to a confirm prompt first.
async function confirmDelete(site) {
  deleteError.value = "";
  try {
    await invoke("delete_map_site", { file: site.file });
    pendingDelete.value = "";
    // Drop any stale hidden-state for a file that no longer exists.
    if (props.mapSitesDisabled.includes(site.file)) {
      emit("update-map-sites-disabled", props.mapSitesDisabled.filter((f) => f !== site.file));
    }
    await refreshMapSites();
    emit("maps-changed");
  } catch (err) {
    deleteError.value = String(err);
    console.error("[Settings] delete_map_site failed:", err);
  }
}

function applyMapsDir() {
  const dir = localMapsDir.value.trim();
  if (dir === props.mapsDir) return;
  emit("update-maps-dir", dir);
  // Re-list sites once App.vue has pushed the new dir to the backend.
  setTimeout(refreshMapSites, 300);
}

watch(localPidConfig, (cfg) => {
  emit("update-pid-config", cfg);
});

watch(localTestFreq, (hz) => {
  const n = Math.max(1, Math.round(Number(hz)))
  if (isFinite(n) && n !== props.testFrequency) emit("update-test-frequency", n)
});

// Reopening the modal reseeds localDownsample from the prop, which would echo
// the value straight back — guard so only real operator changes reconnect the
// telemetry socket.
watch(localDownsample, (algorithm) => {
  if (algorithm !== props.downsampleAlgorithm) emit("update-downsample-algorithm", algorithm)
});

function isValidIp(ip) {
  const ipv4Pattern = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
  return ipv4Pattern.test(ip);
}

// Emits only — persisting the choice is App.vue's job (get_ip), which is also
// where it can refuse the change outright if a recording is running. This just
// declines to emit while locked so the modal cannot start an argument it has
// no standing to win.
function applyIp() {
  if (serverIpLocked.value) return;

  if (ipMode.value === "none") {
    emit("update-ip", "");
    return;
  }
  const ip = ipMode.value === "localhost" ? "localhost" : customIp.value.trim();
  if (ipMode.value === "custom" && (!ip || !isValidIp(ip))) return;
  emit("update-ip", ip);
}

watch(ipMode, () => {
  applyIp();
});

watch(customIp, () => {
  if (ipMode.value === "custom") {
    applyIp();
  }
});

// ── Keybindings ──────────────────────────────────────────────────────────────
// The editor itself lives in its own modal: every actuator binds two keys, and
// that grid does not fit this modal's width. All this group holds is the way in
// and a count of what is currently bound.

const { bindings } = useKeyBindings();
const keybindsOpen = ref(false);

const boundCount = computed(() => Object.keys(bindings.value).length);
</script>

<template>
  <div v-if="isOpen"
       ref="overlayRef"
       class="modal-overlay"
       @click.self="$emit('close')"
       @keydown.esc="$emit('close')"
       tabindex="-1">
    <div class="modal-container">
      <div class="modal-header">
        <div class="modal-header-title">
          <i class="pi pi-cog" />
          <h3>Settings</h3>
        </div>
        <button class="modal-close-btn" @click="$emit('close')" title="Close">
          <i class="pi pi-times" />
        </button>
      </div>
      <div class="modal-body">
        <div class="setting-group">
          <span class="setting-group-label"><i class="pi pi-palette" />View</span>
          <div class="view-toggle">
            <i class="pi pi-sun" :style="{color: darkMode ? 'var(--text-secondary)' : '#f39c12'}"></i>
            <ToggleSwitch v-model="darkMode" class="theme-switch" />
            <i class="pi pi-moon" :style="{color: darkMode ? '#f39c12' : 'var(--text-secondary)'}"></i>
          </div>
        </div>
        <!-- Not gated: this picks which P&ID the client draws, which is a
             per-client view preference (localStorage + a same-browser
             BroadcastChannel), not a command. An engineer at the pad needs it
             to look at the stand they are standing next to. -->
        <div class="setting-group">
          <span class="setting-group-label"><i class="pi pi-sliders-h" />Test Configuration</span>
          <label class="option-row" for="cfg-hot-fire">
            <RadioButton v-model="localPidConfig" value="hot-fire" inputId="cfg-hot-fire" />
            <span>Hot Fire</span>
          </label>
          <label class="option-row" for="cfg-rocket-launch">
            <RadioButton v-model="localPidConfig" value="rocket-launch" inputId="cfg-rocket-launch" />
            <span>Rocket Launch</span>
          </label>
        </div>
        <div class="setting-group" v-if="!readOnly">
          <span class="setting-group-label"><i class="pi pi-wave-pulse" />Test Stream Frequency</span>
          <div class="option-row freq-row">
            <input
              type="number"
              v-model.number="localTestFreq"
              min="1"
              max="1000"
              :disabled="props.testActive"
              class="ip-text-input freq-input"
            />
            <span class="freq-unit-label">Hz</span>
            <span v-if="props.testActive" class="freq-locked-label">locked during test</span>
          </div>
        </div>
        <!-- Not gated on readOnly: which downsampler the server runs for *this*
             client's display socket is a per-client view preference, like the
             P&ID picker above, and changes nothing about the stand. -->
        <div class="setting-group">
          <span class="setting-group-label"><i class="pi pi-chart-line" />Graph Downsampling</span>
          <label class="option-row" for="ds-m4">
            <RadioButton v-model="localDownsample" value="m4" inputId="ds-m4" />
            <span>Peak-preserving (M4)</span>
          </label>
          <label class="option-row" for="ds-decimation">
            <RadioButton v-model="localDownsample" value="decimation" inputId="ds-decimation" />
            <span>Evenly spaced (decimation)</span>
          </label>
          <span class="setting-hint">
            M4 keeps spikes; decimation looks smoother but can miss brief transients.
            Changing this reconnects the telemetry stream.
          </span>
        </div>

        <!-- Hidden in the pad build for the same reason as the frequency above:
             that client cannot command the stand, so a shortcut for doing so
             would be a control that looks live and does nothing. -->
        <div class="setting-group" v-if="!readOnly">
          <span class="setting-group-label"><i class="pi pi-key" />Keybindings</span>
          <div class="option-row binding-row">
            <span class="binding-summary">
              {{ boundCount === 0 ? 'No shortcuts set' : `${boundCount} shortcut${boundCount === 1 ? '' : 's'} set` }}
            </span>
            <button class="binding-open-btn" @click="keybindsOpen = true">
              <i class="pi pi-pencil" />
              <span>Edit</span>
            </button>
          </div>
        </div>
        <!-- The pad reaches the server by loading this page from it, so there is
             nothing here for it to decide — see CAPS.serverSelection. -->
        <div class="setting-group" v-if="canSelectServer">
          <span class="setting-group-label"><i class="pi pi-server" />Server IP Address</span>
          <label class="option-row">
            <RadioButton v-model="ipMode" value="localhost" :disabled="serverIpLocked" />
            <span>Localhost (127.0.0.1)</span>
          </label>
          <label class="option-row">
            <RadioButton v-model="ipMode" value="custom" :disabled="serverIpLocked" />
            <span class="custom-ip-label">Custom:</span>
            <input
              type="text"
              v-model="customIp"
              placeholder="e.g. 192.168.1.100"
              :disabled="serverIpLocked || ipMode !== 'custom'"
              class="ip-text-input"
              @click="!serverIpLocked && (ipMode = 'custom')"
            />
          </label>
          <span v-if="serverIpLocked" class="freq-locked-label">
            locked while a server session or laptop recording is active
          </span>
        </div>

        <div class="setting-group">
          <span class="setting-group-label"><i class="pi pi-folder" />Map Directory</span>
          <input
            type="text"
            v-model="localMapsDir"
            class="ip-text-input"
            @blur="applyMapsDir"
            @keyup.enter="applyMapsDir"
          />
          <span class="no-sites-hint">Holds manifest.json and the downloaded .mbtiles files.</span>
        </div>

        <div class="setting-group">
          <span class="setting-group-label"><i class="pi pi-map" />Flight Maps</span>

          <template v-for="site in mapSites" :key="site.file">
            <div v-if="pendingDelete === site.file" class="option-row site-row confirm-row">
              <span class="confirm-text">Delete “{{ site.name }}”?</span>
              <button class="site-btn destructive" title="Confirm delete" @click="confirmDelete(site)">
                Delete
              </button>
              <button class="site-btn" title="Keep it" @click="pendingDelete = ''">Cancel</button>
            </div>

            <div v-else class="option-row site-row">
              <Checkbox
                :model-value="siteShown(site.file)"
                :binary="true"
                :inputId="'site-' + site.name"
                @update:model-value="toggleSite(site.file, $event)"
              />
              <label :for="'site-' + site.name" class="site-label">
                {{ site.name }}
                <span class="site-zoom-hint">z{{ site.minzoom }}–{{ site.maxzoom }}</span>
              </label>
              <button
                class="site-btn"
                title="Zoom the flight map to this site"
                :disabled="!site.bbox"
                @click="goToSite(site)"
              >
                Go
              </button>
              <button
                class="site-btn icon danger"
                title="Delete this downloaded map"
                @click="pendingDelete = site.file"
              >
                <i class="pi pi-trash" />
              </button>
            </div>
          </template>

          <span v-if="deleteError" class="delete-error">{{ deleteError }}</span>
          <span v-if="mapSites.length > 0" class="no-sites-hint">
            Checked sites are layered on the flight map; finer zoom draws on top.
          </span>
          <span v-if="mapSites.length === 0" class="no-sites-hint">
            No sites downloaded yet — use Download Maps on the Flight panel.
          </span>
        </div>
      </div>
    </div>
  </div>

  <!-- Outside the overlay above, and teleported to <body> from inside itself:
       it stands on its own, so closing Settings behind it leaves it open and its
       esc keydown does not also dismiss Settings. -->
  <keybinds-modal :is-open="keybindsOpen" @close="keybindsOpen = false" />
</template>

<style scoped>
/* Top level modal styles */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  /* The overlay is focused programmatically so it can receive the esc keydown.
     It is tabindex="-1" (not keyboard-reachable), so suppressing the focus ring
     costs nothing — otherwise Chromium traces one around the whole viewport. */
  outline: none;
}

.modal-container {
  display: flex;
  flex-direction: column;
  background: var(--modal-bg);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  min-width: 320px;
  max-width: 420px;
  width: 90%;
  /* The overlay centres this box, so anything taller than the viewport spills
     off both ends with no way to reach either. Five groups clear a short laptop
     window, so the body scrolls and the header stays put. */
  max-height: 90vh;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-color);
}

.modal-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-header-title .pi {
  font-size: 0.95rem;
  color: var(--text-muted);
}

.modal-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.2px;
  color: var(--text-primary);
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  min-height: 0;
  overflow-y: auto;
}

/* Close button styles */
.modal-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0;
  box-shadow: none;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.modal-close-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-color);
  background: var(--bg-secondary);
}

/* Setting group styles — bordered section card, matching the app's card sections */
.setting-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.setting-group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.setting-group-label .pi {
  font-size: 0.78rem;
}

/* IP Input styles */
.ip-text-input {
  flex: 1;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 4px 8px;
  font-size: 0.9rem;
  font-family: inherit;
}

.ip-text-input:focus {
  outline: none;
  border-color: var(--input-focus-border);
}

.ip-text-input:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Dark mode toggle styles */
.view-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}

.theme-switch {
  --p-toggleswitch-width: 36px;
  --p-toggleswitch-height: 20px;
  --p-toggleswitch-handle-size: 14px;
}

/* Individual setting row option styles */
.option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  margin: 0 -6px;
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.12s;
}

label.option-row:hover {
  background: var(--bg-primary);
}

.option-row span {
  font-size: 0.85rem;
  color: var(--text-primary);
}

.custom-ip-label {
  white-space: nowrap;
}

.freq-row {
  gap: 6px;
  cursor: default;
}

.freq-row:hover {
  background: none;
}

.freq-input {
  width: 72px;
  flex: none;
  text-align: right;
}

.freq-unit-label {
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.freq-locked-label {
  font-size: 0.68rem;
  color: var(--text-muted);
  font-style: italic;
  margin-left: 4px;
}

.setting-hint {
  font-size: 0.68rem;
  line-height: 1.35;
  color: var(--text-muted);
}

/* Keybinding editor */
/* A stand can carry twenty-odd valves, so the list scrolls inside the group
   rather than pushing the rest of the settings off the modal. */
.binding-list {
  display: flex;
  flex-direction: column;
  max-height: 220px;
  overflow-y: auto;
  padding-right: 2px;
}

.binding-group-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 6px 0 2px;
}

.binding-group-label:first-child {
  margin-top: 0;
}

/* Keybindings — a summary and the way into the editor, which is its own modal. */
.binding-row {
  gap: 8px;
  cursor: default;
}

.binding-row:hover {
  background: none;
}

.binding-summary {
  flex: 1;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.binding-open-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.8rem;
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.binding-open-btn:hover {
  border-color: var(--input-focus-border);
}

.binding-open-btn .pi {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.site-zoom-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-left: 4px;
}

/* Site rows: name takes the slack, controls pin to the right edge. */
.site-row {
  gap: 6px;
}

.site-label {
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  color: var(--text-primary);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.site-btn {
  flex: none;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-family: inherit;
  padding: 2px 8px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.site-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-surface);
}

.site-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.site-btn.icon {
  display: inline-flex;
  align-items: center;
  padding: 3px 7px;
}

.site-btn.danger:hover:not(:disabled) {
  color: #ff6b6b;
  border-color: #ff6b6b;
}

/* The confirm step reads as destructive before it is hovered, not after. */
.site-btn.destructive {
  color: #fff;
  background: #d9463f;
  border-color: #d9463f;
  font-weight: 600;
}

.site-btn.destructive:hover {
  background: #c23a34;
  border-color: #c23a34;
  color: #fff;
}

.confirm-row {
  gap: 6px;
}

.confirm-text {
  flex: 1;
  min-width: 0;
  font-size: 0.8rem;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.delete-error {
  font-size: 0.78rem;
  color: #ff6b6b;
}

.no-sites-hint {
  font-size: 0.78rem;
  color: var(--text-muted);
  font-style: italic;
}

.option-row :deep(.p-radiobutton) {
  margin-right: 0;
  flex-shrink: 0;
}

/* Theme transition for dark/light switch */
.modal-overlay,
.modal-container,
.modal-header,
.modal-body,
.modal-footer,
.modal-close-btn,
.ip-text-input,
.setting-group-label,
.server-ip-text {
  transition: var(--theme-transition);
}

</style>
