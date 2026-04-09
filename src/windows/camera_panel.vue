<script setup>
import { invoke } from "@tauri-apps/api/core";
import { inject, ref, nextTick, onMounted, onUnmounted, onActivated } from "vue";

import Button from "primevue/button";

// Required so <KeepAlive include="CameraPanel"> in App.vue matches this component
defineOptions({ name: 'CameraPanel' });

// ── Stream resume ─────────────────────────────────────────────────────────────
// WebRTC streams can pause when switching OS windows or navigating away and back.
// Resume is triggered by two mechanisms:
//   1. onActivated — fires when Vue's KeepAlive restores this panel after SPA navigation
//   2. visibilitychange — fires when the OS window regains focus / becomes visible

function resumeAllStreams() {
    for (const videoEl of Object.values(videoRefs)) {
        if (videoEl?.srcObject && videoEl.paused) {
            videoEl.play().catch(() => {});
        }
    }
}

function onVisibilityChange() {
    if (!document.hidden) resumeAllStreams();
}

onActivated(resumeAllStreams);
onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange));

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
    document.removeEventListener('visibilitychange', onVisibilityChange);
});

const server_ip = inject("serverIp");
const cameras = ref();

const arr = ref([]);

const text = ref();
const videoRefs = {};
const AUTH_HEADERS = { "Authorization": `Basic ${btoa("admin:propteambestteam")}` };

function apiBaseUrl() {
    return `http://${server_ip.value}:8000`;
}

function getCameraIp(item) {
    return String(item?.ip ?? item?.camera_ip ?? item?.cameraIp ?? "").trim();
}

function getCameraHostname(item) {
    const host = String(item?.hostname ?? item?.camera_hostname ?? "").trim();
    return host || getCameraIp(item);
}

async function ensureOk(response, messagePrefix) {
    if (response.ok) return;
    const bodyText = await response.text().catch(() => response.statusText);
    throw new Error(`${messagePrefix} (${response.status}): ${bodyText}`);
}

async function listRecordings(ip = null) {
    const params = new URLSearchParams();
    if (ip) params.set("ip", ip);
    const query = params.toString();
    const url = `${apiBaseUrl()}/v1/camera/recordings${query ? `?${query}` : ""}`;
    const response = await fetch(url, { headers: AUTH_HEADERS });
    await ensureOk(response, "Failed to list recordings");

    const payload = await response.json();
    const recordings = Array.isArray(payload?.recordings) ? payload.recordings : [];
    return recordings.sort((a, b) => Number(b.modified_unix_ms || 0) - Number(a.modified_unix_ms || 0));
}

function recordingDownloadUrl(downloadPath) {
    if (/^https?:\/\//i.test(downloadPath)) return downloadPath;
    return `${apiBaseUrl()}${downloadPath}`;
}

async function downloadRecording(recording) {
    const url = recordingDownloadUrl(recording.download_path);
    const response = await fetch(url, { headers: AUTH_HEADERS });
    await ensureOk(response, "Failed to download recording");

    const filename = recording.filename || "recording.mp4";
    const buffer = await response.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));
    return invoke("save_downloaded_camera_recording", { filename, data: bytes });
}

function setVideoRef(el, ip) {
    if (el) {
        videoRefs[ip] = el;
    }
}

async function startRecording(item) {
    const ip = getCameraIp(item);
    const hostname = getCameraHostname(item);
    if (!ip) {
        text.value = `Cannot start recording for ${hostname}: missing camera IP`;
        return;
    }
    if (activeRecordings.value[ip]) return;

    try {
        const params = new URLSearchParams({ ip });
        const response = await fetch(`${apiBaseUrl()}/v1/camera/recordings/start?${params}`, {
            method: "POST",
            headers: AUTH_HEADERS,
        });
        await ensureOk(response, `Failed to start recording for ${hostname} [${ip}]`);
        activeRecordings.value = { ...activeRecordings.value, [ip]: true };
        text.value = `Recording started for ${hostname} [${ip}]`;
    } catch (e) {
        text.value = String(e);
    }
}

async function stopRecording(item) {
    const ip = getCameraIp(item);
    const hostname = getCameraHostname(item);
    if (!ip) {
        text.value = `Cannot stop recording for ${hostname}: missing camera IP`;
        return;
    }
    if (!activeRecordings.value[ip]) return;

    text.value = `Stopping recording for ${hostname} [${ip}]...`;
    try {
        const params = new URLSearchParams({ ip });
        const response = await fetch(`${apiBaseUrl()}/v1/camera/recordings/stop?${params}`, {
            method: "POST",
            headers: AUTH_HEADERS,
        });
        await ensureOk(response, `Failed to stop recording for ${hostname} [${ip}]`);
        activeRecordings.value = { ...activeRecordings.value, [ip]: false };

        const recordings = await listRecordings(ip);
        if (!recordings.length) {
            text.value = `Stopped recording for ${hostname} [${ip}], but no file was listed yet`;
            return;
        }

        const newest = recordings[0];
        const savedPath = await downloadRecording(newest);
        text.value = `Saved recording to ${savedPath} (${hostname} [${ip}])`;
    } catch (e) {
        text.value = String(e);
    }
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
    arr.value = []; // empty array on call
    
    text.value = "Fetching Cameras...";
    const camera_url = `${apiBaseUrl()}/v1/cameras`;
    fetch(camera_url, { headers: AUTH_HEADERS })
    .then
    (
        (res)=>res.json()
    ).then(async (body) => {
        text.value=JSON.stringify(body);
        cameras.value = body.cameras;
        const serverRecordingStates = {};
        body.cameras.forEach(element => {
            const normalizedIp = getCameraIp(element);
            const normalizedCamera = {
                ...element,
                ip: normalizedIp,
                hostname: getCameraHostname(element),
            };
            arr.value.push(normalizedCamera);
            if (normalizedIp) {
                serverRecordingStates[normalizedIp] = !!element.recording;
            }
            //arr.push(`${camera_url}:8889${element.stream_path}`)
        });
        activeRecordings.value = serverRecordingStates;
        text.value = "Cameras Loaded Successfully";

        // Auto start camera streams after loading
        await nextTick();
        arr.value.forEach(item => startStream(item));
    }).catch(error => {
        text.value = String(error);
    })
}

function refresh_list() {
    fetch(`${apiBaseUrl()}/v1/cameras/reconnect`, {
        method: "POST",
        headers: AUTH_HEADERS
    }).then(_ => {
        get_list();
    });
}

function cam_right(ip) {
    //TODO: update x_movement/y_movement amounts
    fetch(`http://${server_ip.value}:8000/v1/camera?ip=${ip}&x_movement=-0.2&y_movement=0`, {
        method: "POST",
        headers: AUTH_HEADERS
    });
}

function cam_left(ip) { 
    fetch(`http://${server_ip.value}:8000/v1/camera?ip=${ip}&x_movement=0.2&y_movement=0`, {
        method: "POST",
        headers: AUTH_HEADERS
    });
}

function cam_up(ip) {
    fetch(`http://${server_ip.value}:8000/v1/camera?ip=${ip}&x_movement=0&y_movement=0.2`, {
        method: "POST",
        headers: AUTH_HEADERS
    });
}

function cam_down(ip) {
    fetch(`http://${server_ip.value}:8000/v1/camera?ip=${ip}&x_movement=0&y_movement=-0.2`, {
        method: "POST",
        headers: AUTH_HEADERS
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
                            @click="stopRecording(item)" :disabled="!activeRecordings[item.ip]" />
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