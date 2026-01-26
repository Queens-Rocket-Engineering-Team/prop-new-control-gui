<script setup>
import MultiSelect from 'primevue/multiselect';
import { onMounted, ref } from 'vue';

const place_holder = ref(['Option 1', 'Option 2', 'Option 3']);
const selected_options = ref([]);

//TODO: fix imports later, make em pretty
import Chart from 'primevue/chart';

const chartData = ref({
  labels: ['70s', '60s', '50s', '40s', '30s', '20s', '10s'],
  datasets: [
    {
      label: 'Sample Data',
      backgroundColor: '#42A5F5',
      data: [1, 0, 39, 10, 40, 39, 80, 40]
    }
  ]
});

const chartOptions = ref({
  responsive: true,
  maintainAspectRatio: false
});

onMounted()

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