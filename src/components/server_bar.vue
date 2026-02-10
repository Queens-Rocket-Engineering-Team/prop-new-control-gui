<script setup>
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

const ip_address = ref("");
const server_status = ref("");
const health_check_enabled = ref(false  );
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
async function submitIP(ip){
  invoke("submit_ip", {newIp: ip});
}

onMounted(() => {
  //fetch the current ip address on load to populate the field and start health checks
  //TODO: make this a better implementation. Probably shouldnt pass state of this variable with rust. Probably should
  //use either browser localstorage or Tauri's storage API.
  invoke("fetch_server_ip").then((ip) => {
    ip_address.value = ip;
  });
  setInterval(fetchServerHealth, 1000);
});
</script>

<template>
  <div id="server-bar">
      <div id="server-select">
        <form @submit.prevent="submitIP(ip_address)">
          Server IP: 
          <input type="text" v-model="ip_address" @change="submitIP(ip_address)">
          <label>Enable Health Check:</label>
          <input type="checkbox" v-model="health_check_enabled">
        </form>
      </div>
      <div id="server-health">
        <p>Server Health: {{ server_status }}</p>
      </div>
    </div>
</template>