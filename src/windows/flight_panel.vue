<script setup>
import { computed, inject, onActivated, onMounted, onUnmounted, ref, watch } from "vue";
import { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import Button from "primevue/button";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri, tileUrlTemplate } from "../lib/tileSource.js";
import { useOnlineStatus } from "../composables/useOnlineStatus.js";

// Name must match the KeepAlive include list in App.vue so the map's WebGL
// context and viewport survive panel switches.
defineOptions({ name: "FlightPanel" });

const props = defineProps({
  // Harness hook: lets flight_harness.js supply raster meta without Tauri.
  tileMetaOverride: { type: Object, default: null },
});

const { currentFix, bearing, trailVersion, getTrailGeoJSON, reset } =
  inject("flightTrack");
const mapSite = inject("mapSite", ref(""));
const sensorData = inject("sensorData", ref({}));

const { online, recheck } = useOnlineStatus();

const mapEl = ref(null);
const follow = ref(true);
const hasBasemap = ref(false);
const siteName = ref("");
const threeD = ref(false);

// Download-mode state
const downloadMode = ref(false);
const drawing = ref(false);
const bboxSel = ref(null); // [w, s, e, n]
const dlName = ref("");
const dlMinZoom = ref(12);
const dlMaxZoom = ref(17);
const downloading = ref(false);
const dlProgress = ref(null); // {name, fetched, failed, total, done, error}
const dlError = ref("");

// In a plain browser (harness) there is no offline meta — use whole-world
// bounds over online fallback tiles from tileSource.js.
const ONLINE_FALLBACK_META = {
  name: "online",
  format: "png",
  minzoom: 0,
  maxzoom: 19,
  bounds: [-180, -85, 180, 85],
};

// Online Esri imagery used while selecting an area to download.
// NOTE: Esri path order is {z}/{y}/{x}.
const ESRI_META = {
  name: "Esri World Imagery (online)",
  format: "jpg",
  minzoom: 0,
  maxzoom: 19,
  bounds: [-180, -85, 180, 85],
  tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  attribution: "Esri, Maxar, Earthstar Geographics",
};

// The MapLibre instance and deck overlay are deliberately kept out of Vue
// reactivity — proxying them breaks their internals.
let map = null;
let overlay = null;
let resizeObserver = null;
let unlistenProgress = null;
let suppressFollowUntil = 0; // lets programmatic camera moves finish uninterrupted

function positionFeature() {
  const fix = currentFix.value;
  if (!fix) return { type: "FeatureCollection", features: [] };
  return {
    type: "Feature",
    properties: { bearing: bearing.value },
    geometry: { type: "Point", coordinates: [fix.lon, fix.lat] },
  };
}

const EMPTY_FC = { type: "FeatureCollection", features: [] };

