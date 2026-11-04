import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Button } from './button.tsx'
import { Checkbox, Switch } from './checkbox.tsx'
import { Progress } from './feedback.tsx'
import { Field, Input } from './field.tsx'

function SwitchDemo() {
  const [on, setOn] = useState(false)
  return (
    <>
      <Switch checked={on} onCheckedChange={setOn} label="Уведомления" />
      <Checkbox label="Только мои" />
    </>
  )
}

describe('поля и кнопки', () => {
  it('поле внутри Field связано с подсказкой, а при ошибке помечено неверным', () => {
    const { rerender } = render(
      <Field label="Email" hint="Рабочий адрес">
        <Input name="email" />
      </Field>,
    )
    const input = screen.getByRole('textbox', { name: 'Email' })
    expect(input.getAttribute('aria-invalid')).toBeNull()
    const hintId = input.getAttribute('aria-describedby')
    expect(hintId && document.getElementById(hintId)?.textContent).toBe('Рабочий адрес')

    rerender(
      <Field label="Email" error="Неверный адрес">
        <Input name="email" />
      </Field>,
    )
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('Неверный адрес')
  })

  it('занятая кнопка не нажимается и помечена aria-busy', () => {
    render(
      <Button variant="primary" busy>
        Войти
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Войти' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.className).toContain('ui-button--primary')
  })

  it('переключатель и флажок управляются пробелом', async () => {
    const user = userEvent.setup()
    render(<SwitchDemo />)

    const toggle = screen.getByRole('switch', { name: 'Уведомления' })
    toggle.focus()
    await user.keyboard(' ')
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    const box = screen.getByRole('checkbox', { name: 'Только мои' }) as HTMLInputElement
    box.focus()
    await user.keyboard(' ')
    expect(box.checked).toBe(true)
  })

  it('прогресс сообщает значение, без значения — неопределённый', () => {
    render(
      <>
        <Progress label="Импорт" value={30} max={60} />
        <Progress label="Загрузка" />
      </>,
    )
    expect(screen.getByRole('progressbar', { name: 'Импорт' }).getAttribute('aria-valuenow')).toBe(
      '30',
    )
    expect(
      screen.getByRole('progressbar', { name: 'Загрузка' }).getAttribute('aria-valuenow'),
    ).toBeNull()
  })
})
