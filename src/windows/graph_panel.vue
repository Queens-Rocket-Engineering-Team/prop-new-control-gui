<script setup>
import MultiSelect from 'primevue/multiselect';
import { ref } from 'vue';

import Chart from 'primevue/chart';

const selected_options = ref([]);

const props = defineProps({
  chart_array: {
    type: Array,
    required: true
  }
});

const chartOptions = ref({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
});

</script>

<template>
  <div id="graph_view">
    <MultiSelect v-model="selected_options" :options="chart_array" optionLabel="name" filter placeholder="Select Datastreams"/>
    <br />
    <div v-for="value in selected_options">
      <h3>Sensor: {{ value.name }}</h3>
      <Chart type="line" :data="value.data" :options="value.chartOptions" />
      
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