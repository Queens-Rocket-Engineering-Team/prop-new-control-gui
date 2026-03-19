<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

const props = defineProps({
  serverIp: {
    type: String,
    default: "",
  },
});

const apiColor = ref("grey");
const voiceColor = ref("grey");
const pttColor = ref("grey");
let intervalId = null;
let pttIntervalId = null;

function getHost() {
  if (!props.serverIp) return "";
  return props.serverIp === "localhost" ? "127.0.0.1" : props.serverIp;
}

async function checkApi() {
  if (!props.serverIp) {
    apiColor.value = "grey";
    return;
  }

  const host = getHost();
  try {
    const response = await fetch(`http://${host}:8000/health`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    apiColor.value = response.ok ? "green" : "red";
  } catch {
    apiColor.value = "red";
  }
}

async function checkVoice() {
  if (!props.serverIp) {
    voiceColor.value = "grey";
    return;
  }

  const host = getHost();
  try {
    await fetch(`http://${host}:8080`, {
      mode: "no-cors",
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    voiceColor.value = "green";
  } catch {
    voiceColor.value = "red";
  }
}

async function checkHealth() {
  await Promise.all([checkApi(), checkVoice()]);
}

function startChecks() {
  stopChecks();
  checkHealth();
  intervalId = setInterval(checkHealth, 5000);
}

function stopChecks() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function checkPttState() {
  try {
    const held = await invoke("fetch_ptt_state");
    pttColor.value = held ? "green" : "grey";
  } catch {
    pttColor.value = "grey";
  }
}

function startPttChecks() {
  stopPttChecks();
  checkPttState();
  pttIntervalId = setInterval(checkPttState, 150);
}

function stopPttChecks() {
  if (pttIntervalId !== null) {
    clearInterval(pttIntervalId);
    pttIntervalId = null;
  }
}

watch(
  () => props.serverIp,
  (newIp) => {
    if (newIp) {
      apiColor.value = "grey";
      voiceColor.value = "grey";
      startChecks();
    } else {
      apiColor.value = "grey";
      voiceColor.value = "grey";
      stopChecks();
    }
  }
);

onMounted(() => {
  if (props.serverIp) {
    startChecks();
  }
  startPttChecks();
});

onUnmounted(() => {
  stopChecks();
  stopPttChecks();
});
</script>

<template>
  <div id="server-indicator">
    <span class="server-ip-text">{{ serverIp || "No Server" }}</span>
    <div class="status-item">
      <span class="status-label">API</span>
      <span class="led-dot" :class="`led-${apiColor}`"></span>
    </div>
    <div class="status-item">
      <span class="status-label">Voice</span>
      <span class="led-dot" :class="`led-${voiceColor}`"></span>
    </div>
    <div class="status-item">
      <span class="status-label">PTT</span>
      <span class="led-dot" :class="`led-${pttColor}`"></span>
    </div>
  </div>
</template>


<style scoped>
/* ── Server status indicator — inline element (embedded in nav bar) ── */
#server-indicator {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background-color: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 11px;
  user-select: none;
  width: 100%;
  box-sizing: border-box;
}

.server-ip-text {
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 52%;
}

.status-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.status-label {
  color: var(--text-secondary);
  font-size: 10px;
}

.led-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.led-grey {
  background-color: #666;
  box-shadow: 0 0 4px #666;
}

.led-green {
  background-color: #2ecc71;
  box-shadow: 0 0 6px #2ecc71;
}

.led-red {
  background-color: #e74c3c;
  box-shadow: 0 0 6px #e74c3c;
}

#server-indicator {
  transition: var(--theme-transition);
}
</style>