// Overlay sources/layers live inside the style so a setStyle() on site change
// rebuilds everything in one shot.
function makeStyle(meta) {
  const sources = {
    // lineMetrics enables line-gradient (color-by-altitude) later
    trail: { type: "geojson", data: getTrailGeoJSON(), lineMetrics: true },
    position: { type: "geojson", data: positionFeature() },
  };
  const layers = [
    { id: "bg", type: "background", paint: { "background-color": "#101418" } },
  ];
  if (meta) {
    sources.basemap = {
      type: "raster",
      tiles: [meta.tiles ?? tileUrlTemplate()],
      tileSize: 256,
      scheme: "xyz", // TMS flip happens Rust-side; frontend stays XYZ
      minzoom: meta.minzoom,
      maxzoom: meta.maxzoom, // MapLibre overzooms raster past this automatically
      bounds: meta.bounds,   // stops tile requests outside coverage
      attribution:
        meta.attribution ?? (isTauri() ? "" : "© OpenStreetMap contributors"),
    };
    layers.push({ id: "basemap", type: "raster", source: "basemap" });
  }
  if (downloadMode.value) {
    sources["draw-rect"] = { type: "geojson", data: EMPTY_FC };
    layers.push(
      { id: "draw-rect-fill", type: "fill", source: "draw-rect",
        paint: { "fill-color": "#4da3ff", "fill-opacity": 0.15 } },
      { id: "draw-rect-line", type: "line", source: "draw-rect",
        paint: { "line-color": "#4da3ff", "line-width": 2 } },
    );
  }
  layers.push(
    {
      id: "trail-line",
      type: "line",
      source: "trail",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ff4d4d", "line-width": 3 },
    },
    {
      id: "rocket",
      type: "symbol",
      source: "position",
      layout: {
        "icon-image": "rocket-arrow",
        "icon-size": 0.9,
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map", // bearing is geographic, rotate with the map
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    },
  );
  return { version: 8, sources, layers };
}

// Arrowhead marker drawn on a canvas: points up (north) at bearing 0.
function makeRocketArrowImage() {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const c = canvas.getContext("2d");
  c.translate(size / 2, size / 2);
  c.beginPath();
  c.moveTo(0, -18);
  c.lineTo(12, 14);
  c.lineTo(0, 7);
  c.lineTo(-12, 14);
  c.closePath();
  c.fillStyle = "#ffd21f";
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = "#1a1a1a";
  c.stroke();
  return c.getImageData(0, 0, size, size);
}

async function fetchMeta() {
  if (props.tileMetaOverride) return props.tileMetaOverride;
  if (!isTauri()) return ONLINE_FALLBACK_META;
  try {
    return await invoke("get_tile_meta");
  } catch (err) {
    console.error("[FlightPanel] get_tile_meta failed:", err);
    return null;
  }
}

function startCenter(meta) {
  const fix = currentFix.value;
  if (fix) return [fix.lon, fix.lat];
  if (meta) {
    const [w, s, e, n] = meta.bounds;
    return [(w + e) / 2, (s + n) / 2];
  }
  return [0, 0];
}

function refreshOverlays() {
  map?.getSource("trail")?.setData(getTrailGeoJSON());
  map?.getSource("position")?.setData(positionFeature());
}

// Single restyle path for site changes, download-mode exit, and post-download.
async function applySiteRestyle() {
  if (!map) return;
  let meta = props.tileMetaOverride ?? null;
  if (!meta) {
    meta = await fetchMeta();
    // App.vue's set_tile_source invoke races this; retry once.
    if (!meta && isTauri() && mapSite.value) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      meta = await fetchMeta();
    }
  }
  hasBasemap.value = !!meta;
  siteName.value = meta?.name ?? "";
  map.setMaxZoom((meta?.maxzoom ?? 19) + 3);
  map.setStyle(makeStyle(meta));
  map.once("idle", () => {
    refreshOverlays();
    syncDeck();
  });
  if (meta) map.fitBounds(meta.bounds, { padding: 40, duration: 0 });
}

onMounted(async () => {
  const meta = await fetchMeta();
  hasBasemap.value = !!meta;
  siteName.value = meta?.name ?? "";

  map = new MapLibreMap({
    container: mapEl.value,
    style: makeStyle(meta),
    center: startCenter(meta),
    zoom: meta && meta !== ONLINE_FALLBACK_META ? Math.min(meta.maxzoom - 2, 15) : 2,
    maxZoom: (meta?.maxzoom ?? 19) + 3,
    attributionControl: isTauri() ? false : undefined,
  });
  // Re-adds the marker image lazily after every setStyle (style swaps drop
  // previously added images).
  map.on("styleimagemissing", (e) => {
    if (e.id === "rocket-arrow") map.addImage("rocket-arrow", makeRocketArrowImage());
  });
  map.on("dragstart", () => { follow.value = false; });

  // deck.gl overlay for the 3D flight path. Added exactly once — the
  // interleaved overlay re-resolves its layers on every styledata event, so
  // setStyle() site swaps need no control re-add (re-adding a removed
  // MapboxOverlay renders nothing).
  overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay);

  resizeObserver = new ResizeObserver(() => map?.resize());
  resizeObserver.observe(mapEl.value);

  if (isTauri()) {
    unlistenProgress = await listen("map-download-progress", onDownloadProgress);
  }

  if (import.meta.env.DEV) window.__flightMap = map; // harness/devtools access
});

