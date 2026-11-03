import { defineConfig } from 'vitest/config'

// Каждый пакет — отдельный проект Vitest; общий прогон: `pnpm test` (однократно, без watch).
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
  },
})
