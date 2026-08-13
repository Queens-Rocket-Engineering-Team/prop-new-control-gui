<script setup>
import { computed, inject, onActivated, onMounted, onUnmounted, ref, watch } from "vue";
import { Map as MapLibreMap, ScaleControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import ToggleSwitch from "primevue/toggleswitch";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri, tileUrlTemplate } from "../lib/tileSource.js";
import { parseCoords } from "../lib/coords.js";
import { useOnlineStatus } from "../composables/useOnlineStatus.js";
import RocketPane from "../components/rocket_pane.vue";

// Name must match the KeepAlive include list in App.vue so the map's WebGL
// context and viewport survive panel switches.
defineOptions({ name: "FlightPanel" });

const props = defineProps({
  // Harness hook: lets flight_harness.js supply raster meta without Tauri.
  tileMetaOverride: { type: Object, default: null },
});

const { currentFix, bearing, trailVersion, getTrailGeoJSON, reset } =
  inject("flightTrack");
const mapSitesDisabled = inject("mapSitesDisabled", ref([]));
const mapsDir = inject("mapsDir", ref(""));
const mapsVersion = inject("mapsVersion", ref(0));
const mapFlyTo = inject("mapFlyTo", ref(null));
const sensorData = inject("sensorData", ref({}));

const { online, recheck } = useOnlineStatus();

// Dry-run switch: pretend the network is gone even when it isn't, so the
// offline behaviour can be rehearsed at a desk instead of discovered at the
// pad. Everything that depends on connectivity reads onlineActive, not online,
// so the simulation is faithful — live imagery and place names disappear and
// the network-only actions grey out, exactly as they will in the field.
const liveImagery = ref(localStorage.getItem("qret-live-imagery") !== "false");
const onlineActive = computed(() => online.value && liveImagery.value);

const mapEl = ref(null);
const follow = ref(true);
// The flight is always drawn in 3D — there is no reason to throw away the
// altimeter reading. DEFAULT_PITCH is what the camera starts at and what
// "Reset View" returns to; MAX_PITCH is raised from MapLibre's default 60 so
// the camera can get closer to side-on, which matters because a rocket climbs
// several times further than it drifts.
const DEFAULT_PITCH = 55;
const MAX_PITCH = 85;
const labelsOn = ref(localStorage.getItem("qret-map-labels") !== "false");

// Downloaded sites from manifest.json: [{name, file, bbox, minzoom, maxzoom}].
const sites = ref([]);

// OSM label layer state, surfaced in the toolbar so "no labels" is always
// distinguishable from "labels broken".
const featureCount = ref(0);
const sitesMissingFeatures = ref([]);
const fetchingLabels = ref(false);
const labelsError = ref("");

// Rocket side pane: collapsed flag + width, both persisted. The pane overlays
// the map, inset by PANE_GAP so the map edge stays visible around it.
const PANE_MIN_W = 180;
const PANE_MAX_W = 460;
const PANE_GAP = 8;

function clampPaneWidth(w) {
  return Math.min(PANE_MAX_W, Math.max(PANE_MIN_W, w));
}

const paneOpen = ref(localStorage.getItem("qret-rocket-pane-open") !== "false");
const paneWidth = ref(clampPaneWidth(Number(localStorage.getItem("qret-rocket-pane-w")) || 240));

// Download-mode state
const downloadMode = ref(false);
const drawing = ref(false);
const bboxSel = ref(null); // [w, s, e, n]
const dlName = ref("");
const dlMinZoom = ref(12);
const dlMaxZoom = ref(17);
const dlFeatures = ref(localStorage.getItem("qret-map-dl-features") !== "false");
const downloading = ref(false);
const dlProgress = ref(null); // {name, fetched, failed, total, bytes, skipped, done, error}
const dlRate = ref(null);     // tiles/sec, smoothed across progress events
const dlByteRate = ref(null); // bytes/sec, smoothed the same way
const dlFeaturesPhase = ref(false); // true while the OSM feature fetch runs
const dlFeaturesElapsed = ref(0);   // seconds, so the phase never looks frozen
const dlError = ref("");
const dlWarning = ref("");
const gotoText = ref("");
const gotoError = ref(false);
const hoverCorner = ref(""); // corner under the pointer / being dragged

// Once a download is under way the area is fixed: the running job captured the
// bbox at launch, so a resize would change what the map shows without changing
// what is actually being fetched. The feature phase counts too — that query is
// still using the same bbox.
const selectionLocked = computed(() => downloading.value || dlFeaturesPhase.value);

const cursorClass = computed(() =>
  hoverCorner.value ? `corner-${CORNER_DIAGONAL[hoverCorner.value] ?? "nesw"}` : "",
);

// Online Esri imagery: the download-mode basemap, and the live underlay
// beneath offline coverage when the network is up.
// NOTE: Esri path order is {z}/{y}/{x}.
const ESRI_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTRIBUTION = "Esri, Maxar, Earthstar Geographics";

