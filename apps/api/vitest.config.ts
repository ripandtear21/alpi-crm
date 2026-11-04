import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'api',
    // Тесты входа поднимают embedded PostgreSQL; первый запуск (initdb) на Windows небыстрый.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
})