onActivated(() => map?.resize()); // container was display-detached under KeepAlive

onUnmounted(() => {
  unlistenProgress?.();
  unlistenProgress = null;
  cleanupDrawHandlers();
  resizeObserver?.disconnect();
  resizeObserver = null;
  overlay = null; // map.remove() tears the control down
  map?.remove(); // release the WebGL context
  map = null;
});

watch(trailVersion, () => {
  map?.getSource("trail")?.setData(getTrailGeoJSON());
  if (threeD.value) syncDeck();
});

watch([currentFix, bearing], ([fix]) => {
  if (!map || !fix) return;
  map.getSource("position")?.setData(positionFeature());
  if (threeD.value) syncDeck();
  if (!follow.value || downloadMode.value) return;
  // Recentering every fix would interrupt an in-progress wheel-zoom or
  // rotate animation (easeTo cancels them), locking the operator out of
  // zooming/rotating the (3D) view while following. The suppress window
  // protects programmatic moves (e.g. the 3D pitch ease) the same way.
  if (map.isZooming() || map.isRotating()) return;
  if (performance.now() < suppressFollowUntil) return;
  // Pad GPS jitter (<~2 m) isn't worth chasing — keeps the camera idle at rest.
  const c = map.getCenter();
  const moved = Math.abs(c.lat - fix.lat) + Math.abs(c.lng - fix.lon);
  if (moved < 0.00002) return;
  // Duration ≈ fix cadence, linear easing so successive moves chain smoothly.
  map.easeTo({ center: [fix.lon, fix.lat], duration: 280, easing: (t) => t });
});

// Site changed (possibly from another window's settings).
watch(mapSite, () => {
  if (!isTauri() || !map || downloadMode.value) return;
  applySiteRestyle();
});

function recenter() {
  follow.value = true;
  const fix = currentFix.value;
  if (fix && map) map.easeTo({ center: [fix.lon, fix.lat], duration: 300 });
}

// ── 3D flight path (deck.gl) ─────────────────────────────────────────────────

function buildDeckLayers() {
  if (!threeD.value) return [];
  const fix = currentFix.value;
  const layers = [
    new PathLayer({
      id: "trail-3d",
      // Fresh wrapper each call: the coords array mutates in place, so a new
      // data reference is what tells deck to re-upload.
      data: [{ path: getTrailGeoJSON().geometry.coordinates }],
      getPath: (d) => d.path,
      getColor: [255, 176, 32, 230], // amber, distinct from the red ground trail
      widthMinPixels: 3,
      billboard: true,
    }),
  ];
  if (fix) {
    const alt = fix.alt ?? 0;
    layers.push(
      new LineLayer({
        id: "drop-line",
        data: [0],
        getSourcePosition: () => [fix.lon, fix.lat, alt],
        getTargetPosition: () => [fix.lon, fix.lat, 0],
        getColor: [255, 255, 255, 110],
        widthMinPixels: 1,
      }),
      new ScatterplotLayer({
        id: "rocket-3d",
        data: [0],
        getPosition: () => [fix.lon, fix.lat, alt],
        getFillColor: [255, 210, 31, 255],
        radiusMinPixels: 5,
        radiusMaxPixels: 9,
      }),
    );
  }
  return layers;
}

function syncDeck() {
  overlay?.setProps({ layers: buildDeckLayers() });
}

