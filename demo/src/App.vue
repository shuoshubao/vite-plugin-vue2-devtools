<template>
    <div id="app-root">
        <el-menu :default-active="activeIndex" mode="horizontal" @select="go">
            <el-menu-item index="/">Home</el-menu-item>
            <el-menu-item index="/about">About</el-menu-item>
        </el-menu>
        <div class="page">
            <router-view />
        </div>
    </div>
</template>

<script>
export default {
    name: 'App',
    data() {
        return {
            activeIndex: this.$route.path
        };
    },
    methods: {
        go(index) {
            this.activeIndex = index;
            if (this.$route.path !== index) this.$router.push(index);
        }
    }
};
</script>

<style>
#app-root {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.page {
    padding: 20px;
}
</style>
