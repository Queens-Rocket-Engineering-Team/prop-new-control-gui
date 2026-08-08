<script setup>
import { saveDownloadedCameraRecording } from "../lib/desktop.js";
import {
    inject,
    nextTick,
    onActivated,
    onDeactivated,
    onMounted,
    onUnmounted,
    ref,
    watch,
} from "vue";

import Button from "primevue/button";

// Required so <KeepAlive include="CameraPanel"> in App.vue matches this component.
defineOptions({ name: "CameraPanel" });

const AUTH_HEADERS = { "Authorization": `Basic ${btoa("admin:propteambestteam")}` };
const DEFAULT_TILE_WIDTH = 360;
const ICE_DISCOVERY_TIMEOUT_MS = 3_000;
const ICE_GATHERING_TIMEOUT_MS = 8_000;
const WHEP_REQUEST_TIMEOUT_MS = 15_000;
const CONNECTION_TIMEOUT_MS = 20_000;
const DISCONNECTED_GRACE_MS = 6_000;
const VIDEO_STALL_TIMEOUT_MS = 20_000;
const STREAM_WATCHDOG_INTERVAL_MS = 5_000;
const MAX_STREAM_RETRIES = 5;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

const server_ip = inject("serverIp");
const cameras = ref([]);
const arr = ref([]);
const text = ref();
const loading = ref(false);
const refreshing = ref(false);
const activeRecordings = ref({});
const mutedStates = ref({});
const tileSizes = ref({});
const streamStates = ref({});

// Non-reactive WebRTC resources are owned here and mirrored into streamStates for UI.
const videoRefs = new Map();
const streamSessions = new Map();
const iceServerCache = new Map();

let nextSessionId = 0;
let listRequestId = 0;
let listAbortController = null;
let refreshRequestId = 0;
let refreshAbortController = null;
let watchdogTimer = null;
let panelActive = true;
let componentDestroyed = false;
let _resizing = null;

function currentServerIp() {
    return String(server_ip?.value ?? "").trim();
}

function apiBaseUrl(server = currentServerIp()) {
    return `http://${server}:8000`;
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
    const detail = String(bodyText || response.statusText || "request failed").slice(0, 500);
    throw new Error(`${messagePrefix} (${response.status}): ${detail}`);
}

function isAbortError(error) {
    return error?.name === "AbortError";
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

class UnsupportedMediaError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnsupportedMediaError";
    }
}

function makeAbortError() {
    const error = new Error("Request cancelled");
    error.name = "AbortError";
    return error;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = WHEP_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const parentSignal = options.signal;
    let timedOut = false;

    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) throw makeAbortError();
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) controller.abort();

    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (timedOut) throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
        throw error;
    } finally {
        window.clearTimeout(timer);
        parentSignal?.removeEventListener("abort", abortFromParent);
    }
}

function cameraStreamKey(item) {
    const ip = getCameraIp(item);
    const streamPath = String(item?.stream_path ?? "").trim();
    const hostname = getCameraHostname(item);
    // MediaMTX paths identify streams more precisely than camera IPs (a camera
    // can expose both a main and sub stream from the same address).
    return streamPath ? `path:${streamPath}` : ip ? `ip:${ip}` : hostname ? `host:${hostname}` : "";
}

function streamFingerprint(item, server = currentServerIp()) {
    return `${server}|${String(item?.stream_path ?? "").trim()}`;
}

function streamStateFor(key) {
    return streamStates.value[key] ?? { state: "idle", message: "Not connected" };
}

function streamStatusLabel(key) {
    const state = streamStateFor(key).state;
    return {
        connecting: "Connecting",
        error: "Error",
        idle: "Idle",
        live: "Live",
        retrying: "Retrying",
        unsupported: "Unsupported",
    }[state] ?? state;
}

function setStreamStatus(key, state, message) {
    if (!key || componentDestroyed) return;
    const normalizedMessage = message || "";
    const current = streamStates.value[key];
    if (current?.state === state && current?.message === normalizedMessage) return;
    streamStates.value = {
        ...streamStates.value,
        [key]: { state, message: normalizedMessage, updatedAt: Date.now() },
    };
}

function isMuted(key) {
    return mutedStates.value[key] !== false;
}

function findCurrentCamera(key) {
    return arr.value.find((item) => item.streamKey === key);
}

function isCurrentSession(session) {
    return !componentDestroyed
        && streamSessions.get(session.key) === session
        && !session.intentionalClose
        && !session.failureHandled;
}

