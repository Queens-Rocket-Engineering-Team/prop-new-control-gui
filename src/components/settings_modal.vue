<script setup>
import { ref, watch, nextTick, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import ToggleSwitch from 'primevue/toggleswitch';
import RadioButton from 'primevue/radiobutton';
import { useKeyBindings } from "../composables/useKeyBindings.js";

const props = defineProps({
  isOpen: Boolean,
  currentIp: String,
  pidConfig: { type: String, default: 'rocket-launch' },
});

const emit = defineEmits(["close", "update-ip", "update-pid-config"]);

const ipMode = ref("none");
const customIp = ref("");
const cameraRecordingDir = ref("");
const darkMode = ref(false);  // false = light, true = dark
const localPidConfig = ref("rocket-launch");
const overlayRef = ref(null);

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

      try {
        const dir = await invoke("fetch_camera_recording_dir");
        cameraRecordingDir.value = dir || "";
      } catch (err) {
        console.error("Failed to fetch camera recording directory:", err);
      }
    }
  }
);

watch(localPidConfig, (cfg) => {
  emit("update-pid-config", cfg);
});

watch(darkMode, (isDark) => {
  document.documentElement.classList.toggle("dark-mode", isDark);
  // Set color-scheme so the SVG's light-dark() CSS function resolves correctly
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
});

function isValidIp(ip) {
  const ipv4Pattern = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
  return ipv4Pattern.test(ip);
}

