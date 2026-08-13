<script setup>
// The keybinding editor, in its own window rather than inside Settings.
// A stand can carry twenty-odd valves and every actuator binds two keys, so the
// grid needs more width than the settings modal's 420px and more height than a
// scroll box wedged between the other settings groups.
//
// Teleported to <body> so it is not nested inside the settings modal's DOM:
// otherwise its esc keydown would bubble to that overlay's handler and close
// both at once. It also keeps the .modal-overlay class, which is what stops
// control_panel.vue acting on keys while a modal is up — the guard that lets
// this editor capture a key without also firing it.

import { computed, nextTick, ref, watch } from "vue";
import { useKeyBindings } from "../composables/useKeyBindings.js";
import KeyField from "./key_field.vue";

const props = defineProps({
  isOpen: Boolean,
});

const emit = defineEmits(["close"]);

const overlayRef = ref(null);

// Focus the overlay when it opens so the esc handler receives key events.
watch(
  () => props.isOpen,
  (open) => { if (open) nextTick(() => overlayRef.value?.focus()); }
);

const { editableControls } = useKeyBindings();

// Sectioned in registration order so the editor reads like the control panel.
// Each section carries its own column captions — OPEN/CLOSE for valves, ON/OFF
// for plugs — taken from its widest row, so the states are named once at the
// top instead of on every line. Sections whose controls have a single binding
// (variable controls, E-STOP) get no caption row: there is no column to
// distinguish.
const bindingGroups = computed(() => {
  const groups = [];
  for (const row of editableControls.value) {
    const name = row.group || 'Controls';
    let group = groups.find((g) => g.name === name);
    if (!group) groups.push((group = { name, rows: [], columns: [] }));
    group.rows.push(row);
    if (row.cells.length > group.columns.length) {
      group.columns = row.cells.map((c) => c.action);
    }
  }
  return groups;
});

// Every row reserves the same number of field slots, so a control with one
// binding (a variable control, E-STOP) lines its field up under the *first*
// column rather than drifting to wherever flex happens to put it.
const maxColumns = computed(() =>
  bindingGroups.value.reduce((n, g) => Math.max(n, g.columns.length), 1)
);

// Capture and validation live in key_field.vue, shared with the switch-sync
// prompt so a binding is changed the same way wherever it is offered.
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen"
         ref="overlayRef"
         class="modal-overlay"
         @click.self="emit('close')"
         @keydown.esc="emit('close')"
         tabindex="-1">
      <div class="modal-container">
        <div class="modal-header">
          <div class="modal-header-title">
            <i class="pi pi-key" />
            <h3>Keybindings</h3>
          </div>
          <button class="modal-close-btn" @click="emit('close')" title="Close">
            <i class="pi pi-times" />
          </button>
        </div>

        <div class="modal-body">
          <div v-if="bindingGroups.length === 0" class="binding-empty">
            Open the Control panel to load bindable controls.
          </div>
          <div v-else class="binding-list" :style="{ '--cell-cols': maxColumns }">
            <template v-for="group in bindingGroups" :key="group.name">
              <!-- Name and captions travel together, so the sticky offset is the
                   height of this block rather than a number guessed to match it. -->
              <div class="binding-section-head">
                <div class="binding-group-label">{{ group.name }}</div>
                <div v-if="group.columns.length > 1" class="binding-row">
                  <span class="binding-label" />
                  <span class="binding-cells">
                    <span v-for="col in group.columns" :key="col" class="binding-col">{{ col }}</span>
                  </span>
                </div>
              </div>
              <div v-for="row in group.rows" :key="row.id" class="binding-row">
                <span class="binding-label" :title="row.label">{{ row.label }}</span>
                <span class="binding-cells">
                  <key-field
                    v-for="cell in row.cells"
                    :key="cell.id"
                    :target="cell.target"
                    :label="`${row.label} — ${cell.action}`"
                  />
                </span>
              </div>
            </template>
          </div>
        </div>

        <div class="modal-footer">
          Click a field and press a key to bind it; backspace clears.
          Each key commands one state, so open and close are bound separately.
          Shortcuts act on the Control panel only.
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Above the settings modal (z-index 1000), which stays open behind this. */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  outline: none;
}

.modal-container {
  display: flex;
  flex-direction: column;
  background: var(--modal-bg);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  width: 92%;
  max-width: 560px;
  max-height: 80vh;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-color);
  flex: none;
}

.modal-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-header-title .pi {
  font-size: 0.95rem;
  color: var(--text-muted);
}

.modal-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.2px;
  color: var(--text-primary);
}

.modal-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0;
  box-shadow: none;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.modal-close-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-color);
  background: var(--bg-secondary);
}

/* The body scrolls, not the page — the header and footer stay put so the
   instructions and the close button are reachable from anywhere in the list. */
.modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 16px 12px;
}

.modal-footer {
  flex: none;
  padding: 10px 16px;
  background: var(--bg-surface);
  border-top: 1px solid var(--border-color);
  font-size: 0.7rem;
  font-style: italic;
  line-height: 1.5;
  color: var(--text-muted);
}

.binding-list {
  display: flex;
  flex-direction: column;
}

/* Sticky so the section name and its column captions stay visible while
   scrolling a long valve list — otherwise the OPEN/CLOSE headings scroll away
   and the two fields become indistinguishable. */
.binding-section-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--modal-bg);
  padding-bottom: 3px;
}

.binding-group-label {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 10px 0 3px;
  border-bottom: 1px solid var(--border-color);
}

/* One row per control, one field per state. */
.binding-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 3px 0;
}

.binding-label {
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Fixed-width regardless of how many fields the row actually has, so every
   section's columns line up with every other section's. */
.binding-cells {
  display: flex;
  gap: 8px;
  flex: none;
  width: calc(var(--cell-cols) * 110px + (var(--cell-cols) - 1) * 8px);
}

.binding-col {
  flex: none;
  width: 110px;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  text-align: center;
}

.binding-empty {
  font-size: 0.75rem;
  font-style: italic;
  color: var(--text-muted);
  padding: 12px 0;
}

.modal-overlay,
.modal-container,
.modal-header,
.modal-body,
.modal-footer,
.modal-close-btn {
  transition: var(--theme-transition);
}
</style>
