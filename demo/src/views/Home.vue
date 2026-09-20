<template>
  <div class="home">
    <h1>{{ title }}</h1>
    <el-button type="primary" @click="count++">Clicked {{ count }} times</el-button>
    <p>Double count (computed): {{ doubleCount }}</p>

    <div class="cards">
      <user-card
        v-for="u in users"
        :key="u.id"
        :name="u.name"
        :age="u.age"
        :active="u.id === activeId"
        @select="activeId = u.id"
      />
    </div>
  </div>
</template>

<script>
import UserCard from '../components/UserCard.vue';

export default {
  name: 'Home',
  components: { UserCard },
  data() {
    return {
      title: 'Vue 2.6.14 Component Panel Demo',
      count: 0,
      activeId: 1,
      users: [
        { id: 1, name: 'Alice', age: 30 },
        { id: 2, name: 'Bob', age: 25 },
        { id: 3, name: 'Carol', age: 41 }
      ]
    }
  },
  computed: {
    doubleCount() {
      return this.count * 2
    }
  }
}
</script>

<style scoped>
.cards {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}
</style>
