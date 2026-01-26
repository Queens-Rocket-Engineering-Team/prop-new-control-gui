<script setup>
import MultiSelect from 'primevue/multiselect';
import { onMounted, ref } from 'vue';

const place_holder = ref(['Option 1', 'Option 2', 'Option 3']);
const selected_options = ref([]);

//TODO: fix imports later, make em pretty
import Chart from 'primevue/chart';

const chartData = ref({
  labels: ["10s", "9s", "8s", "7s", "6s", "5s", "4s", "3s", "2s", "1s"],
  datasets: [
    {
      label: 'Sample Data',
      backgroundColor: '#42A5F5',
      data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }
  ]
});

const chartOptions = ref({
  responsive: true,
  maintainAspectRatio: false
});

function simulate_data() {
  // This function simulates data updates for the chart
  ws.send(JSON.stringify({ data: [...chartData.value.datasets[0].data.slice(1), Math.floor(Math.random() * 1000)] }));
}

//websocket simulation
const ws = new WebSocket('wss://echo.websocket.org');
ws.onopen = () => console.log('Connected');
ws.onmessage = (event) => update_chart(JSON.parse(event.data));
ws.onerror = (error) => console.error('WebSocket error:', error);
ws.onclose = () => console.log('Disconnected');

function update_chart(new_data) {
  chartData.value.datasets[0].data = new_data.data;
}

onMounted(() => {
    setInterval(() => simulate_data(), 1000);
});

</script>

<template>
    <div>
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