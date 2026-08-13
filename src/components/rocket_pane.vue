<script setup>
import { computed, inject, ref } from "vue";
import PidDiagram from "./PidDiagram.vue";

// Right-hand companion pane for the flight panel: the rocket diagram with a
// live online/offline card over each avionics board, plus GPS/flight readouts.
// Collapsing/resizing is owned by the parent flight panel.

const { currentFix, vspeed, phase } = inject("flightTrack");
const sensorData = inject("sensorData", ref({}));
const devices = inject("devices", ref([]));

const altUnit = computed(() => sensorData.value?.Alt?.unit ?? "m");

// ── Board status ────────────────────────────────────────────────────────────
// The diagram tags each avionics board with a BOARD-<NAME> drawio id whose
// suffix is exactly the telemetry stream name the ground station publishes for
// that board (group `rocket_nodes`): 1 alive, 0 dead, -1 no LoRa link yet.
// Deriving the list from the parsed cells rather than hardcoding it means
// naming another board in the drawio file is all it takes to get a card.

const ROCKET_SVG = "/Rocket-Diagrams/Chimera_Diagram.drawio.svg";
const NODE_GROUP = "rocket_nodes";
const GROUND_STATION = "GREG";

const boards = ref([]); // [{ id: 'BOARD-UCM', name: 'UCM' }, ...]

function onCellsParsed(cells) {
  boards.value = Object.keys(cells)
    .filter((id) => id.toUpperCase().startsWith("BOARD-"))
    .map((id) => ({ id, name: id.slice("BOARD-".length) }));
}

// These readings are relayed by the ground station, so when it drops the values
// simply stop arriving and latch at whatever they last were — five green LEDs
// would sit there indefinitely. No per-stream receive time is comparable to
// local time (lastSourceT is device-clock), so gate on the device record, which
// /ws/state keeps authoritative and never evicts.
const gsLive = computed(() =>
  devices.value.some((d) => d.name === GROUND_STATION && d.connected !== false),
);

function boardState(name) {
  if (!gsLive.value) return "unknown";
  // Exact-case key plus a group check: the stream map is flat and the ground
  // station also publishes `Alt` (altitude, m) alongside `ALT` (altimeter
  // board). Requiring the group makes a case near-miss impossible, not just
  // unlikely.
  const stream = sensorData.value?.[name];
  if (!stream || stream.sensorType !== NODE_GROUP) return "unknown";
  if (stream.value === 1) return "online";
  if (stream.value === 0) return "offline";
  return "unknown"; // -1 — nothing heard over LoRa yet
}

const BOARD_LABELS = {
  online: "ONLINE",
  offline: "OFFLINE",
  unknown: "UNKNOWN",
};

const PHASE_LABELS = {
  pad: "On pad",
  ascent: "Ascent",
  drogue: "Drogue descent",
  main: "Main descent",
  landed: "Landed",
};

const phaseLabel = computed(() => PHASE_LABELS[phase.value] ?? "—");

function fmt(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}
</script>

<template>
  <div class="rocket-pane">
    <div class="pane-title">Rocket</div>

    <div class="diagram-slot">
      <PidDiagram :svg-url="ROCKET_SVG" @cells-parsed="onCellsParsed">
        <template #default="{ positionBeside }">
          <!-- Pinned: the boards sit ~15px apart, close enough that letting the
               overlay solver displace these would produce a ragged column. -->
          <div
            v-for="board in boards"
            :key="board.id"
            :style="positionBeside(board.id, 'right', 8)"
            :data-pid-cell="board.id"
            data-pid-pinned
            class="pid-overlay board-card"
            :title="`${board.name} — ${BOARD_LABELS[boardState(board.name)]}`"
          >
            <span class="board-led" :class="`board-${boardState(board.name)}`" />
            <span class="board-name">{{ board.name }}</span>
          </div>
        </template>
      </PidDiagram>
    </div>

    <div class="cards">
      <div class="card card-wide">
        <div class="card-label">Flight phase</div>
        <div class="card-value" :class="'phase-' + (phase ?? 'none')">{{ phaseLabel }}</div>
      </div>

      <div class="card">
        <div class="card-label">Altitude</div>
        <div class="card-value">
          {{ fmt(currentFix?.alt) }}<span class="card-unit">{{ altUnit }}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-label">Vert. speed</div>
        <div class="card-value">
          {{ fmt(vspeed, 1) }}<span class="card-unit">{{ altUnit }}/s</span>
        </div>
      </div>

      <div class="card card-wide">
        <div class="card-label">Position</div>
        <div class="card-value card-mono">
          <template v-if="currentFix">
            {{ currentFix.lat.toFixed(6) }}<br />{{ currentFix.lon.toFixed(6) }}
          </template>
          <template v-else>no fix</template>
        </div>
      </div>

      <div class="card">
        <div class="card-label">Satellites</div>
        <div class="card-value">{{ currentFix?.sats ?? "—" }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rocket-pane {
  /* No height here: the flight panel positions this pane absolutely over the
     map and its top/bottom offsets define the box. */
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.pane-title {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* Grows to fill whatever vertical space the pane has. The diagram is far
   taller than it is wide, so usePidOverlay's min(cw/vw, ch/vh) scale is
   height-bound at every pane width the flight panel allows — meaning height is
   what actually sets the diagram's size. The min-height is a legibility floor:
   below it the four upper boards close to within a few pixels of each other and
   their cards can no longer sit beside them, so the pane scrolls
   (overflow-y: auto) rather than compressing further. */
.diagram-slot {
  flex: 1;
  min-height: 420px;
  overflow: hidden;
}

/* ── Board status cards ── */

.board-card {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 1px 4px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  font-size: 8px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
}

.board-name {
  color: var(--text-secondary);
  letter-spacing: 0.03em;
}

.board-led {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background 0.2s, box-shadow 0.2s;
}

.board-online {
  background: #2ecc71;
  box-shadow: 0 0 4px rgba(46, 204, 113, 0.6);
}

.board-offline {
  background: #e74c3c;
  box-shadow: 0 0 4px rgba(231, 76, 60, 0.5);
}

/* Unlit — the board has never been heard from, or the ground station relaying
   its state is gone, so there is no live reading to colour. */
.board-unknown {
  background: var(--text-muted);
  box-shadow: none;
  opacity: 0.6;
}

.cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.card {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card-wide {
  grid-column: 1 / -1;
}

.card-label {
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.card-value {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-primary);
}

.card-mono {
  font-family: monospace;
  font-size: 0.85rem;
}

.card-unit {
  font-size: 0.72rem;
  font-weight: 400;
  color: var(--text-secondary);
  margin-left: 4px;
}

.phase-ascent { color: #4da3ff; }
.phase-drogue { color: #ffb020; }
.phase-main   { color: #2ecc71; }
.phase-landed { color: #2ecc71; }
</style>
