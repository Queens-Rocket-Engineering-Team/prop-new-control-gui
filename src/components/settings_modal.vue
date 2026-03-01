<script setup>
import { ref, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import ToggleSwitch from 'primevue/toggleswitch';
import RadioButton from 'primevue/radiobutton';

const props = defineProps({
  isOpen: Boolean,
  currentIp: String,
});

const emit = defineEmits(["close", "update-ip"]);

const ipMode = ref("none");
const customIp = ref("");
const cameraRecordingDir = ref("");
const darkMode = ref(false);  // false = light, true = dark
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

      try {
        const dir = await invoke("fetch_camera_recording_dir");
        cameraRecordingDir.value = dir || "";
      } catch (err) {
        console.error("Failed to fetch camera recording directory:", err);
      }
    }
  }
);

watch(darkMode, (isDark) => {
  document.documentElement.classList.toggle("dark-mode", isDark);
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

</style>
