import { configure, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ReactNode, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '../i18n/index.ts'
import { Button } from './button.tsx'
import { Combobox } from './combobox.tsx'
import { Dialog, SidePanel } from './dialog.tsx'
import { Menu } from './menu.tsx'

function DialogDemo({ side = false, children }: { side?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const Frame = side ? SidePanel : Dialog
  return (
    <I18nextProvider i18n={createI18n('ru')}>
      <Button onClick={() => setOpen(true)}>Передать сделки</Button>
      <Frame
        open={open}
        onClose={() => setOpen(false)}
        title="Передача сделок"
        footer={<Button onClick={() => setOpen(false)}>Готово</Button>}
      >
        <p>Выберите, кому передать сделки.</p>
        {children}
      </Frame>
    </I18nextProvider>
  )
}

function SearchInDialog() {
  const [query, setQuery] = useState('')
  return (
    <Combobox
      label="Кому"
      value={query}
      onValueChange={setQuery}
      options={[{ id: 'u1', label: 'Олеся Коваль' }]}
      onSelect={(option) => setQuery(option.label)}
    />
  )
}

async function openDialog(side = false, children?: ReactNode) {
  const user = userEvent.setup()
  render(<DialogDemo side={side}>{children}</DialogDemo>)
  await user.click(screen.getByRole('button', { name: 'Передать сделки' }))
  return { user, dialog: screen.getByRole('dialog', { name: 'Передача сделок' }) }
}

// Рамка диалога на экране: happy-dom не считает раскладку, задаём её сами.
const FRAME = { left: 600, top: 0, right: 1000, bottom: 800 }
function placeDialog(dialog: HTMLElement) {
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
    ...FRAME,
    x: FRAME.left,
    y: FRAME.top,
    width: FRAME.right - FRAME.left,
    height: FRAME.bottom - FRAME.top,
    toJSON: () => FRAME,
  })
}
const INSIDE = { clientX: 800, clientY: 700 }
const OUTSIDE = { clientX: 200, clientY: 400 }

afterEach(() => {
  vi.restoreAllMocks()
  configure({ reactStrictMode: false })
})

// Приложение в разработке рендерится под <StrictMode> (main.tsx): весь набор — в обоих режимах.
describe.each([
  { mode: 'обычный рендер', strict: false },
  { mode: 'React StrictMode', strict: true },
])('диалог ($mode)', ({ strict }) => {
  beforeEach(() => {
    configure({ reactStrictMode: strict })
  })

  it('открывается по кнопке, закрывается по Esc и возвращает фокус на кнопку', async () => {
    const user = userEvent.setup()
    render(<DialogDemo />)

    const trigger = screen.getByRole('button', { name: 'Передать сделки' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Передача сделок' })
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(dialog.contains(document.activeElement)).toBe(true)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('кнопка «Закрыть» в заголовке тоже закрывает и возвращает фокус', async () => {
    const user = userEvent.setup()
    render(<DialogDemo />)

    const trigger = screen.getByRole('button', { name: 'Передать сделки' })
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('боковая панель закрывается по Esc так же, как диалог', async () => {
    const user = userEvent.setup()
    render(<DialogDemo side />)

    const trigger = screen.getByRole('button', { name: 'Передать сделки' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Передача сделок' }).className).toContain(
      'ui-dialog--side',
    )
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('Esc в меню внутри диалога закрывает только меню, второй Esc — диалог', async () => {
    const { user } = await openDialog(
      false,
      <Menu label="Действия" items={[{ id: 'edit', label: 'Изменить', onSelect: () => {} }]} />,
    )
    const trigger = screen.getByRole('button', { name: 'Действия' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menu', { name: 'Действия' })).toBeTruthy()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Передача сделок' })).toBeTruthy()
    expect(document.activeElement).toBe(trigger)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Esc в подсказках поиска внутри диалога закрывает только подсказки', async () => {
    const { user } = await openDialog(false, <SearchInDialog />)
    const input = screen.getByRole('combobox', { name: 'Кому' })
    await user.type(input, 'о')
    expect(input.getAttribute('aria-expanded')).toBe('true')

    await user.keyboard('{Escape}')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('dialog', { name: 'Передача сделок' })).toBeTruthy()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('щелчок по затемнению вне рамки закрывает', async () => {
    const { dialog } = await openDialog(true)
    placeDialog(dialog)
    fireEvent.pointerDown(dialog, OUTSIDE)
    fireEvent.click(dialog, OUTSIDE)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('щелчок по пустому месту внутри высокой боковой панели не закрывает', async () => {
    const { dialog } = await openDialog(true)
    placeDialog(dialog)
    // Пустое место панели — тоже сам <dialog>, как и затемнение; отличает их только рамка.
    fireEvent.pointerDown(dialog, INSIDE)
    fireEvent.click(dialog, INSIDE)
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })

  it('выделение текста, отпущенное над затемнением, не закрывает', async () => {
    const { dialog } = await openDialog(true)
    placeDialog(dialog)
    // Нажали на тексте внутри, отпустили снаружи: браузер шлёт click общему предку — <dialog>.
    fireEvent.pointerDown(screen.getByText('Выберите, кому передать сделки.'), INSIDE)
    fireEvent.click(dialog, OUTSIDE)
    expect(screen.queryByRole('dialog')).not.toBeNull()

    // Следующий настоящий щелчок по затемнению по-прежнему закрывает.
    fireEvent.pointerDown(dialog, OUTSIDE)
    fireEvent.click(dialog, OUTSIDE)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('щелчок без нажатия на затемнении (после нажатия на затемнении раньше) не закрывает', async () => {
    const { dialog } = await openDialog(true)
    placeDialog(dialog)
    // Первый щелчок начат на затемнении, но отпущен внутри — не закрывает и не оставляет следа.
    fireEvent.pointerDown(dialog, OUTSIDE)
    fireEvent.click(dialog, INSIDE)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.click(dialog, OUTSIDE)
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })
})
