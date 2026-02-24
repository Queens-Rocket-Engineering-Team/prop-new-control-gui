<script setup>
import { ref, watch } from "vue";
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

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
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

function applyIp() {
  if (ipMode.value === "none") {
    emit("update-ip", "");
    return;
  }
  const ip = ipMode.value === "localhost" ? "localhost" : customIp.value.trim();
  if (ipMode.value === "custom" && !ip) return;
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
  <div v-if="isOpen" class="modal-overlay" @click.self="$emit('close')">
    <div class="modal-container">
      <div class="modal-header">
        <h3>Settings</h3>
        <button class="modal-close-btn" @click="$emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="setting-group">
          <span class="setting-group-label">View</span>
          <div style="display: flex; align-items: center; gap: 8px;">
            <i class="pi pi-sun" :style="{color: darkMode ? '#888' : '#f39c12'}"></i>
            <ToggleSwitch v-model="darkMode" :style="{'--p-toggleswitch-width': '36px', '--p-toggleswitch-height': '20px', '--p-toggleswitch-handle-size': '14px'}" />
            <i class="pi pi-moon" :style="{color: darkMode ? '#f39c12' : '#888'}"></i>
          </div>
        </div>
        <div class="setting-group">
          <span class="setting-group-label">Server IP Address</span>
          <div class="localhost-option" style="display: flex; align-items: center;">
            <RadioButton v-model="ipMode" value="localhost" style="margin-right: 6px;" />
            <label for="opt-localhost">Localhost (127.0.0.1)</label>
          </div>
          <div class="custom-ip-option" style="display: flex; align-items: center;">
            <RadioButton v-model="ipMode" value="custom" style="margin-right: 6px;" />
            <label for="opt-custom">Custom: </label>
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
