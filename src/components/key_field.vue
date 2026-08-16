<script setup>
// One key-capture box. Readonly by design: its keydowns are captured, not
// typed, so whatever combo is pressed becomes the binding for this target.
//
// Shared by the keybindings editor and the switch-sync prompt so a binding is
// changed the same way wherever it is offered — the prompt is often where an
// operator first notices a switch is bound to the wrong key.

import { computed, ref } from "vue";
import { useKeyBindings, pressKey, resetHeld, targetId } from "../composables/useKeyBindings.js";

const props = defineProps({
  /** Binding target descriptor — see useKeyBindings.js. */
  target: { type: Object, required: true },
  /** Shown as the field's title, e.g. "AV-1 — OPEN". */
  label: { type: String, default: '' },
});

const { keyForTarget, setBinding, clearBinding } = useKeyBindings();

const combo = computed(() => keyForTarget.value[targetId(props.target)] ?? '');

// A chord is built across several keydowns and committed on the first release,
// so the field has to hold a half-finished combo of its own while the keys are
// down. `pending` is that, and it doubles as the live preview: the string only
// grows while the grip does, reading ctrl → ctrl+a → ctrl+a+b as fingers land.
const pending = ref('');
const error = ref('');

const display = computed(() => pending.value || combo.value);

// Tab and escape are left alone so the surrounding modal can still be navigated
// and dismissed while a field has focus; canonicaliseCombo rejects the
// remaining reserved keys itself.
function captureKey(event) {
  if (event.key === 'Tab' || event.key === 'Escape') return;
  event.preventDefault();

  const grip = pressKey(event);
  // Backspace and delete clear the binding, but only pressed on their own —
  // inside a chord they are ordinary keys like any other.
  if (!pending.value && (grip === 'backspace' || grip === 'delete')) {
    clearBinding(props.target);
    resetHeld();
    error.value = '';
    return;
  }
  pending.value = grip;
  error.value = '';
}

const MODIFIER_NAMES = ['ctrl', 'alt', 'shift', 'meta'];

// The first release ends the chord: waiting for the last one would mean an
// operator who lifts ctrl before b binds something different from one who
// does not, and the grip is the same either way.
function commitKey() {
  if (!pending.value) return;
  // Modifiers with nothing to modify — someone leaning on shift, not a binding
  // attempt. Dropped quietly rather than reported as a bad shortcut.
  if (pending.value.split('+').every((part) => MODIFIER_NAMES.includes(part))) {
    reset();
    return;
  }
  const result = setBinding(props.target, pending.value);
  error.value = result.ok
    ? ''
    : result.reason === 'conflict'
      ? `Already firing on the way in: "${result.conflict}" is part of this chord`
      : 'Not a usable shortcut';
  pending.value = '';
  resetHeld();
}

// A chord abandoned mid-grip must not leak into the next field, and any key
// still down when focus leaves will never deliver its keyup here.
function reset() {
  pending.value = '';
  error.value = '';
  resetHeld();
}
</script>

<template>
  <input
    type="text"
    readonly
    class="key-field"
    :class="{ bound: display, capturing: pending, invalid: error }"
    :value="display"
    :title="error || label"
    @keydown="captureKey"
    @keyup="commitKey"
    @blur="reset"
  />
</template>

<style scoped>
/* Wide enough for a chord: "ctrl+shift+f11" and "ctrl+a+b" both have to be
   readable, not ellipsised into two bindings that look alike. */
.key-field {
  flex: none;
  width: 150px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 4px 8px;
  font-size: 0.8rem;
  font-family: inherit;
  text-align: center;
  text-transform: lowercase;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: var(--theme-transition);
}

.key-field:focus {
  outline: none;
  border-color: var(--input-focus-border);
}

/* Mid-chord, so it is obvious the field is still listening and the combo shown
   is not the one stored yet. */
.key-field.capturing {
  border-style: dashed;
  border-color: var(--input-focus-border);
}

/* A refused combo — the reason is in the title. The theme has no danger token;
   this is the same red the recording alert uses. */
.key-field.invalid {
  border-color: #e74c3c;
  color: #e74c3c;
}

/* An unbound field is legible but recessive, so a half-bound pair reads as a
   gap in the column rather than as two equal-looking fields. */
.key-field:not(.bound) {
  color: var(--text-muted);
  border-style: dashed;
}
</style>
