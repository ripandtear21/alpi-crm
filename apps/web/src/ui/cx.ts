/** Склеивает классы, пропуская пустые: cx('ui-button', busy && 'is-busy'). */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