function applyIp() {
  if (ipMode.value === "none") {
    emit("update-ip", "");
    return;
  }
  const ip = ipMode.value === "localhost" ? "localhost" : customIp.value.trim();
  if (ipMode.value === "custom" && (!ip || !isValidIp(ip))) return;
  invoke("submit_ip", { newIp: ip });
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

function applyCameraRecordingDir() {
  const dir = cameraRecordingDir.value.trim();
  invoke("set_camera_recording_dir", { newDir: dir });
}

// ------- keybindings editing support ---------------------------------------
const {
  controlKeyMap,
  userBindings,
  knownValves,
  knownAux,
  knownKasa,
} = useKeyBindings();

const controlList = computed(() => {
  const list = [];
  for (const id of knownValves.value) list.push({ type: 'valve', id });
  for (const key of knownAux.value) list.push({ type: 'aux', key });
  for (const host of knownKasa.value) list.push({ type: 'kasa', host });
  return list;
});

function ctrlId(ctrl) {
  if (ctrl.type === 'valve') return `valve:${ctrl.id}`;
  if (ctrl.type === 'aux') return `aux:${ctrl.key}`;
  if (ctrl.type === 'kasa') return `kasa:${ctrl.host}`;
  return '';
}

function ctrlLabel(ctrl) {
  if (ctrl.type === 'valve') return ctrl.id;
  if (ctrl.type === 'aux') return ctrl.key;
  if (ctrl.type === 'kasa') return ctrl.host;
  return '';
}

function matches(ctrl, entry) {
  if (!entry) return false;
  if (ctrl.type === 'valve' && entry.type === 'valve') return entry.id === ctrl.id;
  if (ctrl.type === 'aux' && entry.type === 'aux') return entry.key === ctrl.key;
  if (ctrl.type === 'kasa' && entry.type === 'kasa') return entry.host === ctrl.host;
  return false;
}

function keyFor(ctrl) {
  for (const [k, entry] of Object.entries(userBindings.value)) {
    if (matches(ctrl, entry)) return k;
  }
  for (const [k, entry] of Object.entries(controlKeyMap.value)) {
    if (matches(ctrl, entry)) return k;
  }
  return '';
}

// Helper to build a normalized key combination string from a KeyboardEvent
function buildKeyCombo(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  const key = event.key.toLowerCase();
  if (key && !['control', 'alt', 'shift', 'meta'].includes(key)) {
    parts.push(key);
  }
  return parts.join('+');
}

// Helper to validate a key combo (basic: at least one key, no empty)
function isValidKeyCombo(combo) {
  return combo && combo.split('+').length >= 1;
}

function setKeyFor(ctrl, newCombo) {
  newCombo = String(newCombo).toLowerCase().trim();
  if (!isValidKeyCombo(newCombo)) return;
  for (const k of Object.keys(userBindings.value)) {
    if (matches(ctrl, userBindings.value[k])) {
      delete userBindings.value[k];
    }
  }
  if (newCombo in userBindings.value) {
    delete userBindings.value[newCombo];
  }
  userBindings.value[newCombo] = {
    type: ctrl.type,
    ...(ctrl.type === 'valve'
      ? { id: ctrl.id }
      : ctrl.type === 'aux'
      ? { key: ctrl.key }
      : { host: ctrl.host }),
  };
}

function clearKey(ctrl) {
  for (const k of Object.keys(userBindings.value)) {
    if (matches(ctrl, userBindings.value[k])) {
      delete userBindings.value[k];
    }
  }
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
        <h3>Settings</h3>
        <button class="modal-close-btn" @click="$emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="setting-group">
          <span class="setting-group-label">View</span>
          <div class="view-toggle">
            <i class="pi pi-sun" :style="{color: darkMode ? 'var(--text-secondary)' : '#f39c12'}"></i>
            <ToggleSwitch v-model="darkMode" class="theme-switch" />
            <i class="pi pi-moon" :style="{color: darkMode ? '#f39c12' : 'var(--text-secondary)'}"></i>
          </div>
        </div>
        <div class="setting-group">
          <span class="setting-group-label">Test Configuration</span>
          <div class="option-row">
            <RadioButton v-model="localPidConfig" value="hot-fire" inputId="cfg-hot-fire" />
            <label for="cfg-hot-fire">Hot Fire</label>
          </div>
          <div class="option-row">
            <RadioButton v-model="localPidConfig" value="rocket-launch" inputId="cfg-rocket-launch" />
            <label for="cfg-rocket-launch">Rocket Launch</label>
          </div>
        </div>
        <div class="setting-group">
          <span class="setting-group-label">Server IP Address</span>
          <div class="option-row">
            <RadioButton v-model="ipMode" value="localhost" />
            <label>Localhost (127.0.0.1)</label>
          </div>
          <div class="option-row">
            <RadioButton v-model="ipMode" value="custom" />
            <label>Custom: </label>
            <input
              type="text"
              v-model="customIp"
              placeholder="e.g. 192.168.1.100"
              :disabled="ipMode !== 'custom'"
              class="ip-text-input"
              @click="ipMode = 'custom'"
            />
          </div>
        </div>

        <div class="setting-group">
          <span class="setting-group-label">Camera Recording Directory</span>
          <input
            type="text"
            v-model="cameraRecordingDir"
            class="ip-text-input"
            placeholder="Defaults to your Videos folder"
            @blur="applyCameraRecordingDir"
            @keyup.enter="applyCameraRecordingDir"
          />
        </div>

        <div class="setting-group">
          <span class="setting-group-label">Keybindings</span>
          <div
            v-for="ctrl in controlList"
            :key="ctrlId(ctrl)"
            class="option-row binding-row"
          >
            <label>{{ ctrlLabel(ctrl) }}</label>
            <input
              type="text"
              :value="keyFor(ctrl)"
              readonly
              class="key-input"
              placeholder="Click to set"
              @keydown.prevent="e => setKeyFor(ctrl, buildKeyCombo(e))"
              @focus="$event.target.select()"
            />
            <button class="clear-btn" @click="clearKey(ctrl)">×</button>
          </div>
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
}

.modal-container {
  background: var(--modal-bg);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  min-width: 320px;
  max-width: 420px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.modal-body {
  padding: 20px 18px;
}

/* Close button styles */
.modal-close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 1rem;
  cursor: pointer;
  padding: 2px 6px;
  line-height: 1;
  box-shadow: none;
}

.modal-close-btn:hover {
  color: var(--text-primary);
  border-color: transparent;
  background: none;
}

/* Setting group styles */
.setting-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.setting-group-label {
  font-size: 0.78rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
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
}

.option-row :deep(.p-radiobutton) {
  margin-right: 6px;
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

/* Keybinding editor styles */
.binding-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.key-input {
  min-width: 80px;
  padding: 2px 4px;
  font-size: 0.9rem;
  text-transform: lowercase;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
}
.key-input:focus {
  outline: none;
  border-color: var(--input-focus-border);
}
.clear-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}
.clear-btn:hover {
  color: var(--text-primary);
}

</style>
