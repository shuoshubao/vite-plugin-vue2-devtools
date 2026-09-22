import { createVuePlugin } from 'vite-plugin-vue2';
import vue2Devtools from '../lib/index.js';

export default {
    plugins: [createVuePlugin(), vue2Devtools()],
    server: {
        port: 5000,
        allowedHosts: true,
        strictPort: true
    }
};
