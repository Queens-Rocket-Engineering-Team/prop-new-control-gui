<script setup>
import { invoke } from "@tauri-apps/api/core";
import { inject, ref, nextTick, onUnmounted } from "vue";

import Button from "primevue/button";

// activeRecordings tracks which camera IPs are currently recording (reactive for UI)
const activeRecordings = ref({});

// mutedStates tracks per-camera mute state
const mutedStates = ref({});
function toggleMute(ip) {
    mutedStates.value = { ...mutedStates.value, [ip]: !mutedStates.value[ip] };
}

// tileSizes tracks per-tile width in px — keyed by camera IP
const tileSizes = ref({});
const DEFAULT_TILE_WIDTH = 360;

let _resizing = null;

function onTileResizeStart(e, ip) {
    _resizing = { ip, startX: e.clientX, startWidth: tileSizes.value[ip] ?? DEFAULT_TILE_WIDTH };
    document.addEventListener('mousemove', onTileResizeMove);
    document.addEventListener('mouseup',  onTileResizeEnd);
    e.preventDefault();
}

function onTileResizeMove(e) {
    if (!_resizing) return;
    const w = Math.max(240, _resizing.startWidth + (e.clientX - _resizing.startX));
    tileSizes.value = { ...tileSizes.value, [_resizing.ip]: w };
}

function onTileResizeEnd() {
    _resizing = null;
    document.removeEventListener('mousemove', onTileResizeMove);
    document.removeEventListener('mouseup',  onTileResizeEnd);
}

onUnmounted(() => {
    document.removeEventListener('mousemove', onTileResizeMove);
    document.removeEventListener('mouseup',  onTileResizeEnd);
});

const server_ip = inject("serverIp");
const cameras = ref();

let arr = [];

const text = ref();
const videoRefs = {};
const recorders = {};
const recordingStates = {};

const DEFAULT_RECORDING_TIMESLICE_MS = 500;
const MIN_RECORDING_TIMESLICE_MS = 100;
const MAX_RECORDING_TIMESLICE_MS = 5000;

function getRecordingTimesliceMs() {
    const raw = localStorage.getItem("cameraRecordingChunkMs");
    const parsed = Number(raw);

    if (!Number.isFinite(parsed)) {
        return DEFAULT_RECORDING_TIMESLICE_MS;
    }

    return Math.max(MIN_RECORDING_TIMESLICE_MS, Math.min(MAX_RECORDING_TIMESLICE_MS, Math.floor(parsed)));
}

function setVideoRef(el, ip) {
    if (el) {
        videoRefs[ip] = el;
    }
}

async function startRecording(item) {
    const ip = item.ip;
    if (recorders[ip]) return;

    const videoEl = videoRefs[ip];
    if (!videoEl || !videoEl.srcObject) {
        text.value = `No stream available for ${ip}`;
        return;
    }

    const recorder = new MediaRecorder(videoEl.srcObject);
    recorders[ip] = recorder;
    const chunkTimesliceMs = getRecordingTimesliceMs();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = recorder.mimeType.includes('webm') ? 'webm' : 'mp4';
    const filename = `${timestamp}-${item.hostname}.${ext}`;

    try {
        const savedPath = await invoke("init_camera_recording_file", { filename });
        recordingStates[ip] = {
            filename,
            savedPath,
            bytesWritten: 0,
            writeQueue: Promise.resolve(),
        };
    } catch (e) {
        delete recorders[ip];
        text.value = `Failed to start recording for ${item.hostname}: ${e}`;
        return;
    }

    recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            const state = recordingStates[ip];
            if (!state) return;

            state.writeQueue = state.writeQueue.then(async () => {
                const buffer = await event.data.arrayBuffer();
                const bytes = Array.from(new Uint8Array(buffer));
                await invoke("append_camera_recording_chunk", { filename: state.filename, data: bytes });
                state.bytesWritten += bytes.length;
                text.value = `Recording ${item.hostname}: ${state.bytesWritten} bytes written`;
            }).catch((e) => {
                text.value = `Chunk write failed for ${item.hostname}: ${e}`;
            });
        }
    };

    recorder.onstop = async () => {
        const state = recordingStates[ip];
        if (!state) return;

        text.value = `Finalizing recording for ${item.hostname}...`;
        try {
            await state.writeQueue;
            text.value = `Saved: ${state.savedPath} (${state.bytesWritten} bytes)`;
        } catch (e) {
            text.value = `Save failed: ${e}`;
        }
        delete recordingStates[ip];
        activeRecordings.value = { ...activeRecordings.value, [ip]: false };
    };

    recorder.start(chunkTimesliceMs);
    activeRecordings.value = { ...activeRecordings.value, [ip]: true };
    text.value = `Recording started for ${item.hostname} (chunk ${chunkTimesliceMs}ms)`;
}

