<script setup>
import { ref, nextTick, onMounted, watch } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import logoUrl from "../../app-icon.svg";

const props = defineProps({
  isOpen: Boolean,
});

const emit = defineEmits(["close"]);

const REPO_URL = "https://github.com/Queens-Rocket-Engineering-Team/prop-new-control-gui";

const overlayRef = ref(null);

// __APP_VERSION__ comes from package.json via vite.config.js `define`. It is the
// only version available in the plain web build; under Tauri we prefer
// getVersion(), which reads the authoritative value from tauri.conf.json.
const version = ref(__APP_VERSION__);

onMounted(async () => {
  try {
    version.value = await getVersion();
  } catch {
    // Not running under Tauri (web build) — keep the build-time version.
  }
});

// Focus the overlay when it opens so the esc handler receives key events.
watch(
  () => props.isOpen,
  (open) => { if (open) nextTick(() => overlayRef.value?.focus()); }
);

async function openRepo() {
  try {
    await openUrl(REPO_URL);
  } catch (err) {
    console.error("[About] openUrl failed, falling back to window.open:", err);
    window.open(REPO_URL, "_blank", "noopener");
  }
}
</script>

<template>
  <div v-if="isOpen"
       ref="overlayRef"
       class="modal-overlay"
       @click.self="emit('close')"
       @keydown.esc="emit('close')"
       tabindex="-1">
    <div class="modal-container">
      <button class="modal-close-btn" @click="emit('close')" title="Close">✕</button>

      <div class="about-body">
        <img :src="logoUrl" alt="HELM logo" class="about-logo" style="--logo-size: 240px;"/>

        <h1 class="about-title">HELM</h1>
        <p class="about-expansion">Hub for Engine and Launch Monitoring</p>

        <p class="about-version">Version {{ version }}</p>

        <a class="about-repo" href="#" @click.prevent="openRepo">
          <i class="pi pi-github"></i>
          <span>View on GitHub</span>
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  /* See settings_modal.vue — focused for esc handling, so hide the focus ring
     that would otherwise outline the entire viewport. */
  outline: none;
}

.modal-container {
  position: relative;
  background: var(--modal-bg);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  min-width: 320px;
  max-width: 380px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.modal-close-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 1rem;
  cursor: pointer;
  padding: 2px 6px;
  line-height: 1;
  box-shadow: none;
}

.modal-close-btn:hover {
  color: var(--text-primary);
  border-color: transparent;
  background: none;
}

.about-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 34px 24px 28px;
}

.about-logo {
  width: var(--logo-size, 140px);
  height: var(--logo-size, 140px);
  display: block;
}

.about-title {
  margin: 18px 0 0;
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--text-primary);
}

.about-expansion {
  margin: 6px 0 0;
  font-size: 0.9rem;
  color: var(--text-secondary);
}

.about-version {
  margin: 16px 0 0;
  font-size: 0.78rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}

.about-repo {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 18px;
  padding: 7px 14px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 0.82rem;
  color: var(--text-secondary);
  text-decoration: none;
  cursor: pointer;
}

.about-repo:hover {
  color: var(--text-primary);
  border-color: var(--border-accent);
}

.modal-overlay,
.modal-container,
.modal-close-btn,
.about-title,
.about-expansion,
.about-version,
.about-repo {
  transition: var(--theme-transition);
}
</style>
