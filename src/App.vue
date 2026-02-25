<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import "primeicons/primeicons.css";

import NavBar from "./components/nav_bar.vue";
import ServerBar from "./components/server_bar.vue";
import SettingsModal from "./components/settings_modal.vue";

//import the windows as they are defined in their own vue files
import WelcomePanel from "./windows/welcome_panel.vue";
import CameraPanel from "./windows/camera_panel.vue";
import GraphPanel from "./windows/graph_panel.vue";
import ControlPanel from "./windows/control_panel.vue";
import DebugPanel from "./windows/debug_panel.vue";
import FlightPanel from "./windows/flight_panel.vue";

let window_content = ref(WelcomePanel); //initializes the functional window content to the welcome panel.
//changes the content of the functional window to the inputted compnent
function setActive(component) {
  window_content.value = component;
}

// Synced from NavBar's @resize emit so the grid column tracks the drag
const navbarWidth = ref(180);
function onNavResize(w) {
  navbarWidth.value = w;
}

const server_ip = ref("");
function get_ip(new_ip) {
  console.log("Received new IP from settings:", new_ip);
  server_ip.value = new_ip;
  fetchDataStreams(); 
  connectWebSocket();
}

const settingsOpen = ref(false);

//======================WEBSOCKET FUNCTIONALITY=============================
const chart_array = ref([]);
const websocket_status = ref('Disconnected');
let ws;

function connectWebSocket() {
  ws = new WebSocket(`ws://${server_ip.value}:8000/ws/logs`);
  ws.onopen = () => console.log('Connected');
  ws.onmessage = (event) => {
    let parsed = JSON.parse(event.data)
    console.log('Received WebSocket message:', parsed); //TODO remove this after testing
    //Currently filtering for only logs
    // TODO: send messages to debug panel
    if (parsed.channel == "logs") {
      updateChartData(parsed.data);
    }
  };
  ws.onerror = (error) => console.error('WebSocket error:', error);
  ws.onclose = () => console.log('Disconnected');
}

function updateChartData(data) {
  let data_string = data.split(" ")[2]
  let [name, value_str] = data_string.split(":"); // Example data_string: "PTCombustionChamber:250.5"
  let value = parseFloat(value_str);
  let chart = chart_array.value.find(chart => chart.name === name);
  if (chart) {
    chart.data.datasets[0].data = [...chart.data.datasets[0].data.slice(1), value]; // shift data left and adds new value at end WHILE preserving the array's length to prevent reactivity issues.
  }
}

