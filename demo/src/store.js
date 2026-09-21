import Vue from 'vue';
import Vuex from 'vuex';

Vue.use(Vuex);

export default new Vuex.Store({
    state: {
        count: 0,
        user: { name: 'Admin', role: 'admin' },
        tags: ['vue2', 'vuex', 'vite']
    },
    getters: {
        doubleCount: state => state.count * 2,
        tagCount: state => state.tags.length
    },
    mutations: {
        increment(state, step = 1) {
            state.count += step;
        },
        setUserName(state, name) {
            state.user.name = name;
        },
        addTag(state, tag) {
            state.tags.push(tag);
        }
    },
    actions: {
        incrementAsync({ commit }, step) {
            setTimeout(() => commit('increment', step), 300);
        }
    }
});
