<script setup>
import MultiSelect from 'primevue/multiselect';
import { invoke } from "@tauri-apps/api/core";
import { onMounted, onUnmounted, ref } from 'vue';

import Chart from 'primevue/chart';

const chart_array = ref([]);
const selected_options = ref([]);

const debug_text = ref('');
const websocket_status = ref('Disconnected');

let server_ip;
let ws;

onMounted(() => {
  invoke("fetch_server_ip").then((ip) => {
    server_ip = ip;
    ws = new WebSocket(`ws://${server_ip}:8000/ws/logs`);
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
  });
  fetch_data_streams();
});

function update_chart_data(data_string) {
  // Example data_string: "PTCombustionChamber:250.5"
  let [name, value_str] = data_string.split(":");
  let value = parseFloat(value_str);
  let chart = chart_array.value.find(chart => chart.name === name);
  if (chart) {
    chart.data.datasets[0].data = [...chart.data.datasets[0].data.slice(1), value];
  }
}

onUnmounted(() => {
  if (ws) {
    ws.close();
    ws = null;
  }
});

function fetch_data_streams() {
  chart_array.value = []; // empty array on call
  invoke("fetch_server_ip").then((ip) => {
        server_ip = ip;
  });
  fetch(`http://${server_ip}:8000/config`, { headers: { "Authorization": `Basic ${btoa("admin:propteambestteam")}` } })
    .then(response => response.json())
    .then(data => {
      let test = {"count":1,"configs":{"ESP32-01":{"controls":{"AVPurge1":{"defaultState":"OPEN","pin":41,"type":"solenoid"},"Ign":{"defaultState":"OPEN","pin":5,"type":"relay"},"Safe24":{"defaultState":"OPEN","pin":4,"type":"relay"},"AVFill":{"defaultState":"CLOSED","pin":38,"type":"solenoid"},"AVRun":{"defaultState":"CLOSED","pin":39,"type":"solenoid"},"IgnPrime":{"defaultState":"OPEN","pin":6,"type":"relay"},"AVVent":{"defaultState":"OPEN","pin":43,"type":"solenoid"},"AVDump":{"defaultState":"OPEN","pin":40,"type":"solenoid"},"AVPurge2":{"defaultState":"OPEN","pin":42,"type":"solenoid"}},"deviceType":"Sensor Monitor","deviceName":"ESP32-01","sensorInfo":{"pressureTransducers":{"PTN2Supply":{"units":"PSI","ADCIndex":4,"pin":1,"maxPressure_PSI":200},"PTN2OSupply":{"units":"PSI","ADCIndex":4,"pin":0,"maxPressure_PSI":1000},"PTPreInjector":{"units":"PSI","ADCIndex":4,"pin":2,"maxPressure_PSI":1000},"PTCombustionChamber":{"units":"PSI","ADCIndex":3,"pin":0,"maxPressure_PSI":1000},"PTRun":{"units":"PSI","ADCIndex":4,"pin":3,"maxPressure_PSI":1000}},"loadCells":{"LCThrust":{"lowPin":2,"units":"kg","excitation_V":5,"highPin":3,"loadRating_N":5000,"ADCIndex":3,"sensitivity_vV":2},"LCFill":{"lowPin":0,"units":"kg","excitation_V":5,"highPin":1,"loadRating_N":889.644,"ADCIndex":2,"sensitivity_vV":36}},"thermocouples":{}}}}}
      console.log(test);
      data = test; //TODO remove this line when actual server is sending data
      debug_text.value = "fetch recieved";
      let sens_inf = data.configs["ESP32-01"].sensorInfo;
      Object.values(sens_inf).forEach((sensors) => {
        Object.entries(sensors).forEach(([key, value]) => {
          chart_array.value.push(
            {
              name: key,
              data: {
                  labels: Array.from({ length: 101 }, (_, i) => `${100 - i}s`),
                  datasets: [
                    {
                      label: key,
                      backgroundColor: '#396cd8',
                      borderColor: '#396cd8',
                      data: Array(101).fill(0),
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
}

const chartOptions = ref({
  responsive: true,
  maintainAspectRatio: false,
});

</script>

<template>
  <div id="graph_view">
    <button @click="fetch_data_streams">Fetch Data Streams</button>
    <p>Websocket status: {{ websocket_status }}</p>
    <MultiSelect v-model="selected_options" :options="chart_array" optionLabel="name" filter placeholder="Select Datastreams"/>
    <br />
    <p>Placeholder for where graphs and datastreams will go</p>
    <div v-for="value in selected_options">
      <h3>Header: {{ value.name }}</h3>
      <Chart type="line" :data="value.data" :options="chartOptions" />
      
    </div>
  </div>


</template>

<style scoped>
#graph_view {
  overflow: scroll;
}

:deep(.p-chart) {
  height: 300px;
  background-color: #fff;
  border-top: #2d5868 2px solid;
  border-left: #2d5868 2px solid;
  border-bottom: #2d5868 2px solid;
  border-radius: 10px 10px 10px 10px;
}
</style>