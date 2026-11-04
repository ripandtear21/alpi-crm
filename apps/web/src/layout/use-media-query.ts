import { useCallback, useMemo, useSyncExternalStore } from 'react'

// Ширина, ниже которой каркас считается телефонным: левое меню сворачивается за кнопку.
export const MOBILE_MEDIA_QUERY = '(max-width: 767px)'

export function useMediaQuery(query: string): boolean {
  // Один объект MediaQueryList и для подписки, и для чтения значения.
  const list = useMemo(() => window.matchMedia(query), [query])
  const subscribe = useCallback(
    (onChange: () => void) => {
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [list],
  )
  return useSyncExternalStore(
    subscribe,
    () => list.matches,
    () => false,
  )
}
