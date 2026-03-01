<script setup>
import { invoke } from "@tauri-apps/api/core";
import { ref, nextTick } from "vue";

import { Panel } from "primevue";

let server_ip;
const cameras = ref();

let arr = [];

const text = ref();
const videoRefs = {};
const recorders = {};
const recordedChunks = {};

function setVideoRef(el, ip) {
    if (el) {
        videoRefs[ip] = el;
    }
}

function startRecording(item) {
    const ip = item.ip;
    if (recorders[ip]) return;

    const videoEl = videoRefs[ip];
    if (!videoEl || !videoEl.srcObject) {
        text.value = `No stream available for ${ip}`;
        return;
    }

    recordedChunks[ip] = [];
    const recorder = new MediaRecorder(videoEl.srcObject);
    recorders[ip] = recorder;

    recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            recordedChunks[ip].push(event.data);
            console.log(`[${ip}] Chunk: ${event.data.size} bytes`);
        }
    };

    recorder.onstop = async () => {
        const blob = new Blob(recordedChunks[ip], { type: recorder.mimeType });
        const buffer = await blob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = recorder.mimeType.includes('webm') ? 'webm' : 'mp4';
        const filename = `${timestamp}-${item.hostname}.${ext}`;
        text.value = `Saving ${bytes.length} bytes for ${item.hostname}...`;
        try {
            const savedPath = await invoke("save_recording", { data: bytes, filename });
            text.value = `Saved: ${savedPath}`;
        } catch (e) {
            text.value = `Save failed: ${e}`;
        }
        delete recordedChunks[ip];
    };

    recorder.start(1000);
    text.value = `Recording started for ${item.hostname}`;
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

    const whepUrl = `http://${server_ip}:8889${item.stream_path}/whep`;
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
    invoke("fetch_server_ip").then((ip) => {
        server_ip = ip;
    });
    text.value = "Fetching Cameras...";
    const camera_url = `http://${server_ip}:8000/v1/cameras`;
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
    fetch(`http://${server_ip}:8000/v1/cameras/reconnect`, {
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
    fetch(`http://${server_ip}:8000/v1/camera?ip=${ip}&x_movement=-0.2&y_movement=0`, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${btoa("admin:propteambestteam")}`
        }
    });
    text.value = "t";
}

function cam_left(ip) { 
    fetch(`http://${server_ip}:8000/v1/camera?ip=${ip}&x_movement=0.2&y_movement=0`, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${btoa("admin:propteambestteam")}`
        } 
    });
}

function cam_up(ip) {
    fetch(`http://${server_ip}:8000/v1/camera?ip=${ip}&x_movement=0&y_movement=0.2`, {
        method: "POST",
        headers: {
            "Authorization": `Basic ${btoa("admin:propteambestteam")}`
        }
    });
}

function cam_down(ip) {
    fetch(`http://${server_ip}:8000/v1/camera?ip=${ip}&x_movement=0&y_movement=-0.2`, {
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