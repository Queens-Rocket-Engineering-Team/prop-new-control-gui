<script setup>
// Reconciliation prompt: physical switch positions against what the device
// actually reports. See useSwitchSync.js for why a registration owes one.
//
// Rows are computed by useControlLayer.js, which is where device state lives.
// This component renders them and decides nothing except when Confirm is
// allowed — which is only once every row agrees.

import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import KeyField from "./key_field.vue";

const props = defineProps({
  isOpen: Boolean,
  /**
   * [{ key, label, deviceLabel, switchLabel, expected, matched, group,
   *    cells: [{ id, target, action }] }]
   * `group` is the owning device's name, or '' outside the just-registered
   * flow (see useControlLayer.js) — rows with no meaningful device to group by.
   */
  rows: { type: Array, default: () => [] },
  /** Device names that raised this prompt; empty when reopened for review. */
  devices: { type: Array, default: () => [] },
});

const emit = defineEmits(["confirm", "dismiss"]);

const overlayRef = ref(null);
const bodyRef = ref(null);

// Declared ahead of the immediate watcher below, which reads and writes all
// three synchronously during setup — before any would exist if declared in
// their more natural spot nearer where each is otherwise used. A `const`/`let`
// referenced by an immediate watcher's callback before its own declaration
// line has run is a TDZ crash, not just a stale read: watch() runs its
// callback synchronously here, ahead of every later statement in this block.
let seenDevices = new Set();
const justAdded = ref(new Set());
const confirmingDismiss = ref(false);

watch(
  () => props.isOpen,
  (open) => {
    if (!open) return
    nextTick(() => overlayRef.value?.focus());
    // Establishes the baseline for the "device joined mid-review" watcher
    // below: everything present at open is not a later addition, even if two
    // registrations landed close enough together to open together.
    //
    // immediate: true matters here beyond the usual reason. This component can
    // mount already open — a device can already be pending the moment the
    // control panel first renders it — which is a mount, not a false→true
    // transition. Without immediate the baseline would stay empty through that
    // case, and the first devices update afterward would misread the device
    // already on screen as a fresh arrival: wrong banner, and a flash/scroll
    // aimed at the wrong section.
    seenDevices = new Set(props.devices);
    justAdded.value = new Set();
    confirmingDismiss.value = false;
  },
  { immediate: true },
);

const mismatched = computed(() => props.rows.filter((r) => !r.matched));
const allMatched = computed(() => props.rows.length > 0 && mismatched.value.length === 0);

// ── Dismissing with mismatches still outstanding ─────────────────────────────
// Esc and the X button do not dismiss directly — they ask first, but only when
// there is something to lose. Nothing stands between the operator and closing
// once every switch already agrees with the device; the confirmation exists
// for the bypass, not for the click. (Declared above, with seenDevices.)

function requestDismiss() {
  if (mismatched.value.length === 0) {
    emit('dismiss', []);
    return;
  }
  confirmingDismiss.value = true;
}

function cancelDismiss() {
  confirmingDismiss.value = false;
}

function proceedDismiss() {
  emit('dismiss', mismatched.value.map((r) => r.key));
  confirmingDismiss.value = false;
}

// A switch fixed while the prompt sits open drops out of the count this
// confirmation is about. Once none are left there is nothing left to bypass,
// so the question answers itself rather than lingering on stale numbers.
watch(allMatched, (matched) => { if (matched) confirmingDismiss.value = false; });

const heading = computed(() => {
  if (props.devices.length === 0) return 'Switches still out of sync';
  if (props.devices.length === 1) return `${props.devices[0]} connected`;
  return `${props.devices.length} devices connected`;
});

// ── Rows from a device that registered while this was already open ──────────
// Grouped by device so a second registration's rows read as a distinct,
// labelled addition rather than blending anonymously into the first device's
// list — otherwise an operator scrolled deep into a long valve list has no
// reason to notice the list grew under them while Confirm stays disabled.
//
// A header is worth showing only once there is more than one device to tell
// apart; a lone registration would just repeat the name already in the
// heading above.
const groups = computed(() => {
  const list = [];
  for (const row of props.rows) {
    const name = row.group || '';
    let group = list.find((g) => g.name === name);
    if (!group) list.push((group = { name, rows: [] }));
    group.rows.push(row);
  }
  return list;
});

const showGroupLabels = computed(() => groups.value.filter((g) => g.name).length > 1);

let _clearTimer = null;

