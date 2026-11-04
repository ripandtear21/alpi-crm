import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'

// Компонентные тесты клиента: DOM даёт happy-dom, у него рабочий matchMedia
// и управляемая ширина окна — на этом стоят тесты адаптивного каркаса.
export default defineProject({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