function buildWhepUrl(item, server) {
    const rawPath = String(item?.stream_path ?? "").trim();
    if (!rawPath) throw new Error("Camera is missing its MediaMTX stream path");

    if (/^https?:\/\//i.test(rawPath)) {
        const url = new URL(rawPath);
        const path = url.pathname.replace(/\/+$/, "");
        if (!/\/whep$/i.test(path)) url.pathname = `${path}/whep`;
        return url.toString();
    }

    const normalizedPath = rawPath.replace(/^\/+|\/+$/g, "");
    const endpointPath = /\/whep$/i.test(normalizedPath) ? normalizedPath : `${normalizedPath}/whep`;
    return `http://${server}:8889/${endpointPath}`;
}

function splitLinkHeader(value) {
    const parts = [];
    let start = 0;
    let quoted = false;
    let angleDepth = 0;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
        if (!quoted && character === "<") angleDepth += 1;
        if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);
        if (!quoted && angleDepth === 0 && character === ",") {
            parts.push(value.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(value.slice(start));
    return parts;
}

function parseIceServers(linkHeader) {
    if (!linkHeader) return [];

    return splitLinkHeader(linkHeader).flatMap((entry) => {
        const urlMatch = entry.match(/^\s*<([^>]+)>/);
        if (!urlMatch || !/^(?:stun|turn|turns):/i.test(urlMatch[1])) return [];

        const parameters = {};
        const parameterPattern = /;\s*([^=;\s]+)(?:\s*=\s*(?:"([^"]*)"|([^;,\s]+)))?/g;
        let match;
        while ((match = parameterPattern.exec(entry)) !== null) {
            parameters[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
        }

        if (!String(parameters.rel || "").split(/\s+/).includes("ice-server")) return [];
        const iceServer = { urls: urlMatch[1] };
        if (parameters.username) iceServer.username = parameters.username;
        if (parameters.credential) iceServer.credential = parameters.credential;
        return [iceServer];
    });
}

async function discoverIceServers(whepUrl, signal) {
    const cached = iceServerCache.get(whepUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.iceServers;

    try {
        const response = await fetchWithTimeout(whepUrl, {
            method: "OPTIONS",
            headers: { "Accept": "application/sdp" },
            signal,
        }, ICE_DISCOVERY_TIMEOUT_MS);
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                const error = new Error(`MediaMTX rejected WHEP ICE discovery (${response.status})`);
                error.name = "WhepAuthorizationError";
                throw error;
            }
            console.warn(`[Camera] WHEP OPTIONS returned ${response.status}; continuing without advertised ICE servers`);
            return [];
        }

        const iceServers = parseIceServers(response.headers.get("Link"));
        iceServerCache.set(whepUrl, { iceServers, expiresAt: Date.now() + 60_000 });
        return iceServers;
    } catch (error) {
        if (signal.aborted || isAbortError(error) || error?.name === "WhepAuthorizationError") throw error;
        // MediaMTX can operate without advertised STUN/TURN servers on a local network.
        return [];
    }
}

function waitForIceGathering(pc, signal) {
    if (signal.aborted) return Promise.reject(makeAbortError());
    if (pc.iceGatheringState === "complete") return Promise.resolve(true);

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (completed) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", onStateChange);
            signal.removeEventListener("abort", onAbort);
            resolve(completed);
        };
        const onStateChange = () => {
            if (pc.iceGatheringState === "complete") finish(true);
        };
        const onAbort = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", onStateChange);
            reject(makeAbortError());
        };
        const timer = window.setTimeout(() => finish(false), ICE_GATHERING_TIMEOUT_MS);

        pc.addEventListener("icegatheringstatechange", onStateChange);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function preferH264(videoTransceiver) {
    const codecs = globalThis.RTCRtpReceiver?.getCapabilities?.("video")?.codecs ?? [];
    if (!codecs.length) return;

    const h264Codecs = codecs.filter((codec) => codec.mimeType?.toLowerCase() === "video/h264");
    if (!h264Codecs.length) {
        throw new UnsupportedMediaError("This WebView does not expose an H.264 WebRTC decoder");
    }

    if (typeof videoTransceiver.setCodecPreferences === "function") {
        const preferredH264 = [...h264Codecs].sort((left, right) => {
            const leftPacketized = /packetization-mode=1/i.test(left.sdpFmtpLine || "") ? 1 : 0;
            const rightPacketized = /packetization-mode=1/i.test(right.sdpFmtpLine || "") ? 1 : 0;
            return rightPacketized - leftPacketized;
        });
        const remainingCodecs = codecs.filter((codec) => !h264Codecs.includes(codec));
        try {
            videoTransceiver.setCodecPreferences([...preferredH264, ...remainingCodecs]);
        } catch (error) {
            // Older WebKit versions have exposed this method before fully
            // supporting it. The default codec order is still usable.
            console.warn("[Camera] Could not prefer H.264 codecs; using the WebView default order", error);
        }
    }
}

