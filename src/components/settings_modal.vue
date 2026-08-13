<script setup>
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import { CAPS } from "../lib/platform.js";
import { useKeyBindings, buildKeyCombo } from "../composables/useKeyBindings.js";
import ToggleSwitch from 'primevue/toggleswitch';
import RadioButton from 'primevue/radiobutton';

const props = defineProps({
  isOpen:        Boolean,
  currentIp:     String,
  pidConfig:     { type: String,  default: 'rocket-launch' },
  testFrequency: { type: Number,  default: 190 },
  testActive:    { type: Boolean, default: false },
  serverSessionActiveConnected: { type: Boolean, default: false },
  localRecordingActive: { type: Boolean, default: false },
});

const emit = defineEmits(["close", "update-ip", "update-pid-config", "update-test-frequency"]);

const ipMode = ref("none");
const customIp = ref("");
const localPidConfig = ref("rocket-launch");
const localTestFreq = ref(190);
const overlayRef = ref(null);
const serverIpLocked = computed(
  () => props.serverSessionActiveConnected || props.localRecordingActive,
);

// The web build is served by the host it talks to, so it has no server to pick.
const canSelectServer = CAPS.serverSelection;
// Gates only the settings that issue commands — currently the stream frequency,
// which re-rates the whole stand. Deliberately not the P&ID picker: that just
// selects which diagram this client draws. See the template.
const readOnly = !CAPS.commands;

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
  (open) => {
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
    }
  }
);

watch(localPidConfig, (cfg) => {
  emit("update-pid-config", cfg);
});

watch(localTestFreq, (hz) => {
  const n = Math.max(1, Math.round(Number(hz)))
  if (isFinite(n) && n !== props.testFrequency) emit("update-test-frequency", n)
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
// The list of bindable controls is published by control_panel.vue, which is the
// only place that knows them: valves come from the parsed P&ID, not the device
// list. Every window mounts that panel first, so the list is populated by the
// time anyone opens this modal. All binding logic lives in the composable — this
// is just the editor.

const { editableTargets, keyForTarget, setBinding, clearBinding } = useKeyBindings();

// Sectioned in registration order so the editor reads like the control panel.
const bindingGroups = computed(() => {
  const groups = [];
  for (const row of editableTargets.value) {
    const name = row.group || 'Controls';
    let group = groups.find((g) => g.name === name);
    if (!group) groups.push((group = { name, rows: [] }));
    group.rows.push(row);
  }
  return groups;
});

function comboFor(row) {
  return keyForTarget.value[row.id] ?? '';
}

// The input is readonly and its keydowns are captured, not typed: whatever
// combo is pressed becomes the binding. Backspace/delete clears it instead.
// Tab and escape are left alone so the modal can still be navigated and
// dismissed while a row has focus; setBinding rejects the rest of the reserved
// keys itself.
function captureKey(row, event) {
  if (event.key === 'Tab' || event.key === 'Escape') return;
  event.preventDefault();
  if (event.key === 'Backspace' || event.key === 'Delete') {
    clearBinding(row.target);
    return;
  }
  setBinding(row.target, buildKeyCombo(event));
}
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
        <!-- Hidden in the pad build for the same reason as the frequency above:
             that client cannot command the stand, so a shortcut for doing so
             would be a control that looks live and does nothing. -->
        <div class="setting-group" v-if="!readOnly">
          <span class="setting-group-label"><i class="pi pi-key" />Keybindings</span>
          <div v-if="bindingGroups.length === 0" class="binding-empty">
            Open the Control panel to load bindable controls.
          </div>
          <div v-else class="binding-list">
            <template v-for="group in bindingGroups" :key="group.name">
              <div class="binding-group-label">{{ group.name }}</div>
              <div v-for="row in group.rows" :key="row.id" class="option-row binding-row">
                <span class="binding-label">{{ row.label }}</span>
                <span v-if="row.action" class="binding-action">{{ row.action }}</span>
                <input
                  type="text"
                  readonly
                  class="ip-text-input binding-input"
                  :value="comboFor(row)"
                  placeholder="unbound"
                  @keydown="captureKey(row, $event)"
                />
                <button
                  class="binding-clear-btn"
                  title="Clear"
                  :disabled="!comboFor(row)"
                  @click="clearBinding(row.target)"
                >
                  <i class="pi pi-times" />
                </button>
              </div>
            </template>
          </div>
          <span class="binding-hint">
            Click a field and press a key to bind it; backspace clears.
            Each key commands one state, so open and close are bound separately.
            Shortcuts act on the Control panel only.
          </span>
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
      </div>
    </div>
  </div>
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
  background: var(--modal-bg);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  min-width: 320px;
  max-width: 420px;
  width: 90%;
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

.binding-row {
  gap: 6px;
  cursor: default;
}

.binding-row:hover {
  background: none;
}

.binding-label {
  flex: 1;
  font-size: 0.85rem;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The state this key commands. Fixed-width so the key fields line up down the
   column and an unbound half of a pair is obvious at a glance. */
.binding-action {
  flex: none;
  width: 52px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  text-align: right;
}

.binding-input {
  flex: none;
  width: 96px;
  text-align: center;
  cursor: pointer;
  text-transform: lowercase;
}

.binding-clear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--text-secondary);
  font-size: 0.7rem;
  cursor: pointer;
  padding: 0;
}

.binding-clear-btn:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--border-color);
  background: var(--bg-secondary);
}

.binding-clear-btn:disabled {
  opacity: 0.25;
  cursor: default;
}

.binding-hint,
.binding-empty {
  font-size: 0.68rem;
  color: var(--text-muted);
  font-style: italic;
  line-height: 1.4;
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
