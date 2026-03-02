<script setup>
import { invoke } from "@tauri-apps/api/core";
import { inject, ref, nextTick } from "vue";

import { Panel } from "primevue";

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
        const savedPath = await invoke("init_recording_file", { filename });
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
                await invoke("append_recording_chunk", { filename: state.filename, data: bytes });
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
    };

    recorder.start(chunkTimesliceMs);
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
    text.value = "t";
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
    <div id="camera_control">
        <h1>Camera View</h1>
        <button @click="get_list">get</button>
        <button @click="refresh_list">refresh</button>
        <p>Cameras Output: {{ text }}</p>
        <div v-for="(item, index) in arr" :key="index" >
            <Panel :header="item.hostname" toggleable="true">
                <video :ref="(el) => setVideoRef(el, item.ip)" autoplay playsinline controls style="width: 100%; height: auto;"></video>
                <br>
                <button @click="cam_left(item.ip)">left</button>
                <button @click="cam_right(item.ip)">right</button>
                <button @click="cam_up(item.ip)">up</button>
                <button @click="cam_down(item.ip)">down</button>
                <button @click="startRecording(item)">record</button>
                <button @click="stopRecording(item.ip)">stop</button>
            </Panel>
        </div>
    </div>
</template>

<style scoped>
    #camera_control {
        overflow: scroll;
    }
</style>