function toggle3D() {
  threeD.value = !threeD.value;
  suppressFollowUntil = performance.now() + 500; // let the pitch ease finish
  if (threeD.value) {
    map?.easeTo({ pitch: 60, duration: 400 });
    syncDeck();
  } else {
    overlay?.setProps({ layers: [] });
    map?.easeTo({ pitch: 0, duration: 400 });
  }
}

// ── Map downloader ───────────────────────────────────────────────────────────

function enterDownloadMode() {
  if (!map || downloadMode.value) return;
  if (threeD.value) toggle3D();
  follow.value = false;
  downloadMode.value = true;
  dlError.value = "";
  bboxSel.value = null;
  map.setMaxZoom(22);
  map.setStyle(makeStyle(ESRI_META));
  map.once("idle", () => {
    refreshOverlays();
    syncDeck();
  });
}

function exitDownloadMode({ restyle = true } = {}) {
  cleanupDrawHandlers();
  downloadMode.value = false;
  drawing.value = false;
  bboxSel.value = null;
  dlError.value = "";
  if (restyle) applySiteRestyle();
}

// Rectangle draw: crosshair drag over the online imagery.
let drawStart = null;

function rectFeature(a, b) {
  const w = Math.min(a.lng, b.lng), e = Math.max(a.lng, b.lng);
  const s = Math.min(a.lat, b.lat), n = Math.max(a.lat, b.lat);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
}

function startAreaSelect() {
  if (!map || drawing.value) return;
  drawing.value = true;
  bboxSel.value = null;
  map.getSource("draw-rect")?.setData(EMPTY_FC);
  map.dragPan.disable();
  map.getCanvas().style.cursor = "crosshair";
  map.once("mousedown", onDrawDown);
}

function onDrawDown(e) {
  e.preventDefault();
  drawStart = e.lngLat;
  map.on("mousemove", onDrawMove);
  window.addEventListener("mouseup", onDrawUp, { once: true });
}

function onDrawMove(e) {
  map.getSource("draw-rect")?.setData(rectFeature(drawStart, e.lngLat));
}

function onDrawUp() {
  map.off("mousemove", onDrawMove);
  map.dragPan.enable();
  map.getCanvas().style.cursor = "";
  drawing.value = false;
  const data = map.getSource("draw-rect")?.serialize()?.data;
  const ring = data?.geometry?.coordinates?.[0];
  if (ring && ring.length === 5) {
    const [w, s] = ring[0];
    const [e, n] = ring[2];
    if (e - w > 1e-5 && n - s > 1e-5) bboxSel.value = [w, s, e, n]; // ignore accidental clicks
  }
  drawStart = null;
}

function cleanupDrawHandlers() {
  if (!map) return;
  map.off("mousedown", onDrawDown);
  map.off("mousemove", onDrawMove);
  window.removeEventListener("mouseup", onDrawUp);
  map.dragPan.enable();
  const canvas = map.getCanvas?.();
  if (canvas) canvas.style.cursor = "";
}

// Slippy tile math (mirrors the Rust side) for the live size estimate.
function lon2tileX(lon, z) {
  return Math.min(2 ** z - 1, Math.max(0, Math.floor(((lon + 180) / 360) * 2 ** z)));
}
function lat2tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  return Math.min(2 ** z - 1, Math.max(0, y));
}

const MAX_TILES = 200_000;
const WARN_TILES = 20_000;

const tileCount = computed(() => {
  if (!bboxSel.value) return 0;
  const [w, s, e, n] = bboxSel.value;
  let total = 0;
  for (let z = dlMinZoom.value; z <= dlMaxZoom.value; z++) {
    total += (lon2tileX(e, z) - lon2tileX(w, z) + 1) * (lat2tileY(s, z) - lat2tileY(n, z) + 1);
  }
  return total;
});
const estMB = computed(() => (tileCount.value * 25_000) / 1e6); // ~25 KB/tile satellite jpeg

