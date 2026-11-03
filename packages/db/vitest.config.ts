import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'db',
    // Первый запуск embedded PostgreSQL (initdb) на Windows занимает несколько секунд.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
})
