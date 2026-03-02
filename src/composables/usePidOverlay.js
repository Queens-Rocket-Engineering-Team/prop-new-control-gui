import { ref, computed, onMounted, onUnmounted } from 'vue'

/**
 * Computes screen-space overlay positions from drawio mxGeometry cell data.
 *
 * Instead of querying rendered SVG DOM elements (which carry no IDs in
 * drawio's export format), this uses the mxGeometry coordinates parsed
 * directly from the mxfile embedded in the SVG, scaled to screen pixels
 * via the container dimensions and SVG viewBox.
 *
 * @param {Ref<HTMLElement>} containerRef - the .pid-diagram wrapper element
 * @param {Ref<Object>}      cells        - { [cellId]: { x, y, w, h } }
 * @param {Ref<Object>}      viewBox      - { width, height } from SVG viewBox
 */
export function usePidOverlay(containerRef, cells, viewBox) {
  const containerSize = ref({ width: 0, height: 0 })
  let resizeObserver = null

  function updateSize() {
    const el = containerRef.value
    if (!el) return
    const r = el.getBoundingClientRect()
    containerSize.value = { width: r.width, height: r.height }
  }

  // Scale factor + letterbox offsets, respecting SVG default
  // preserveAspectRatio="xMidYMid meet"
  const xform = computed(() => {
    const { width: cw, height: ch } = containerSize.value
    const { width: vw, height: vh } = viewBox.value
    if (!cw || !ch || !vw || !vh) return { scale: 1, ox: 0, oy: 0 }
    const scale = Math.min(cw / vw, ch / vh)
    return {
      scale,
      ox: (cw - vw * scale) / 2,   // horizontal letterbox offset
      oy: (ch - vh * scale) / 2,   // vertical letterbox offset
    }
  })

  function _pos(cellId) {
    const cell = cells.value?.[cellId]
    if (!cell) return null
    const { scale, ox, oy } = xform.value
    return {
      cx: ox + (cell.x + cell.w / 2) * scale,
      cy: oy + (cell.y + cell.h / 2) * scale,
      hw: (cell.w / 2) * scale,
      hh: (cell.h / 2) * scale,
    }
  }

  /** Centers an overlay on the cell. */
  function positionOf(cellId) {
    const p = _pos(cellId)
    if (!p) return { display: 'none' }
    return {
      position: 'absolute',
      left: `${p.cx}px`,
      top: `${p.cy}px`,
      transform: 'translate(-50%, -50%)',
    }
  }

  /**
   * Positions an overlay flush against one side of the cell.
   * @param {'right'|'left'|'top'|'bottom'} side
   * @param {number} gap  pixel gap between cell edge and overlay
   */
  function positionBeside(cellId, side = 'right', gap = 10) {
    const p = _pos(cellId)
    if (!p) return { display: 'none' }

    const pl = {
      right:  { left: p.cx + p.hw + gap, top: p.cy,           transform: 'translate(0, -50%)'    },
      left:   { left: p.cx - p.hw - gap, top: p.cy,           transform: 'translate(-100%, -50%)' },
      top:    { left: p.cx,              top: p.cy - p.hh - gap, transform: 'translate(-50%, -100%)' },
      bottom: { left: p.cx,              top: p.cy + p.hh + gap, transform: 'translate(-50%, 0)'     },
    }
    const { left, top, transform } = pl[side] ?? pl.right
    return { position: 'absolute', left: `${left}px`, top: `${top}px`, transform }
  }

  onMounted(() => {
    updateSize()
    resizeObserver = new ResizeObserver(updateSize)
    if (containerRef.value) resizeObserver.observe(containerRef.value)
  })

  onUnmounted(() => resizeObserver?.disconnect())

  return { positionOf, positionBeside }
}
