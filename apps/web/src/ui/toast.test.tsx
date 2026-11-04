import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '../i18n/index.ts'
import { Button } from './button.tsx'
import { Dialog } from './dialog.tsx'
import { TOAST_DURATION_MS, ToastProvider, useToast } from './toast.tsx'

function SaveButton() {
  const toast = useToast()
  return <Button onClick={() => toast('Сохранено')}>Сохранить</Button>
}

function DialogWithSave() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Открыть</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Сделка">
        <SaveButton />
      </Dialog>
    </>
  )
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

  it('закрытое вручную снимает свой таймер', async () => {
    vi.useFakeTimers()
    renderWithToasts()

    act(() => screen.getByRole('button', { name: 'Сохранить' }).click())
    expect(vi.getTimerCount()).toBe(1)
    act(() => screen.getByRole('button', { name: 'Закрыть уведомление' }).click())
    expect(screen.queryByText('Сохранено')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('под указателем не исчезает; после ухода указателя отсчёт идёт заново', () => {
    vi.useFakeTimers()
    renderWithToasts()

    act(() => screen.getByRole('button', { name: 'Сохранить' }).click())
    const toast = screen.getByText('Сохранено').closest('.ui-toast') as HTMLElement
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 1000))
    fireEvent.pointerEnter(toast)
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS * 2))
    expect(screen.getByText('Сохранено')).toBeTruthy()

    fireEvent.pointerLeave(toast)
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 1000))
    expect(screen.getByText('Сохранено')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.queryByText('Сохранено')).toBeNull()
  })

  it('с фокусом внутри не исчезает, пока фокус не уйдёт', () => {
    vi.useFakeTimers()
    renderWithToasts()

    act(() => screen.getByRole('button', { name: 'Сохранить' }).click())
    const close = screen.getByRole('button', { name: 'Закрыть уведомление' })
    act(() => close.focus())
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS * 2))
    expect(screen.getByText('Сохранено')).toBeTruthy()

    act(() => screen.getByRole('button', { name: 'Сохранить' }).focus())
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS))
    expect(screen.queryByText('Сохранено')).toBeNull()
  })

  it('каждое уведомление живёт своим таймером: пауза одного не держит другое', () => {
    vi.useFakeTimers()
    renderWithToasts()

    act(() => screen.getByRole('button', { name: 'Сохранить' }).click())
    act(() => vi.advanceTimersByTime(1000))
    act(() => screen.getByRole('button', { name: 'Сохранить' }).click())
    const [first, second] = screen.getAllByText('Сохранено')
    fireEvent.pointerEnter(second?.closest('.ui-toast') as HTMLElement)
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS))
    expect(screen.getAllByText('Сохранено')).toEqual([second])
    expect(first?.isConnected).toBe(false)
  })

  it('при открытом модальном диалоге уведомления внутри него, после закрытия — снова на странице', async () => {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={createI18n('ru')}>
        <ToastProvider>
          <DialogWithSave />
        </ToastProvider>
      </I18nextProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Открыть' }))
    const dialog = screen.getByRole('dialog', { name: 'Сделка' })
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    const region = screen.getByText('Сохранено').closest('[aria-live]') as HTMLElement
    expect(dialog.contains(region)).toBe(true)
    expect(region.getAttribute('popover')).toBe('manual')

    // Кнопка уведомления внутри диалога доступна и не закрывает сам диалог.
    await user.click(screen.getByRole('button', { name: 'Закрыть уведомление' }))
    expect(screen.queryByText('Сохранено')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Сделка' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    const after = screen.getByText('Сохранено').closest('[aria-live]') as HTMLElement
    expect(after.isConnected).toBe(true)
    expect(after.closest('dialog')).toBeNull()
  })

  it('без ToastProvider useToast сообщает об ошибке, а не молчит', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<SaveButton />)).toThrow(/ToastProvider/)
  })
})
