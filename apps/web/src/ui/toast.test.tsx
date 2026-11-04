import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ReactNode, useState } from 'react'
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

function DialogWithSave({ openerHiddenWhileOpen = false }: { openerHiddenWhileOpen?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {!(open && openerHiddenWhileOpen) && <Button onClick={() => setOpen(true)}>Открыть</Button>}
      <Dialog open={open} onClose={() => setOpen(false)} title="Сделка">
        <SaveButton />
      </Dialog>
    </>
  )
}

function DialogWithSaveAndClose() {
  const [open, setOpen] = useState(false)
  const toast = useToast()
  return (
    <>
      <Button onClick={() => setOpen(true)}>Открыть</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Сделка">
        <Button
          onClick={() => {
            toast('Сохранено')
            setOpen(false)
          }}
        >
          Сохранить и закрыть
        </Button>
      </Dialog>
    </>
  )
}

function NestedDialogs() {
  const [open, setOpen] = useState(false)
  const [inner, setInner] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Открыть</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Сделка">
        <Button onClick={() => setInner(true)}>Подробнее</Button>
        <Dialog open={inner} onClose={() => setInner(false)} title="Контакт">
          <Button onClick={() => setInner(false)}>Готово</Button>
        </Dialog>
      </Dialog>
    </>
  )
}

function renderWithDialog(ui: ReactNode) {
  render(
    <I18nextProvider i18n={createI18n('ru')}>
      <ToastProvider>{ui}</ToastProvider>
    </I18nextProvider>,
  )
}

/** Область уведомлений: она одна, даже пока уведомлений нет. */
function toastRegion(): HTMLElement {
  const regions = document.querySelectorAll<HTMLElement>('.ui-toasts')
  expect(regions).toHaveLength(1)
  return regions[0] as HTMLElement
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

  it('область уведомлений — один и тот же узел на странице, в диалоге и после его закрытия', async () => {
    const user = userEvent.setup()
    renderWithDialog(<DialogWithSave />)

    const region = toastRegion()
    expect(region.closest('dialog')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Открыть' }))
    expect(toastRegion()).toBe(region)
    expect(screen.getByRole('dialog', { name: 'Сделка' }).contains(region)).toBe(true)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(toastRegion()).toBe(region)
    expect(region.isConnected).toBe(true)
    expect(region.closest('dialog')).toBeNull()
  })

  it('после каждого переноса область снова выводится в верхний слой — над открытым диалогом', async () => {
    // В happy-dom нет popover: подменяем showPopover и следим, что за чем открывается.
    const shown: string[] = []
    const showModal = HTMLDialogElement.prototype.showModal
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      shown.push('диалог')
      showModal.call(this)
    })
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value(this: HTMLElement) {
        shown.push(this.closest('dialog') ? 'область в диалоге' : 'область на странице')
      },
    })
    try {
      const user = userEvent.setup()
      renderWithDialog(<DialogWithSave />)
      expect(shown).toEqual(['область на странице'])

      await user.click(screen.getByRole('button', { name: 'Открыть' }))
      expect(shown.slice(-2)).toEqual(['диалог', 'область в диалоге'])

      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(shown.at(-1)).toBe('область на странице')
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
      vi.restoreAllMocks()
    }
  })

  it('«сохранить и закрыть»: уведомление добавляется в уже стоящую область, а не вставляется вместе с ней', async () => {
    const user = userEvent.setup()
    renderWithDialog(<DialogWithSaveAndClose />)

    await user.click(screen.getByRole('button', { name: 'Открыть' }))
    const region = toastRegion()
    const records: MutationRecord[] = []
    const observer = new MutationObserver((batch) => records.push(...batch))
    observer.observe(document.body, { childList: true, subtree: true })
    await user.click(screen.getByRole('button', { name: 'Сохранить и закрыть' }))
    records.push(...observer.takeRecords())
    observer.disconnect()

    expect(screen.queryByRole('dialog')).toBeNull()
    const toast = screen.getByText('Сохранено').closest('.ui-toast') as HTMLElement
    expect(toastRegion()).toBe(region)
    expect(region.contains(toast)).toBe(true)

    const added = (record: MutationRecord, node: Node) => [...record.addedNodes].includes(node)
    const toastAdded = records.findIndex((record) => added(record, toast))
    expect(toastAdded).toBeGreaterThanOrEqual(0)
    expect(records[toastAdded]?.target).toBe(region)
    // Область уходит из закрываемого диалога раньше, чем в неё попадает уведомление:
    // ни одна запись после добавления уведомления не вставляет саму область.
    const regionMovedAfter = records.slice(toastAdded).some((record) => added(record, region))
    expect(regionMovedAfter).toBe(false)
  })

  it('во вложенном диалоге область переходит в верхний, после его закрытия — в нижний', async () => {
    const user = userEvent.setup()
    renderWithDialog(<NestedDialogs />)

    const region = toastRegion()
    await user.click(screen.getByRole('button', { name: 'Открыть' }))
    await user.click(screen.getByRole('button', { name: 'Подробнее' }))
    expect(screen.getByRole('dialog', { name: 'Контакт' }).contains(region)).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Готово' }))
    expect(screen.queryByRole('dialog', { name: 'Контакт' })).toBeNull()
    const outer = screen.getByRole('dialog', { name: 'Сделка' })
    expect(outer.contains(region)).toBe(true)
    expect(toastRegion()).toBe(region)
  })

  it('провайдер, снятый с открытым диалогом, забирает область со страницы', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <I18nextProvider i18n={createI18n('ru')}>
        <ToastProvider>
          <DialogWithSave />
        </ToastProvider>
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'Открыть' }))
    const region = toastRegion()

    unmount()
    expect(region.isConnected).toBe(false)
    expect(document.querySelector('.ui-toasts')).toBeNull()
  })

  it('при переезде области в диалог таймер уведомления не начинается заново', () => {
    vi.useFakeTimers()
    renderWithDialog(
      <>
        <SaveButton />
        <DialogWithSave />
      </>,
    )

    act(() => screen.getByRole('button', { name: 'Сохранить' }).click())
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 2000))
    act(() => screen.getByRole('button', { name: 'Открыть' }).click())
    expect(screen.getByRole('dialog', { name: 'Сделка' }).contains(toastRegion())).toBe(true)
    expect(screen.getByText('Сохранено')).toBeTruthy()
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.queryByText('Сохранено')).toBeNull()
  })

  it('фокус на уведомлении в закрываемом диалоге не оставляет его на экране навсегда', () => {
    vi.useFakeTimers()
    // Кнопка, открывшая диалог, пока он открыт, исчезает: вернуть фокус некуда, и с уведомления
    // его снимает только перенос области из закрытого диалога.
    renderWithDialog(<DialogWithSave openerHiddenWhileOpen />)

    act(() => screen.getByRole('button', { name: 'Открыть' }).click())
    expect(screen.queryByRole('button', { name: 'Открыть' })).toBeNull()
    act(() => screen.getByRole('button', { name: 'Сохранить' }).click())
    const close = screen.getByRole('button', { name: 'Закрыть уведомление' })
    act(() => close.focus())
    // Esc с фокусом на уведомлении: браузер шлёт диалогу cancel, фокус остаётся на кнопке.
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Сохранено')).toBeTruthy()
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS))
    expect(screen.queryByText('Сохранено')).toBeNull()
  })

  it('без ToastProvider useToast сообщает об ошибке, а не молчит', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<SaveButton />)).toThrow(/ToastProvider/)
  })
})