// Esri's transparent "hybrid" reference overlays — the label half of satellite
// imagery. Esri's own imagery carries no names at all, so without these an
// online view outside downloaded coverage is unlabelled pixels.
const ESRI_REFERENCE = [
  ["online-roads",
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
  ["online-places",
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
];

// The MapLibre instance and deck overlay are deliberately kept out of Vue
// reactivity — proxying them breaks their internals.
let map = null;
let overlay = null;
let resizeObserver = null;
let unlistenProgress = null;
let suppressFollowUntil = 0; // lets programmatic camera moves finish uninterrupted
let featuresFC = null; // merged OSM features of the enabled sites

const EMPTY_FC = { type: "FeatureCollection", features: [] };

// ── Site helpers ─────────────────────────────────────────────────────────────

const enabledSites = computed(() =>
  sites.value
    .filter((s) => !mapSitesDisabled.value.includes(s.file))
    .slice()
    // Higher-resolution sites draw later (on top), so a small z14-17 launch
    // box nests visually inside a wide z10-13 region.
    .sort((a, b) => (a.maxzoom ?? 0) - (b.maxzoom ?? 0)),
);

const siteSummary = computed(() => {
  const list = enabledSites.value;
  if (list.length === 0) return "";
  if (list.length === 1) return list[0].name;
  return `${list.length} sites`;
});

const hasBasemap = computed(
  () => enabledSites.value.length > 0 || (isTauri() ? onlineActive.value : liveImagery.value),
);

async function refreshSites() {
  if (!isTauri()) return;
  try {
    const manifest = await invoke("list_map_sites");
    sites.value = (manifest?.sites ?? []).filter((s) => Array.isArray(s.bbox));
  } catch (err) {
    console.error("[FlightPanel] list_map_sites failed:", err);
  }
}

async function refreshFeatures() {
  if (!isTauri()) {
    featuresFC = null;
    featureCount.value = 0;
    sitesMissingFeatures.value = [];
    return;
  }
  const merged = [];
  const missing = [];
  for (const site of enabledSites.value) {
    try {
      const fc = await invoke("get_site_features", { file: site.file });
      if (fc?.features?.length) merged.push(...fc.features);
      else missing.push(site);
    } catch (err) {
      console.error(`[FlightPanel] get_site_features(${site.file}) failed:`, err);
      missing.push(site);
    }
  }
  featuresFC = merged.length ? { type: "FeatureCollection", features: merged } : null;
  featureCount.value = merged.length;
  // Sites with no feature data yet: downloaded before features existed, or the
  // Overpass fetch failed at download time. Without this the only way to get
  // labels would be re-downloading every tile.
  sitesMissingFeatures.value = missing;
  console.log(
    `[FlightPanel] OSM features: ${merged.length} loaded from ` +
    `${enabledSites.value.length - missing.length}/${enabledSites.value.length} enabled sites` +
    (missing.length ? ` (missing: ${missing.map((s) => s.name).join(", ")})` : ""),
  );
}

// Waiting on Overpass must always end. The query itself is quick (a 70x70 km
// launch box answers in ~12 s) and the Rust side caps its own attempts, but a
// laptop suspend can leave the underlying request wedged: the socket dies
// silently and the timeout guarding it is measured on a monotonic clock that
// doesn't advance while suspended, so nothing ever fires. This deadline is
// wall-clock, in the webview, and is the backstop that guarantees the panel
// comes back — plus a Skip button so the operator never has to wait it out.
const FEATURE_FETCH_DEADLINE_MS = 180_000;
let abandonFeatureFetch = null;

function skipFeatureFetch() {
  abandonFeatureFetch?.("skipped");
}

// Resolves to { count } on success, or { abandoned: "timeout" | "skipped" }.
// A late-arriving result is simply ignored; the features file is still written
// Rust-side, so "Fetch labels" will pick it up.
function fetchFeaturesBounded(name, bbox) {
  let timer = null;
  const escape = new Promise((resolve) => {
    abandonFeatureFetch = resolve;
    timer = setTimeout(() => resolve("timeout"), FEATURE_FETCH_DEADLINE_MS);
  });
  return Promise.race([
    invoke("download_map_features", { name, bbox: [...bbox] }).then((count) => ({ count })),
    escape.then((reason) => ({ abandoned: reason })),
  ]).finally(() => {
    clearTimeout(timer);
    abandonFeatureFetch = null;
  });
}

function abandonedMessage(reason, what) {
  return reason === "timeout"
    ? `Place-name lookup for ${what} timed out — imagery is saved. Use “Fetch labels” to retry.`
    : `Place-name lookup for ${what} skipped — imagery is saved. Use “Fetch labels” to add them later.`;
}

// Pull OSM features for enabled sites that have none, using the bbox recorded
// in the manifest. Tiles are untouched — this only writes the features file.
async function fetchMissingLabels() {
  if (!isTauri() || fetchingLabels.value) return;
  const targets = sitesMissingFeatures.value.slice();
  if (!targets.length) return;
  fetchingLabels.value = true;
  labelsError.value = "";
  const failures = [];
  for (const site of targets) {
    try {
      const outcome = await fetchFeaturesBounded(site.name, site.bbox);
      if (outcome.abandoned) {
        failures.push(`${site.name} (${outcome.abandoned})`);
        if (outcome.abandoned === "skipped") break; // stop the whole run, not just this site
      } else {
        console.log(`[FlightPanel] ${site.name}: ${outcome.count} OSM features saved`);
      }
    } catch (err) {
      console.error(`[FlightPanel] download_map_features(${site.name}) failed:`, err);
      failures.push(`${site.name} (${err})`);
    }
  }
  fetchingLabels.value = false;
  if (failures.length) labelsError.value = `Couldn't fetch labels for ${failures.join(", ")}`;
  await applySiteRestyle();
}

function unionBounds(list) {
  if (!list.length) return null;
  let [w, s, e, n] = list[0].bbox;
  for (const site of list.slice(1)) {
    const [w2, s2, e2, n2] = site.bbox;
    w = Math.min(w, w2); s = Math.min(s, s2);
    e = Math.max(e, e2); n = Math.max(n, n2);
  }
  return [w, s, e, n];
}

function bboxRing([w, s, e, n]) {
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

// Coverage borders: every box the user has downloaded, labeled with its zoom
// range so nested resolutions read at a glance.
function coverageFC(list) {
  return {
    type: "FeatureCollection",
    features: list.map((site) => ({
      type: "Feature",
      properties: {
        name: site.name,
        minzoom: site.minzoom ?? 0,
        maxzoom: site.maxzoom ?? 0,
        label: `${site.name}  z${site.minzoom}–${site.maxzoom}`,
      },
      geometry: { type: "Polygon", coordinates: [bboxRing(site.bbox)] },
    })),
  };
}

// Border color steps with resolution: blue wide-area boxes, warmer nested
// high-res boxes.
const COVERAGE_COLOR = ["step", ["get", "maxzoom"], "#4da3ff", 15, "#ffb020", 18, "#ff6b4d"];

// MapLibre cross-fades a raster layer over 300 ms when swapping to a new zoom
// level's tiles, on top of however long the fetch took. That reads as the
// labels taking about a second to sharpen up. Zero makes tiles snap in the
// moment they are ready — and for the offline sqlite-backed sites, where the
// "fetch" is sub-millisecond, the fade was the entire delay.
const RASTER_PAINT = { "raster-fade-duration": 0 };

// Must match the directory under public/glyphs. Deliberately free of spaces:
// MapLibre percent-encodes the fontstack into the glyph URL, and relying on the
// webview's custom-scheme handler to decode that correctly is avoidable risk.
const MAP_FONT = ["NotoSans"];

// ── Style assembly ───────────────────────────────────────────────────────────

function osmFeatureLayers() {
  const line = (id, filter, paint, layout = {}) => ({
    id, type: "line", source: "osm-features", filter, paint, layout,
  });
  const label = (id, filter, layout, paint = {}) => ({
    id,
    type: "symbol",
    source: "osm-features",
    filter,
    layout: {
      "text-font": MAP_FONT,
      "text-field": ["get", "name"],
      ...layout,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(10, 14, 18, 0.9)",
      "text-halo-width": 1.4,
      ...paint,
    },
  });
  const kind = (k) => ["==", ["get", "kind"], k];
  const isPoly = ["==", ["geometry-type"], "Polygon"];
  const isLine = ["==", ["geometry-type"], "LineString"];
  const isPoint = ["==", ["geometry-type"], "Point"];
  const named = ["has", "name"];

  return [
    {
      id: "feat-water-fill",
      type: "fill",
      source: "osm-features",
      filter: ["all", kind("water"), isPoly],
      paint: { "fill-color": "rgba(74, 144, 217, 0.22)" },
    },
    line("feat-water-line", ["all", kind("water"), isPoly],
      { "line-color": "rgba(120, 180, 240, 0.65)", "line-width": 1 }),
    line("feat-park-line", ["all", kind("park"), isPoly],
      { "line-color": "rgba(88, 200, 120, 0.8)", "line-width": 1.5, "line-dasharray": [3, 2] }),
    line("feat-waterway", ["all", kind("waterway"), isLine],
      { "line-color": "rgba(120, 180, 240, 0.8)", "line-width": 1.5 }),
    line("feat-road", ["all", kind("road"), isLine],
      { "line-color": "rgba(255, 255, 255, 0.55)", "line-width": 1.2 }),
    label("feat-road-label", ["all", kind("road"), isLine, named], {
      "symbol-placement": "line",
      "text-size": 10.5,
    }),
    label("feat-waterway-label", ["all", kind("waterway"), isLine, named], {
      "symbol-placement": "line",
      "text-size": 10.5,
    }, { "text-color": "#bcd8f5" }),
    label("feat-area-label", ["all", ["any", kind("water"), kind("park")], named,
      ["any", isPoly, isPoint]], {
      "text-size": 12,
    }, { "text-color": "#cfe3f8" }),
    label("feat-place-label", ["all", kind("place"), named, isPoint], {
      "text-size": 13,
      "text-transform": "uppercase",
      "text-letter-spacing": 0.08,
    }),
  ];
}

// Overlay sources/layers live inside the style so a single setStyle() call
// rebuilds everything (site toggles, download-mode swaps, label toggles).
function makeStyle() {
  const sources = {
    // Ground track only. The current position and the elevated track are deck
    // layers, since MapLibre can't lift geometry off the ground plane.
    // lineMetrics enables line-gradient (color-by-altitude) later.
    trail: { type: "geojson", data: getTrailGeoJSON(), lineMetrics: true },
  };
  const layers = [
    { id: "bg", type: "background", paint: { "background-color": "#101418" } },
  ];

  // Download mode always gets imagery — you cannot pick an area to download
  // over a blank screen — so the dry-run switch doesn't apply there.
  const showOnline =
    downloadMode.value || (isTauri() ? onlineActive.value : liveImagery.value);
  const offline = isTauri() && !props.tileMetaOverride ? enabledSites.value : [];

  // Base: online imagery (Esri in Tauri, OSM in the browser harness) under
  // everything, whenever the network can serve it.
  if (props.tileMetaOverride) {
    const meta = props.tileMetaOverride;
    sources["override"] = {
      type: "raster",
      tiles: [meta.tiles ?? tileUrlTemplate("")],
      tileSize: 256,
      scheme: "xyz",
      minzoom: meta.minzoom,
      maxzoom: meta.maxzoom,
      bounds: meta.bounds,
      attribution: meta.attribution ?? "",
    };
    layers.push({ id: "override", type: "raster", source: "override", paint: RASTER_PAINT });
  } else if (showOnline) {
    const inTauri = isTauri();
    sources["online-basemap"] = {
      type: "raster",
      tiles: [inTauri ? ESRI_TILES : tileUrlTemplate("")],
      tileSize: 256,
      scheme: "xyz",
      minzoom: 0,
      maxzoom: 19,
      attribution: inTauri ? ESRI_ATTRIBUTION : "© OpenStreetMap contributors",
    };
    layers.push({ id: "online-basemap", type: "raster", source: "online-basemap", paint: RASTER_PAINT });

    // Online place/road labels, over the online imagery but *under* the
    // offline site rasters pushed below. That ordering is the whole trick:
    // inside downloaded coverage the opaque offline imagery paints over these,
    // so only the sharp OSM vector labels show there, while outside coverage
    // (where no offline raster is drawn) they are the only labels available.
    // No viewport test, no toggling — the masking is exact, per pixel.
    // Skipped outside Tauri: the harness's OSM basemap already has labels
    // baked into it, so these would double up.
    if (inTauri && labelsOn.value) {
      for (const [id, url] of ESRI_REFERENCE) {
        sources[id] = {
          type: "raster",
          tiles: [url],
          tileSize: 256,
          scheme: "xyz",
          minzoom: 0,
          maxzoom: 19,
        };
        layers.push({ id, type: "raster", source: id, paint: RASTER_PAINT });
      }
    }
  }

  // Offline sites, low→high resolution so nested boxes win where they overlap.
  if (!downloadMode.value) {
    offline.forEach((site, i) => {
      const id = `site-${i}`;
      sources[id] = {
        type: "raster",
        tiles: [tileUrlTemplate(site.file)],
        tileSize: 256,
        scheme: "xyz", // TMS flip happens Rust-side; frontend stays XYZ
        minzoom: site.minzoom,
        maxzoom: site.maxzoom, // MapLibre overzooms raster past this automatically
        bounds: site.bbox,     // stops tile requests outside coverage
      };
      layers.push({ id, type: "raster", source: id, paint: RASTER_PAINT });
    });
  }

  // Coverage borders + zoom labels. In download mode every site is outlined
  // (you're planning new coverage); otherwise just the enabled ones.
  const outlined = isTauri() ? (downloadMode.value ? sites.value : enabledSites.value) : [];
  if (outlined.length) {
    sources["coverage"] = { type: "geojson", data: coverageFC(outlined) };
    layers.push(
      {
        id: "coverage-border",
        type: "line",
        source: "coverage",
        paint: {
          "line-color": COVERAGE_COLOR,
          "line-width": 1.75,
          "line-dasharray": [3, 2],
        },
      },
      {
        id: "coverage-label",
        type: "symbol",
        source: "coverage",
        layout: {
          "text-font": MAP_FONT,
          "text-field": ["get", "label"],
          "text-size": 11,
          "symbol-placement": "line",
          "text-offset": [0, -0.8],
        },
        paint: {
          "text-color": COVERAGE_COLOR,
          "text-halo-color": "rgba(10, 14, 18, 0.9)",
          "text-halo-width": 1.2,
        },
      },
    );
  }

  // OSM vector features (roads, lakes, parks, places) — crisp offline labels.
  if (labelsOn.value && featuresFC && !downloadMode.value) {
    sources["osm-features"] = { type: "geojson", data: featuresFC };
    layers.push(...osmFeatureLayers());
  }

  if (downloadMode.value) {
    // Seeded from the current selection rather than empty, so a restyle (e.g.
    // toggling Labels mid-selection) doesn't wipe the box the operator drew.
    const selection = bboxSel.value;
    sources["draw-rect"] = {
      type: "geojson",
      data: selection ? rectFromBbox(selection) : EMPTY_FC,
    };
    sources["draw-handles"] = {
      type: "geojson",
      data: selection && !selectionLocked.value ? handlesFromBbox(selection) : EMPTY_FC,
    };
    layers.push(
      { id: "draw-rect-fill", type: "fill", source: "draw-rect",
        paint: { "fill-color": "#4da3ff", "fill-opacity": 0.15 } },
      { id: "draw-rect-line", type: "line", source: "draw-rect",
        paint: { "line-color": "#4da3ff", "line-width": 2 } },
      // Grab targets for resizing. Drawn last so they sit above the fill, and
      // generously sized — they have to be catchable with a trackpad.
      { id: "draw-handle", type: "circle", source: "draw-handles",
        paint: {
          "circle-radius": 7,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#1a5f9e",
          "circle-stroke-width": 2.5,
        } },
    );
  }

  // Ground track: the flight's shadow on the map, drawn flat because MapLibre
  // line layers can only sit on the ground plane. The flight itself is drawn
  // at true altitude by the deck.gl overlay (see buildDeckLayers) — including
  // the current-position marker, which is why there is no symbol layer here.
  layers.push({
    id: "trail-line",
    type: "line",
    source: "trail",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ff4d4d", "line-width": 3 },
  });

  return {
    version: 8,
    // Offline text rendering needs glyph PBFs; they ship in public/glyphs so
    // the app origin serves them with no network.
    // Root-relative so it resolves against whatever origin the webview serves
    // the app from (http://tauri.localhost, the vite dev server, …).
    glyphs: "/glyphs/{fontstack}/{range}.pbf",
    sources,
    layers,
  };
}

function startCenter() {
  const fix = currentFix.value;
  if (fix) return [fix.lon, fix.lat];
  if (props.tileMetaOverride) {
    const [w, s, e, n] = props.tileMetaOverride.bounds;
    return [(w + e) / 2, (s + n) / 2];
  }
  const union = unionBounds(enabledSites.value);
  if (union) return [(union[0] + union[2]) / 2, (union[1] + union[3]) / 2];
  return [0, 0];
}

function maxMapZoom() {
  if (downloadMode.value) return 22;
  const zooms = enabledSites.value.map((s) => s.maxzoom ?? 0);
  const offlineMax = zooms.length ? Math.max(...zooms) : 0;
  // Simulating offline caps the zoom at what the downloaded tiles support,
  // just as a real disconnection would.
  const base = onlineActive.value || !isTauri() ? 19 : offlineMax || 19;
  return Math.max(base, offlineMax) + 3;
}

// Camera padding that keeps framed content clear of the overlaying rocket pane.
function cameraPadding(base = 40) {
  return {
    top: base,
    bottom: base,
    left: base,
    right: base + (paneOpen.value ? paneWidth.value + PANE_GAP * 2 : 0),
  };
}

function refreshOverlays() {
  map?.getSource("trail")?.setData(getTrailGeoJSON());
}

// Single restyle path for site/label toggles, online changes, download-mode
// exit, and post-download refresh.
async function applySiteRestyle({ refit = false } = {}) {
  if (!map) return;
  await refreshSites();
  await refreshFeatures();
  map.setMaxZoom(maxMapZoom());
  map.setStyle(makeStyle());
  map.once("idle", () => {
    refreshOverlays();
    syncDeck();
  });
  if (refit && !currentFix.value) {
    const union = props.tileMetaOverride?.bounds ?? unionBounds(enabledSites.value);
    if (union) map.fitBounds(union, { padding: cameraPadding(), duration: 0 });
  }
}

onMounted(async () => {
  await refreshSites();
  await refreshFeatures();

  map = new MapLibreMap({
    container: mapEl.value,
    style: makeStyle(),
    center: startCenter(),
    zoom: enabledSites.value.length || props.tileMetaOverride ? 11 : 2,
    maxZoom: maxMapZoom(),
    pitch: DEFAULT_PITCH, // 3D from the first frame, not on demand
    maxPitch: MAX_PITCH,
    attributionControl: isTauri() ? false : undefined,
  });
  map.on("dragstart", () => { follow.value = false; });

  // Metric scale bar. Bottom-right so it sits clear of the download card.
  map.addControl(new ScaleControl({ maxWidth: 130, unit: "metric" }), "bottom-right");

  const union = props.tileMetaOverride?.bounds ?? unionBounds(enabledSites.value);
  if (union && !currentFix.value) map.fitBounds(union, { padding: cameraPadding(), duration: 0 });
  applyPendingFlyTo(); // "Go" from Settings on this panel's very first open

  // deck.gl overlay for the 3D flight path. Added exactly once — the
  // interleaved overlay re-resolves its layers on every styledata event, so
  // setStyle() site swaps need no control re-add (re-adding a removed
  // MapboxOverlay renders nothing).
  overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay);
  syncDeck(); // draw whatever track already exists

  resizeObserver = new ResizeObserver(() => map?.resize());
  resizeObserver.observe(mapEl.value);

  if (isTauri()) {
    unlistenProgress = await listen("map-download-progress", onDownloadProgress);
  }

  if (import.meta.env.DEV) window.__flightMap = map; // harness/devtools access
});

onActivated(() => {
  map?.resize(); // container was display-detached under KeepAlive
  applyPendingFlyTo(); // a "Go" that arrived while this panel was hidden
});

onUnmounted(() => {
  unlistenProgress?.();
  unlistenProgress = null;
  cleanupDrawHandlers();
  stopPaneResize();
  resizeObserver?.disconnect();
  resizeObserver = null;
  overlay = null; // map.remove() tears the control down
  map?.remove(); // release the WebGL context
  map = null;
});

watch(trailVersion, () => {
  map?.getSource("trail")?.setData(getTrailGeoJSON());
  syncDeck();
});

watch([currentFix, bearing], ([fix]) => {
  if (!map || !fix) return;
  syncDeck(); // moves the 3D position marker to the new fix
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

// Rebuild the current style without disturbing which mode we are in.
function restyleInPlace() {
  if (!map) return;
  map.setStyle(makeStyle());
  map.once("idle", () => {
    refreshOverlays();
    syncDeck();
  });
}

// Site set changed (possibly from another window's settings), maps dir moved,
// or a site was deleted from disk.
//
// Download mode needs handling too, not skipping: it draws a coverage border
// for every site so you can see existing coverage while planning new areas, so
// a site deleted while this panel is open would otherwise keep its border on
// the map. It just can't go through applySiteRestyle, which would rebuild the
// offline raster layers that download mode deliberately hides (and refit the
// camera out from under a selection being positioned).
watch([mapSitesDisabled, mapsDir, mapsVersion], async () => {
  if (!isTauri() || !map) return;
  if (downloadMode.value) {
    await refreshSites();
    restyleInPlace();
  } else {
    applySiteRestyle({ refit: true });
  }
});

// "Go" on a site in Settings. Tracked by timestamp so asking for the same site
// twice still moves the camera, and so a request that arrives before this panel
// is mounted is applied once it is.
let lastFlyToTs = 0;

function applyPendingFlyTo() {
  const request = mapFlyTo.value;
  if (!map || !request || request.ts === lastFlyToTs) return;
  lastFlyToTs = request.ts;
  follow.value = false; // otherwise the next GPS fix yanks the camera back
  map.fitBounds(request.bbox, { padding: cameraPadding(), duration: 900 });
}

watch(mapFlyTo, applyPendingFlyTo);

// Network came or went — or the dry-run switch was flipped: add/remove the
// live imagery underlay and its place names.
watch(onlineActive, () => {
  localStorage.setItem("qret-live-imagery", String(liveImagery.value));
  if (!map || downloadMode.value || props.tileMetaOverride) return;
  applySiteRestyle();
});

watch(labelsOn, (on) => {
  localStorage.setItem("qret-map-labels", String(on));
  if (!map) return;
  // In download mode the style is the online basemap only, so restyle in place
  // rather than going through applySiteRestyle (which would rebuild the
  // offline layers and drop the selection rectangle).
  if (downloadMode.value) {
    restyleInPlace();
  } else {
    applySiteRestyle();
  }
});

function recenter() {
  follow.value = true;
  const fix = currentFix.value;
  if (fix && map) map.easeTo({ center: [fix.lon, fix.lat], duration: 300 });
}

// ── Rocket side pane ─────────────────────────────────────────────────────────

function togglePane() {
  paneOpen.value = !paneOpen.value;
  localStorage.setItem("qret-rocket-pane-open", String(paneOpen.value));
}

let paneDrag = null; // { startX, startW }

function onPaneResizeDown(e) {
  paneDrag = { startX: e.clientX, startW: paneWidth.value };
  window.addEventListener("mousemove", onPaneResizeMove);
  window.addEventListener("mouseup", stopPaneResize, { once: true });
  e.preventDefault();
}

function onPaneResizeMove(e) {
  if (!paneDrag) return;
  paneWidth.value = clampPaneWidth(paneDrag.startW + (paneDrag.startX - e.clientX));
}

function stopPaneResize() {
  if (!paneDrag) return;
  paneDrag = null;
  window.removeEventListener("mousemove", onPaneResizeMove);
  localStorage.setItem("qret-rocket-pane-w", String(paneWidth.value));
}

// ── 3D flight path (deck.gl) ─────────────────────────────────────────────────

function buildDeckLayers() {
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
      // Current position, at true altitude. Cyan against the amber track so
      // "where it is now" never reads as part of "where it has been", and
      // white-ringed so it stays legible over both imagery and open water.
      new ScatterplotLayer({
        id: "rocket-3d",
        data: [0],
        getPosition: () => [fix.lon, fix.lat, alt],
        getFillColor: [0, 224, 255, 255],
        stroked: true,
        lineWidthMinPixels: 2,
        getLineColor: [255, 255, 255, 235],
        radiusMinPixels: 7,
        radiusMaxPixels: 11,
      }),
    );
  }
  return layers;
}

function syncDeck() {
  overlay?.setProps({ layers: buildDeckLayers() });
}

// Rotating and pitching the map is easy to do by accident and awkward to undo
// by hand, so offer one click back to north-up at the default tilt. Keeps the
// centre and zoom — this re-levels the camera, it doesn't move you.
function resetView() {
  if (!map) return;
  suppressFollowUntil = performance.now() + 700; // let the ease finish uninterrupted
  map.easeTo({ bearing: 0, pitch: DEFAULT_PITCH, duration: 500 });
}

// ── Map downloader ───────────────────────────────────────────────────────────

function enterDownloadMode() {
  if (!map || downloadMode.value) return;
  // Flatten while picking an area: dragging a rectangle on a tilted map draws
  // a trapezoid on screen, which makes the coverage genuinely hard to judge.
  // The tilt comes back on exit.
  map.easeTo({ pitch: 0, duration: 300 });
  follow.value = false;
  downloadMode.value = true;
  dlError.value = "";
  dlWarning.value = "";
  gotoText.value = "";
  gotoError.value = false;
  bboxSel.value = null;
  refreshSites().then(() => {
    if (!downloadMode.value) return;
    map.setMaxZoom(22);
    map.setStyle(makeStyle());
    map.once("idle", () => {
      refreshOverlays();
      syncDeck();
    });
    // Corner dragging stays armed for the whole of download mode; the handlers
    // no-op until a box exists.
    map.on("mousedown", onHandleDown);
    map.on("mouseenter", "draw-handle", onHandleEnter);
    map.on("mouseleave", "draw-handle", onHandleLeave);
  });
}

function exitDownloadMode({ restyle = true } = {}) {
  cleanupDrawHandlers();
  map?.easeTo({ pitch: DEFAULT_PITCH, duration: 300 }); // back to the flight view
  downloadMode.value = false;
  drawing.value = false;
  bboxSel.value = null;
  dlError.value = "";
  if (restyle) applySiteRestyle({ refit: true });
}

// Go-to-coordinates: decimal or DMS, e.g. 47°57'56.4"N 81°52'22.4"W.
function gotoCoords() {
  const parsed = parseCoords(gotoText.value);
  gotoError.value = !parsed;
  if (!parsed || !map) return;
  map.flyTo({
    center: [parsed.lon, parsed.lat],
    zoom: Math.max(map.getZoom(), 13),
    duration: 1200,
  });
}

// ── Area selection: draw once, then nudge the corners ────────────────────────
// bboxSel is the single source of truth and is updated on every mouse move, so
// the kilometre and tile readouts track the drag live — which is the only size
// reference available while dragging over featureless imagery.

const MIN_BBOX_DEG = 1e-5; // below this a drag was really a stray click

let drawStart = null;
let resizeAnchor = null; // the corner held fixed while its opposite is dragged

// The corner diagonally opposite each handle, i.e. the one that stays put.
const OPPOSITE_CORNER = {
  sw: ([w, s, e, n]) => ({ lng: e, lat: n }),
  se: ([w, s, e, n]) => ({ lng: w, lat: n }),
  ne: ([w, s, e, n]) => ({ lng: w, lat: s }),
  nw: ([w, s, e, n]) => ({ lng: e, lat: s }),
};

// Which diagonal a corner sits on, for the resize cursor.
const CORNER_DIAGONAL = { sw: "nesw", ne: "nesw", se: "nwse", nw: "nwse" };

function bboxFromCorners(a, b) {
  return [
    Math.min(a.lng, b.lng), Math.min(a.lat, b.lat),
    Math.max(a.lng, b.lng), Math.max(a.lat, b.lat),
  ];
}

function rectFromBbox([w, s, e, n]) {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
}

function handlesFromBbox([w, s, e, n]) {
  const corners = { sw: [w, s], se: [e, s], ne: [e, n], nw: [w, n] };
  return {
    type: "FeatureCollection",
    features: Object.entries(corners).map(([corner, coordinates]) => ({
      type: "Feature",
      properties: { corner },
      geometry: { type: "Point", coordinates },
    })),
  };
}

// Every write to the selection goes through here so the rectangle, the corner
// handles and the size readouts can never disagree. The rectangle stays drawn
// while locked — you still want to see the area being fetched — but the grab
// handles disappear, so "not resizable now" is visible, not just enforced.
function setSelection(bbox) {
  bboxSel.value = bbox;
  map?.getSource("draw-rect")?.setData(bbox ? rectFromBbox(bbox) : EMPTY_FC);
  map?.getSource("draw-handles")?.setData(
    bbox && !selectionLocked.value ? handlesFromBbox(bbox) : EMPTY_FC,
  );
}

// Show/hide the handles as the lock engages and releases.
watch(selectionLocked, (locked) => {
  if (!map) return;
  if (locked) {
    // Defensive: abandon a resize that is somehow still in flight.
    if (resizeAnchor) {
      map.off("mousemove", onHandleMove);
      window.removeEventListener("mouseup", onHandleUp);
      map.dragPan.enable();
      resizeAnchor = null;
    }
    hoverCorner.value = "";
  }
  const bbox = bboxSel.value;
  map.getSource("draw-handles")?.setData(
    bbox && !locked ? handlesFromBbox(bbox) : EMPTY_FC,
  );
});

function tooSmall(bbox) {
  return !bbox || bbox[2] - bbox[0] < MIN_BBOX_DEG || bbox[3] - bbox[1] < MIN_BBOX_DEG;
}

function startAreaSelect() {
  if (!map || drawing.value || selectionLocked.value) return;
  drawing.value = true;
  setSelection(null);
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
  setSelection(bboxFromCorners(drawStart, e.lngLat));
}

function onDrawUp() {
  map.off("mousemove", onDrawMove);
  map.dragPan.enable();
  map.getCanvas().style.cursor = "";
  drawing.value = false;
  if (tooSmall(bboxSel.value)) setSelection(null); // ignore accidental clicks
  drawStart = null;
}

// Corner dragging. Registered for the whole of download mode; it defers to the
// initial draw while that is in progress.
function onHandleDown(e) {
  if (drawing.value || selectionLocked.value || !bboxSel.value || !map) return;
  const hit = map.queryRenderedFeatures(e.point, { layers: ["draw-handle"] })[0];
  if (!hit) return;
  e.preventDefault();
  resizeAnchor = OPPOSITE_CORNER[hit.properties.corner]?.(bboxSel.value);
  if (!resizeAnchor) return;
  hoverCorner.value = hit.properties.corner; // hold the cursor for the drag
  map.dragPan.disable();
  map.on("mousemove", onHandleMove);
  window.addEventListener("mouseup", onHandleUp, { once: true });
}

function onHandleMove(e) {
  if (resizeAnchor) setSelection(bboxFromCorners(resizeAnchor, e.lngLat));
}

function onHandleUp() {
  if (!map) return;
  map.off("mousemove", onHandleMove);
  map.dragPan.enable();
  resizeAnchor = null;
  hoverCorner.value = "";
  if (tooSmall(bboxSel.value)) setSelection(null);
}

// Hover cursor is driven by a class rather than by setting canvas.style.cursor
// directly: MapLibre's drag-pan handler rewrites that inline style back to
// "grab" on the next mousemove, so the resize cursor never survived. A CSS
// rule marked !important outranks its inline style. (The crosshair during the
// initial draw is unaffected — dragPan is disabled then, so nothing fights it.)
function onHandleEnter(e) {
  if (drawing.value || resizeAnchor || selectionLocked.value) return;
  hoverCorner.value = e.features?.[0]?.properties?.corner ?? "";
}

function onHandleLeave() {
  if (resizeAnchor) return; // mid-drag the pointer often leaves the handle
  hoverCorner.value = "";
}

function cleanupDrawHandlers() {
  if (!map) return;
  map.off("mousedown", onDrawDown);
  map.off("mousemove", onDrawMove);
  map.off("mousedown", onHandleDown);
  map.off("mousemove", onHandleMove);
  map.off("mouseenter", "draw-handle", onHandleEnter);
  map.off("mouseleave", "draw-handle", onHandleLeave);
  window.removeEventListener("mouseup", onDrawUp);
  window.removeEventListener("mouseup", onHandleUp);
  drawStart = null;
  resizeAnchor = null;
  hoverCorner.value = "";
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

// Ground dimensions of the selection. Operators think in kilometres of drift
// and descent, not tile counts.
const KM_PER_DEG_LAT = 111.132;
const KM_PER_DEG_LON_EQUATOR = 111.320;

const bboxSizeText = computed(() => {
  if (!bboxSel.value) return "";
  const [w, s, e, n] = bboxSel.value;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const widthKm = (e - w) * KM_PER_DEG_LON_EQUATOR * Math.cos(midLat);
  const heightKm = (n - s) * KM_PER_DEG_LAT;
  const fmt = (km) => (km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString());
  return `${fmt(widthKm)} × ${fmt(heightKm)} km`;
});

// Everything still standing between the operator and a download, phrased as
// the action that clears it. This is the single source of truth for the
// Download button's disabled state so the button can never be greyed out for a
// reason the card isn't showing.
const downloadBlockers = computed(() => {
  const reasons = [];
  if (!isTauri()) reasons.push("Downloading is only available in the desktop app");
  if (!dlName.value.trim()) reasons.push("Name the site — it becomes the map's file name");
  if (!bboxSel.value) reasons.push("Select an area: click Select area, then drag a box on the map");
  if (dlMinZoom.value > dlMaxZoom.value) reasons.push("Set the first zoom no higher than the second");
  if (bboxSel.value && tileCount.value > MAX_TILES) {
    reasons.push(
      `Shrink the area or zoom range — ${tileCount.value.toLocaleString()} tiles is over the ${MAX_TILES.toLocaleString()} limit`,
    );
  }
  return reasons;
});

const canDownload = computed(() => !downloading.value && downloadBlockers.value.length === 0);

let pendingDownload = null; // { name, bbox, features } for the post-tile phase

async function startDownload() {
  if (!canDownload.value) return;
  dlError.value = "";
  dlWarning.value = "";
  dlProgress.value = null;
  dlRate.value = null;
  dlByteRate.value = null;
  rateSample = null;
  localStorage.setItem("qret-map-dl-features", String(dlFeatures.value));
  try {
    const name = dlName.value.trim();
    pendingDownload = { name, bbox: [...bboxSel.value], features: dlFeatures.value };
    await invoke("download_map_tiles", {
      name,
      bbox: bboxSel.value,
      minzoom: dlMinZoom.value,
      maxzoom: dlMaxZoom.value,
    });
    downloading.value = true;
  } catch (err) {
    pendingDownload = null;
    dlError.value = String(err);
    recheck(); // a failed start may mean we just went offline
  }
}

function cancelDownload() {
  invoke("cancel_map_download").catch(() => {});
}

// Throughput is derived from the gap between progress events rather than
// reported by Rust — the events already carry running counters, and smoothing
// here keeps the readout steady without extra IPC.
let rateSample = null; // { t, fetched, bytes }

const RATE_SMOOTHING = 0.3; // EMA weight on the newest sample

function updateRate(p) {
  const now = performance.now();
  const bytes = p.bytes ?? 0;
  if (!rateSample) {
    rateSample = { t: now, fetched: p.fetched, bytes };
    return;
  }
  const dt = (now - rateSample.t) / 1000;
  const dTiles = p.fetched - rateSample.fetched;
  const dBytes = bytes - rateSample.bytes;
  // Ignore sub-100ms gaps: the divisor gets small enough to make the estimate
  // jump around. Counters only ever grow, so a negative delta means a restart.
  if (dt < 0.1 || dTiles < 0 || dBytes < 0) return;
  const ema = (prev, instant) =>
    prev == null ? instant : prev + RATE_SMOOTHING * (instant - prev);
  dlRate.value = ema(dlRate.value, dTiles / dt);
  dlByteRate.value = ema(dlByteRate.value, dBytes / dt);
  rateSample = { t: now, fetched: p.fetched, bytes };
}

// Decimals only where they carry information: a data rate of "3.6 MB/s" is
// worth distinguishing from 4, a total of "161 MB" is not.
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 100e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${Math.round(n)} B`;
}

// Projected finished size, from the average tile size seen so far. Uses only
// tiles this run actually pulled — a resumed download's skipped tiles cost no
// bytes and would otherwise drag the average toward zero.
const dlProjectedBytes = computed(() => {
  const p = dlProgress.value;
  if (!p?.bytes) return null;
  const downloadedNow = p.fetched - (p.skipped ?? 0);
  if (downloadedNow < 25) return null; // too small a sample to extrapolate from
  return (p.bytes / downloadedNow) * p.total;
});

const dlEtaText = computed(() => {
  const p = dlProgress.value;
  if (!p || !dlRate.value || dlRate.value < 1) return "";
  const remaining = p.total - p.fetched;
  if (remaining <= 0) return "";
  const secs = remaining / dlRate.value;
  if (secs < 60) return `~${Math.ceil(secs)}s left`;
  if (secs < 3600) return `~${Math.round(secs / 60)} min left`;
  return `~${(secs / 3600).toFixed(1)} h left`;
});

// One line: volume so far (with projected total once it's meaningful), then
// data rate, tile rate and ETA.
const dlStatsText = computed(() => {
  const p = dlProgress.value;
  if (!p) return "";
  const parts = [];
  const projected = dlProjectedBytes.value;
  parts.push(
    projected
      ? `${formatBytes(p.bytes ?? 0)} of ~${formatBytes(projected)}`
      : formatBytes(p.bytes ?? 0),
  );
  if (dlByteRate.value) parts.push(`${formatBytes(dlByteRate.value)}/s`);
  if (dlRate.value) parts.push(`${Math.round(dlRate.value).toLocaleString()} tiles/s`);
  if (dlEtaText.value) parts.push(dlEtaText.value);
  return parts.join("  ·  ");
});

async function onDownloadProgress(event) {
  const p = event.payload;
  dlProgress.value = p;
  if (!p.done) {
    updateRate(p);
    return;
  }
  downloading.value = false;
  if (p.error) {
    pendingDownload = null;
    dlError.value = p.error;
    return; // keep the panel open so the operator sees it (incl. "cancelled")
  }

  // Tiles are in; optionally pull the OSM feature layer before wrapping up.
  const pending = pendingDownload;
  pendingDownload = null;
  if (pending?.features) {
    dlFeaturesPhase.value = true;
    dlFeaturesElapsed.value = 0;
    const tick = setInterval(() => { dlFeaturesElapsed.value += 1; }, 1000);
    try {
      const outcome = await fetchFeaturesBounded(pending.name, pending.bbox);
      if (outcome.abandoned) {
        dlWarning.value = abandonedMessage(outcome.abandoned, pending.name);
        console.warn(`[FlightPanel] ${pending.name}: feature fetch ${outcome.abandoned}`);
      } else {
        console.log(`[FlightPanel] ${pending.name}: ${outcome.count} OSM features saved`);
      }
    } catch (err) {
      // Non-fatal: the imagery is fine without the label layer.
      dlWarning.value = `Feature fetch failed — imagery saved. ${err}`;
      console.error("[FlightPanel] download_map_features failed:", err);
    } finally {
      clearInterval(tick);
      dlFeaturesPhase.value = false;
    }
  }

  // Make sure the new site is visible (it may have been hidden pre-redownload).
  const file = `${p.name}.mbtiles`;
  if (mapSitesDisabled.value.includes(file)) {
    mapSitesDisabled.value = mapSitesDisabled.value.filter((f) => f !== file);
  }
  if (dlWarning.value) {
    // Leave the card open so the warning is seen; refresh the borders behind it.
    await refreshSites();
    map?.setStyle(makeStyle());
  } else {
    exitDownloadMode({ restyle: true });
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
        label="Reset View"
        icon="pi pi-compass"
        size="small"
        severity="secondary"
        :disabled="downloadMode"
        title="Point the camera north again at the default tilt (keeps your position and zoom)"
        @click="resetView"
      />
      <Button
        label="Labels"
        icon="pi pi-tag"
        size="small"
        :severity="labelsOn ? 'primary' : 'secondary'"
        :title="downloadMode
          ? 'Place and road names over the online imagery'
          : (featureCount
              ? `${featureCount.toLocaleString()} offline map features (roads, lakes, parks), plus online names outside downloaded areas`
              : 'Online place names outside downloaded areas; no offline feature data for the visible sites yet')"
        @click="labelsOn = !labelsOn"
      />
      <Button
        v-if="sitesMissingFeatures.length && !downloadMode"
        :label="fetchingLabels ? 'Fetching…' : `Fetch labels (${sitesMissingFeatures.length})`"
        icon="pi pi-download"
        size="small"
        severity="warn"
        :disabled="!onlineActive || fetchingLabels"
        :title="!online ? 'Fetching place names needs an internet connection'
          : !liveImagery ? 'Simulating offline — turn live imagery back on to fetch'
          : `Download road/lake/park names for: ${sitesMissingFeatures.map((s) => s.name).join(', ')}`"
        @click="fetchMissingLabels"
      />
      <Button
        label="Download Maps"
        icon="pi pi-cloud-download"
        size="small"
        severity="secondary"
        :disabled="!onlineActive || downloading || downloadMode"
        :title="!online ? 'No internet connection — downloading tiles needs one'
                : !liveImagery ? 'Simulating offline — turn live imagery back on to download'
                : downloading ? 'A map download is already running'
                : downloadMode ? 'Already in download mode' : 'Download satellite tiles for offline use'"
        @click="enterDownloadMode"
      />
      <span v-if="!online" class="wifi-off" title="No internet connection">
        <i class="pi pi-wifi"></i>
      </span>
      <span v-if="siteSummary && !downloadMode" class="site-name">{{ siteSummary }}</span>
      <label
        v-if="online && !downloadMode"
        class="live-toggle"
        :class="{ simulating: !liveImagery }"
        :title="liveImagery
          ? 'Live imagery is filling in outside your downloaded areas. Switch off to rehearse how the map behaves with no connection.'
          : 'Simulating no connection: only downloaded tiles are drawn and the network-only actions are disabled. Your connection is untouched.'"
      >
        <ToggleSwitch v-model="liveImagery" class="live-switch" />
        <span>{{ liveImagery ? "+ live imagery" : "offline dry run" }}</span>
      </label>

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

      <Button
        :icon="paneOpen ? 'pi pi-angle-double-right' : 'pi pi-angle-double-left'"
        size="small"
        severity="secondary"
        text
        :title="paneOpen ? 'Hide rocket pane' : 'Show rocket pane'"
        @click="togglePane"
      />
    </div>

    <div class="map-row">
      <div
        class="map-wrap"
        :class="cursorClass"
        :style="{ '--pane-inset': paneOpen ? paneWidth + PANE_GAP * 2 + 'px' : '0px' }"
      >
        <div ref="mapEl" class="map-el"></div>

        <div v-if="!hasBasemap && !downloadMode" class="no-site-banner">
          No offline maps and no internet — use Download Maps when online
        </div>

        <div v-if="labelsError" class="labels-error" @click="labelsError = ''">
          {{ labelsError }} <span class="dismiss">(click to dismiss)</span>
        </div>

        <div v-if="downloadMode" class="download-card">
          <div class="dl-title">Download offline maps</div>

          <template v-if="!downloading && !dlFeaturesPhase">
            <div class="dl-section">
              <span class="dl-section-label">Find location</span>
              <div class="dl-row">
                <input
                  type="text"
                  v-model="gotoText"
                  class="dl-input"
                  :class="{ 'dl-input-error': gotoError }"
                  placeholder="47°57'56.4&quot;N 81°52'22.4&quot;W or 47.9657, -81.8729"
                  @keyup.enter="gotoCoords"
                />
                <Button label="Go" size="small" severity="secondary" @click="gotoCoords" />
              </div>
              <div v-if="gotoError" class="dl-error">Couldn't parse those coordinates</div>
            </div>

            <div class="dl-section">
              <span class="dl-section-label">New site</span>
              <input
                type="text"
                v-model="dlName"
                class="dl-input"
                placeholder="Site name — required (e.g. Timmins2026)"
              />
              <div class="dl-row">
                <label>Zoom</label>
                <input type="number" v-model.number="dlMinZoom" min="10" max="20" class="dl-input dl-zoom" />
                <span>to</span>
                <input type="number" v-model.number="dlMaxZoom" min="10" max="20" class="dl-input dl-zoom" />
              </div>
              <label class="dl-check">
                <Checkbox v-model="dlFeatures" :binary="true" />
                <span>Include OSM features (roads, lakes, parks)</span>
              </label>
              <Button
                :label="drawing ? 'Drag on the map…' : (bboxSel ? 'Redraw area' : 'Select area')"
                icon="pi pi-expand"
                size="small"
                :severity="bboxSel ? 'secondary' : 'primary'"
                :disabled="drawing"
                @click="startAreaSelect"
              />
              <div v-if="bboxSel" class="dl-estimate" :class="{ warn: tileCount > WARN_TILES }">
                <div class="dl-area-size">{{ bboxSizeText }}</div>
                {{ tileCount.toLocaleString() }} tiles, ~{{ estMB.toFixed(0) }} MB
                <template v-if="tileCount > MAX_TILES"> — too large, shrink the area/zoom</template>
              </div>
              <div v-if="bboxSel" class="dl-hint">
                Drag any corner handle to adjust — the size above updates as you go.
              </div>
              <div v-else class="dl-hint">
                Cover the pad plus worst-case drift and descent, not just the pad.
                Dashed boxes show what's already downloaded — nest a smaller,
                higher-zoom box inside a wide low-zoom one for detail where it counts.
              </div>
            </div>

            <div v-if="downloadBlockers.length" class="dl-blockers">
              <span class="dl-blockers-title">
                <i class="pi pi-info-circle"></i>Before you can download:
              </span>
              <ul>
                <li v-for="reason in downloadBlockers" :key="reason">{{ reason }}</li>
              </ul>
            </div>

            <div class="dl-actions">
              <Button label="Download" icon="pi pi-cloud-download" size="small"
                      :disabled="!canDownload" @click="startDownload" />
              <Button label="Close" size="small" severity="secondary"
                      @click="exitDownloadMode()" />
            </div>
            <div class="dl-tos">
              Imagery © Esri, features © OpenStreetMap contributors — internal team
              use only; do not redistribute downloaded tiles.
            </div>
          </template>

          <template v-else-if="downloading">
            <div class="dl-progress-text">
              {{ dlProgress ? `${dlProgress.fetched.toLocaleString()} / ${dlProgress.total.toLocaleString()} tiles`
                            : "Starting…" }}
              <span v-if="dlProgress?.failed" class="warn"> ({{ dlProgress.failed }} failed)</span>
            </div>
            <div v-if="dlStatsText" class="dl-progress-rate">{{ dlStatsText }}</div>
            <div class="dl-bar">
              <div class="dl-bar-fill"
                   :style="{ width: dlProgress ? (100 * dlProgress.fetched / dlProgress.total) + '%' : '0%' }"></div>
            </div>
            <Button label="Cancel Download" size="small" severity="danger" @click="cancelDownload" />
          </template>

          <template v-else>
            <div class="dl-progress-text">
              Fetching place names… {{ dlFeaturesElapsed }}s
            </div>
            <div class="dl-bar dl-bar-indeterminate"><div class="dl-bar-fill"></div></div>
            <div class="dl-hint">
              Querying OpenStreetMap for roads, lakes and parks — usually under
              15s. Your tiles are already saved either way.
            </div>
            <Button label="Skip place names" icon="pi pi-times" size="small"
                    severity="secondary" @click="skipFeatureFetch" />
          </template>

          <div v-if="dlWarning" class="dl-warning">{{ dlWarning }}</div>
          <div v-if="dlError" class="dl-error">{{ dlError }}</div>
        </div>
      </div>

      <template v-if="paneOpen">
        <div
          class="pane-resizer"
          :style="{ right: paneWidth + PANE_GAP * 2 + 'px' }"
          @mousedown="onPaneResizeDown"
        ></div>
        <RocketPane :style="{ width: paneWidth + 'px' }" class="pane-host" />
      </template>
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

.live-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

/* Amber while simulating, so a dry run is never mistaken for the real thing. */
.live-toggle.simulating {
  color: #e67e22;
  font-weight: 600;
}

.live-switch {
  --p-toggleswitch-width: 30px;
  --p-toggleswitch-height: 17px;
  --p-toggleswitch-handle-size: 11px;
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

/* The rocket pane floats over the map rather than sharing the row with it.
   Laying them out side by side meant every resize frame changed the map
   canvas width — MapLibre re-rendered on each one (visible flicker) and the
   view squeezed horizontally. Overlaying keeps the canvas a fixed size, so
   showing, hiding and dragging the pane never touch the map's scaling. */
.map-row {
  flex: 1;
  min-height: 0;
  position: relative;
}

.map-wrap {
  position: absolute;
  inset: 0;
  border-radius: 6px;
  overflow: hidden;
}

/* Keep the scale bar in the map's bottom-right corner but clear of the
   overlaying rocket pane, which would otherwise cover it. */
.map-wrap :deep(.maplibregl-ctrl-bottom-right) {
  margin-right: var(--pane-inset, 0px);
}

/* !important is required: MapLibre's drag-pan writes cursor:grab straight onto
   the canvas element, and an inline style loses only to an important rule. */
.map-wrap.corner-nesw :deep(.maplibregl-canvas) {
  cursor: nesw-resize !important;
}

.map-wrap.corner-nwse :deep(.maplibregl-canvas) {
  cursor: nwse-resize !important;
}

.pane-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  z-index: 5;
  cursor: col-resize;
  border-radius: 3px;
}

.pane-resizer:hover {
  background: var(--border-color);
}

.pane-host {
  position: absolute;
  top: 8px;
  right: 8px;
  bottom: 8px;
  z-index: 4;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
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
  width: 290px;
  max-height: calc(100% - 24px);
  overflow-y: auto;
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

.dl-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.dl-section-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
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
  min-width: 0;
}

.dl-input-error {
  border-color: #ff4d4d;
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

.dl-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: var(--text-secondary);
  cursor: pointer;
}

.dl-estimate {
  font-size: 0.82rem;
  color: var(--text-primary);
  font-family: monospace;
}

.dl-area-size {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
}

.labels-error {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 70%;
  background: var(--bg-surface);
  border: 1px solid #e67e22;
  border-radius: 6px;
  color: #e67e22;
  font-size: 0.8rem;
  padding: 8px 14px;
  cursor: pointer;
  z-index: 6;
}

.labels-error .dismiss {
  color: var(--text-muted);
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

.dl-blockers {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.dl-blockers-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--text-muted);
}

.dl-blockers ul {
  margin: 0;
  padding-left: 18px;
}

.dl-blockers li {
  margin: 2px 0;
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

.dl-progress-rate {
  font-size: 0.78rem;
  font-family: monospace;
  color: var(--text-muted);
  margin-top: -4px;
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

.dl-bar-indeterminate .dl-bar-fill {
  width: 40%;
  animation: dl-indeterminate 1.2s ease-in-out infinite alternate;
}

@keyframes dl-indeterminate {
  from { margin-left: 0; }
  to   { margin-left: 60%; }
}

.dl-warning {
  font-size: 0.8rem;
  color: #e67e22;
}

.dl-error {
  font-size: 0.8rem;
  color: #ff4d4d;
}
</style>
