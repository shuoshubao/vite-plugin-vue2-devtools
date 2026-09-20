<template>
  <el-card class="user-card" :class="{ active }" @click.native="$emit('select')">
    <div class="name">{{ name }}</div>
    <div class="meta">age: {{ age }}</div>
    <div class="meta">status: {{ status }}</div>
  </el-card>
</template>

<script>
export default {
  name: 'UserCard',
  props: {
    name: { type: String, required: true },
    age: { type: Number, default: 0 },
    active: { type: Boolean, default: false }
  },
  computed: {
    status() {
      return this.active ? 'selected' : 'idle'
    }
  }
}
</script>

<style scoped>
.user-card {
  width: 140px;
  cursor: pointer;
}
.user-card.active {
  border: 2px solid #41b883;
}
.name {
  font-weight: 600;
}
.meta {
  color: #888;
  font-size: 12px;
}
</style>
