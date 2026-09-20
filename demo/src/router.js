import Vue from 'vue'
import VueRouter from 'vue-router'
import About from './views/About.vue'
import Home from './views/Home.vue'

Vue.use(VueRouter)

export default new VueRouter({
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/about', name: 'about', component: About }
  ]
})
