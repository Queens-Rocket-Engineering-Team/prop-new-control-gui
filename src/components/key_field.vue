<script setup>
// One key-capture box. Readonly by design: its keydowns are captured, not
// typed, so whatever combo is pressed becomes the binding for this target.
//
// Shared by the keybindings editor and the switch-sync prompt so a binding is
// changed the same way wherever it is offered — the prompt is often where an
// operator first notices a switch is bound to the wrong key.

import { computed } from "vue";
import { useKeyBindings, buildKeyCombo, targetId } from "../composables/useKeyBindings.js";

const props = defineProps({
  /** Binding target descriptor — see useKeyBindings.js. */
  target: { type: Object, required: true },
  /** Shown as the field's title, e.g. "AV-1 — OPEN". */
  label: { type: String, default: '' },
});

const { keyForTarget, setBinding, clearBinding } = useKeyBindings();

const combo = computed(() => keyForTarget.value[targetId(props.target)] ?? '');

// Tab and escape are left alone so the surrounding modal can still be navigated
// and dismissed while a field has focus; setBinding rejects the remaining
// reserved keys itself.
function captureKey(event) {
  if (event.key === 'Tab' || event.key === 'Escape') return;
  event.preventDefault();
  if (event.key === 'Backspace' || event.key === 'Delete') {
    clearBinding(props.target);
    return;
  }
  setBinding(props.target, buildKeyCombo(event));
}
</script>

<template>
  <input
    type="text"
    readonly
    class="key-field"
    :class="{ bound: combo }"
    :value="combo"
    :title="label"
    @keydown="captureKey"
  />
</template>

<style scoped>
.key-field {
  flex: none;
  width: 110px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 4px 8px;
  font-size: 0.85rem;
  font-family: inherit;
  text-align: center;
  text-transform: lowercase;
  cursor: pointer;
  transition: var(--theme-transition);
}

.key-field:focus {
  outline: none;
  border-color: var(--input-focus-border);
}

/* An unbound field is legible but recessive, so a half-bound pair reads as a
   gap in the column rather than as two equal-looking fields. */
.key-field:not(.bound) {
  color: var(--text-muted);
  border-style: dashed;
}
</style>