const canDownload = computed(() =>
  isTauri() &&
  !downloading.value &&
  !!bboxSel.value &&
  dlName.value.trim().length > 0 &&
  dlMinZoom.value <= dlMaxZoom.value &&
  tileCount.value > 0 &&
  tileCount.value <= MAX_TILES,
);

async function startDownload() {
  if (!canDownload.value) return;
  dlError.value = "";
  dlProgress.value = null;
  try {
    await invoke("download_map_tiles", {
      name: dlName.value.trim(),
      bbox: bboxSel.value,
      minzoom: dlMinZoom.value,
      maxzoom: dlMaxZoom.value,
    });
    downloading.value = true;
  } catch (err) {
    dlError.value = String(err);
    recheck(); // a failed start may mean we just went offline
  }
}

function cancelDownload() {
  invoke("cancel_map_download").catch(() => {});
}

function onDownloadProgress(event) {
  const p = event.payload;
  dlProgress.value = p;
  if (!p.done) return;
  downloading.value = false;
  if (p.error) {
    dlError.value = p.error;
    return; // keep the panel open so the operator sees it (incl. "cancelled")
  }
  const file = `${p.name}.mbtiles`;
  exitDownloadMode({ restyle: false });
  if (mapSite.value === file) {
    applySiteRestyle(); // watcher won't refire on an unchanged value (re-download case)
  } else {
    mapSite.value = file; // App.vue watcher → set_tile_source + broadcast + localStorage
  }
}
</script>

