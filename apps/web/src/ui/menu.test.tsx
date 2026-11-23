import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Menu } from './menu.tsx'

function renderMenu() {
  const onEdit = vi.fn()
  const onArchive = vi.fn()
  render(
    <Menu
      label="Действия"
      items={[
        { id: 'edit', label: 'Изменить', onSelect: onEdit },
        { id: 'copy', label: 'Копировать', onSelect: vi.fn(), disabled: true },
        { id: 'archive', label: 'В архив', onSelect: onArchive, danger: true },
      ]}
    />,
  )
  return { onEdit, onArchive, trigger: screen.getByRole('button', { name: 'Действия' }) }
}

describe('всплывающее меню', () => {
  it('открывается с клавиатуры, стрелки двигают фокус, пропуская недоступный пункт', async () => {
    const user = userEvent.setup()
    const { trigger } = renderMenu()
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')

    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu', { name: 'Действия' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Изменить' }))

    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'В архив' }))

    // По кругу: после последнего — снова первый; вверх с первого — последний.
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Изменить' }))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'В архив' }))
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Изменить' }))
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'В архив' }))
  })

  it('Enter выбирает пункт, меню закрывается, фокус возвращается на кнопку', async () => {
    const user = userEvent.setup()
    const { trigger, onArchive } = renderMenu()

    trigger.focus()
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'В архив' }))
    await user.keyboard('{Enter}')

    expect(onArchive).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('Esc закрывает меню без выбора и возвращает фокус', async () => {
    const user = userEvent.setup()
    const { trigger, onEdit } = renderMenu()

    await user.click(trigger)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Изменить' }))
    await user.keyboard('{Escape}')

    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('щелчок вне меню закрывает его', async () => {
    const user = userEvent.setup()
    const { trigger } = renderMenu()

    await user.click(trigger)
    await user.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
