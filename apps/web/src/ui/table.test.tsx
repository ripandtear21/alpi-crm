import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Table } from './table.tsx'

type Deal = { id: string; title: string; amount: number }

// Выдуманные сделки для теста.
const DEALS: Deal[] = [
  { id: 'd1', title: 'Окна для склада', amount: 1200 },
  { id: 'd2', title: 'Арка в гостиной', amount: 300 },
  { id: 'd3', title: 'Балконный блок', amount: 800 },
]

function renderTable(onRowActivate = vi.fn()) {
  render(
    <Table
      caption="Сделки"
      rows={DEALS}
      rowKey={(deal) => deal.id}
      rowLabel={(deal) => deal.title}
      onRowActivate={onRowActivate}
      columns={[
        { key: 'title', header: 'Название', cell: (deal) => deal.title, sortValue: (d) => d.title },
        {
          key: 'amount',
          header: 'Сумма',
          cell: (deal) => deal.amount,
          sortValue: (deal) => deal.amount,
          numeric: true,
        },
      ]}
    />,
  )
  return onRowActivate
}

function titles() {
  const body = screen.getAllByRole('rowgroup')[1]
  if (!body) throw new Error('нет тела таблицы')
  return within(body)
    .getAllByRole('row')
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent)
}

describe('таблица', () => {
  it('сортировка по столбцу с клавиатуры: Enter и пробел на заголовке', async () => {
    const user = userEvent.setup()
    renderTable()
    const amount = screen.getByRole('columnheader', { name: /Сумма/ })
    expect(amount.getAttribute('aria-sort')).toBe('none')

    within(amount).getByRole('button').focus()
    await user.keyboard('{Enter}')
    expect(amount.getAttribute('aria-sort')).toBe('ascending')
    expect(titles()).toEqual(['Арка в гостиной', 'Балконный блок', 'Окна для склада'])

    await user.keyboard(' ')
    expect(amount.getAttribute('aria-sort')).toBe('descending')
    expect(titles()).toEqual(['Окна для склада', 'Балконный блок', 'Арка в гостиной'])
  })

  it('строка открывается Enter, стрелки вверх и вниз переходят между строками', async () => {
    const user = userEvent.setup()
    const onRowActivate = renderTable()

    const first = screen.getByRole('button', { name: 'Окна для склада' })
    first.focus()
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Арка в гостиной' }))
    await user.keyboard('{ArrowDown}{ArrowDown}')
    // На последней строке стрелка вниз фокус не теряет.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Балконный блок' }))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Арка в гостиной' }))

    await user.keyboard('{Enter}')
    expect(onRowActivate).toHaveBeenCalledWith(DEALS[1])
  })

  it('пустая таблица показывает текст вместо строк', () => {
    render(
      <Table
        caption="Сделки"
        rows={[] as Deal[]}
        rowKey={(deal) => deal.id}
        columns={[{ key: 'title', header: 'Название', cell: (deal) => deal.title }]}
        empty="Сделок пока нет"
      />,
    )
    expect(screen.getByRole('cell', { name: 'Сделок пока нет' })).toBeTruthy()
  })
})