watch(
  () => props.devices,
  (names) => {
    if (!props.isOpen) return;
    const added = names.filter((n) => !seenDevices.has(n));
    seenDevices = new Set(names);
    if (added.length === 0) return;

    justAdded.value = new Set(added);
    clearTimeout(_clearTimer);
    _clearTimer = setTimeout(() => { justAdded.value = new Set(); }, 4000);
    // A newly-registered device's switches start unmatched, so a dismiss
    // confirmation already on screen is now asking about a smaller mismatch
    // than the one actually on the table. Back out rather than let "Dismiss
    // anyway" bypass a device the operator has not even seen yet.
    confirmingDismiss.value = false;

    nextTick(() => {
      const el = bodyRef.value?.querySelector(`[data-sync-group="${CSS.escape(added[0])}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
);

onUnmounted(() => clearTimeout(_clearTimer));

const addedRowCount = computed(() =>
  props.rows.filter((r) => justAdded.value.has(r.group)).length
);
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen"
         ref="overlayRef"
         class="modal-overlay"
         @keydown.esc="confirmingDismiss ? cancelDismiss() : requestDismiss()"
         tabindex="-1">
      <!-- No @click.self dismiss, unlike the other modals: this one is asking a
           question about the state of the stand, and a stray click on the
           backdrop is not an answer to it. Esc and the button still close it
           — subject, while anything is still mismatched, to the confirmation
           in the footer below rather than closing outright. -->
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
              <p v-if="justAdded.size > 0" class="modal-alert">
                <i class="pi pi-arrow-down" />
                {{ [...justAdded].join(', ') }} also connected —
                {{ addedRowCount }} more switch{{ addedRowCount === 1 ? '' : 'es' }} to check.
              </p>
            </div>
          </div>
          <button
            class="modal-close-btn"
            title="Dismiss without syncing"
            @click="requestDismiss"
          >
            <i class="pi pi-times" />
          </button>
        </div>

        <div ref="bodyRef" class="modal-body">
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

          <template v-for="group in groups" :key="group.name || '__ungrouped__'">
            <div
              v-if="showGroupLabels && group.name"
              class="sync-group-label"
              :class="{ 'group-new': justAdded.has(group.name) }"
              :data-sync-group="group.name"
            >
              {{ group.name }}
            </div>

            <div
              v-for="row in group.rows"
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
          </template>
        </div>

        <div v-if="confirmingDismiss" class="modal-footer confirm-footer">
          <span class="sync-status">
            <i class="pi pi-exclamation-triangle" />
            {{ mismatched.length }} switch{{ mismatched.length === 1 ? '' : 'es' }}
            will not match the device. Dismiss anyway?
          </span>
          <span class="confirm-footer-actions">
            <button class="sync-back-btn" @click="cancelDismiss">Keep working</button>
            <button class="sync-dismiss-btn" @click="proceedDismiss">Dismiss anyway</button>
          </span>
        </div>

        <div v-else class="modal-footer">
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

/* Names the thing that just grew the list, since the list growing is otherwise
   silent to anyone not looking straight at it. Fades with the row highlight
   below rather than lingering after the operator has moved on. */
.modal-alert {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 6px 0 0;
  font-size: 0.72rem;
  font-weight: 700;
  color: #f39c12;
  animation: sync-alert-fade 4s ease-out forwards;
}

.modal-alert .pi {
  font-size: 0.7rem;
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

/* Only shown once a second device is in play — see showGroupLabels. Sticky
   under the column captions so it stays legible while its own rows scroll.
   The offset is .sync-head's own rendered height — there is no layout API to
   derive it, so it has to be kept in sync by hand if that row's padding or
   font-size changes. */
.sync-group-label {
  position: sticky;
  top: 26px;
  z-index: 1;
  background: var(--modal-bg);
  padding: 6px 0 3px;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.sync-group-label.group-new {
  animation: sync-row-flash 4s ease-out;
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
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  color: #f39c12;
}

.sync-status.ok {
  color: #2ecc71;
}

/* Replaces the normal footer while a dismiss is pending confirmation, rather
   than stacking a second overlay on top of this one — the mismatched rows
   are still the relevant context, so keeping them on screen behind an
   unchanged body says more than hiding them behind a fresh dialog would. */
.confirm-footer .sync-status {
  color: #f39c12;
  font-weight: 700;
}

.confirm-footer-actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.sync-back-btn {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.8rem;
  padding: 5px 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.sync-back-btn:hover {
  color: var(--text-primary);
  border-color: var(--input-focus-border);
}

/* Deliberately not styled like .sync-confirm-btn's success green — this is the
   button that leaves something unresolved, and should not read as the safe or
   default choice even though it sits on the right where "proceed" usually is. */
.sync-dismiss-btn {
  background: rgba(231, 76, 60, 0.12);
  border: 1px solid #e74c3c;
  border-radius: 6px;
  color: #e74c3c;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 700;
  padding: 5px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.sync-dismiss-btn:hover {
  background: rgba(231, 76, 60, 0.22);
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

@keyframes sync-row-flash {
  0%   { background: rgba(243, 156, 18, 0.28); }
  100% { background: transparent; }
}

@keyframes sync-alert-fade {
  0%, 70% { opacity: 1; }
  100%    { opacity: 0; }
}
</style>
