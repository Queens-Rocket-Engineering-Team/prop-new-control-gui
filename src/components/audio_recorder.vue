<script setup>
import { ref, inject } from 'vue'

const startAudio    = inject('startAudio',    () => Promise.resolve())
const stopAudio     = inject('stopAudio',     () => Promise.resolve())
const listAudioFiles = inject('listAudioFiles', () => Promise.resolve({ files: [] }))
const audioFileUrl  = inject('audioFileUrl',  (f) => f)

const recording  = ref(false)
const busy       = ref(false)
const statusMsg  = ref('')
const showFiles  = ref(false)
const files      = ref([])
const filesLoading = ref(false)

async function toggleRecording() {
  busy.value = true
  statusMsg.value = ''
  try {
    if (!recording.value) {
      const res = await startAudio()
      recording.value = true
      statusMsg.value = res?.status === 'started' ? 'Recording…' : (res?.status ?? 'Started')
    } else {
      const res = await stopAudio()
      recording.value = false
      statusMsg.value = res?.file ? `Saved: ${res.file}.opus` : 'Stopped'
    }
  } catch (err) {
    console.error('[AudioRecorder]', err)
    statusMsg.value = String(err)
  } finally {
    busy.value = false
  }
}

async function loadFiles() {
  showFiles.value = !showFiles.value
  if (!showFiles.value) return
  filesLoading.value = true
  try {
    const res = await listAudioFiles()
    files.value = res?.files ?? []
  } catch (err) {
    console.error('[AudioRecorder] listFiles failed:', err)
    files.value = []
  } finally {
    filesLoading.value = false
  }
}
</script>

<template>
  <div class="audio-recorder">
    <button
      class="audio-btn"
      :class="{ 'audio-btn--recording': recording }"
      :disabled="busy"
      @click="toggleRecording"
      title="Mumble audio recording"
    >
      <span class="audio-dot" :class="{ pulsing: recording }" />
      {{ busy ? '…' : recording ? 'Stop Audio' : 'Rec Audio' }}
    </button>

    <button class="files-btn" @click="loadFiles" :title="showFiles ? 'Hide recordings' : 'Show recordings'">
      <i class="pi" :class="showFiles ? 'pi-chevron-up' : 'pi-folder-open'" />
    </button>

    <span v-if="statusMsg" class="audio-status">{{ statusMsg }}</span>

    <div v-if="showFiles" class="files-popover">
      <div class="files-header">Audio Recordings</div>
      <div v-if="filesLoading" class="files-loading">Loading…</div>
      <div v-else-if="files.length === 0" class="files-empty">No recordings found.</div>
      <div v-else class="files-list">
        <a
          v-for="f in files"
          :key="f.filename"
          :href="audioFileUrl(f.filename)"
          :download="f.filename"
          class="file-link"
        >
          <i class="pi pi-file-audio" />
          {{ f.filename }}
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.audio-recorder {
  display: flex;
  align-items: center;
  gap: 5px;
  position: relative;
}

.audio-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.7rem;
  font-family: inherit;
  font-weight: 600;
  padding: 2px 9px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
  white-space: nowrap;
}

.audio-btn:hover:not(:disabled) {
  color: var(--text-primary);
}

.audio-btn--recording {
  color: #e74c3c;
  border-color: #e74c3c;
}

.audio-btn--recording:hover:not(:disabled) {
  background: rgba(231, 76, 60, 0.1);
}

.audio-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.audio-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
  transition: background 0.2s;
}

.audio-btn--recording .audio-dot {
  background: #e74c3c;
  box-shadow: 0 0 4px rgba(231, 76, 60, 0.7);
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.3; }
}

.pulsing {
  animation: pulse-dot 1s ease-in-out infinite;
}

.files-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: transparent;
  color: var(--text-muted);
  font-size: 0.75rem;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  flex-shrink: 0;
}

.files-btn:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
}

.audio-status {
  font-size: 0.68rem;
  color: var(--text-muted);
  white-space: nowrap;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Files popover ── */

.files-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 200;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  min-width: 280px;
  max-width: 420px;
  font-family: 'Consolas', 'Menlo', monospace;
}

.files-header {
  padding: 6px 10px 5px;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-color);
}

.files-loading,
.files-empty {
  padding: 8px 10px;
  font-size: 0.72rem;
  color: var(--text-muted);
  font-style: italic;
}

.files-list {
  max-height: 200px;
  overflow-y: auto;
}

.file-link {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 0.72rem;
  color: var(--text-primary);
  text-decoration: none;
  border-bottom: 1px solid var(--border-color);
  transition: background 0.12s;
}

.file-link:last-child {
  border-bottom: none;
}

.file-link:hover {
  background: var(--bg-surface);
}

.file-link .pi {
  font-size: 0.78rem;
  color: var(--text-muted);
  flex-shrink: 0;
}
</style>
