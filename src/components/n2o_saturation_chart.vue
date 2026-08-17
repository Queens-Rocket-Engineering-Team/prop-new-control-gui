<script setup>
// The N2O saturation line with the tank's current operating point on it.
//
// Hand-rolled SVG rather than uplot_chart.vue: that component is wired to a
// relative-time x axis and a single series, it draws to canvas (which is why it
// hardcodes rgba(128,128,128,...) instead of theming), and everything
// interesting here - the marker, the two guides, the nodes where each guide
// crosses the curve - is a custom draw there and a one-line element here. The
// curve is static, so there is nothing for a plotting library to do.
//
// This SVG lives in PidDiagram's .overlay-layer, not its .svg-layer, so the
// aggressive `:deep(svg text) { fill: ... !important }` re-theming that
// PidDiagram applies to the drawio export does not reach it. Do not move it.
//
// Purely informational: no colour changes with the operating condition, no
// thresholds, no interaction. Colour marks identity (the curve is the pressure
// group's blue), never judgement.

import { computed } from 'vue'
import { saturationCurve, pSatFromT, tSatFromP, psigOf, psiaOf } from '../lib/n2oSaturation.js'

const props = defineProps({
  /** Tank temperature, degrees C. null when no thermistor is available. */
  tempC: { type: Number, default: null },
  /** Tank pressure, psig - GAUGE, as the stand reads it. */
  pressurePsig: { type: Number, default: null },

  // Frame. Covers the operating band rather than the whole saturation line:
  // triple-to-critical would squeeze everything interesting into the top fifth
  // of the box. Linear in P, not log, so the vertical gap between the marker
  // and the curve stays proportional to the psi number printed beside it.
  tMinC: { type: Number, default: -40 },
  tMaxC: { type: Number, default: 40 },
  pMin: { type: Number, default: 0 },
  pMax: { type: Number, default: 1050 }, // psig; the critical point is 1036.1

  width: { type: Number, default: 196 },
  height: { type: Number, default: 104 },
})

// 1 viewBox unit = 1 px, so stroke widths and font sizes are literal px and the
// card's `zoom` scales the whole thing uniformly.
const PAD = { l: 24, r: 6, t: 6, b: 13 }
const X_TICKS = [-40, -20, 0, 20, 40]
const Y_TICKS = [0, 250, 500, 750, 1000]

const plotW = computed(() => props.width - PAD.l - PAD.r)
const plotH = computed(() => props.height - PAD.t - PAD.b)
const right = computed(() => PAD.l + plotW.value)
const bottom = computed(() => PAD.t + plotH.value)

const xOf = (tC) => PAD.l + ((tC - props.tMinC) / (props.tMaxC - props.tMinC)) * plotW.value
const yOf = (p) => PAD.t + (1 - (p - props.pMin) / (props.pMax - props.pMin)) * plotH.value

// This chart is the one place that crosses the gauge/absolute seam in both
// directions: it draws an absolute NIST table on a gauge axis, and it asks that
// table questions about a gauge reading. Everything below the next two computeds
// is in psig.
const finite = (v) => (Number.isFinite(v) ? v : null)
const tempC = computed(() => finite(props.tempC))
const pressure = computed(() => finite(props.pressurePsig))

const inX = (tC) => tC >= props.tMinC && tC <= props.tMaxC
const inY = (p) => p >= props.pMin && p <= props.pMax
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

// Static: depends only on the frame, so it is built once and never rebuilt as
// telemetry ticks.
const curvePath = computed(() => {
  const pts = saturationCurve(props.tMinC, props.tMaxC)
  return pts
    .map(([t, p], i) => `${i ? 'L' : 'M'}${xOf(t).toFixed(2)} ${yOf(psigOf(p)).toFixed(2)}`)
    .join(' ')
})

const visibleTicksX = computed(() => X_TICKS.filter(inX))
const visibleTicksY = computed(() => Y_TICKS.filter(inY))

// Where each guide crosses the curve. The horizontal guide sits at constant
// pressure, so it meets the curve at T_sat(P); the vertical sits at constant
// temperature and meets it at P_sat(T). Drawing both means the gap between the
// marker and each node IS the deviation the card prints as text.
const satTempAtP = computed(() => (pressure.value == null ? null : tSatFromP(psiaOf(pressure.value))))
const satPressAtT = computed(() => (tempC.value == null ? null : psigOf(pSatFromT(tempC.value))))

const nodeAtP = computed(() => {
  const t = satTempAtP.value
  if (t == null || !inX(t) || !inY(pressure.value)) return null
  return { x: xOf(t), y: yOf(pressure.value) }
})

const nodeAtT = computed(() => {
  const p = satPressAtT.value
  if (p == null || !inY(p) || !inX(tempC.value)) return null
  return { x: xOf(tempC.value), y: yOf(p) }
})

const guideY = computed(() => (pressure.value == null ? null : yOf(clamp(pressure.value, props.pMin, props.pMax))))
const guideX = computed(() => (tempC.value == null ? null : xOf(clamp(tempC.value, props.tMinC, props.tMaxC))))

