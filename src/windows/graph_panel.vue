<script setup>
import MultiSelect from 'primevue/multiselect';
import { onMounted, ref } from 'vue';
import Chart from 'primevue/chart';

const place_holder = ref([]);
const selected_options = ref([]);

function fetch_data_streams() {
    //placeholder function to get available data streams
    place_holder.value = ['Option 1', 'Option 2', 'Option 3', 4, 5, 6, 7, 8, 9, 10];
}



//=============================PLACEHOLDER CHART SETUP=============================//
const chartData = ref({
  labels: ["10s", "9s", "8s", "7s", "6s", "5s", "4s", "3s", "2s", "1s"],
  datasets: [
    {
      label: 'Sample Data',
      backgroundColor: '#396cd8',
      borderColor: '#396cd8',
      data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }
  ]
});

const chartOptions = ref({
  responsive: true,
  maintainAspectRatio: false,
});


//============================PLACEHOLDER WEBSOCKET SIMULATION============================//
const ws = new WebSocket('wss://echo.websocket.org');
ws.onopen = () => console.log('Connected');
ws.onmessage = (event) => update_chart(JSON.parse(event.data));
ws.onerror = (error) => console.error('WebSocket error:', error);
ws.onclose = () => console.log('Disconnected');

function simulate_data() {
  // This function simulates data updates for the chart
  ws.send(JSON.stringify({ data: [...chartData.value.datasets[0].data.slice(1), Math.floor(Math.random() * 1000)] }));
}

function update_chart(new_data) {
  chartData.value.datasets[0].data = new_data.data;
}

onMounted(() => {
    fetch_data_streams();
    setInterval(() => simulate_data(), 1000);
});

</script>

<template>
    <div id="graph_view">
        <MultiSelect v-model="selected_options" :options="place_holder" placeholder="Select Datastreams to Display" class=""/>
        <br />
        <p>Placeholder for where graphs and datastreams will go</p>
        <div v-for="value in selected_options">
            <h3>Header: {{ value }}</h3>
            <p>Internal {{ value }}</p>
            <Chart type="line" :data="chartData" :options="chartOptions" />
            
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