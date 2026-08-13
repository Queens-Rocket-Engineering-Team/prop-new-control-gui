<script setup>
// Reconciliation prompt: physical switch positions against what the device
// actually reports. See useSwitchSync.js for why a registration owes one.
//
// Rows are computed by control_panel.vue, which is where device state lives.
// This component renders them and decides nothing except when Confirm is
// allowed — which is only once every row agrees.

import { computed, nextTick, ref, watch } from "vue";
import KeyField from "./key_field.vue";

const props = defineProps({
  isOpen: Boolean,
  /**
   * [{ key, label, deviceLabel, switchLabel, expected, matched,
   *    cells: [{ id, target, action }] }]
   */
  rows: { type: Array, default: () => [] },
  /** Device names that raised this prompt; empty when reopened for review. */
  devices: { type: Array, default: () => [] },
});

const emit = defineEmits(["confirm", "dismiss"]);

const overlayRef = ref(null);

watch(
  () => props.isOpen,
  (open) => { if (open) nextTick(() => overlayRef.value?.focus()); }
);

const mismatched = computed(() => props.rows.filter((r) => !r.matched));
const allMatched = computed(() => props.rows.length > 0 && mismatched.value.length === 0);

const heading = computed(() => {
  if (props.devices.length === 0) return 'Switches still out of sync';
  if (props.devices.length === 1) return `${props.devices[0]} connected`;
  return `${props.devices.length} devices connected`;
});
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen"
         ref="overlayRef"
         class="modal-overlay"
         @keydown.esc="emit('dismiss', mismatched.map((r) => r.key))"
         tabindex="-1">
      <!-- No @click.self dismiss, unlike the other modals: this one is asking a
           question about the state of the stand, and a stray click on the
           backdrop is not an answer to it. Esc and the button still close it. -->
      <div class="modal-container">
        <div class="modal-header">
          <div class="modal-header-title">
            <i class="pi pi-exclamation-triangle" />
            <div>
              <h3>{{ heading }}</h3>
              <p class="modal-subtitle">
                Flip each switch until its position matches the device, then confirm.
                Switch keys do not command anything while this is open.
              </p>
            </div>
          </div>
          <button
            class="modal-close-btn"
            title="Dismiss without syncing"
            @click="emit('dismiss', mismatched.map((r) => r.key))"
          >
            <i class="pi pi-times" />
          </button>
        </div>

        <div class="modal-body">
          <div class="sync-row sync-head">
            <span class="sync-name">Control</span>
            <span class="sync-state">Switch</span>
            <span class="sync-state">Device</span>
            <span class="sync-keys">
              <span v-for="cell in rows[0]?.cells ?? []" :key="cell.id" class="sync-key-caption">
                {{ cell.action }}
              </span>
            </span>
          </div>

          <div
            v-for="row in rows"
            :key="row.key"
            class="sync-row"
            :class="{ matched: row.matched }"
          >
            <span class="sync-name" :title="row.label">
              <i :class="row.matched ? 'pi pi-check-circle' : 'pi pi-circle'" />
              {{ row.label }}
            </span>
            <span class="sync-state" :class="row.matched ? 'state-ok' : 'state-bad'">
              {{ row.switchLabel }}
            </span>
            <span class="sync-state">{{ row.deviceLabel }}</span>
            <span class="sync-keys">
              <key-field
                v-for="cell in row.cells"
                :key="cell.id"
                :target="cell.target"
                :label="`${row.label} — ${cell.action}`"
              />
            </span>
          </div>
        </div>

        <div class="modal-footer">
          <span class="sync-status" :class="{ ok: allMatched }">
            <template v-if="allMatched">All switches match the device.</template>
            <template v-else>
              {{ mismatched.length }} of {{ rows.length }} still to reconcile.
            </template>
          </span>
          <button
            class="sync-confirm-btn"
            :disabled="!allMatched"
            :title="allMatched ? 'Confirm and close' : 'Every switch must match the device first'"
            @click="emit('confirm', rows.map((r) => r.key))"
          >Confirm</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Above every other modal: it is raised by the stand, not by the operator, and
   should not end up behind a settings window that happened to be open. */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  outline: none;
}

.modal-container {
  display: flex;
  flex-direction: column;
  background: var(--modal-bg);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  width: 94%;
  max-width: 680px;
  max-height: 85vh;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-color);
  flex: none;
}

.modal-header-title {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.modal-header-title > .pi {
  font-size: 1rem;
  color: #f39c12;
  margin-top: 2px;
}

.modal-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.2px;
  color: var(--text-primary);
}

.modal-subtitle {
  margin: 3px 0 0;
  font-size: 0.72rem;
  line-height: 1.45;
  color: var(--text-muted);
  max-width: 46ch;
}

.modal-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0;
}

.modal-close-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-color);
  background: var(--bg-secondary);
}

.modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 16px 12px;
}

.sync-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.sync-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--modal-bg);
  border-bottom: 1px solid var(--border-color);
  padding: 8px 0 4px;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.sync-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-head .sync-name {
  font-size: inherit;
  color: inherit;
}

.sync-name .pi {
  font-size: 0.7rem;
  flex: none;
  color: var(--text-muted);
}

.sync-row.matched .sync-name .pi {
  color: #2ecc71;
}

.sync-state {
  flex: none;
  width: 76px;
  text-align: center;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.sync-head .sync-state {
  font-size: inherit;
  font-weight: 700;
}

/* Only the switch column is coloured. The device column is fact — it is what
   the stand reports — so tinting it red would suggest the device is at fault
   when the thing to correct is the switch. */
.state-ok   { color: #2ecc71; }
.state-bad  { color: #f39c12; }

.sync-keys {
  display: flex;
  gap: 8px;
  flex: none;
}

.sync-key-caption {
  flex: none;
  width: 110px;
  text-align: center;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  padding: 10px 16px;
  background: var(--bg-surface);
  border-top: 1px solid var(--border-color);
}

.sync-status {
  font-size: 0.75rem;
  color: #f39c12;
}

.sync-status.ok {
  color: #2ecc71;
}

.sync-confirm-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 700;
  padding: 5px 16px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s;
}

.sync-confirm-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.sync-confirm-btn:not(:disabled):hover {
  border-color: #2ecc71;
  color: #2ecc71;
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
