<script setup>
import { computed, inject, ref } from "vue";

// Right-hand companion pane for the flight panel: live GPS/flight readouts
// plus a reserved slot where the rocket diagram (drawio SVG + overlay cards,
// same mechanism as PidDiagram.vue on the control panel) will eventually
// live. Collapsing/resizing is owned by the parent flight panel.

const { currentFix, vspeed, phase } = inject("flightTrack");
const sensorData = inject("sensorData", ref({}));

const altUnit = computed(() => sensorData.value?.Alt?.unit ?? "m");

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
      <i class="pi pi-send diagram-icon"></i>
      <span>Rocket diagram<br />coming soon</span>
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

.diagram-slot {
  flex: 1;
  min-height: 140px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 0.8rem;
  text-align: center;
  font-style: italic;
}

.diagram-icon {
  font-size: 1.4rem;
  transform: rotate(-45deg);
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
