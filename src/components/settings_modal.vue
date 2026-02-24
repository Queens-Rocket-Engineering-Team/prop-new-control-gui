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
const darkMode = ref(false);  // false = light, true = dark
const overlayRef = ref(null);

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
      </div>
    </div>
  </div>
</template>

<style scoped>
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

.option-row {
  display: flex;
  align-items: center;
}

.option-row :deep(.p-radiobutton) {
  margin-right: 6px;
}
</style>