<template>
  <div class="flight-panel">
    <div class="toolbar">
      <Button
        :label="follow ? 'Following' : 'Follow'"
        icon="pi pi-compass"
        size="small"
        :severity="follow ? 'primary' : 'secondary'"
        :disabled="downloadMode"
        @click="follow ? (follow = false) : recenter()"
      />
      <Button
        label="Clear Trail"
        icon="pi pi-trash"
        size="small"
        severity="secondary"
        @click="reset()"
      />
      <Button
        label="3D"
        icon="pi pi-box"
        size="small"
        :severity="threeD ? 'primary' : 'secondary'"
        :disabled="downloadMode"
        @click="toggle3D"
      />
      <Button
        label="Download Maps"
        icon="pi pi-cloud-download"
        size="small"
        severity="secondary"
        :disabled="!online || downloading || downloadMode"
        @click="enterDownloadMode"
      />
      <span v-if="!online" class="wifi-off" title="No internet connection">
        <i class="pi pi-wifi"></i>
      </span>
      <span v-if="siteName && !downloadMode" class="site-name">{{ siteName }}</span>

      <div class="stats" :class="{ 'no-fix': !currentFix }">
        <template v-if="currentFix">
          <span>{{ currentFix.lat.toFixed(6) }}, {{ currentFix.lon.toFixed(6) }}</span>
          <span v-if="currentFix.alt != null">
            Alt {{ currentFix.alt.toFixed(0) }} {{ sensorData?.Alt?.unit ?? "m" }}
          </span>
          <span v-if="currentFix.sats != null">Sats {{ currentFix.sats }}</span>
        </template>
        <template v-else>no fix</template>
      </div>
    </div>

    <div class="map-wrap">
      <div ref="mapEl" class="map-el"></div>

      <div v-if="!hasBasemap && !downloadMode" class="no-site-banner">
        No map site loaded — pick one in Settings or use Download Maps
      </div>

      <div v-if="downloadMode" class="download-card">
        <div class="dl-title">Download offline maps</div>

        <template v-if="!downloading">
          <input
            type="text"
            v-model="dlName"
            class="dl-input"
            placeholder="Site name (e.g. Timmins2026)"
          />
          <div class="dl-row">
            <label>Zoom</label>
            <input type="number" v-model.number="dlMinZoom" min="10" max="20" class="dl-input dl-zoom" />
            <span>to</span>
            <input type="number" v-model.number="dlMaxZoom" min="10" max="20" class="dl-input dl-zoom" />
          </div>
          <Button
            :label="drawing ? 'Drag on the map…' : (bboxSel ? 'Reselect area' : 'Select area')"
            icon="pi pi-expand"
            size="small"
            :severity="bboxSel ? 'secondary' : 'primary'"
            :disabled="drawing"
            @click="startAreaSelect"
          />
          <div v-if="bboxSel" class="dl-estimate" :class="{ warn: tileCount > WARN_TILES }">
            {{ tileCount.toLocaleString() }} tiles, ~{{ estMB.toFixed(0) }} MB
            <template v-if="tileCount > MAX_TILES"> — too large, shrink the area/zoom</template>
          </div>
          <div v-else class="dl-hint">
            Cover the pad plus worst-case drift and descent, not just the pad.
          </div>
          <div class="dl-actions">
            <Button label="Download" icon="pi pi-cloud-download" size="small"
                    :disabled="!canDownload" @click="startDownload" />
            <Button label="Close" size="small" severity="secondary"
                    @click="exitDownloadMode()" />
          </div>
          <div class="dl-tos">
            Imagery © Esri — internal team use only; do not redistribute downloaded tiles.
          </div>
        </template>

        <template v-else>
          <div class="dl-progress-text">
            {{ dlProgress ? `${dlProgress.fetched.toLocaleString()} / ${dlProgress.total.toLocaleString()} tiles`
                          : "Starting…" }}
            <span v-if="dlProgress?.failed" class="warn"> ({{ dlProgress.failed }} failed)</span>
          </div>
          <div class="dl-bar">
            <div class="dl-bar-fill"
                 :style="{ width: dlProgress ? (100 * dlProgress.fetched / dlProgress.total) + '%' : '0%' }"></div>
          </div>
          <Button label="Cancel Download" size="small" severity="danger" @click="cancelDownload" />
        </template>

        <div v-if="dlError" class="dl-error">{{ dlError }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.flight-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.site-name {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.wifi-off {
  position: relative;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
}

.wifi-off::after {
  content: "";
  position: absolute;
  left: -2px;
  top: 50%;
  width: 120%;
  height: 2px;
  background: currentColor;
  transform: rotate(-45deg);
}

.stats {
  margin-left: auto;
  display: flex;
  gap: 14px;
  font-family: monospace;
  font-size: 0.85rem;
  color: var(--text-primary);
}

.stats.no-fix {
  color: var(--text-muted);
}

.map-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  border-radius: 6px;
  overflow: hidden;
}

.map-el {
  position: absolute;
  inset: 0;
}

.no-site-banner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 10px 18px;
  pointer-events: none;
}

.download-card {
  position: absolute;
  top: 12px;
  left: 12px;
  width: 260px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 14px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}

.dl-title {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.9rem;
}

.dl-input {
  background: var(--input-bg, var(--bg-primary));
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 4px 8px;
  font-size: 0.85rem;
  font-family: inherit;
  width: 100%;
}

.dl-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.dl-zoom {
  width: 58px;
  text-align: right;
}

.dl-estimate {
  font-size: 0.82rem;
  color: var(--text-primary);
  font-family: monospace;
}

.dl-estimate.warn,
.warn {
  color: #e67e22;
}

.dl-hint {
  font-size: 0.78rem;
  color: var(--text-muted);
  font-style: italic;
}

.dl-actions {
  display: flex;
  gap: 8px;
}

.dl-tos {
  font-size: 0.68rem;
  color: var(--text-muted);
}

.dl-progress-text {
  font-size: 0.85rem;
  font-family: monospace;
  color: var(--text-primary);
}

.dl-bar {
  height: 8px;
  border-radius: 4px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.dl-bar-fill {
  height: 100%;
  background: #4da3ff;
  transition: width 0.3s ease;
}

.dl-error {
  font-size: 0.8rem;
  color: #ff4d4d;
}
</style>
