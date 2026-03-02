<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';


import { nextTick } from 'vue';
const logs = ref([]);
const websocket_status = ref('Disconnected');
let ws;
let server_ip = '';

const availableChannels = ["log", "errlog", "debuglog", "syslog"];
const selectedChannels = ref([...availableChannels]);

const logContainerRef = ref(null);
function addLog(channel, msg) {
    logs.value.push({ channel, msg });
    // Keep only the last 200 logs
    if (logs.value.length > 200) logs.value.shift();
    nextTick(() => {
        if (logContainerRef.value) {
            logContainerRef.value.scrollTop = logContainerRef.value.scrollHeight;
        }
    });
}

onMounted(() => {
    invoke('fetch_server_ip').then((ip) => {
        server_ip = ip;
        ws = new WebSocket(`ws://${server_ip}:8000/ws/logs`);
        ws.onopen = () => websocket_status.value = 'Connected';
        ws.onmessage = (event) => {
            let parsed;
            try {
                parsed = JSON.parse(event.data);
            } catch (e) {
                addLog('Malformed message: ' + event.data);
                return;
            }
            if (availableChannels.includes(parsed.channel)) {
                addLog(parsed.channel, parsed.data);
            }
        };
        ws.onerror = (error) => addLog('WebSocket error: ' + error);
        ws.onclose = () => websocket_status.value = 'Disconnected';
    });
});

onUnmounted(() => {
    if (ws) {
        ws.close();
        ws = null;
    }
});

</script>

<template>
    <div id="debug-panel">
        <div style="margin-bottom: 8px;">
            <b>WebSocket status:</b> {{ websocket_status }}
        </div>
        <div style="margin-bottom: 8px;">
            <b>Show channels:</b>
            <div id="channel-checkbox-group">
                <label v-for="ch in availableChannels" :key="ch" class="channel-checkbox">
                    <input type="checkbox" :value="ch" v-model="selectedChannels" />
                    <span class="channel-label">{{ ch }}</span>
            
                </label>
            </div>
        </div>
        
        <div id="log-container" ref="logContainerRef">
            <div v-for="(log, idx) in logs.filter(l => selectedChannels.includes(l.channel))" :key="idx" class="log-line">
                [{{ log.channel }}] {{ log.msg }}
            </div>
        </div>
    </div>
</template>

<style scoped>
#debug-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
}
/* Channel selector styling */
#channel-checkbox-group {
    display: flex;
    gap: 12px;
    margin-top: 4px;
    margin-bottom: 2px;
}
.channel-checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 15px;
    background: #23272f;
    border-radius: 8px;
    padding: 4px 14px;
    border: 1px solid #444;
    cursor: pointer;
    user-select: none;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    transition: background 0.2s, box-shadow 0.2s;
}
.channel-checkbox:hover {
    background: #2c313a;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
}
.channel-checkbox input[type="checkbox"] {
    accent-color: #396cd8;
    margin-right: 2px;
    width: 16px;
    height: 16px;
}
.channel-label {
    color: #e0e0e0;
    font-weight: 500;
    letter-spacing: 0.5px;
}
#log-container {
    flex: 1;
    overflow-y: auto;
    background: #181818;
    color: #e0e0e0;
    font-family: monospace;
    font-size: 14px;
    border-radius: 8px;
    padding: 12px;
    border: 1px solid #333;
    min-height: 200px;
}
.log-line {
    white-space: pre-wrap;
    margin-bottom: 2px;
}
</style>