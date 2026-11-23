// Генератор псевдослучайных чисел с зерном для тестовых данных (pnpm seed): одно и то же зерно —
// те же имена, этапы и суммы при каждом запуске. Самописный mulberry32 вместо зависимости:
// для тестовых данных криптостойкость не нужна, нужна воспроизводимость.

export interface Random {
  /** Число в [0, 1). */
  next(): number
  /** Целое в [min, max]. */
  int(min: number, max: number): number
  /** Истина с вероятностью `p`. */
  chance(p: number): boolean
  /** Случайный элемент непустого списка. */
  pick<T>(items: readonly T[]): T
  /** Индекс по весам: чем больше вес, тем чаще. */
  weighted(weights: readonly number[]): number
}

export function createRandom(seed: number): Random {
  let state = seed >>> 0
  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(next() * items.length)]
      if (item === undefined) throw new Error('pick из пустого списка')
      return item
    },
    weighted(weights) {
      const total = weights.reduce((sum, w) => sum + w, 0)
      let r = next() * total
      for (const [i, w] of weights.entries()) {
        r -= w
        if (r < 0) return i
      }
      return weights.length - 1
    },
  }
}