function stopRecording(ip) {
    if (!recorders[ip]) return;
    recorders[ip].stop();
    delete recorders[ip];
    text.value = `Stopping recording for ${ip}...`;
}

// Setup WebRTC connection for video streaming
async function startStream(item) {
    const videoEl = videoRefs[item.ip];
    if (!videoEl) return;

    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (event) => {
        videoEl.srcObject = event.streams[0];
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
            resolve();
        } else {
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') {
                    resolve();
                }
            };
        }
    });

    const whepUrl = `http://${server_ip.value}:8889${item.stream_path}/whep`;
    const res = await fetch(whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
    });

    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
}

async function get_list() {
    arr = []; // empty array on call
    
    text.value = "Fetching Cameras...";
    const camera_url = `http://${server_ip.value}:8000/v1/cameras`;
    fetch(camera_url, { headers: { "Authorization": `Basic ${btoa("admin:propteambestteam")}`}})    
    .then
    (
        (res)=>res.json()
    ).then(async (body) => {
        text.value=JSON.stringify(body);
        cameras.value = body.cameras;
        body.cameras.forEach(element => {
            arr.push(element);
            //arr.push(`${camera_url}:8889${element.stream_path}`)
        });
        text.value = "Cameras Loaded Successfully";

        // Auto start camera streams after loading
        await nextTick();
        arr.forEach(item => startStream(item));
    }).catch(error => {
        text.value = error;
    })
}

function refresh_list() {
    fetch(`http://${server_ip.value}:8000/v1/cameras/reconnect`, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${btoa("admin:propteambestteam")}`
        }
    }).then(_ => {
        get_list();
    });
}

function cam_right(ip) {
    //TODO: update x_movement/y_movement amounts
    fetch(`http://${server_ip.value}:8000/v1/camera?ip=${ip}&x_movement=-0.2&y_movement=0`, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${btoa("admin:propteambestteam")}`
        }
    });
}

function cam_left(ip) { 
    fetch(`http://${server_ip.value}:8000/v1/camera?ip=${ip}&x_movement=0.2&y_movement=0`, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${btoa("admin:propteambestteam")}`
        } 
    });
}

function cam_up(ip) {
    fetch(`http://${server_ip.value}:8000/v1/camera?ip=${ip}&x_movement=0&y_movement=0.2`, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${btoa("admin:propteambestteam")}`
        }
    });
}

