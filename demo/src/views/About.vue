<template>
    <div class="about">
        <h1>About</h1>
        <p>This page exists to give the component tree more than one route.</p>
        <el-tag>{{ framework }}</el-tag>
    </div>
</template>

<script>
export default {
    name: 'About',
    data() {
        return {
            framework: 'Vue 2.6.14'
        };
    }
};
</script>
