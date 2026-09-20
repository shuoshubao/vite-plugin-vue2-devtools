import { createVuePlugin } from 'vite-plugin-vue2'
import vue2Devtools from 'vite-plugin-vue2-devtools'

export default {
  plugins: [createVuePlugin(), vue2Devtools()],
  server: {
    port: 5199
  }
}