function remoteSessionUrl(response, whepUrl) {
    const location = response.headers.get("Location");
    if (!location) return null;
    try {
        return new URL(location, response.url || whepUrl).toString();
    } catch {
        return null;
    }
}

function releaseRemoteSession(url) {
    if (!url) return;
    void fetch(url, { method: "DELETE", keepalive: true }).catch(() => {});
}

function cancelVideoFrameWatch(session) {
    if (session.videoFrameRequest != null && session.videoEl?.cancelVideoFrameCallback) {
        session.videoEl.cancelVideoFrameCallback(session.videoFrameRequest);
    }
    session.videoFrameRequest = null;
}

function scheduleVideoFrameWatch(session) {
    cancelVideoFrameWatch(session);
    const videoEl = session.videoEl;
    if (!videoEl?.requestVideoFrameCallback) return;

    const onFrame = () => {
        session.videoFrameRequest = null;
        if (!isCurrentSession(session) || session.videoEl !== videoEl) return;
        session.lastFrameAt = Date.now();
        scheduleVideoFrameWatch(session);
    };
    session.videoFrameRequest = videoEl.requestVideoFrameCallback(onFrame);
}

async function playVideo(session, context = "Starting video", allowMutedRetry = true) {
    const videoEl = session.videoEl;
    if (!videoEl || !isCurrentSession(session)) return;

    videoEl.muted = isMuted(session.key);
    try {
        await videoEl.play();
        if (session.hasVideoTrack && isCurrentSession(session)) {
            session.lastFrameAt = Date.now();
            setStreamStatus(session.key, "live", "Video is playing");
        }
    } catch (error) {
        if (!isCurrentSession(session)) return;
        if (allowMutedRetry && error?.name === "NotAllowedError" && !videoEl.muted) {
            mutedStates.value = { ...mutedStates.value, [session.key]: true };
            videoEl.muted = true;
            await playVideo(session, "Starting muted video", false);
            return;
        }
        setStreamStatus(
            session.key,
            "error",
            `${context} failed: ${errorMessage(error)}. Press Retry to reconnect.`,
        );
    }
}

function bindVideoElement(session, videoEl) {
    if (!videoEl || !isCurrentSession(session)) return;
    const previousVideoEl = session.videoEl;
    session.removeVideoListeners?.();
    cancelVideoFrameWatch(session);
    if (previousVideoEl && previousVideoEl !== videoEl && previousVideoEl.srcObject === session.mediaStream) {
        previousVideoEl.pause();
        previousVideoEl.srcObject = null;
    }
    session.videoEl = videoEl;
    videoEl.muted = isMuted(session.key);
    videoEl.srcObject = session.mediaStream;

    const onPlaying = () => {
        if (!isCurrentSession(session) || !session.hasVideoTrack) return;
        session.lastFrameAt = Date.now();
        setStreamStatus(session.key, "live", "Video is playing");
    };
    const onWaiting = () => {
        if (!isCurrentSession(session) || streamStateFor(session.key).state === "retrying") return;
        setStreamStatus(session.key, "connecting", "Video is buffering...");
    };
    const onError = () => {
        const code = videoEl.error?.code;
        void handleSessionFailure(session, new Error(`The video element reported a media error${code ? ` (code ${code})` : ""}`));
    };

    videoEl.addEventListener("playing", onPlaying);
    videoEl.addEventListener("waiting", onWaiting);
    videoEl.addEventListener("stalled", onWaiting);
    videoEl.addEventListener("error", onError);
    session.removeVideoListeners = () => {
        videoEl.removeEventListener("playing", onPlaying);
        videoEl.removeEventListener("waiting", onWaiting);
        videoEl.removeEventListener("stalled", onWaiting);
        videoEl.removeEventListener("error", onError);
    };

    scheduleVideoFrameWatch(session);
    void playVideo(session);
}

function setVideoRef(element, key) {
    if (!element) {
        videoRefs.delete(key);
        return;
    }

    videoRefs.set(key, element);
    const session = streamSessions.get(key);
    if (
        session?.mediaStream
        && isCurrentSession(session)
        && (session.videoEl !== element || element.srcObject !== session.mediaStream)
    ) {
        bindVideoElement(session, element);
    }
}

