import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '../i18n/index.ts'
import { Button } from './button.tsx'
import { ToastProvider, useToast } from './toast.tsx'

function SaveButton() {
  const toast = useToast()
  return <Button onClick={() => toast('Сохранено')}>Сохранить</Button>
}

function renderWithToasts() {
  render(
    <I18nextProvider i18n={createI18n('ru')}>
      <ToastProvider>
        <SaveButton />
      </ToastProvider>
    </I18nextProvider>,
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('уведомления', () => {
  it('появляются в вежливой live-области и закрываются кнопкой', async () => {
    const user = userEvent.setup()
    renderWithToasts()

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    const region = screen.getByText('Сохранено').closest('[aria-live]')
    expect(region?.getAttribute('aria-live')).toBe('polite')

    await user.click(screen.getByRole('button', { name: 'Закрыть уведомление' }))
    expect(screen.queryByText('Сохранено')).toBeNull()
  })

  it('исчезают сами через несколько секунд', () => {
    vi.useFakeTimers()
    renderWithToasts()

    act(() => screen.getByRole('button', { name: 'Сохранить' }).click())
    expect(screen.getByText('Сохранено')).toBeTruthy()
    act(() => vi.advanceTimersByTime(6000))
    expect(screen.queryByText('Сохранено')).toBeNull()
  })

  it('без ToastProvider useToast сообщает об ошибке, а не молчит', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<SaveButton />)).toThrow(/ToastProvider/)
  })
})
