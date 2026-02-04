<template>
    <div>Control Panel</div> <br>
    <img :src="imageUrl"/>
</template>

<script setup>  
const imageUrl = new URL('@assets/diagram.png', import.meta.url).href;
</script>