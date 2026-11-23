import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Tabs } from './tabs.tsx'

const TABS = [
  { id: 'notes', label: 'Заметки', content: <p>Список заметок</p> },
  { id: 'calls', label: 'Звонки', content: <p>Список звонков</p> },
  { id: 'files', label: 'Файлы', content: <p>Список файлов</p> },
]

describe('вкладки', () => {
  it('в порядке Tab стоит только выбранная вкладка, затем её содержимое', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button type="button">До вкладок</button>
        <Tabs label="Разделы сделки" tabs={TABS} />
      </>,
    )

    expect(screen.getByRole('tablist', { name: 'Разделы сделки' })).toBeTruthy()
    screen.getByRole('button', { name: 'До вкладок' }).focus()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Заметки' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: 'Заметки' }))
  })

  it('стрелки переключают вкладку по кругу, Home и End — на края', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Tabs label="Разделы сделки" tabs={TABS} onChange={onChange} />)

    screen.getByRole('tab', { name: 'Заметки' }).focus()
    await user.keyboard('{ArrowRight}')
    const calls = screen.getByRole('tab', { name: 'Звонки' })
    expect(document.activeElement).toBe(calls)
    expect(calls.getAttribute('aria-selected')).toBe('true')
    expect(calls.tabIndex).toBe(0)
    expect(screen.getByRole('tab', { name: 'Заметки' }).tabIndex).toBe(-1)
    expect(screen.getByRole('tabpanel').textContent).toBe('Список звонков')
    expect(onChange).toHaveBeenLastCalledWith('calls')

    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Файлы' }))
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Заметки' }))
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Файлы' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').textContent).toBe('Список файлов')
  })
})