// The operating point needs both coordinates. Off-frame it clamps to the edge
// and becomes a chevron pointing the way it went, so it can never wander out of
// the box and imply a reading the frame does not cover.
const marker = computed(() => {
  if (tempC.value == null || pressure.value == null) return null
  const offX = !inX(tempC.value)
  const offY = !inY(pressure.value)
  return {
    x: clamp(xOf(tempC.value), PAD.l, right.value),
    y: clamp(yOf(pressure.value), PAD.t, bottom.value),
    off: offX || offY,
    // Chevron direction: up/down dominates, since pressure is the axis that
    // actually leaves the frame in practice (supercritical).
    dir: offY ? (pressure.value > props.pMax ? 'up' : 'down')
      : (tempC.value > props.tMaxC ? 'right' : 'left'),
  }
})

/** Chevron path at the frame edge, pointing out of the box. */
function chevron({ x, y, dir }) {
  const s = 3.2
  if (dir === 'up') return `M${x - s} ${y + s} L${x} ${y - s * 0.4} L${x + s} ${y + s}`
  if (dir === 'down') return `M${x - s} ${y - s} L${x} ${y + s * 0.4} L${x + s} ${y - s}`
  if (dir === 'right') return `M${x - s} ${y - s} L${x + s * 0.4} ${y} L${x - s} ${y + s}`
  return `M${x + s} ${y - s} L${x - s * 0.4} ${y} L${x + s} ${y + s}`
}

/** Dim the whole frame when there is nothing live to show. */
const idle = computed(() => tempC.value == null && pressure.value == null)
</script>

<template>
  <svg
    class="sat-chart"
    :class="{ idle }"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    role="img"
  >
    <title>Nitrous oxide saturation curve</title>

    <!-- Horizontal gridlines only: vertical ones would compete with the
         temperature guide, which is the line that carries meaning. -->
    <g class="grid">
      <line
        v-for="p in visibleTicksY"
        :key="`gy-${p}`"
        :x1="PAD.l" :x2="right" :y1="yOf(p)" :y2="yOf(p)"
      />
    </g>

    <g class="frame">
      <line :x1="PAD.l" :x2="right" :y1="bottom" :y2="bottom" />
      <line :x1="PAD.l" :x2="PAD.l" :y1="PAD.t" :y2="bottom" />
    </g>

    <g class="tick-label">
      <text
        v-for="t in visibleTicksX"
        :key="`tx-${t}`"
        :x="xOf(t)" :y="height - 4"
        text-anchor="middle"
      >{{ t }}</text>
      <text
        v-for="p in visibleTicksY"
        :key="`ty-${p}`"
        :x="PAD.l - 3" :y="yOf(p)"
        text-anchor="end" dominant-baseline="middle"
      >{{ p }}</text>
    </g>

    <path class="curve" :d="curvePath" />

    <!-- Guides span the frame rather than stopping at the marker: an operator
         reading a value off an axis needs the line to reach that axis. -->
    <line
      v-if="guideY != null"
      class="guide" :x1="PAD.l" :x2="right" :y1="guideY" :y2="guideY"
    />
    <line
      v-if="guideX != null"
      class="guide" :x1="guideX" :x2="guideX" :y1="PAD.t" :y2="bottom"
    />

    <circle v-if="nodeAtP" class="sat-node" :cx="nodeAtP.x" :cy="nodeAtP.y" r="2" />
    <circle v-if="nodeAtT" class="sat-node" :cx="nodeAtT.x" :cy="nodeAtT.y" r="2" />

    <template v-if="marker">
      <path v-if="marker.off" class="marker-off" :d="chevron(marker)" />
      <circle v-else class="marker" :cx="marker.x" :cy="marker.y" r="2.8" />
    </template>
  </svg>
</template>

<style scoped>
/* One source for every hairline. --border-color is unusable here: in dark mode
   it is #242424 on a #1c1c1c card. --text-muted reads in both themes, and
   opacity does the rest - the same approach PidDiagram uses for leader lines. */
.sat-chart {
  display: block;
  color: var(--text-muted);
  overflow: visible;
}

.sat-chart.idle {
  opacity: 0.55;
}

.grid line,
.frame line {
  stroke: currentColor;
  stroke-width: 0.75;
}

.grid line {
  opacity: 0.16;
}

.frame line {
  opacity: 0.34;
}

.tick-label text {
  fill: currentColor;
  opacity: 0.75;
  font-family: Inter, system-ui, sans-serif;
  font-size: 6.5px;
  font-variant-numeric: tabular-nums;
}

/* The pressure-transducer group colour from useSensorGroups.js, so the curve
   reads as the same "pressure" thing it does on the graph panel. Identity, not
   state - it never changes with the reading. */
.curve {
  fill: none;
  stroke: #3498db;
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.guide {
  stroke: currentColor;
  opacity: 0.55;
  stroke-width: 0.75;
  stroke-dasharray: 2 3;
}

.sat-node {
  fill: none;
  stroke: #3498db;
  stroke-width: 1;
}

.marker {
  fill: var(--bg-secondary);
  stroke: var(--text-primary);
  stroke-width: 1.25;
}

.marker-off {
  fill: none;
  stroke: var(--text-primary);
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-linecap: round;
}
</style>
