<script setup>
import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";

const props = defineProps({
  isOpen: Boolean,
  currentIp: String,
});

const emit = defineEmits(["close", "update-ip"]);

const ipMode = ref("localhost");
const customIp = ref("");

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      const ip = props.currentIp || "";
      if (!ip || ip === "localhost" || ip === "127.0.0.1") {
        ipMode.value = "localhost";
      } else {
        ipMode.value = "custom";
        customIp.value = ip;
      }
    }
  }
);

function saveSettings() {
  const ip = ipMode.value === "localhost" ? "localhost" : customIp.value.trim();
  if (ipMode.value === "custom" && !ip) return;
  invoke("submit_ip", { newIp: ip });
  emit("update-ip", ip);
  emit("close");
}
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
          <span class="setting-group-label">Server IP Address</span>
          <div class="localhost-option">
            <input type="radio" id="opt-localhost" value="localhost" v-model="ipMode" />
            <label for="opt-localhost">Localhost (127.0.0.1)</label>
          </div>
          <div class="custom-ip-option">
            <input type="radio" id="opt-custom" value="custom" v-model="ipMode" />
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
      <div class="modal-footer">
        <button class="btn-secondary" @click="$emit('close')">Cancel</button>
        <button class="btn-primary" @click="saveSettings">Save</button>
      </div>
    </div>
  </div>
</template>
