<script setup>
import { ref } from "vue";
import ToggleSwitch from "primevue/toggleswitch";

const imageUrl = new URL("/diagram.png", import.meta.url).href;

const N2Regulator = ref(false);
const MvN2Dump = ref(false);
const AVFillN2 = ref(false);
</script>

<template>
  <div id="control-panel">
    <h1 class="title">Control Panel</h1>

    <div class="main-content">
      <div class="control-sidebar">
        <div class="control-section">
          <h3>Controls</h3>
          
          <div class="control-item" :class="{active: N2Regulator}">
            <div class="control-info">
              <label class="control-label">N2 Regulator</label>
            </div>
            <ToggleSwitch v-model="N2Regulator" />
          </div>

          <div class="control-item" :class="{active: MvN2Dump}">
            <div class="control-info">
              <label class="control-label">MV N2 Dump</label>
            </div>
            <ToggleSwitch v-model="MvN2Dump" />
          </div>

          <div class="control-item" :class="{active: AVFillN2}">
            <div class="control-info">
              <label class="control-label">AV Fill N2</label>
            </div>
            <ToggleSwitch v-model="AVFillN2" />
          </div>
        </div>

        <div class="server-terminal"></div>
      </div>    

      <div class="diagram-wrapper">
        <img :src="imageUrl" alt="P&ID Diagram" class="diagram" />
      </div>
      
      <div class="sensor-sidebar">
        <h3>Sensor Status</h3>
        <div class="sensor-group">
          <div class="sensor-1">
            <label class="sensor-label">Sensor 1</label>
            <div class="sensor-value">Value: 123</div>
          </div>
          <div class="sensor-2">
            <label class="sensor-label">Sensor 2</label>
            <div class="sensor-value">Value: 456</div>
          </div>
          <div class="sensor-3">
            <label class="sensor-label">Sensor 3</label>
            <div class="sensor-value">Value: 789</div>
          </div>
        </div>
      </div>

      <div class="status-bar">
        <div class="status-item">Server: RUNNING</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
#control-panel {
  width: 100%;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.title {
  padding: 12px 20px;
  font-size: 24px;
  font-weight: bold;
  text-align: center;
  letter-spacing: 3px;
}

.main-content {
  display: grid;
  grid-template-columns: 280px 1fr 280px;
  gap: 16px;
  padding: 16px;
  height: calc(100vh - 64px);
  overflow: hidden;
  flex: 1;
}

.control-sidebar {
  border: 1px solid;
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.control-section {
  flex: 1;
}

.control-section h3 {
  font-size: 16px;
  margin: 0 0 16px 0;
  text-transform: uppercase;
  letter-spacing: 1px;
  border-bottom: 1px solid;
  padding-bottom: 8px;
}

.control-item {
  border: 1px solid;
  border-radius: 4px;
  padding: 12px;
  margin-bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.control-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.control-label {
  font-size: 14px;
  font-weight: bold;
}

.control-status {
  font-size: 12px;
  text-transform: uppercase;
}

.diagram-wrapper {
  border: 1px solid;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 8px;
}

.diagram {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}

.sensor-sidebar {
  border: 1px solid;
  border-radius: 8px;
  padding: 16px;
  overflow-y: auto;
}

.sensor-sidebar h3 {
  font-size: 16px;
  margin: 0 0 16px 0;
  text-transform: uppercase;
  letter-spacing: 1px;
  border-bottom: 1px solid;
  padding-bottom: 8px;
}

.sensor-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sensor-label {
  font-size: 12px;
  text-transform: uppercase;
}

.sensor-value {
  font-size: 18px;
  font-weight: bold;
}

.status-bar {
  display: flex;
  justify-content: center;
  gap: 40px;
  font-size: 14px;
}
</style>