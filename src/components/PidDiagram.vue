<script setup>
import { ref, watch, onMounted } from 'vue'
import { usePidOverlay } from '../composables/usePidOverlay.js'

const emit = defineEmits(['cells-parsed'])

const props = defineProps({
  /** Path to SVG served from /public, e.g. '/Launch-P&ID.svg' */
  svgUrl: { type: String, required: true },
  /** Map of pipe element IDs → flow state booleans */
  pipeFlowStates: { type: Object, default: () => ({}) },
  /** Map of element IDs → CSS color strings (applied as fill) */
  elementColors:  { type: Object, default: () => ({}) },
})

const containerRef = ref(null)
const svgContent   = ref('')
const loading      = ref(true)
const error        = ref(null)

// Parsed mxfile geometry — fed into the overlay composable
const pidCells = ref({})             // { [id]: { x, y, w, h } }
const viewBox  = ref({ width: 1466, height: 952 })  // updated from SVG

const { positionOf, positionBeside } = usePidOverlay(containerRef, pidCells, viewBox)

// ─── mxfile parsing ────────────────────────────────────────────────────────
// drawio embeds the diagram data as mxfile XML in the SVG's `content`
// attribute.  The rendered SVG elements carry no semantic IDs, so we read
// cell positions directly from mxGeometry instead of querying the DOM.

function parsePidCells(svgText) {
  // Parse as XML so DOMParser decodes &lt; &gt; &quot; etc. in attributes
  const svgDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  if (svgDoc.querySelector('parsererror')) {
    console.warn('[PidDiagram] SVG XML parse error')
    return
  }

  const svgEl = svgDoc.documentElement

  // Update viewBox
  const vb = (svgEl.getAttribute('viewBox') || '0 0 1466 952').trim().split(/\s+/).map(Number)
  viewBox.value = { width: vb[2] ?? 1466, height: vb[3] ?? 952 }

  // getAttribute() returns the decoded content string (entities resolved)
  const content = svgEl.getAttribute('content')
  if (!content) {
    console.warn('[PidDiagram] SVG has no mxfile content attribute')
    return
  }

  // Parse the mxfile XML
  const mxDoc = new DOMParser().parseFromString(content, 'text/xml')
  if (mxDoc.querySelector('parsererror')) {
    console.warn('[PidDiagram] mxfile XML parse error')
    return
  }

  // ── Pass 1: read raw geometry + parent for every cell ──────────────────
  // Some shapes (especially custom library shapes) are stored as children of
  // a container/group cell. Their mxGeometry x/y are RELATIVE to the parent,
  // not the SVG root. We need to walk the parent chain to get absolute coords.
  const raw = {}   // { [id]: { x, y, w, h, parent, isEdge } }

  for (const el of mxDoc.querySelectorAll('[id]')) {
    const id = el.getAttribute('id')
    if (!id) continue

    const geo = el.querySelector('mxGeometry')
    if (!geo) continue

    // The mxCell child carries the parent/edge attributes when the element
    // is an <object> wrapper; fall back to the element's own attributes.
    let mxCellChild = null
    for (const child of el.children) {
      if (child.tagName === 'mxCell') { mxCellChild = child; break }
    }

    const parent = mxCellChild?.getAttribute('parent')
                ?? el.getAttribute('parent')
                ?? '1'

    const isEdge = (mxCellChild?.getAttribute('edge') ?? el.getAttribute('edge')) === '1'

    raw[id] = {
      x: parseFloat(geo.getAttribute('x')      ?? '0'),
      y: parseFloat(geo.getAttribute('y')      ?? '0'),
      w: parseFloat(geo.getAttribute('width')  ?? '0'),
      h: parseFloat(geo.getAttribute('height') ?? '0'),
      parent,
      isEdge,
    }
  }

  // ── Pass 2: resolve absolute position by walking the parent chain ───────
  const absCache = {}
  function resolveAbs(id, depth = 0) {
    if (id === '1' || id === '0' || depth > 20) return { x: 0, y: 0 }
    if (absCache[id]) return absCache[id]
    const cell = raw[id]
    if (!cell) return { x: 0, y: 0 }
    if (cell.parent === '1' || cell.parent === '0') {
      return (absCache[id] = { x: cell.x, y: cell.y })
    }
    const parentAbs = resolveAbs(cell.parent, depth + 1)
    return (absCache[id] = { x: cell.x + parentAbs.x, y: cell.y + parentAbs.y })
  }

  // ── Pass 3: build the final map — only named vertex cells ───────────────
  const cells = {}
  for (const [id, cell] of Object.entries(raw)) {
    if (id === '0' || id === '1') continue
    if (cell.isEdge) continue
    if (cell.w === 0 || cell.h === 0) continue

    const abs = resolveAbs(id)
    cells[id] = { x: abs.x, y: abs.y, w: cell.w, h: cell.h }
  }

  console.debug('[PidDiagram] parsed cells:', Object.keys(cells))
  pidCells.value = cells
  emit('cells-parsed', cells)
}

