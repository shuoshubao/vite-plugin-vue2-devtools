import { createVuePlugin } from 'vite-plugin-vue2';
import vueDevtools from 'vite-plugin-vue-devtools';

export default {
    plugins: [createVuePlugin(), vueDevtools()],
    server: {
        port: 5000,
        allowedHosts: true,
        strictPort: true
    }
};
