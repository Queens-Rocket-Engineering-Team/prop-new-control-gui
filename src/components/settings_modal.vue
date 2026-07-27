<script setup>
import { ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import ToggleSwitch from 'primevue/toggleswitch';
import RadioButton from 'primevue/radiobutton';

const props = defineProps({
  isOpen:        Boolean,
  currentIp:     String,
  pidConfig:     { type: String,  default: 'rocket-launch' },
  testFrequency: { type: Number,  default: 190 },
  testActive:    { type: Boolean, default: false },
});

const emit = defineEmits(["close", "update-ip", "update-pid-config", "update-test-frequency"]);

const ipMode = ref("none");
const customIp = ref("");
const cameraRecordingDir = ref("");
const localPidConfig = ref("rocket-launch");
const localTestFreq = ref(190);
const overlayRef = ref(null);

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

watch(localTestFreq, (hz) => {
  const n = Math.max(1, Math.round(Number(hz)))
  if (isFinite(n) && n !== props.testFrequency) emit("update-test-frequency", n)
});

function isValidIp(ip) {
  const ipv4Pattern = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
  return ipv4Pattern.test(ip);
}

function applyIp() {
  if (ipMode.value === "none") {
    invoke("submit_ip", { newIp: "" });
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
        <div class="setting-group">
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
        <div class="setting-group">
          <span class="setting-group-label"><i class="pi pi-server" />Server IP Address</span>
          <label class="option-row">
            <RadioButton v-model="ipMode" value="localhost" />
            <span>Localhost (127.0.0.1)</span>
          </label>
          <label class="option-row">
            <RadioButton v-model="ipMode" value="custom" />
            <span class="custom-ip-label">Custom:</span>
            <input
              type="text"
              v-model="customIp"
              placeholder="e.g. 192.168.1.100"
              :disabled="ipMode !== 'custom'"
              class="ip-text-input"
              @click="ipMode = 'custom'"
            />
          </label>
        </div>

        <div class="setting-group">
          <span class="setting-group-label"><i class="pi pi-video" />Camera Recording Directory</span>
          <input
            type="text"
            v-model="cameraRecordingDir"
            class="ip-text-input"
            placeholder="Defaults to your Videos folder"
            @blur="applyCameraRecordingDir"
            @keyup.enter="applyCameraRecordingDir"
          />
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