function cleanupSessionTransport(session, deleteRemote = true) {
    session.abortController?.abort();
    window.clearTimeout(session.connectionTimer);
    window.clearTimeout(session.disconnectTimer);
    session.connectionTimer = null;
    session.disconnectTimer = null;

    cancelVideoFrameWatch(session);
    session.removeVideoListeners?.();
    session.removeVideoListeners = null;

    if (session.pc) {
        session.pc.onconnectionstatechange = null;
        session.pc.oniceconnectionstatechange = null;
        session.pc.onicecandidateerror = null;
        session.pc.ontrack = null;
        try {
            session.pc.close();
        } catch {
            // Closing an already-closed peer is harmless.
        }
        session.pc = null;
    }

    if (session.mediaStream) {
        for (const track of session.mediaStream.getTracks()) {
            track.onended = null;
            track.stop();
        }
        session.mediaStream = null;
    }

    const videoEl = session.videoEl || videoRefs.get(session.key);
    if (videoEl?.srcObject) {
        videoEl.pause();
        videoEl.srcObject = null;
    }
    session.videoEl = null;

    if (deleteRemote && session.whepSessionUrl) {
        releaseRemoteSession(session.whepSessionUrl);
        session.whepSessionUrl = null;
    }
}

function closeStream(key, { state = null, message = "", deleteRemote = true } = {}) {
    const session = streamSessions.get(key);
    if (session) {
        session.intentionalClose = true;
        window.clearTimeout(session.retryTimer);
        session.retryTimer = null;
        cleanupSessionTransport(session, deleteRemote);
        if (streamSessions.get(key) === session) streamSessions.delete(key);
    }
    if (state) setStreamStatus(key, state, message);
}

function closeAllStreams({ state = null, message = "", deleteRemote = true } = {}) {
    for (const key of [...streamSessions.keys()]) {
        closeStream(key, { state, message, deleteRemote });
    }
}

async function handleSessionFailure(session, error) {
    if (!isCurrentSession(session) || session.failureHandled) return;
    session.failureHandled = true;
    const reason = errorMessage(error);
    cleanupSessionTransport(session, true);

    if (error?.name === "UnsupportedMediaError") {
        setStreamStatus(session.key, "unsupported", reason);
        return;
    }

    const currentCamera = findCurrentCamera(session.key);
    const serverUnchanged = currentServerIp() === session.server;
    const canRetry = panelActive
        && currentCamera
        && serverUnchanged
        && session.attempt < MAX_STREAM_RETRIES;

    if (!canRetry) {
        setStreamStatus(session.key, "error", reason);
        return;
    }

    const nextAttempt = session.attempt + 1;
    const delay = RETRY_DELAYS_MS[Math.min(nextAttempt - 1, RETRY_DELAYS_MS.length - 1)];
    setStreamStatus(
        session.key,
        "retrying",
        `${reason}. Retrying in ${Math.round(delay / 1000)}s (${nextAttempt}/${MAX_STREAM_RETRIES})...`,
    );

    session.retryTimer = window.setTimeout(() => {
        if (streamSessions.get(session.key) !== session || !panelActive || componentDestroyed) return;
        const latestCamera = findCurrentCamera(session.key);
        if (!latestCamera || currentServerIp() !== session.server) return;
        streamSessions.delete(session.key);
        void startStream(latestCamera, { attempt: nextAttempt });
    }, delay);
}

function handleConnected(session) {
    if (!isCurrentSession(session)) return;
    window.clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
    session.lastFrameAt = Date.now();
    if (session.hasVideoTrack) {
        window.clearTimeout(session.connectionTimer);
        session.connectionTimer = null;
    }
    setStreamStatus(
        session.key,
        "connecting",
        session.hasVideoTrack ? "Media connected; starting playback..." : "Connected; waiting for video track...",
    );
    if (session.hasVideoTrack) void playVideo(session);
}

function handleDisconnected(session) {
    if (!isCurrentSession(session) || session.disconnectTimer) return;
    setStreamStatus(session.key, "connecting", "Media connection interrupted; waiting for recovery...");
    session.disconnectTimer = window.setTimeout(() => {
        session.disconnectTimer = null;
        if (!isCurrentSession(session)) return;
        const state = session.pc?.connectionState;
        const iceState = session.pc?.iceConnectionState;
        if (state === "disconnected" || iceState === "disconnected") {
            void handleSessionFailure(session, new Error("WebRTC media connection was lost"));
        }
    }, DISCONNECTED_GRACE_MS);
}

