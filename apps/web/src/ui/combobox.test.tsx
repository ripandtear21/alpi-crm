import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Combobox, type ComboboxOption } from './combobox.tsx'

// Выдуманные контакты для теста.
const PEOPLE: ComboboxOption[] = [
  { id: 'p1', label: 'Остап Вишня', hint: 'ТОВ «Вікна»' },
  { id: 'p2', label: 'Олеся Коваль' },
  { id: 'p3', label: 'Ірина Ткач' },
]

function SearchDemo({ onSelect }: { onSelect: (option: ComboboxOption) => void }) {
  const [query, setQuery] = useState('')
  const options = PEOPLE.filter((p) => query !== '' && p.label.toLowerCase().includes(query))
  return (
    <Combobox
      label="Контакт"
      value={query}
      onValueChange={setQuery}
      options={options}
      onSelect={(option) => {
        setQuery(option.label)
        onSelect(option)
      }}
      emptyText="Ничего не найдено"
    />
  )
}

describe('поиск с подсказками', () => {
  it('подсказки по вводу, стрелки двигают выделение, Enter выбирает', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<SearchDemo onSelect={onSelect} />)

    const input = screen.getByRole('combobox', { name: 'Контакт' })
    await user.type(input, 'о')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Остап ВишняТОВ «Вікна»',
      'Олеся Коваль',
    ])

    await user.keyboard('{ArrowDown}')
    const first = screen.getByRole('option', { name: /Остап Вишня/ })
    expect(input.getAttribute('aria-activedescendant')).toBe(first.id)
    expect(first.getAttribute('aria-selected')).toBe('true')
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onSelect).toHaveBeenCalledWith(PEOPLE[1])
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect((input as HTMLInputElement).value).toBe('Олеся Коваль')
  })

  it('Esc закрывает подсказки, без совпадений виден текст «ничего не найдено»', async () => {
    const user = userEvent.setup()
    render(<SearchDemo onSelect={vi.fn()} />)

    const input = screen.getByRole('combobox', { name: 'Контакт' })
    await user.type(input, 'щ')
    expect(screen.getByText('Ничего не найдено')).toBeTruthy()

    await user.clear(input)
    await user.type(input, 'п')
    expect(screen.getByRole('listbox')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })
})
