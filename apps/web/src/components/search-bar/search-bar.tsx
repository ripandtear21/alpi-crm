import type { ProjectSummary } from '@alpi/shared'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type KeyboardEvent, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../layout/use-media-query.ts'
import { Badge } from '../../ui/badge.tsx'
import { cx } from '../../ui/cx.ts'
import { Dialog } from '../../ui/dialog.tsx'
import { projectQueryKey, useCurrentProject } from '../project-switcher/current-project.tsx'
import {
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  type SearchApi,
  SearchApiError,
  type SearchDealHit,
  type SearchResults,
} from './search-api.ts'
import './search-bar.css'

// Строка поиска в шапке (тикет crm-deals/15; spec.md MVP, раздел 5.4): запрос к API через паузу
// после ввода, выпадающий список с группами «Угоди», «Контакти», «Організації» — в нём только
// то, что вернул сервер (охват роли держит API). Шаблон WAI-ARIA «combobox» со списком: фокус
// остаётся в поле, стрелки выделяют результат, Enter открывает его по ссылке с проектом, Esc
// закрывает список. На телефоне поле в шапке — кнопка, поиск открывается во весь экран.

/** Пауза после ввода, после которой уходит запрос. */
export const SEARCH_DEBOUNCE_MS = 250

type Kind = 'deals' | 'contacts' | 'organizations'
const KINDS: readonly Kind[] = ['deals', 'contacts', 'organizations']

type Hit = { kind: Kind; id: string; label: string; deal?: SearchDealHit }

function hitsOf(results: SearchResults): Hit[] {
  return [
    ...results.deals.items.map((deal) => ({
      kind: 'deals' as const,
      id: deal.id,
      label: deal.title,
      deal,
    })),
    ...results.contacts.items.map((contact) => ({
      kind: 'contacts' as const,
      id: contact.id,
      label: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
    })),
    ...results.organizations.items.map((organization) => ({
      kind: 'organizations' as const,
      id: organization.id,
      label: organization.name,
    })),
  ]
}

export function SearchBar({ api }: { api: SearchApi }) {
  const { t } = useTranslation('layout')
  const { current } = useCurrentProject()
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY)
  const [dialogOpen, setDialogOpen] = useState(false)

  // Вне проекта искать негде: поле на своём месте, но неактивно.
  if (!current) {
    return (
      <input
        type="search"
        className="ui-input app-header__search"
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        disabled
      />
    )
  }

  if (isMobile) {
    return (
      <>
        <button
          type="button"
          className="ui-input app-header__search search-bar__trigger"
          aria-haspopup="dialog"
          onClick={() => setDialogOpen(true)}
        >
          <span className="vh">{t('search.open')}</span>
          <span aria-hidden="true">{t('search.placeholder')}</span>
        </button>
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title={t('search.label')}
          className="search-dialog"
        >
          {dialogOpen && (
            <SearchBox
              key={current.id}
              api={api}
              project={current}
              inline
              onDone={() => setDialogOpen(false)}
            />
          )}
        </Dialog>
      </>
    )
  }

  return (
    <SearchBox
      key={current.id}
      api={api}
      project={current}
      inline={false}
      className="app-header__search"
    />
  )
}

