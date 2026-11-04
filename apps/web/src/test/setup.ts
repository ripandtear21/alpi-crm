import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { setViewportWidth } from './viewport.ts'

// Глобальные функции Vitest выключены, поэтому Testing Library сама не чистит DOM — чистим здесь.
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  setViewportWidth(1024)
})
