import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// В разработке запросы /api/* уходят на API (apps/api, порт 3000) без префикса /api —
// так же, как это делает обратный прокси в docker-compose.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