//Synced with @update-ip
function fetchDataStreams() {
  chart_array.value = []; // empty the array to remove old charts.
  fetch(`http://${server_ip.value}:8000/config`, { headers: { "Authorization": `Basic ${btoa("admin:propteambestteam")}` } })
  .then(response => response.json())
  .then(data => {
    console.log('Received config data:', data); //TODO remove this after testing
    //TODO remove this block when done testing 
      // {
      //   let test = { "count": 1, "configs": { "ESP32-01": { "controls": { "AVPurge1": { "defaultState": "OPEN", "pin": 41, "type": "solenoid" }, "Ign": { "defaultState": "OPEN", "pin": 5, "type": "relay" }, "Safe24": { "defaultState": "OPEN", "pin": 4, "type": "relay" }, "AVFill": { "defaultState": "CLOSED", "pin": 38, "type": "solenoid" }, "AVRun": { "defaultState": "CLOSED", "pin": 39, "type": "solenoid" }, "IgnPrime": { "defaultState": "OPEN", "pin": 6, "type": "relay" }, "AVVent": { "defaultState": "OPEN", "pin": 43, "type": "solenoid" }, "AVDump": { "defaultState": "OPEN", "pin": 40, "type": "solenoid" }, "AVPurge2": { "defaultState": "OPEN", "pin": 42, "type": "solenoid" } }, "deviceType": "Sensor Monitor", "deviceName": "ESP32-01", "sensorInfo": { "pressureTransducers": { "PTN2Supply": { "units": "PSI", "ADCIndex": 4, "pin": 1, "maxPressure_PSI": 200 }, "PTN2OSupply": { "units": "PSI", "ADCIndex": 4, "pin": 0, "maxPressure_PSI": 1000 }, "PTPreInjector": { "units": "PSI", "ADCIndex": 4, "pin": 2, "maxPressure_PSI": 1000 }, "PTCombustionChamber": { "units": "PSI", "ADCIndex": 3, "pin": 0, "maxPressure_PSI": 1000 }, "PTRun": { "units": "PSI", "ADCIndex": 4, "pin": 3, "maxPressure_PSI": 1000 } }, "loadCells": { "LCThrust": { "lowPin": 2, "units": "kg", "excitation_V": 5, "highPin": 3, "loadRating_N": 5000, "ADCIndex": 3, "sensitivity_vV": 2 }, "LCFill": { "lowPin": 0, "units": "kg", "excitation_V": 5, "highPin": 1, "loadRating_N": 889.644, "ADCIndex": 2, "sensitivity_vV": 36 } }, "thermocouples": {} } } } }
      //   console.log(test);
      //   data = test;
      // }
    let sens_inf = data.configs["PANDA-V1.1"].sensorInfo; //data for sensors will come in format: {configs}->{ESP32-01}->{sensorInfo}->{sensorType}->{sensorName}->{sensorData}
    Object.values(sens_inf).forEach((sensors) => { // loops through each sensor type 
      // this should be done with .keys, but for some reason it broke when I tried that. TODO: look into this later.
      Object.entries(sensors).forEach(([key, value]) => { // loop through each INDIVIDUAL sensor and creates a chart for each one.
        chart_array.value.push(
          {
            name: key,
            data: {
              labels: Array.from({ length: 101 }, (_, i) => `${100 - i}s`), // currently x axis is always 100 seconds counting down TODO: will want to change this to vary with some kind of setting
              datasets: [
                {
                  label: key,
                  backgroundColor: '#396cd8',
                  borderColor: '#396cd8',
                  data: Array(101).fill(0), // initialize chart data to all 0s
                }
              ]
            },
            chartOptions: {
              responsive: true,
              maintainAspectRatio: false,
              animation: false,
              scales: {y: {ticks: {callback: (number) => `${number} ${value.units || ''}`}}} // adds units to y axis
            }
          }
        );
      });
    });
  })
  .catch(error => {
    console.error('Error fetching datastreams:', error);
  });
}

onMounted(() => {
  invoke("fetch_server_ip").then((ip) => {
    if (ip) server_ip.value = ip;
  });
});

onUnmounted(() => {
  if (ws) ws.close();
});
</script>

<template>
  <main class="container">
    <div
      id="grid-container"
      :style="{ gridTemplateColumns: navbarWidth + 'px 1fr' }"
    >
      <nav-bar
        @navigate="setActive"
        @open-settings="settingsOpen = true"
        @resize="onNavResize"
      ></nav-bar>

      <component :is="window_content" :chart_array="chart_array" class="swap-container"></component>
    </div>

    <server-bar :server-ip="server_ip"></server-bar>
    <button @click="updateChartData('hello t PTRun:250.5')">test</button>
    <settings-modal
      :is-open="settingsOpen"
      :current-ip="server_ip"
      @close="settingsOpen = false"
      @update-ip="get_ip"
    ></settings-modal>
  </main>
</template>

<style scoped>
.container {
  margin: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
}

#grid-container {
  display: grid;
  /* grid-template-columns is set dynamically by App.vue via :style */
  gap: 0;
  flex: 1;
  min-height: 0;
}

.swap-container {
  background-color: var(--bg-primary);
  border: var(--border-color) 2px solid;
  border-radius: 0 10px 10px 0;
  padding: 10px;
  text-align: left;
}
</style>