function SearchBox({
  api,
  project,
  inline,
  className,
  onDone,
}: {
  api: SearchApi
  project: ProjectSummary
  /** Список под полем в потоке страницы (поиск во весь экран), а не всплывающий. */
  inline: boolean
  className?: string
  /** Результат открыт: закрыть поиск во весь экран. */
  onDone?: () => void
}) {
  const { t } = useTranslation('layout')
  const navigate = useNavigate()
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (index: number) => `${baseId}-option-${index}`
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const trimmed = text.trim()
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(trimmed), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [trimmed])

  const searchable = query.length >= SEARCH_MIN_LENGTH
  const results = useQuery({
    queryKey: projectQueryKey(project.id, 'search', query),
    queryFn: ({ signal }) => api.search(project.id, query, signal),
    enabled: searchable,
    retry: false,
    staleTime: 30_000,
  })

  // Результаты — только к тому, что сейчас в поле: пока пауза не прошла, старые не выбираются.
  const settled = searchable && query === trimmed
  const hits = settled && results.data ? hitsOf(results.data) : []
  const showList = (open || inline) && trimmed.length >= SEARCH_MIN_LENGTH
  const activeHit = showList ? hits[active] : undefined

  function choose(hit: Hit) {
    setOpen(false)
    setActive(-1)
    setText('')
    onDone?.()
    const code = project.code
    if (hit.kind === 'deals') {
      void navigate({ to: '/p/$code/deals/$dealId', params: { code, dealId: hit.id } })
    } else if (hit.kind === 'contacts') {
      void navigate({ to: '/p/$code/contacts/$contactId', params: { code, contactId: hit.id } })
    } else {
      void navigate({
        to: '/p/$code/organizations/$organizationId',
        params: { code, organizationId: hit.id },
      })
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      if (hits.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) =>
        index === -1 && step === -1 ? hits.length - 1 : (index + step + hits.length) % hits.length,
      )
      return
    }
    if (event.key === 'Enter' && activeHit) {
      event.preventDefault()
      choose(activeHit)
      return
    }
    if (event.key === 'Escape' && showList && !inline) {
      event.preventDefault()
      setOpen(false)
      setActive(-1)
    }
  }

  let status: string | null = null
  if (showList) {
    if (!settled || results.isPending) status = t('search.loading')
    else if (results.isError) {
      status =
        results.error instanceof SearchApiError && results.error.status === 403
          ? t('search.forbidden')
          : t('search.failed')
    } else if (hits.length === 0) status = t('search.empty')
  }
  const hasMore =
    settled && results.data !== undefined && KINDS.some((kind) => results.data[kind].hasMore)

  return (
    <div className={cx('search-bar', inline && 'search-bar--inline', className)}>
      <input
        type="search"
        role="combobox"
        className="ui-input search-bar__input"
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        value={text}
        maxLength={SEARCH_MAX_LENGTH}
        autoComplete="off"
        // biome-ignore lint/a11y/noAutofocus: поиск во весь экран открыли ради ввода — фокус сразу в поле
        autoFocus={inline}
        aria-autocomplete="list"
        aria-expanded={showList && hits.length > 0}
        aria-controls={listId}
        aria-activedescendant={activeHit ? optionId(active) : undefined}
        onChange={(event) => {
          setText(event.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {showList && (
        <div className="search-bar__popup ui-popup">
          {hits.length > 0 && (
            <div id={listId} role="listbox" aria-label={t('search.results')}>
              {KINDS.map((kind) => {
                const group = hits
                  .map((hit, index) => ({ hit, index }))
                  .filter(({ hit }) => hit.kind === kind)
                if (group.length === 0) return null
                const groupId = `${baseId}-${kind}`
                return (
                  // biome-ignore lint/a11y/useSemanticElements: группа вариантов внутри listbox — role="group" по шаблону WAI-ARIA, <fieldset> там недопустим
                  <div key={kind} role="group" aria-labelledby={groupId}>
                    <div id={groupId} role="presentation" className="search-bar__group">
                      {t(`search.groups.${kind}`)}
                    </div>
                    {group.map(({ hit, index }) => (
                      <div
                        key={hit.id}
                        id={optionId(index)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={index === active}
                        className="ui-popup__item search-bar__item"
                        // mousedown, а не click: поле не теряет фокус до выбора.
                        onMouseDown={(event) => {
                          event.preventDefault()
                          choose(hit)
                        }}
                      >
                        <span className="search-bar__label">{hit.label}</span>
                        {hit.deal && <DealMarks deal={hit.deal} />}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
          {status && (
            <p className="ui-popup__empty" role="status">
              {status}
            </p>
          )}
          {hits.length > 0 && hasMore && <p className="ui-popup__empty">{t('search.more')}</p>}
        </div>
      )}
    </div>
  )
}

/** Пометки сделки в выдаче: архив и итог (выиграна, проиграна). */
function DealMarks({ deal }: { deal: SearchDealHit }) {
  const { t } = useTranslation('layout')
  return (
    <span className="ui-popup__hint search-bar__marks">
      {deal.status !== 'open' && (
        <Badge tone={deal.status === 'won' ? 'win' : 'danger'}>
          {t(`search.status.${deal.status}`)}
        </Badge>
      )}
      {deal.archivedAt !== null && <Badge>{t('search.archived')}</Badge>}
    </span>
  )
}