// ─── SVG loading ────────────────────────────────────────────────────────────

async function loadSvg() {
  loading.value = true
  error.value   = null
  try {
    const res = await fetch(props.svgUrl)
    if (!res.ok) throw new Error(`Failed to load SVG: ${res.status}`)
    const text = await res.text()
    svgContent.value = text
    parsePidCells(text)
  } catch (e) {
    error.value = e.message
    loading.value = false
    return
  }
  loading.value = false
}

// ─── Pipe flow animation & element coloring ─────────────────────────────────
// These target rendered SVG elements by class/id after the SVG is in the DOM.
// They are best-effort: if a rendered element's id doesn't exist in the DOM,
// they silently no-op. (drawio rendered elements may not carry semantic IDs)

function syncFlowStates() {
  const container = containerRef.value
  if (!container) return
  for (const [id, isFlowing] of Object.entries(props.pipeFlowStates)) {
    container.querySelector(`#${CSS.escape(id)}`)
      ?.classList.toggle('pipe-flowing', isFlowing)
  }
}

function syncColors() {
  const container = containerRef.value
  if (!container) return
  for (const [id, color] of Object.entries(props.elementColors)) {
    const el = container.querySelector(`#${CSS.escape(id)}`)
    if (el) el.style.fill = color
  }
}

watch(() => props.svgUrl,         loadSvg)
watch(() => props.pipeFlowStates, syncFlowStates, { deep: true })
watch(() => props.elementColors,  syncColors,      { deep: true })

onMounted(loadSvg)
</script>

<template>
  <div class="pid-diagram" ref="containerRef">
    <div v-if="loading" class="pid-status">Loading diagram…</div>
    <div v-else-if="error" class="pid-status pid-error">{{ error }}</div>
    <div v-else class="svg-layer" v-html="svgContent" />

    <div class="overlay-layer">
      <slot :position-of="positionOf" :position-beside="positionBeside" />
    </div>
  </div>
</template>

<style scoped>
.pid-diagram {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.pid-status {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 14px;
  color: var(--text-muted);
}

.pid-error { color: #e74c3c; }

.svg-layer { width: 100%; height: 100%; }

.svg-layer :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

/* ── Recolor the draw.io SVG to follow the app's theme ─────────────────────
   draw.io exports use three coloring mechanisms we must handle:
   1. fill/stroke as HTML attributes  (e.g. fill="#000000")
   2. fill/stroke via inline style using light-dark() CSS fn
      — these resolve correctly once we set color-scheme on <html>
        (settings_modal.vue sets document.documentElement.style.colorScheme)
   3. Text labels via <foreignObject><div> with color: light-dark(...)
      — overridden below as a belt-and-suspenders fix
   ─────────────────────────────────────────────────────────────────────── */

.svg-layer :deep(svg) {
  background: transparent !important;
}

/* White background rects (attribute-based) */
.svg-layer :deep(svg rect[fill="#ffffff"]),
.svg-layer :deep(svg rect[fill="rgb(255, 255, 255)"]),
.svg-layer :deep(svg rect[fill="white"]) {
  fill: var(--bg-primary) !important;
}

/* Native SVG text elements */
.svg-layer :deep(svg text),
.svg-layer :deep(svg tspan) {
  fill: var(--text-primary) !important;
}

/* Text labels inside foreignObject (draw.io HTML label format) */
.svg-layer :deep(foreignObject div),
.svg-layer :deep(foreignObject span),
.svg-layer :deep(foreignObject p) {
  color: var(--text-primary) !important;
}

/* Strokes (attribute-based and inline-style — !important wins over both) */
.svg-layer :deep(svg path),
.svg-layer :deep(svg line),
.svg-layer :deep(svg polyline),
.svg-layer :deep(svg polygon),
.svg-layer :deep(svg circle),
.svg-layer :deep(svg ellipse),
.svg-layer :deep(svg rect) {
  stroke: var(--text-primary) !important;
}

/* Filled shapes with explicit fill attribute (not "none") */
.svg-layer :deep(svg path[fill]:not([fill="none"])),
.svg-layer :deep(svg polygon[fill]:not([fill="none"])),
.svg-layer :deep(svg circle[fill]:not([fill="none"])),
.svg-layer :deep(svg ellipse[fill]:not([fill="none"])),
.svg-layer :deep(svg rect[fill]:not([fill="none"]):not([fill="#ffffff"])) {
  fill: var(--text-primary) !important;
}

.overlay-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.overlay-layer :deep(.pid-overlay) {
  pointer-events: auto;
}

/* Pipe flow animation */
@keyframes pid-flow {
  to { stroke-dashoffset: -18; }
}
.svg-layer :deep(.pipe-flowing),
.svg-layer :deep(.pipe-flowing) path,
.svg-layer :deep(.pipe-flowing) line {
  stroke-dasharray: 12 6;
  animation: pid-flow 0.8s linear infinite;
}
</style>
