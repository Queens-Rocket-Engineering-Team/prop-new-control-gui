<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";

const props = defineProps({
  serverIp: {
    type: String,
    default: "",
  },
});

// 'grey' = no IP set / never connected, 'yellow' = waiting / 1 miss, 'green' = healthy, 'red' = 2+ misses
const ledColor = ref("grey");
const missedCount = ref(0);
let hasConnected = false;
let intervalId = null;

async function checkHealth() {
  if (!props.serverIp) {
    ledColor.value = "grey";
    return;
  }

  const host = props.serverIp === "localhost" ? "127.0.0.1" : props.serverIp;
  try {
    const response = await fetch(`http://${host}:8000/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      hasConnected = true;
      missedCount.value = 0;
      ledColor.value = "green";
    } else {
      handleMiss();
    }
  } catch {
    handleMiss();
  }
}

function handleMiss() {
  if (!hasConnected) return;
  missedCount.value++;
  ledColor.value = missedCount.value === 1 ? "yellow" : "red";
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

watch(
  () => props.serverIp,
  (newIp) => {
    if (newIp) {
      missedCount.value = 0;
      hasConnected = false;
      ledColor.value = "grey";
      startChecks();
    } else {
      ledColor.value = "grey";
      stopChecks();
    }
  }
);

onMounted(() => {
  if (props.serverIp) {
    startChecks();
  }
});

onUnmounted(() => {
  stopChecks();
});
</script>

<template>
  <div id="server-indicator">
    <div class="led-dot" :class="`led-${ledColor}`"></div>
    <span class="server-ip-text">{{ serverIp || "No Server" }}</span>
  </div>
</template>


<style scoped>
/* ── Server status indicator — inline element (embedded in nav bar) ── */
#server-indicator {
  display: flex;
  align-items: center;
  gap: 7px;
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

.led-yellow {
  background-color: #f39c12;
  box-shadow: 0 0 6px #f39c12;
}

.led-red {
  background-color: #e74c3c;
  box-shadow: 0 0 6px #e74c3c;
}

#server-indicator {
  transition: var(--theme-transition);
}
</style>