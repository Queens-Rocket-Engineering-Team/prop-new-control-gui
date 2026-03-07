import { ref, computed, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';

// Helper to build a normalized key combination string from a KeyboardEvent
function buildKeyCombo(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  const key = event.key.toLowerCase();
  if (key && !['control', 'alt', 'shift', 'meta'].includes(key)) {
    parts.push(key);
  }
  return parts.join('+');
}

// Helper to validate a key combo (basic: at least one key, no empty)
function isValidKeyCombo(combo) {
  return combo && combo.split('+').length >= 1;
}

// raw user-specified bindings, loaded from disk and mutated by settings UI.
const userBindings = ref({});
// generated defaults based on current control lists.
const autoBindings = ref({});
// keep track of the last-seen control lists so settings UI can render them.
const knownValves = ref([]);
const knownAux = ref([]);   // list of auxiliary control keys
const knownKasa = ref([]);  // list of kasa device hosts

// The map actually used by the app: if the user has supplied any bindings we
// honour that mapping exactly; otherwise we fall back to the automatically
// generated set.  (Could be extended to merge, but keeping it simple.)
const controlKeyMap = computed(() => {
  if (Object.keys(userBindings.value).length) {
    return { ...userBindings.value };
  }
  return { ...autoBindings.value };
});

// Inverse lookup used for display hints.
const idToKey = computed(() => {
  const m = {};
  for (const [k, v] of Object.entries(controlKeyMap.value)) {
    if (v.type === 'valve') m[v.id] = k;
    else if (v.type === 'aux') m[v.key] = k;
    else if (v.type === 'kasa') m[v.host] = k;
  }
  return m;
});

function buildDefaultBindings(valves, auxControls, kasaDevices) {
  knownValves.value = valves.slice();
  knownAux.value = auxControls.map((c) => c.key);
  knownKasa.value = kasaDevices.map((d) => d.host);

  const map = {};
  const used = new Set();

  const chooseKey = (str) => {
    for (const ch of String(str).toLowerCase()) {
      if (/^[a-z0-9]$/.test(ch) && !used.has(ch)) {
        used.add(ch);
        return ch;
      }
    }
    for (let code = 97; code <= 122; code++) {
      const ch = String.fromCharCode(code);
      if (!used.has(ch)) {
        used.add(ch);
        return ch;
      }
    }
    for (let d = 0; d <= 9; d++) {
      const ch = String(d);
      if (!used.has(ch)) {
        used.add(ch);
        return ch;
      }
    }
    return null;
  };

  for (const id of valves) {
    const key = chooseKey(id);
    if (key) map[key] = { type: 'valve', id };
  }
  for (const ctrl of auxControls) {
    const key = chooseKey(ctrl.key);
    if (key) map[key] = { type: 'aux', key: ctrl.key };
  }
  for (const dev of kasaDevices) {
    const key = chooseKey(dev.alias || dev.host);
    if (key) map[key] = { type: 'kasa', host: dev.host };
  }

  autoBindings.value = map;
}

async function loadKeyBindings() {
  try {
    const result = await invoke('load_keybindings');
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      userBindings.value = result;
    }
  } catch (err) {
    console.error('[KeyBindings] load failed:', err);
  }
}

async function saveKeyBindings() {
  try {
    await invoke('save_keybindings', { bindings: userBindings.value });
  } catch (err) {
    console.error('[KeyBindings] save failed:', err);
  }
}

// automatically persist when the user map changes
watch(userBindings, saveKeyBindings, { deep: true });

export function useKeyBindings() {
  return {
    userBindings,
    autoBindings,
    controlKeyMap,
    idToKey,
    knownValves,
    knownAux,
    knownKasa,
    buildDefaultBindings,
    loadKeyBindings,
    saveKeyBindings,
  };
}
