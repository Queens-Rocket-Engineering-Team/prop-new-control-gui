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