function installPeerHandlers(session) {
    const pc = session.pc;
    pc.onconnectionstatechange = () => {
        if (!isCurrentSession(session)) return;
        if (pc.connectionState === "connected") handleConnected(session);
        if (pc.connectionState === "disconnected") handleDisconnected(session);
        if (pc.connectionState === "failed") {
            void handleSessionFailure(session, new Error("WebRTC peer connection failed"));
        }
        if (pc.connectionState === "closed") {
            void handleSessionFailure(session, new Error("WebRTC peer connection closed unexpectedly"));
        }
    };
    pc.oniceconnectionstatechange = () => {
        if (!isCurrentSession(session)) return;
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            handleConnected(session);
        } else if (pc.iceConnectionState === "disconnected") {
            handleDisconnected(session);
        } else if (pc.iceConnectionState === "failed") {
            void handleSessionFailure(session, new Error("WebRTC ICE negotiation failed"));
        } else if (pc.iceConnectionState === "closed") {
            void handleSessionFailure(session, new Error("WebRTC ICE connection closed unexpectedly"));
        }
    };
    pc.onicecandidateerror = (event) => {
        if (!isCurrentSession(session) || streamStateFor(session.key).state === "live") return;
        const detail = event.errorText || "An ICE candidate could not be reached";
        setStreamStatus(session.key, "connecting", detail);
    };
    pc.ontrack = (event) => {
        if (!isCurrentSession(session)) return;
        const track = event.track;
        if (!session.mediaStream.getTracks().some((currentTrack) => currentTrack.id === track.id)) {
            session.mediaStream.addTrack(track);
        }
        if (track.kind === "video") {
            session.hasVideoTrack = true;
            session.lastFrameAt = Date.now();
            window.clearTimeout(session.connectionTimer);
            session.connectionTimer = null;
            track.onended = () => {
                if (isCurrentSession(session)) {
                    void handleSessionFailure(session, new Error("The remote video track ended"));
                }
            };
        }

        const videoEl = videoRefs.get(session.key);
        if (videoEl && (session.videoEl !== videoEl || videoEl.srcObject !== session.mediaStream)) {
            bindVideoElement(session, videoEl);
        } else if (track.kind === "video") {
            void playVideo(session);
        }
    };
}

// Setup and retain one managed WebRTC/WHEP connection per camera.
async function startStream(item, { attempt = 0, force = false } = {}) {
    const key = item.streamKey || cameraStreamKey(item);
    const server = currentServerIp();
    if (!key || !server || !panelActive || componentDestroyed) return;

    const fingerprint = streamFingerprint(item, server);
    const existing = streamSessions.get(key);
    if (existing && !force && !existing.failureHandled && existing.fingerprint === fingerprint) return;
    if (existing) closeStream(key);

    if (typeof globalThis.RTCPeerConnection !== "function") {
        setStreamStatus(key, "unsupported", "WebRTC is disabled or unavailable in this WebKitGTK build");
        return;
    }

    const session = {
        id: ++nextSessionId,
        key,
        item,
        server,
        fingerprint,
        attempt,
        intentionalClose: false,
        failureHandled: false,
        abortController: new AbortController(),
        pc: null,
        mediaStream: null,
        videoEl: null,
        whepSessionUrl: null,
        retryTimer: null,
        connectionTimer: null,
        disconnectTimer: null,
        videoFrameRequest: null,
        removeVideoListeners: null,
        hasVideoTrack: false,
        lastFrameAt: Date.now(),
        lastVideoTime: 0,
    };
    streamSessions.set(key, session);
    setStreamStatus(key, "connecting", attempt ? `Reconnect attempt ${attempt}/${MAX_STREAM_RETRIES}...` : "Discovering stream settings...");

    try {
        const whepUrl = buildWhepUrl(item, server);
        const iceServers = await discoverIceServers(whepUrl, session.abortController.signal);
        if (!isCurrentSession(session)) return;

        try {
            session.pc = new RTCPeerConnection({ iceServers });
        } catch (error) {
            if (!iceServers.length) throw error;
            // Bad optional Link metadata must not prevent a local-network connection.
            session.pc = new RTCPeerConnection({ iceServers: [] });
        }
        session.mediaStream = new MediaStream();
        installPeerHandlers(session);

        const videoTransceiver = session.pc.addTransceiver("video", { direction: "recvonly" });
        preferH264(videoTransceiver);
        session.pc.addTransceiver("audio", { direction: "recvonly" });

        const videoEl = videoRefs.get(key);
        if (videoEl) bindVideoElement(session, videoEl);

        setStreamStatus(key, "connecting", "Creating WebRTC offer...");
        const offer = await session.pc.createOffer();
        await session.pc.setLocalDescription(offer);
        const iceComplete = await waitForIceGathering(session.pc, session.abortController.signal);
        if (!isCurrentSession(session)) return;

        setStreamStatus(
            key,
            "connecting",
            iceComplete ? "Negotiating with MediaMTX..." : "ICE gathering timed out; trying available candidates...",
        );
        const response = await fetchWithTimeout(whepUrl, {
            method: "POST",
            headers: {
                "Accept": "application/sdp",
                "Content-Type": "application/sdp",
            },
            body: session.pc.localDescription?.sdp || offer.sdp,
            signal: session.abortController.signal,
        });
        const createdSessionUrl = remoteSessionUrl(response, whepUrl);
        if (!isCurrentSession(session)) {
            releaseRemoteSession(createdSessionUrl);
            return;
        }

        session.whepSessionUrl = createdSessionUrl;
        const answer = await response.text();
        if (!response.ok) {
            const detail = String(answer || response.statusText || "request failed").slice(0, 500);
            throw new Error(`MediaMTX WHEP request failed (${response.status}): ${detail}`);
        }
        if (!answer.trim()) throw new Error("MediaMTX returned an empty WHEP answer");

        await session.pc.setRemoteDescription({ type: "answer", sdp: answer });
        if (!isCurrentSession(session)) return;
        if (streamStateFor(key).state !== "live") {
            setStreamStatus(key, "connecting", "Waiting for WebRTC media...");
        }
        if (!session.hasVideoTrack) {
            session.connectionTimer = window.setTimeout(() => {
                session.connectionTimer = null;
                if (isCurrentSession(session) && !session.hasVideoTrack) {
                    void handleSessionFailure(session, new Error("Connected to MediaMTX but no video arrived"));
                }
            }, CONNECTION_TIMEOUT_MS);
        }
    } catch (error) {
        if (!isCurrentSession(session) || session.intentionalClose || isAbortError(error)) return;
        await handleSessionFailure(session, error);
    }
}