function cam_down(ip) {
    fetch(`http://${server_ip.value}:8000/v1/camera?ip=${ip}&x_movement=0&y_movement=-0.2`, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${btoa("admin:propteambestteam")}`
        }
    });
}

</script>

<template>
    <div id="camera-panel">

        <div class="camera-toolbar">
            <span class="panel-title">Camera View</span>
            <span class="status-text">{{ text }}</span>
            <Button label="Load"    size="small" @click="get_list" />
            <Button label="Refresh" size="small" @click="refresh_list" :disabled="!arr.length" />
        </div>

        <div class="camera-grid">
            <div
                v-for="(item, index) in arr"
                :key="index"
                class="camera-tile"
                :style="{ width: (tileSizes[item.ip] ?? DEFAULT_TILE_WIDTH) + 'px' }"
            >

                <div class="tile-header">
                    <span class="tile-name">{{ item.hostname }}</span>
                    <span v-if="activeRecordings[item.ip]" class="rec-indicator">
                        <span class="rec-led" />
                        REC
                    </span>
                </div>

                <div class="video-wrapper" :class="{ recording: activeRecordings[item.ip] }">
                    <video :ref="(el) => setVideoRef(el, item.ip)" autoplay playsinline :muted="!!mutedStates[item.ip]"></video>
                </div>

                <div class="tile-controls">
                    <div class="ptz-label">PTZ</div>
                    <div class="ptz-pad">
                        <div />
                        <Button icon="pi pi-chevron-up"    size="small" @click="cam_up(item.ip)"    />
                        <div />
                        <Button icon="pi pi-chevron-left"  size="small" @click="cam_left(item.ip)"  />
                        <div />
                        <Button icon="pi pi-chevron-right" size="small" @click="cam_right(item.ip)" />
                        <div />
                        <Button icon="pi pi-chevron-down"  size="small" @click="cam_down(item.ip)"  />
                        <div />
                    </div>

                    <Button
                        :icon="mutedStates[item.ip] ? 'pi pi-volume-off' : 'pi pi-volume-up'"
                        size="small"
                        :class="{ 'btn-muted': mutedStates[item.ip] }"
                        @click="toggleMute(item.ip)"
                        v-tooltip="mutedStates[item.ip] ? 'Unmute' : 'Mute'"
                    />

                    <div class="rec-controls">
                        <Button label="Record" icon="pi pi-circle-fill" size="small" class="btn-record"
                            @click="startRecording(item)" :disabled="!!activeRecordings[item.ip]" />
                        <Button label="Stop" icon="pi pi-stop-circle" size="small" class="btn-stop"
                            @click="stopRecording(item.ip)" :disabled="!activeRecordings[item.ip]" />
                    </div>
                </div>

                <div class="tile-resize-handle" @mousedown="onTileResizeStart($event, item.ip)" />

            </div>
        </div>

    </div>
</template>

<style scoped>
#camera-panel {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    background: var(--bg-primary);
    font-family: inherit;
}

/* ── Toolbar ── */
.camera-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
    flex-shrink: 0;
    transition: var(--theme-transition);
}

.panel-title {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-right: auto;
}

.status-text {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-style: italic;
}

/* ── Camera grid ── */
.camera-grid {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-content: flex-start;
}

/* ── Tile ── */
.camera-tile {
    position: relative;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: var(--theme-transition);
    min-width: 240px;
}

/* Drag handle on right edge — same pattern as nav_bar resize handle */
.tile-resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    width: 5px;
    height: 100%;
    cursor: col-resize;
    z-index: 2;
    border-radius: 0 4px 4px 0;
}

.tile-resize-handle:hover,
.tile-resize-handle:active {
    background: rgba(45, 88, 104, 0.45);
}

.tile-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border-color);
}

.tile-name {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.3px;
    text-transform: uppercase;
    color: var(--text-primary);
}

/* ── Recording indicator (header badge) ── */
.rec-indicator {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.3px;
    color: #e74c3c;
    animation: rec-pulse-text 1.2s step-end infinite;
}

.rec-led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #e74c3c;
    box-shadow: 0 0 5px rgba(231, 76, 60, 0.8);
    animation: rec-pulse-glow 1.2s ease-in-out infinite;
}

@keyframes rec-pulse-text {
    0%, 100% { opacity: 1;   }
    50%       { opacity: 0.2; }
}

@keyframes rec-pulse-glow {
    0%, 100% { box-shadow: 0 0 5px rgba(231, 76, 60, 0.9); }
    50%       { box-shadow: 0 0 2px rgba(231, 76, 60, 0.3); }
}

/* ── Video ── */
.video-wrapper {
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
    transition: box-shadow 0.3s ease;
}

.video-wrapper.recording {
    box-shadow: inset 0 0 0 2px #e74c3c;
}

.video-wrapper video {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
}

/* ── Controls bar ── */
.tile-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-top: 1px solid var(--border-color);
}

.ptz-label {
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--text-muted);
    writing-mode: vertical-rl;
    text-orientation: mixed;
    margin-right: 2px;
}

/* D-pad */
.ptz-pad {
    display: grid;
    grid-template-columns: repeat(3, 24px);
    grid-template-rows: repeat(3, 24px);
    gap: 2px;
}

.ptz-pad :deep(.p-button) {
    width: 24px    !important;
    height: 24px   !important;
    padding: 0     !important;
    min-width: 0   !important;
    font-size: 0.6rem !important;
}

/* Record / Stop */
.rec-controls {
    margin-left: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.btn-record :deep(.p-button-icon) { color: #e74c3c !important; }
.btn-stop                         { border-color: var(--border-color) !important; }
.btn-stop:not(:disabled)          { border-color: #e74c3c !important; }

.btn-muted { border-color: var(--border-accent) !important; }
.btn-muted :deep(.p-button-icon) { color: var(--text-muted) !important; }
</style>