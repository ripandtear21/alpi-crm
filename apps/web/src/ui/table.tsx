import { type KeyboardEvent, type ReactNode, useState } from 'react'
import { cx } from './cx.ts'

export type TableColumn<Row> = {
  key: string
  header: ReactNode
  cell: (row: Row) => ReactNode
  /** Есть — столбец сортируется кнопкой в заголовке. */
  sortValue?: (row: Row) => string | number
  /** Числа и деньги: по правому краю, цифры Martian. */
  numeric?: boolean
}

type Sort = { key: string; direction: 'ascending' | 'descending' }

type TableProps<Row> = {
  caption: ReactNode
  columns: TableColumn<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
  /** Есть — первая ячейка строки становится кнопкой, растянутой на всю строку. */
  onRowActivate?: (row: Row) => void
  /** Доступное имя кнопки строки; по умолчанию — текст первой ячейки. */
  rowLabel?: (row: Row) => string
  /** Текст вместо строк, когда их нет. */
  empty?: ReactNode
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compare(a: string | number, b: string | number): number {
  return typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(`${a}`, `${b}`)
}

/**
 * Таблица данных. С клавиатуры: Tab до кнопки сортировки в заголовке, Enter или пробел
 * меняют порядок; Tab до строки, стрелки вверх и вниз — соседние строки, Enter открывает.
 */
export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
  onRowActivate,
  rowLabel,
  empty,
}: TableProps<Row>) {
  const [sort, setSort] = useState<Sort | null>(null)
  const sortColumn = sort && columns.find((column) => column.key === sort.key)
  const getValue = sortColumn?.sortValue
  const sorted = getValue
    ? [...rows].sort(
        (a, b) => compare(getValue(a), getValue(b)) * (sort?.direction === 'descending' ? -1 : 1),
      )
    : rows

  function toggleSort(key: string) {
    setSort((current) =>
      current?.key === key && current.direction === 'ascending'
        ? { key, direction: 'descending' }
        : { key, direction: 'ascending' },
    )
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const body = event.currentTarget.closest('tbody')
    const buttons = Array.from(
      body?.querySelectorAll<HTMLButtonElement>('.ui-table__row-link') ?? [],
    )
    const index = buttons.indexOf(event.currentTarget)
    buttons[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
  }

  return (
    <div className="ui-table-wrap">
      <table className="ui-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(column.numeric && 'ui-table__num')}
                aria-sort={
                  column.sortValue
                    ? sort?.key === column.key
                      ? sort.direction
                      : 'none'
                    : undefined
                }
              >
                {column.sortValue ? (
                  <button
                    type="button"
                    className="ui-table__sort"
                    onClick={() => toggleSort(column.key)}
                  >
                    {column.header}
                    <span aria-hidden="true">
                      {sort?.key === column.key
                        ? sort.direction === 'ascending'
                          ? '↑'
                          : '↓'
                        : '↕'}
                    </span>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            sorted.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column, index) => (
                  <td key={column.key} className={cx(column.numeric && 'ui-table__num')}>
                    {index === 0 && onRowActivate ? (
                      <button
                        type="button"
                        className="ui-table__row-link"
                        aria-label={rowLabel?.(row)}
                        onClick={() => onRowActivate(row)}
                        onKeyDown={onRowKeyDown}
                      >
                        {column.cell(row)}
                      </button>
                    ) : (
                      column.cell(row)
                    )}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
