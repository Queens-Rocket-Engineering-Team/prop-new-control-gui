import { ref, computed, onMounted, onUnmounted } from 'vue'

/**
 * Computes screen-space overlay positions from drawio mxGeometry cell data.
 *
 * Instead of querying rendered SVG DOM elements (which carry no IDs in
 * drawio's export format), this uses the mxGeometry coordinates parsed
 * directly from the mxfile embedded in the SVG, scaled to screen pixels
 * via the container dimensions and SVG viewBox.
 *
 * Overlay cards are far larger than the P&ID symbols they annotate, so in
 * dense areas their preferred positions collide and one card hides another's
 * readout. `refreshLayout()` measures the rendered cards, displaces any that
 * overlap into nearby free space, and emits a leader line back to the symbol
 * so a displaced card can't be misread as belonging to its new neighbour.
 *
 * @param {Ref<HTMLElement>} containerRef - the .pid-diagram wrapper element
 * @param {Ref<Object>}      cells        - { [cellId]: { x, y, w, h } }
 * @param {Ref<Object>}      viewBox      - { width, height } from SVG viewBox
 */
export function usePidOverlay(containerRef, cells, viewBox) {
  const containerSize = ref({ width: 0, height: 0 })
  const leaderLines = ref([])          // [{ x1, y1, x2, y2 }] in container px
  let resizeObserver = null
  let mutationObserver = null
  let frame = 0

  function updateSize() {
    const el = containerRef.value
    if (!el) return
    const r = el.getBoundingClientRect()
    containerSize.value = { width: r.width, height: r.height }
    scheduleLayout()
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

  // Displacement is applied on top of the anchor-relative transform, so the
  // preferred position stays declarative and refreshLayout() only has to set
  // two custom properties (which Vue's style binding leaves alone).
  const NUDGE = 'translate(var(--pid-nudge-x, 0px), var(--pid-nudge-y, 0px))'

  /** Centers an overlay on the cell. */
  function positionOf(cellId) {
    const p = _pos(cellId)
    if (!p) return { display: 'none' }
    return {
      position: 'absolute',
      left: `${p.cx}px`,
      top: `${p.cy}px`,
      transform: `translate(-50%, -50%) ${NUDGE}`,
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
    return {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      transform: `${transform} ${NUDGE}`,
    }
  }

  // ─── Collision resolution ──────────────────────────────────────────────

  const PAD = 4        // keep a small gutter between cards
  // Fine steps so a card settles at the *nearest* clear spot rather than
  // jumping past it — displacement is what makes a label hard to attribute.
  const RADII = Array.from({ length: 25 }, (_, i) => 6 + i * 6)
  const ANGLES = Array.from({ length: 24 }, (_, i) => i * 15)
  const V_BIAS = 1.4     // vertical travel costs a little more than horizontal
  const SIDE_GAP = 8     // matches the gap the cards are rendered with

  const overlaps = (a, b) =>
    a.x - PAD < b.x + b.w && a.x + a.w + PAD > b.x &&
    a.y - PAD < b.y + b.h && a.y + a.h + PAD > b.y

  /** Total area `r` hides of already-placed cards. */
  function hiddenArea(r, placed) {
    let total = 0
    for (const p of placed) {
      const ox = Math.min(r.x + r.w, p.x + p.w) - Math.max(r.x, p.x)
      const oy = Math.min(r.y + r.h, p.y + p.h) - Math.max(r.y, p.y)
      if (ox > 0 && oy > 0) total += ox * oy
    }
    return total
  }

  /**
   * The four placements flush against a symbol. All read as belonging to it
   * just as clearly as the requested one, so switching sides beats sliding the
   * card off into open space — it stays attached and needs no leader line.
   */
  function sidesAround(p, w, h) {
    return [
      { x: p.cx - w / 2,            y: p.cy - p.hh - SIDE_GAP - h },  // top
      { x: p.cx + p.hw + SIDE_GAP,  y: p.cy - h / 2 },                // right
      { x: p.cx - p.hw - SIDE_GAP - w, y: p.cy - h / 2 },             // left
      { x: p.cx - w / 2,            y: p.cy + p.hh + SIDE_GAP },      // bottom
    ].map((s) => ({ ...s, w, h }))
  }

  /** Nearest point on a rect's border to an external point — the line endpoint. */
  function edgePoint(rect, from) {
    const cx = rect.x + rect.w / 2
    const cy = rect.y + rect.h / 2
    const dx = from.x - cx
    const dy = from.y - cy
    if (!dx && !dy) return { x: cx, y: cy }
    // Scale the direction vector until it lands on the rect boundary.
    const sx = dx ? rect.w / 2 / Math.abs(dx) : Infinity
    const sy = dy ? rect.h / 2 / Math.abs(dy) : Infinity
    const s = Math.min(sx, sy)
    return { x: cx + dx * s, y: cy + dy * s }
  }

  function refreshLayout() {
    const root = containerRef.value
    if (!root) return

    const host = root.getBoundingClientRect()
    const els = [...root.querySelectorAll('[data-pid-cell]')]
    if (!els.length) {
      if (leaderLines.value.length) leaderLines.value = []
      return
    }

    // Clear previous displacement so measurements reflect preferred positions.
    for (const el of els) {
      el.style.setProperty('--pid-nudge-x', '0px')
      el.style.setProperty('--pid-nudge-y', '0px')
    }

    const items = []
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      items.push({
        el,
        cellId: el.dataset.pidCell,
        pinned: el.dataset.pidPinned !== undefined,
        anchor: _pos(el.dataset.pidCell),
        x: r.left - host.left,
        y: r.top - host.top,
        w: r.width,
        h: r.height,
      })
    }

    // Cards with an explicit side hint go down first and keep it — the layout
    // shouldn't second-guess a placement someone chose deliberately. After
    // those, larger cards carry the most state, so they hold their preferred
    // spot and push the smaller name plates aside.
    items.sort((a, b) => (b.pinned - a.pinned) || (b.w * b.h - a.w * a.h))

    // The P&ID symbols are obstacles too — a card parked on a valve icon hides
    // the very thing it annotates. Oversized cells (groups, section headings)
    // would blanket the canvas and leave nowhere to go, so they're excluded.
    // Pipe runs are exempt: covering a line costs the operator nothing next to
    // dragging a card further from the component it belongs to.
    const symbols = []
    const maxCell = host.width * host.height * 0.15
    for (const [id, cell] of Object.entries(cells.value ?? {})) {
      if (cell.isPiping) continue
      const p = _pos(id)
      if (!p) continue
      const w = p.hw * 2
      const h = p.hh * 2
      if (!w || !h || w * h > maxCell) continue
      symbols.push({ id, x: p.cx - p.hw, y: p.cy - p.hh, w, h })
    }

    const placed = []
    const lines = []

    for (const it of items) {
      let dx = 0
      let dy = 0
      let detached = false

      // A card may sit on the symbol it labels — that reads as belonging to it,
      // which is why tank name plates are fine centred on their tank.
      const blockers = symbols.filter((s) => s.id !== it.cellId)
      // Burying another card's readout is worse than covering a symbol.
      const hiddenOf = (r) => hiddenArea(r, placed) * 1000 + hiddenArea(r, blockers) * 200

      // An explicit side hint is a decision, not a suggestion: honour it as-is.
      // Pinned cards are laid down first, so everything else routes around them.
      if (!it.pinned
          && (placed.some((p) => overlaps(it, p)) || blockers.some((s) => overlaps(it, s)))) {
        const clampX = (v) => Math.max(0, Math.min(v, Math.max(0, host.width - it.w)))
        const clampY = (v) => Math.max(0, Math.min(v, Math.max(0, host.height - it.h)))
        // Process flow runs left-to-right, so a card shifted sideways stays on
        // its own pipe run; lifting it off that line is what makes an operator
        // trace the wrong row. Vertical travel is charged a little more.
        const distOf = (r) => Math.hypot(r.x - it.x, (r.y - it.y) * V_BIAS)

        let target = { x: it.x, y: it.y, w: it.w, h: it.h }
        let hidden = hiddenOf(target)

        // Step 1 — try the symbol's other faces. Cards centred on their own
        // symbol (tank plates) have no meaningful sides, so they're left alone.
        const centred = it.anchor
          && Math.abs(it.x + it.w / 2 - it.anchor.cx) < 4
          && Math.abs(it.y + it.h / 2 - it.anchor.cy) < 4

        // A face that's already clear is kept as-is, so the side the caller
        // asked for (including any per-card hint) survives untouched.
        if (it.anchor && !centred && hidden > 0) {
          // Rank faces the same way as everything else — least hidden, then
          // least (vertically-biased) travel — so a clear side face wins over
          // the big vertical hop to the top face.
          let bestDist = distOf(target)
          for (const s of sidesAround(it.anchor, it.w, it.h)) {
            const cand = { x: clampX(s.x), y: clampY(s.y), w: it.w, h: it.h }
            const h2 = hiddenOf(cand)
            const d2 = distOf(cand)
            if (h2 < hidden || (h2 === hidden && d2 < bestDist)) {
              target = cand
              hidden = h2
              bestDist = d2
            }
          }
        }

        // Step 2 — only if no face is clear, slide to the nearest open spot.
        // This is the only case that earns a leader line: the card is no longer
        // touching its symbol, so the link has to be drawn.
        if (hidden > 0) {
          detached = true
          const from = target
          let best = { x: from.x, y: from.y, hidden, dist: distOf(from) }
          for (const r of RADII) {
            for (const deg of ANGLES) {
              const rad = (deg * Math.PI) / 180
              const cand = {
                x: clampX(from.x + Math.cos(rad) * r),
                y: clampY(from.y - Math.sin(rad) * r),
                w: it.w,
                h: it.h,
              }
              const scored = { x: cand.x, y: cand.y, hidden: hiddenOf(cand), dist: distOf(cand) }
              if (scored.hidden < best.hidden
                  || (scored.hidden === best.hidden && scored.dist < best.dist)) best = scored
            }
            if (best.hidden === 0) break
          }
          target = { x: best.x, y: best.y, w: it.w, h: it.h }
        }

        dx = target.x - it.x
        dy = target.y - it.y
      }

      const rect = { x: it.x + dx, y: it.y + dy, w: it.w, h: it.h }
      placed.push(rect)

      if (dx || dy) {
        it.el.style.setProperty('--pid-nudge-x', `${Math.round(dx)}px`)
        it.el.style.setProperty('--pid-nudge-y', `${Math.round(dy)}px`)
        if (detached && it.anchor) {
          const tip = edgePoint(rect, { x: it.anchor.cx, y: it.anchor.cy })
          lines.push({ x1: it.anchor.cx, y1: it.anchor.cy, x2: tip.x, y2: tip.y })
        }
      }
    }

    leaderLines.value = lines
  }

  // Card widths change with live telemetry (e.g. "—" → "1013.4"), so re-run
  // the pass whenever overlay content changes, coalesced to one per frame.
  function scheduleLayout() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      refreshLayout()
    })
  }

  onMounted(() => {
    updateSize()
    resizeObserver = new ResizeObserver(updateSize)
    if (containerRef.value) {
      resizeObserver.observe(containerRef.value)
      // childList/characterData only — watching attributes would re-fire on
      // the --pid-nudge writes above and spin.
      mutationObserver = new MutationObserver(scheduleLayout)
      mutationObserver.observe(containerRef.value, {
        childList: true,
        characterData: true,
        subtree: true,
      })
    }
  })

  onUnmounted(() => {
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    if (frame) cancelAnimationFrame(frame)
  })

  return { positionOf, positionBeside, leaderLines, refreshLayout }
}
