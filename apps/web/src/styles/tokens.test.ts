import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Контраст текста --win и --ask на их подложке в светлой теме: подложка полупрозрачная,
// поэтому считаем цвет после наложения на каждый фон темы. Порог WCAG AA для обычного текста.
const AA = 4.5

// CSS в тестах Vitest не обрабатывает (импорт даёт пустую строку) — читаем файл с диска.
// Путь — строкой: глобальный URL здесь от happy-dom, readFileSync его не принимает.
const css = readFileSync(
  fileURLToPath(import.meta.url).replace(/tokens\.test\.ts$/, 'tokens.css'),
  'utf8',
)
const lightBlock = css.slice(css.indexOf(':root[data-theme="light"]'))
const light = lightBlock.slice(0, lightBlock.indexOf('}'))

function token(name: string): string {
  const match = light.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!match?.[1]) throw new Error(`в светлой теме нет токена --${name}`)
  return match[1].trim()
}

type Rgba = [number, number, number, number]

function parse(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1]
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).concat(1) as Rgba
  const rgb = value.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)]
  throw new Error(`не разобран цвет ${value}`)
}

function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]
}

function luminance([r, g, b]: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe('токены светлой темы', () => {
  for (const tone of ['win', 'ask']) {
    for (const ground of ['bg', 'surface', 'raised', 'hover']) {
      it(`--${tone} на --${tone}-wash поверх --${ground} — не ниже AA`, () => {
        const text = parse(token(tone))
        const wash = over(parse(token(`${tone}-wash`)), parse(token(ground)))
        expect(contrast(text, wash)).toBeGreaterThanOrEqual(AA)
      })
    }
  }
})
