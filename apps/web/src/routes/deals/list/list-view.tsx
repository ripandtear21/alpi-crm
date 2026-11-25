import {
  CUSTOM_FIELD_PREFIX,
  DEFAULT_LIST_COLUMNS,
  EMPTY_FILTER,
  FILTER_FIELD_ENTITY,
  type FilterEntity,
  type FilterGroup,
  hasStandalone,
  LIST_COLUMNS,
  type ProjectAccess,
  type SavedFilterVisibility,
  SORTABLE_COLUMNS,
} from '@alpi/shared'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectQueryKey } from '../../../components/project-switcher/current-project.tsx'
import { Button } from '../../../ui/button.tsx'
import { Checkbox } from '../../../ui/checkbox.tsx'
import { cx } from '../../../ui/cx.ts'
import { Dialog } from '../../../ui/dialog.tsx'
import { Notice, Skeleton } from '../../../ui/feedback.tsx'
import { Field, Input, Select } from '../../../ui/field.tsx'
import { Menu, type MenuItem } from '../../../ui/menu.tsx'
import {
  customColumn,
  customColumnSortable,
  customFieldName,
  customFieldOf,
  formatCustomValue,
  liveFields,
} from './custom-values.ts'
import { conditionCount, FilterEditor, type FilterOptions } from './filter-editor.tsx'
import { type ListRows, type ListsApi, ListsApiError } from './lists-api.ts'
import './lists.css'

// Список с колонками, сортировкой, курсорной подгрузкой и счётчиком (тикет crm-deals/12) —
// общий для сделок, контактов и организаций. Фильтр — тот же формат, что у канбана; выбор
// колонок запоминается у пользователя (в браузере, по пользователю и списку); сохранённые
// фильтры — на сервере. На узком экране (375 px) таблица прокручивается по горизонтали.
// Пользовательские поля (тикет crm-fields/07): колонки и сортировка `custom.<id>`, условия
// фильтра; сохранённый фильтр с недоступным полем открывается с пометкой «умова недоступна».

export interface ListColumnDef<Row> {
  key: string
  cell: (row: Row) => ReactNode
  numeric?: boolean
}

/** Что показать над таблицей при выборе строк (массовые действия сделок). */
export interface SelectionActions {
  selection: { ids: string[] } | { filter: FilterGroup }
  count: number
  clear: () => void
}

const COLUMNS_KEY = 'alpi.list.columns'

function readColumns(userId: string, entity: FilterEntity): string[] | null {
  try {
    const raw = window.localStorage.getItem(`${COLUMNS_KEY}.${userId}.${entity}`)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    const known: readonly string[] = LIST_COLUMNS[entity]
    if (!Array.isArray(parsed)) return null
    // Колонки полей проверяются, когда поля загрузятся: поле могли убрать в архив.
    const columns = parsed.filter(
      (c): c is string =>
        typeof c === 'string' && (known.includes(c) || c.startsWith(CUSTOM_FIELD_PREFIX)),
    )
    return columns.length > 0 ? columns : null
  } catch {
    return null
  }
}

function storeColumns(userId: string, entity: FilterEntity, columns: string[] | null) {
  try {
    const key = `${COLUMNS_KEY}.${userId}.${entity}`
    if (columns === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(columns))
  } catch {
    // Не запомнили — выбор действует до перезагрузки.
  }
}

