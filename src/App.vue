<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

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

//collapse or expand navbar on button press.
//TODO: Use jquery or something to make it prettier
function collapseNavbar() {
  const collapseDiv = document.getElementById("collapse");
  if (collapseDiv.style.display === "none" || collapseDiv.style.display === "") {
    collapseDiv.style.display = "block";
  } else {
    collapseDiv.style.display = "none";
  }
}

//===============================================SERVER BAR FUNCTIONALITY=========================================================
const ip_address = ref("");
const server_status = ref("");
const health_check_enabled = ref(false);
async function fetchServerHealth() {
  if (ip_address.value === "") {
    server_status.value = "Ip Not Set";
    return;
  }
  else if (!health_check_enabled.value) {
    server_status.value = "Health Check Disabled";
    return;
  }
  try {
    fetch(`http://${ip_address.value}:8000/health`, { signal: AbortSignal.timeout(1000) })
    .then((response) => {
      if (!response.ok) {
        console.log("Response not ok:", response);
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.text();
    })
    .then((data) => {
      server_status.value = JSON.parse(data).message;
    })
    .catch((error) => {
      server_status.value = "Error fetching - " + error;
      console.error("Error fetching server health:", error);
    });
  } catch (error) {
      server_status.value = "Error fetching - " + error;
      console.error("Error fetching server health:", error);
  }
}
//sends the entered ip address to the backend for sharing state with other components
//TODO: This may not be needed anymore. Can probably just pass through props now.
async function submitIP(ip){
  invoke("submit_ip", {newIp: ip});
}

// /==============================================WEBSOCKET FUNCTIONALITY==========================================================
const chart_array = ref([]);
const websocket_status = ref('Disconnected');
let ws;

function update_chart_data(data_string) {
  let [name, value_str] = data_string.split(":"); // Example data_string: "PTCombustionChamber:250.5"
  let value = parseFloat(value_str);
  let chart = chart_array.value.find(chart => chart.name === name);
  if (chart) {
    chart.data.datasets[0].data = [...chart.data.datasets[0].data.slice(1), value]; // shift data left and adds new value at end WHILE preserving the array's length to prevent reactivity issues.
  }
}

function fetch_data_streams() {
  chart_array.value = []; // empty the array to remove old charts.
  fetch(`http://${ip_address.value}:8000/config`, { headers: { "Authorization": `Basic ${btoa("admin:propteambestteam")}` } })
  .then(response => response.json())
  .then(data => {
    //TODO remove this block when done testing 
    // {
    //   let test = { "count": 1, "configs": { "ESP32-01": { "controls": { "AVPurge1": { "defaultState": "OPEN", "pin": 41, "type": "solenoid" }, "Ign": { "defaultState": "OPEN", "pin": 5, "type": "relay" }, "Safe24": { "defaultState": "OPEN", "pin": 4, "type": "relay" }, "AVFill": { "defaultState": "CLOSED", "pin": 38, "type": "solenoid" }, "AVRun": { "defaultState": "CLOSED", "pin": 39, "type": "solenoid" }, "IgnPrime": { "defaultState": "OPEN", "pin": 6, "type": "relay" }, "AVVent": { "defaultState": "OPEN", "pin": 43, "type": "solenoid" }, "AVDump": { "defaultState": "OPEN", "pin": 40, "type": "solenoid" }, "AVPurge2": { "defaultState": "OPEN", "pin": 42, "type": "solenoid" } }, "deviceType": "Sensor Monitor", "deviceName": "ESP32-01", "sensorInfo": { "pressureTransducers": { "PTN2Supply": { "units": "PSI", "ADCIndex": 4, "pin": 1, "maxPressure_PSI": 200 }, "PTN2OSupply": { "units": "PSI", "ADCIndex": 4, "pin": 0, "maxPressure_PSI": 1000 }, "PTPreInjector": { "units": "PSI", "ADCIndex": 4, "pin": 2, "maxPressure_PSI": 1000 }, "PTCombustionChamber": { "units": "PSI", "ADCIndex": 3, "pin": 0, "maxPressure_PSI": 1000 }, "PTRun": { "units": "PSI", "ADCIndex": 4, "pin": 3, "maxPressure_PSI": 1000 } }, "loadCells": { "LCThrust": { "lowPin": 2, "units": "kg", "excitation_V": 5, "highPin": 3, "loadRating_N": 5000, "ADCIndex": 3, "sensitivity_vV": 2 }, "LCFill": { "lowPin": 0, "units": "kg", "excitation_V": 5, "highPin": 1, "loadRating_N": 889.644, "ADCIndex": 2, "sensitivity_vV": 36 } }, "thermocouples": {} } } } }
    //   console.log(test);
    //   data = test;
    // }
    let sens_inf = data.configs["ESP32-01"].sensorInfo; //data for sensors will come in format: {configs}->{ESP32-01}->{sensorInfo}->{sensorType}->{sensorName}->{sensorData}
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
            }
          }
        );
      });
    });
  })
  .catch(error => {
    console.error('Error fetching datastreams:', error);
  });
  // Close existing WebSocket connections.
  if (ws) { 
    ws.close();
    ws = null;
  }
  // Open new websocket connection.
  ws = new WebSocket(`ws://${ip_address.value}:8000/ws/logs`);
  ws.onopen = () => websocket_status.value = 'Connected';
  ws.onmessage = (event) => {
    console.log('Log message:', parsed);
    let parsed = JSON.parse(event.data)
    //Currently filtering for only logs
    //TODO send these to some kind of terminal later
    if (parsed.channel == "logs") {
      update_chart_data(parsed.data.split(" ")[2]);
    }
  };
  ws.onerror = (error) => console.error('WebSocket error:', error);
  ws.onclose = () => console.log('Disconnected');
}


onMounted(() => {
  // Set up periodic health fetching every 1 seconds
  setInterval(fetchServerHealth, 1000);
});

onUnmounted(() => {
if (ws) {
  ws.close();
  ws = null;
}
});
</script>

<template>
  <main class="container">
    <div id="grid-container">
      <div id="navbar">
        <div id="menu-button" @click="collapseNavbar()">
          <img src="./assets/dropdown.svg" width="30px" />
        </div>
        <div id="collapse">
          <div id="nav-upper">
            <button @click="setActive(ControlPanel)">Control</button>
            <button @click="setActive(GraphPanel)">Data</button>
            <button @click="setActive(CameraPanel)">Camera View</button>
            <button @click="setActive(DebugPanel)">Debug</button>
            <button @click="setActive(FlightPanel)">Flight</button>
          </div>
          <div id="nav-lower">
            <button @click="setActive(WelcomePanel)">Welcome</button>
          </div>
        </div>
      </div>
      <component :is="window_content" class="swap-container" :chart_array="chart_array"></component>

    </div>
    <div id="server-bar">
      <div id="server-select">
        <form @submit.prevent="submitIP(ip_address)">
          Server IP:
          <input type="text" v-model="ip_address" @change="submitIP(ip_address)">
          <label>Enable Health Check:</label>
          <input type="checkbox" v-model="health_check_enabled">
        </form>
        <p>Websocket status: {{ websocket_status }}</p>
        <button @click="fetch_data_streams">Fetch Data Streams</button>
      </div>
      <div id="server-health">
        <p>Server Health: {{ server_status }}</p>
      </div>
    </div>
  </main>
</template>
