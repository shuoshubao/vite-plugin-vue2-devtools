import { createVuePlugin } from 'vite-plugin-vue2';
import vueDevtools from '../lib/index.js';

export default {
    plugins: [createVuePlugin(), vueDevtools()],
    server: {
        allowedHosts: true
    }
};
