type HappyDomWindow = Window & {
  happyDOM: { setViewport(viewport: { width: number; height: number }): void }
}

// Меняет ширину окна happy-dom: window.matchMedia пересчитывается и шлёт событие change,
// как в браузере при повороте телефона или сужении окна.
export function setViewportWidth(width: number): void {
  ;(window as unknown as HappyDomWindow).happyDOM.setViewport({ width, height: 800 })
}