function retryStream(item) {
    const key = item.streamKey;
    closeStream(key);
    setStreamStatus(key, "connecting", "Retry requested...");
    void startStream(item, { attempt: 0, force: true });
}

function toggleMute(key) {
    const nextMuted = !isMuted(key);
    mutedStates.value = { ...mutedStates.value, [key]: nextMuted };
    const videoEl = videoRefs.get(key);
    if (videoEl) videoEl.muted = nextMuted;

    const session = streamSessions.get(key);
    if (session && isCurrentSession(session)) void playVideo(session, nextMuted ? "Resuming muted video" : "Unmuting video");
}

function resumeAllStreams() {
    if (!panelActive || componentDestroyed) return;
    for (const item of arr.value) {
        const session = streamSessions.get(item.streamKey);
        if (!session) {
            void startStream(item);
            continue;
        }
        if (session.failureHandled && !session.retryTimer) continue;
        session.lastFrameAt = Date.now();
        if (session.videoEl?.srcObject && session.videoEl.paused) void playVideo(session, "Resuming video");
    }
}

function monitorStreams() {
    if (!panelActive || componentDestroyed || document.hidden) return;
    const now = Date.now();
    for (const session of streamSessions.values()) {
        if (!isCurrentSession(session) || session.failureHandled || !session.hasVideoTrack) continue;
        const videoEl = session.videoEl;
        if (!videoEl || videoEl.paused) continue;

        if (!videoEl.requestVideoFrameCallback) {
            if (Math.abs(videoEl.currentTime - session.lastVideoTime) > 0.01) {
                session.lastVideoTime = videoEl.currentTime;
                session.lastFrameAt = now;
            }
        }

        if (now - session.lastFrameAt > VIDEO_STALL_TIMEOUT_MS) {
            void handleSessionFailure(session, new Error("Video frames stopped arriving"));
        }
    }
}

function onVisibilityChange() {
    if (!document.hidden) resumeAllStreams();
}

function onTileResizeStart(event, key) {
    _resizing = { key, startX: event.clientX, startWidth: tileSizes.value[key] ?? DEFAULT_TILE_WIDTH };
    document.addEventListener("mousemove", onTileResizeMove);
    document.addEventListener("mouseup", onTileResizeEnd);
    event.preventDefault();
}

function onTileResizeMove(event) {
    if (!_resizing) return;
    const width = Math.max(240, _resizing.startWidth + (event.clientX - _resizing.startX));
    tileSizes.value = { ...tileSizes.value, [_resizing.key]: width };
}

