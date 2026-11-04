import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n/index.ts'
import { Button } from './button.tsx'
import { Dialog, SidePanel } from './dialog.tsx'

function DialogDemo({ side = false }: { side?: boolean }) {
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
      </Frame>
    </I18nextProvider>
  )
}

describe('диалог', () => {
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
})