/** Скачать файл из Blob: ссылка на объект в памяти, щелчок, освобождение. */
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function ListView<E extends FilterEntity>({
  entity,
  api,
  projectId,
  userId,
  title,
  toolbar,
  columns,
  defaultSort,
  initialFilter = EMPTY_FILTER,
  options,
  rowTitle,
  selectable = false,
  renderSelection,
}: {
  entity: E
  api: ListsApi
  projectId: string
  userId: string
  title: string
  /** Дополнительные кнопки рядом с заголовком (например, «Канбан»). */
  toolbar?: ReactNode
  columns: Record<string, ListColumnDef<ListRows[E]>>
  defaultSort: string
  initialFilter?: FilterGroup
  options: FilterOptions
  /** Название строки для доступного имени флажка выбора. */
  rowTitle: (row: ListRows[E]) => string
  selectable?: boolean
  renderSelection?: (actions: SelectionActions, access: ProjectAccess) => ReactNode
}) {
  const { t, i18n } = useTranslation('lists')
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<FilterGroup>(initialFilter)
  const [sort, setSort] = useState(defaultSort)
  const [visible, setVisible] = useState<string[]>(
    () => readColumns(userId, entity) ?? [...DEFAULT_LIST_COLUMNS[entity]],
  )
  const [filterOpen, setFilterOpen] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [allByFilter, setAllByFilter] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)

  const listKey = projectQueryKey(projectId, 'lists', entity)
  const access = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => api.access(projectId),
    retry: false,
  })
  const filterKey = JSON.stringify(filter)
  const page = useInfiniteQuery({
    queryKey: [...listKey, 'page', filterKey, sort],
    queryFn: ({ pageParam }) =>
      api.page(projectId, entity, {
        filter,
        sort,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  })
  const count = useQuery({
    queryKey: [...listKey, 'count', filterKey],
    queryFn: () => api.count(projectId, entity, filter),
    retry: false,
  })
  const saved = useQuery({
    queryKey: [...listKey, 'saved'],
    queryFn: () => api.savedFilters(projectId, entity),
    retry: false,
  })
  const fields = useQuery({
    queryKey: projectQueryKey(projectId, 'lists', 'fields', entity),
    queryFn: () => api.fields(projectId, FILTER_FIELD_ENTITY[entity]),
    retry: false,
  })
  const customFields = liveFields(fields.data)

  const rows = page.data?.pages.flatMap((p) => p.items) ?? []
  const permissions = access.data?.permissions
  const canExport = permissions ? hasStandalone(permissions, 'export') : false
  const sharedFilters = permissions ? hasStandalone(permissions, 'shared_filters') : false
  const number = new Intl.NumberFormat(i18n.language)
  const users = new Map(
    (options.owner ?? options.createdBy ?? []).map((u) => [u.value, u.label] as const),
  )
  const format = { language: i18n.language, users, yes: t('filter.yes'), no: t('filter.no') }
  const allColumns: Record<string, ListColumnDef<ListRows[E]>> = { ...columns }
  for (const field of customFields) {
    allColumns[customColumn(field)] = {
      key: customColumn(field),
      numeric: field.type === 'number' || field.type === 'money',
      cell: (row) =>
        formatCustomValue(
          field,
          (row as { custom?: Record<string, unknown> }).custom?.[field.code],
          format,
        ),
    }
  }
  const shownColumns = visible.filter((key) => allColumns[key])
  const sortableColumns: readonly string[] = SORTABLE_COLUMNS[entity]
  const isSortable = (key: string) =>
    sortableColumns.includes(key) || customColumnSortable(key, customFields)
  const columnLabel = (key: string) => {
    const custom = customFieldOf(key, customFields)
    return custom
      ? customFieldName(custom.field, i18n.language)
      : t(`column.${entity}.${key}` as 'column.deals.title')
  }
  const [sortColumn, sortDirection] = sort.split(':')

  function changeFilter(next: FilterGroup) {
    setFilter(next)
    setSelected(new Set())
    setAllByFilter(false)
    setFilterOpen(false)
  }

  function toggleSort(column: string) {
    const direction = sortColumn === column && sortDirection === 'asc' ? 'desc' : 'asc'
    setSort(`${column}:${direction}`)
  }

  async function exportCsv() {
    setNotice(null)
    try {
      const blob = await api.exportCsv(projectId, entity, {
        filter,
        sort,
        columns: shownColumns,
        lang: i18n.language === 'ru' ? 'ru' : 'uk',
      })
      download(blob, `${entity}-${new Date().toISOString().slice(0, 10)}.csv`)
      setNotice({ kind: 'status', text: t('export.done') })
    } catch {
      setNotice({ kind: 'alert', text: t('export.failed') })
    }
  }

  const savedItems: MenuItem[] = [
    ...(saved.data ?? []).map((item) => ({
      id: `apply-${item.id}`,
      label:
        item.unavailableConditions > 0
          ? t('saved.unavailableMark', { name: item.name })
          : item.name,
      onSelect: () => {
        changeFilter(item.filter)
        setNotice({
          kind: 'status',
          text:
            item.unavailableConditions > 0
              ? t('saved.unavailable', { name: item.name, count: item.unavailableConditions })
              : t('saved.applied', { name: item.name }),
        })
      },
    })),
    { id: 'save', label: t('saved.save'), onSelect: () => setSaveOpen(true) },
    ...(saved.data ?? [])
      .filter((item) => item.canDelete)
      .map((item) => ({
        id: `delete-${item.id}`,
        label: t('saved.delete', { name: item.name }),
        danger: true,
        onSelect: () => {
          void api.deleteFilter(projectId, item.id).then(() => {
            setNotice({ kind: 'status', text: t('saved.deleted') })
            void queryClient.invalidateQueries({ queryKey: [...listKey, 'saved'] })
          })
        },
      })),
  ]

  const loadedIds = rows.map((row) => (row as { id: string }).id)
  const allLoadedSelected = loadedIds.length > 0 && loadedIds.every((id) => selected.has(id))
  const total = count.data?.count ?? 0
  const selection: SelectionActions | null = allByFilter
    ? { selection: { filter }, count: total, clear: () => setAllByFilter(false) }
    : selected.size > 0
      ? {
          selection: { ids: [...selected] },
          count: selected.size,
          clear: () => setSelected(new Set()),
        }
      : null

  const denied = page.error instanceof ListsApiError && page.error.status === 403

  return (
    <section className="list-page">
      <div className="list-head">
        <h1>{title}</h1>
        {toolbar}
      </div>
      <div className="list-toolbar">
        <Button size="sm" onClick={() => setFilterOpen(true)}>
          {conditionCount(filter) > 0
            ? t('filter.buttonCount', { count: conditionCount(filter) })
            : t('filter.button')}
        </Button>
        <Menu label={t('saved.button')} size="sm" items={savedItems} />
        <Button size="sm" onClick={() => setColumnsOpen(true)}>
          {t('columns.button')}
        </Button>
        {canExport && (
          <Button size="sm" onClick={() => void exportCsv()}>
            {t('export.button')}
          </Button>
        )}
        {count.data && (
          <span className="list-count" aria-live="polite">
            {t(count.data.approximate ? 'countApprox' : 'count', {
              total: number.format(count.data.count),
            })}
          </span>
        )}
      </div>
      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {selectable && selection && access.data && (
        <section className="list-selection" aria-label={t('select.actions')}>
          <span>
            {allByFilter
              ? t('select.allByFilterChosen', { count: total })
              : t('select.selected', { count: selected.size })}
          </span>
          {!allByFilter && total > selected.size && (
            <Button size="sm" variant="quiet" onClick={() => setAllByFilter(true)}>
              {t('select.allByFilter', { count: total })}
            </Button>
          )}
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setSelected(new Set())
              setAllByFilter(false)
            }}
          >
            {t('select.clear')}
          </Button>
          {renderSelection?.(selection, access.data)}
        </section>
      )}
      {page.isPending ? (
        <Skeleton label={t('loading')} />
      ) : page.isError ? (
        <Notice kind="alert">{denied ? t('noAccess') : t('loadFailed')}</Notice>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table list-table">
            <caption className="visually-hidden">
              {t(`${entity}.caption` as 'deals.caption')}
            </caption>
            <thead>
              <tr>
                {selectable && (
                  <th scope="col" className="list-table__check">
                    <Checkbox
                      label={<span className="visually-hidden">{t('select.all')}</span>}
                      checked={allLoadedSelected || allByFilter}
                      onChange={() => {
                        setAllByFilter(false)
                        setSelected(allLoadedSelected ? new Set() : new Set(loadedIds))
                      }}
                    />
                  </th>
                )}
                {shownColumns.map((key) => {
                  const header = columnLabel(key)
                  const active = sortColumn === key
                  return (
                    <th
                      key={key}
                      scope="col"
                      className={cx(allColumns[key]?.numeric && 'ui-table__num')}
                      aria-sort={
                        isSortable(key)
                          ? active
                            ? sortDirection === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                          : undefined
                      }
                    >
                      {isSortable(key) ? (
                        <button
                          type="button"
                          className="ui-table__sort"
                          onClick={() => toggleSort(key)}
                        >
                          {header}
                          <span aria-hidden="true">
                            {active ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
                          </span>
                        </button>
                      ) : (
                        header
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={shownColumns.length + (selectable ? 1 : 0)}>{t('empty')}</td>
                </tr>
              ) : (
                rows.map((row) => {
                  const id = (row as { id: string }).id
                  return (
                    <tr key={id}>
                      {selectable && (
                        <td className="list-table__check">
                          <Checkbox
                            label={
                              <span className="visually-hidden">
                                {t('select.row', { title: rowTitle(row) })}
                              </span>
                            }
                            checked={allByFilter || selected.has(id)}
                            onChange={() => {
                              setAllByFilter(false)
                              setSelected((current) => {
                                const next = new Set(current)
                                if (next.has(id)) next.delete(id)
                                else next.add(id)
                                return next
                              })
                            }}
                          />
                        </td>
                      )}
                      {shownColumns.map((key) => (
                        <td key={key} className={cx(allColumns[key]?.numeric && 'ui-table__num')}>
                          {allColumns[key]?.cell(row)}
                        </td>
                      ))}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}
      {page.hasNextPage && (
        <Button
          size="sm"
          disabled={page.isFetchingNextPage}
          onClick={() => void page.fetchNextPage()}
        >
          {t('more')}
        </Button>
      )}

      {filterOpen && (
        <FilterEditor
          entity={entity}
          open
          value={filter}
          options={options}
          customFields={customFields}
          onApply={changeFilter}
          onClose={() => setFilterOpen(false)}
        />
      )}
      {columnsOpen && (
        <ColumnsDialog
          available={Object.keys(allColumns)}
          label={columnLabel}
          value={shownColumns}
          onApply={(next) => {
            setVisible(next)
            storeColumns(userId, entity, next)
            setColumnsOpen(false)
          }}
          onReset={() => {
            setVisible([...DEFAULT_LIST_COLUMNS[entity]])
            storeColumns(userId, entity, null)
            setColumnsOpen(false)
          }}
          onClose={() => setColumnsOpen(false)}
        />
      )}
      {saveOpen && (
        <SaveFilterDialog
          shared={sharedFilters}
          project={
            sharedFilters && permissions !== undefined && permissions.scopes.deals.read === 'all'
          }
          onClose={() => setSaveOpen(false)}
          onSave={async (name, visibility) => {
            try {
              await api.saveFilter(projectId, { entity, name, visibility, filter })
              setSaveOpen(false)
              setNotice({ kind: 'status', text: t('saved.saved', { name }) })
              void queryClient.invalidateQueries({ queryKey: [...listKey, 'saved'] })
              return true
            } catch {
              return false
            }
          }}
        />
      )}
    </section>
  )
}

function ColumnsDialog({
  available,
  label,
  value,
  onApply,
  onReset,
  onClose,
}: {
  available: string[]
  label: (key: string) => string
  value: string[]
  onApply: (columns: string[]) => void
  onReset: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('lists')
  const [chosen, setChosen] = useState(() => new Set(value))
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('columns.title')}
      footer={
        <>
          <Button variant="quiet" onClick={onReset}>
            {t('columns.reset')}
          </Button>
          <Button
            variant="primary"
            disabled={chosen.size === 0}
            onClick={() => onApply(available.filter((key) => chosen.has(key)))}
          >
            {t('columns.apply')}
          </Button>
        </>
      }
    >
      <div className="list-columns">
        {available.map((key) => (
          <Checkbox
            key={key}
            label={label(key)}
            checked={chosen.has(key)}
            onChange={() =>
              setChosen((current) => {
                const next = new Set(current)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
            }
          />
        ))}
      </div>
    </Dialog>
  )
}

function SaveFilterDialog({
  shared,
  project,
  onSave,
  onClose,
}: {
  /** Право «общие фильтры»: можно сохранить для команды. */
  shared: boolean
  /** Ещё и для проекта (охват «все»). */
  project: boolean
  onSave: (name: string, visibility: SavedFilterVisibility) => Promise<boolean>
  onClose: () => void
}) {
  const { t } = useTranslation('lists')
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<SavedFilterVisibility>('personal')
  const [failed, setFailed] = useState(false)
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('saved.title')}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {t('saved.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={name.trim() === ''}
            onClick={() => void onSave(name.trim(), visibility).then((ok) => setFailed(!ok))}
          >
            {t('saved.submit')}
          </Button>
        </>
      }
    >
      <Field label={t('saved.name')}>
        <Input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t('saved.visibility')}>
        <Select
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as SavedFilterVisibility)}
        >
          <option value="personal">{t('saved.personal')}</option>
          {shared && <option value="team">{t('saved.team')}</option>}
          {project && <option value="project">{t('saved.project')}</option>}
        </Select>
      </Field>
      {failed && <Notice kind="alert">{t('saved.failed')}</Notice>}
    </Dialog>
  )
}