function onTileResizeEnd() {
    _resizing = null;
    document.removeEventListener("mousemove", onTileResizeMove);
    document.removeEventListener("mouseup", onTileResizeEnd);
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
    return saveDownloadedCameraRecording(filename, bytes);
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

function normalizeCameraList(rawCameras) {
    const normalizedCameras = [];
    const seenKeys = new Set();
    let duplicates = 0;

    for (const camera of rawCameras) {
        const normalizedCamera = {
            ...camera,
            ip: getCameraIp(camera),
            hostname: getCameraHostname(camera),
            stream_path: String(camera?.stream_path ?? "").trim(),
        };
        const streamKey = cameraStreamKey(normalizedCamera);
        if (!streamKey || seenKeys.has(streamKey)) {
            duplicates += 1;
            continue;
        }
        seenKeys.add(streamKey);
        normalizedCameras.push({ ...normalizedCamera, streamKey });
    }
    return { normalizedCameras, duplicates };
}

function applyCameraList(rawCameras, server) {
    const { normalizedCameras, duplicates } = normalizeCameraList(rawCameras);
    const nextKeys = new Set(normalizedCameras.map((camera) => camera.streamKey));

    for (const [key, session] of streamSessions) {
        const nextCamera = normalizedCameras.find((camera) => camera.streamKey === key);
        if (!nextCamera || session.fingerprint !== streamFingerprint(nextCamera, server)) closeStream(key);
    }

    const nextRecordingStates = {};
    const nextMutedStates = {};
    const nextStreamStates = {};
    for (const camera of normalizedCameras) {
        if (camera.ip) nextRecordingStates[camera.ip] = !!camera.recording;
        nextMutedStates[camera.streamKey] = mutedStates.value[camera.streamKey] !== false;
        nextStreamStates[camera.streamKey] = streamStates.value[camera.streamKey]
            ?? { state: "idle", message: "Ready to connect" };
    }

    for (const key of [...videoRefs.keys()]) {
        if (!nextKeys.has(key)) videoRefs.delete(key);
    }

    cameras.value = normalizedCameras;
    arr.value = normalizedCameras;
    activeRecordings.value = nextRecordingStates;
    mutedStates.value = nextMutedStates;
    streamStates.value = nextStreamStates;
    return duplicates;
}

function abortPendingCameraRequests() {
    listRequestId += 1;
    listAbortController?.abort();
    listAbortController = null;
    loading.value = false;

    refreshRequestId += 1;
    refreshAbortController?.abort();
    refreshAbortController = null;
    refreshing.value = false;
}

async function get_list(options = {}) {
    const forceStreams = options?.forceStreams === true;
    const server = currentServerIp();
    if (!server) {
        text.value = "Enter a server IP before loading cameras";
        return;
    }

    listAbortController?.abort();
    const requestId = ++listRequestId;
    const controller = new AbortController();
    listAbortController = controller;
    loading.value = true;
    text.value = "Fetching Cameras...";

    try {
        const response = await fetchWithTimeout(`${apiBaseUrl(server)}/v1/cameras`, {
            headers: AUTH_HEADERS,
            signal: controller.signal,
        });
        await ensureOk(response, "Failed to fetch cameras");
        const body = await response.json();
        if (requestId !== listRequestId || controller.signal.aborted || server !== currentServerIp()) return;
        if (!Array.isArray(body?.cameras)) throw new Error("Camera response did not contain a cameras array");

        const duplicates = applyCameraList(body.cameras, server);
        text.value = `Loaded ${arr.value.length} camera${arr.value.length === 1 ? "" : "s"}${duplicates ? ` (${duplicates} duplicate${duplicates === 1 ? "" : "s"} ignored)` : ""}`;

        await nextTick();
        if (requestId !== listRequestId || server !== currentServerIp() || !panelActive) return;
        for (const item of arr.value) void startStream(item, { force: forceStreams });
    } catch (error) {
        if (requestId === listRequestId && !controller.signal.aborted && !isAbortError(error)) {
            text.value = errorMessage(error);
        }
    } finally {
        if (requestId === listRequestId) {
            loading.value = false;
            if (listAbortController === controller) listAbortController = null;
        }
    }
}

async function refresh_list() {
    const server = currentServerIp();
    if (!server || refreshing.value) return;

    const requestId = ++refreshRequestId;
    const controller = new AbortController();
    refreshAbortController?.abort();
    refreshAbortController = controller;
    refreshing.value = true;
    text.value = "Refreshing Cameras...";

    try {
        const response = await fetchWithTimeout(`${apiBaseUrl(server)}/v1/cameras/reconnect`, {
            method: "POST",
            headers: AUTH_HEADERS,
            signal: controller.signal,
        });
        await ensureOk(response, "Failed to reconnect cameras");
        if (requestId !== refreshRequestId || server !== currentServerIp()) return;
        await get_list({ forceStreams: true });
    } catch (error) {
        if (requestId === refreshRequestId && !controller.signal.aborted && !isAbortError(error)) {
            text.value = errorMessage(error);
        }
    } finally {
        if (requestId === refreshRequestId) {
            refreshing.value = false;
            if (refreshAbortController === controller) refreshAbortController = null;
        }
    }
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

if (server_ip) {
    watch(server_ip, (newValue, oldValue) => {
        const newServer = String(newValue ?? "").trim();
        const oldServer = String(oldValue ?? "").trim();
        if (newServer === oldServer) return;

        const shouldReload = panelActive && arr.value.length > 0 && !!newServer;
        abortPendingCameraRequests();
        closeAllStreams({ state: "idle", message: "Server changed; stream stopped" });
        iceServerCache.clear();
        cameras.value = [];
        arr.value = [];
        activeRecordings.value = {};
        streamStates.value = {};
        text.value = newServer ? "Server changed" : "Enter a server IP to load cameras";
        if (shouldReload) void get_list();
    });
}

onActivated(async () => {
    panelActive = true;
    await nextTick();
    resumeAllStreams();
});

onDeactivated(() => {
    panelActive = false;
    abortPendingCameraRequests();
    closeAllStreams({ state: "idle", message: "Paused while camera panel is hidden" });
});

onMounted(() => {
    document.addEventListener("visibilitychange", onVisibilityChange);
    watchdogTimer = window.setInterval(monitorStreams, STREAM_WATCHDOG_INTERVAL_MS);
});

onUnmounted(() => {
    componentDestroyed = true;
    panelActive = false;
    abortPendingCameraRequests();
    closeAllStreams();
    window.clearInterval(watchdogTimer);
    document.removeEventListener("mousemove", onTileResizeMove);
    document.removeEventListener("mouseup", onTileResizeEnd);
    document.removeEventListener("visibilitychange", onVisibilityChange);
});

</script>

<template>
    <div id="camera-panel">

        <div class="camera-toolbar">
            <span class="panel-title">Camera View</span>
            <span class="status-text">{{ text }}</span>
            <Button
                :label="loading ? 'Loading...' : 'Load'"
                size="small"
                @click="get_list"
                :disabled="!server_ip || loading || refreshing"
            />
            <Button
                :label="refreshing ? 'Refreshing...' : 'Refresh'"
                size="small"
                @click="refresh_list"
                :disabled="!server_ip || loading || refreshing"
            />
        </div>

        <div class="camera-grid">
            <div
                v-for="item in arr"
                :key="item.streamKey"
                class="camera-tile"
                :style="{ width: (tileSizes[item.streamKey] ?? DEFAULT_TILE_WIDTH) + 'px' }"
            >

                <div class="tile-header">
                    <span class="tile-name">{{ item.hostname }}</span>
                    <span v-if="activeRecordings[item.ip]" class="rec-indicator">
                        <span class="rec-led" />
                        REC
                    </span>
                </div>

                <div class="video-wrapper" :class="{ recording: activeRecordings[item.ip] }">
                    <video
                        :ref="(element) => setVideoRef(element, item.streamKey)"
                        autoplay
                        playsinline
                        :muted="isMuted(item.streamKey)"
                    ></video>
                    <div
                        class="stream-state-badge"
                        :class="`state-${streamStateFor(item.streamKey).state}`"
                    >
                        {{ streamStatusLabel(item.streamKey) }}
                    </div>
                    <div
                        v-if="streamStateFor(item.streamKey).state !== 'live'"
                        class="stream-overlay"
                    >
                        <span>{{ streamStateFor(item.streamKey).message }}</span>
                        <Button
                            v-if="streamStateFor(item.streamKey).state === 'error'"
                            label="Retry"
                            icon="pi pi-refresh"
                            size="small"
                            @click="retryStream(item)"
                        />
                    </div>
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
                        :icon="isMuted(item.streamKey) ? 'pi pi-volume-off' : 'pi pi-volume-up'"
                        size="small"
                        :class="{ 'btn-muted': isMuted(item.streamKey) }"
                        @click="toggleMute(item.streamKey)"
                        v-tooltip="isMuted(item.streamKey) ? 'Unmute' : 'Mute'"
                    />

                    <div class="rec-controls">
                        <Button label="Record" icon="pi pi-circle-fill" size="small" class="btn-record"
                            @click="startRecording(item)" :disabled="!!activeRecordings[item.ip]" />
                        <Button label="Stop" icon="pi pi-stop-circle" size="small" class="btn-stop"
                            @click="stopRecording(item)" :disabled="!activeRecordings[item.ip]" />
                    </div>
                </div>

                <div class="tile-resize-handle" @mousedown="onTileResizeStart($event, item.streamKey)" />

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
    max-width: min(50vw, 520px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    position: relative;
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

.stream-state-badge {
    position: absolute;
    top: 6px;
    left: 6px;
    z-index: 2;
    padding: 2px 5px;
    border-radius: 3px;
    background: rgba(20, 20, 20, 0.78);
    color: #ddd;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    pointer-events: none;
}

.stream-state-badge.state-live {
    color: #7de29a;
}

.stream-state-badge.state-error,
.stream-state-badge.state-unsupported {
    color: #ff8b82;
}

.stream-state-badge.state-retrying {
    color: #ffd36d;
}

.stream-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 26px 18px 12px;
    background: rgba(0, 0, 0, 0.58);
    color: #ddd;
    font-size: 10px;
    line-height: 1.35;
    text-align: center;
}

.stream-overlay :deep(.p-button) {
    font-size: 0.65rem;
    padding: 0.25rem 0.45rem;
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
