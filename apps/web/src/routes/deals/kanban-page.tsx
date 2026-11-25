import {
  EMPTY_FILTER,
  type FieldDefinitionSummary,
  type FilterGroup,
  type PipelineSummary,
  type RequiredFieldsMissing,
  type StageSummary,
} from '@alpi/shared'
import {
  type InfiniteData,
  type QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { type DragEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CustomValues } from '../../components/custom-fields/custom-fields-api.tsx'
import { readRequiredFieldsMissing } from '../../components/custom-fields/required-fields.ts'
import {
  RequiredFieldsDialog,
  useMissingFieldsText,
} from '../../components/custom-fields/required-fields-form.tsx'
import { DealCard, formatMoney } from '../../components/deal-card/deal-card.tsx'
import {
  projectHref,
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import { useMediaQuery } from '../../layout/use-media-query.ts'
import { Badge } from '../../ui/badge.tsx'
import { Button, buttonClass } from '../../ui/button.tsx'
import { cx } from '../../ui/cx.ts'
import { Skeleton } from '../../ui/feedback.tsx'
import { Field, Select } from '../../ui/field.tsx'
import type { MenuItem } from '../../ui/menu.tsx'
import { Tabs } from '../../ui/tabs.tsx'
import {
  type BoardDeal,
  type DealsApi,
  DealsApiError,
  type DealsPage,
  type OwnerFilter,
  type StageAggregate,
} from './deals-api.ts'
import {
  type CustomFormat,
  customFieldName,
  formatCustomValue,
  liveFields,
} from './list/custom-values.ts'
import { conditionCount, FilterEditor } from './list/filter-editor.tsx'
import { dealFilterOptions } from './list/filter-options.ts'
import { LostDialog } from './lost-dialog.tsx'
import { NewDealDialog } from './new-deal-dialog.tsx'
import './kanban.css'

// Экран «Угоди» — канбан выбранной воронки (тикет crm-deals/11; spec.md MVP, раздел 5.1).
//
// - Колонки — действующие этапы воронки; карточки — открытые неархивные сделки, которые отдал
//   API (охват соблюдает сервер). Каждая колонка грузит страницу из 50 и подгружает остальные
//   при прокрутке, но не больше COLUMN_LIMIT: дальше — ссылка «ще N — відкрити списком».
// - Шапка колонки — число и суммы по валютам из запроса агрегатов, а не из загруженных карточек.
// - Перетаскивание между колонками — смена этапа, на «Виграно» — выигрыш, на «Програно» —
//   диалог причины. Карточка переезжает сразу; отказ API возвращает её на место с сообщением
//   (например, список полей, которых требует этап).
// - Телефон (≤ 768 px): одна колонка, этапы — вкладками с числом сделок, без перетаскивания;
//   этап, выигрыш и проигрыш — в меню карточки (оно есть и на широком экране — для клавиатуры).
// - Экран меняет сделку только действием пользователя (ADR 0003).
// - Обязательные поля (тикет crm-fields/04): отказ 422 смены этапа или выигрыша возвращает
//   карточку на место и открывает форму заполнения незаполненных полей; «Зберегти» повторяет
//   действие вместе со значениями, отмена оставляет карточку на месте.

/** Сколько карточек колонка подгружает прокруткой; дальше — список с фильтром этапа. */
export const COLUMN_LIMIT = 500
const PHONE_QUERY = '(max-width: 768px)'
const PIPELINE_STORAGE_KEY = 'alpi.kanban.pipeline'

type Notice = { kind: 'status' | 'alert'; text: string } | null

/** Открытая форма заполнения: отказ API и повтор действия со значениями. */
interface Filling {
  title: string
  deal: BoardDeal
  missing: RequiredFieldsMissing
  retry: (custom: CustomValues) => void
}

function readStoredPipeline(projectId: string): string | null {
  try {
    return window.localStorage.getItem(`${PIPELINE_STORAGE_KEY}.${projectId}`)
  } catch {
    return null
  }
}

function storePipeline(projectId: string, pipelineId: string) {
  try {
    window.localStorage.setItem(`${PIPELINE_STORAGE_KEY}.${projectId}`, pipelineId)
  } catch {
    // Не запомнили — воронка всё равно выбрана до перезагрузки.
  }
}

/**
 * Экран со своим QueryClientProvider: клиент — из контекста маршрута, тот же, что у всего
 * приложения (main.tsx), поэтому кэш общий, а экран работает и там, где провайдера выше нет.
 */
export function KanbanPage({
  api,
  userId,
  queryClient,
  pipelineId,
  onPipelineChange,
}: {
  api: DealsApi
  userId: string
  queryClient: QueryClient
  /** Воронка из адреса; нет — выбранная в прошлый раз или первая. */
  pipelineId?: string | undefined
  /** Показана другая воронка: адрес меняется на неё (тикет crm-deals/15). */
  onPipelineChange?: (pipelineId: string) => void
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <Kanban
        api={api}
        userId={userId}
        pipelineId={pipelineId}
        onPipelineChange={onPipelineChange}
      />
    </QueryClientProvider>
  )
}

type PipelineInAddress = {
  pipelineId?: string | undefined
  onPipelineChange?: ((pipelineId: string) => void) | undefined
}

function Kanban({
  api,
  userId,
  pipelineId,
  onPipelineChange,
}: { api: DealsApi; userId: string } & PipelineInAddress) {
  const { t } = useTranslation('deals')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('kanban.title')}</h1>
        <p>{t('kanban.noProject')}</p>
      </section>
    )
  }
  return (
    <Board
      key={current.id}
      api={api}
      projectId={current.id}
      projectCode={current.code}
      userId={userId}
      pipelineId={pipelineId}
      onPipelineChange={onPipelineChange}
    />
  )
}

/**
 * Адрес списка сделок с тем, что видно на канбане: воронка, этап колонки (если есть), фильтр
 * и выбранный ответственный (в списке это условие фильтра).
 */
function listHref(
  projectCode: string,
  pipelineId: string,
  stageId: string | undefined,
  filter: FilterGroup,
  owner: OwnerFilter | undefined,
): string {
  const parts: FilterGroup[] = conditionCount(filter) > 0 ? [filter] : []
  if (owner === 'none') parts.push({ and: [{ field: 'owner', op: 'empty' }] })
  else if (owner !== undefined) parts.push({ and: [{ field: 'owner', op: 'eq', value: owner }] })
  const params: Record<string, string> = { pipeline: pipelineId }
  if (stageId) params.stage = stageId
  if (parts.length > 0)
    params.filter = JSON.stringify(parts.length === 1 ? parts[0] : { and: parts })
  return projectHref(projectCode, `/deals/list?${new URLSearchParams(params)}`)
}

/** Ключи запросов канбана проекта: всё под одним префиксом, чтобы обновлять разом. */
const boardKey = (projectId: string, ...rest: unknown[]) =>
  projectQueryKey(projectId, 'deals', 'board', ...rest)

/** Позиция id этапа в ключе колонки: [project, id, deals, board, column, pipeline, stage, owner]. */
const STAGE_IN_KEY = 6

function Board({
  api,
  projectId,
  projectCode,
  userId,
  pipelineId,
  onPipelineChange,
}: {
  api: DealsApi
  projectId: string
  projectCode: string
  userId: string
} & PipelineInAddress) {
  const { t, i18n } = useTranslation('deals')
  const { t: tl } = useTranslation('lists')
  const queryClient = useQueryClient()
  const phone = useMediaQuery(PHONE_QUERY)
  const [storedPipeline, setStoredPipeline] = useState(() => readStoredPipeline(projectId))
  const [owner, setOwner] = useState<OwnerFilter | undefined>(undefined)
  const [notice, setNotice] = useState<Notice>(null)
  const [creating, setCreating] = useState(false)
  const [losing, setLosing] = useState<BoardDeal | null>(null)
  const [dragged, setDragged] = useState<BoardDeal | null>(null)
  const [filling, setFilling] = useState<Filling | null>(null)
  const missingText = useMissingFieldsText()
  // Фильтр канбана — тот же формат и та же выдача API, что у списка сделок (тикет crm-deals/12).
  const [filter, setFilter] = useState<FilterGroup>(EMPTY_FILTER)
  const [filterOpen, setFilterOpen] = useState(false)
  const filterKey = JSON.stringify(filter)
  const filters = conditionCount(filter)

  const pipelines = useQuery({
    queryKey: boardKey(projectId, 'pipelines'),
    queryFn: () => api.pipelines(projectId),
    retry: false,
  })
  const owners = useQuery({
    queryKey: boardKey(projectId, 'owners'),
    queryFn: () => api.owners(projectId),
    retry: false,
  })
  const active = (pipelines.data ?? []).filter((p) => p.archivedAt === null)
  const pipeline =
    active.find((p) => p.id === (pipelineId ?? storedPipeline)) ??
    active.find((p) => p.id === storedPipeline) ??
    active[0]
  // В адресе — показанная воронка: и когда её там не было, и когда там чужая или архивная.
  const shownPipelineId = pipeline?.id
  useEffect(() => {
    if (shownPipelineId !== undefined && shownPipelineId !== pipelineId) {
      onPipelineChange?.(shownPipelineId)
    }
  }, [shownPipelineId, pipelineId, onPipelineChange])
  const ownerKey = owner ?? 'all'
  const aggregates = useQuery({
    queryKey: boardKey(projectId, 'aggregates', pipeline?.id, ownerKey, filterKey),
    queryFn: () => api.aggregates(projectId, pipeline?.id ?? '', owner, filter),
    enabled: pipeline !== undefined,
    retry: false,
  })
  // Пользовательские поля (тикет crm-fields/07): условия фильтра и до 3 полей на карточке,
  // их выбирает администратор в настройках воронки.
  const fields = useQuery({
    queryKey: boardKey(projectId, 'fields'),
    queryFn: () => api.fields(projectId),
    retry: false,
  })
  const cardFieldIds = useQuery({
    queryKey: boardKey(projectId, 'card-fields', pipeline?.id),
    queryFn: () => api.cardFields(projectId, pipeline?.id ?? ''),
    enabled: pipeline !== undefined,
    retry: false,
  })
  // Права роли: поля групп «только чтение» форма заполнения показывает без правки (тикет
  // crm-fields/04). Тот же ключ, что у карточки сделки и списков: один запрос на проект.
  const access = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => api.access(projectId),
    retry: false,
  })
  const customFields = liveFields(fields.data)
  const cardFields = (cardFieldIds.data?.fieldIds ?? []).flatMap((id) =>
    customFields.filter((f) => f.id === id),
  )
  const cardFormat: CustomFormat = {
    language: i18n.language,
    users: new Map((owners.data ?? []).map((o) => [o.id, o.name] as const)),
    yes: t('card.yes'),
    no: t('card.no'),
  }
  const lostReasons = useQuery({
    queryKey: boardKey(projectId, 'lost-reasons'),
    queryFn: () => api.lostReasons(projectId),
    enabled: losing !== null,
    retry: false,
  })

  const header = (
    <div className="kanban-head">
      <h1>{t('kanban.title')}</h1>
      {pipeline && (
        <div className="kanban-toolbar">
          <Field label={t('kanban.pipeline')} className="kanban-toolbar__field">
            <Select
              size="sm"
              value={pipeline.id}
              onChange={(event) => {
                storePipeline(projectId, event.target.value)
                setStoredPipeline(event.target.value)
                onPipelineChange?.(event.target.value)
              }}
            >
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('kanban.owner')} className="kanban-toolbar__field">
            <Select
              size="sm"
              value={ownerKey}
              onChange={(event) =>
                setOwner(event.target.value === 'all' ? undefined : event.target.value)
              }
            >
              <option value="all">{t('kanban.ownerAll')}</option>
              <option value="me">{t('kanban.ownerMe')}</option>
              <option value="none">{t('kanban.ownerNone')}</option>
              {(owners.data ?? [])
                .filter((o) => o.id !== userId)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Button size="sm" onClick={() => setFilterOpen(true)}>
            {filters > 0 ? tl('filter.buttonCount', { count: filters }) : tl('filter.button')}
          </Button>
          <a
            className={buttonClass({ size: 'sm' })}
            href={listHref(projectCode, pipeline.id, undefined, filter, owner)}
          >
            {tl('listView')}
          </a>
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            {t('kanban.newDeal')}
          </Button>
        </div>
      )}
      {filterOpen && (
        <FilterEditor
          entity="deals"
          open
          value={filter}
          options={dealFilterOptions(active, owners.data ?? [])}
          customFields={customFields}
          onApply={(next) => {
            setFilter(next)
            setFilterOpen(false)
          }}
          onClose={() => setFilterOpen(false)}
        />
      )}
    </div>
  )

  if (pipelines.isPending) {
    return (
      <section>
        {header}
        <Skeleton label={t('kanban.loading')} />
      </section>
    )
  }
  if (pipelines.isError) {
    const denied = pipelines.error instanceof DealsApiError && pipelines.error.status === 403
    return (
      <section>
        {header}
        <p className="ui-notice" role="alert">
          {denied ? t('kanban.noAccess') : t('kanban.loadFailed')}
        </p>
      </section>
    )
  }
  if (!pipeline) {
    return (
      <section>
        {header}
        <p>{t('kanban.noPipelines')}</p>
      </section>
    )
  }

  const stages = pipeline.stages
  const aggregateOf = (stageId: string): StageAggregate | undefined =>
    aggregates.data?.stages.find((s) => s.stageId === stageId)

  function errorText(error: unknown): string {
    if (!(error instanceof DealsApiError)) return t('errors.unknown')
    const missing = readRequiredFieldsMissing(error.code, error.details)
    if (missing) {
      return error.code === 'STAGE_REQUIREMENTS_MISSING'
        ? t('errors.STAGE_REQUIREMENTS_MISSING', { fields: missingText(missing) })
        : t('errors.REQUIRED_FIELDS_MISSING', { fields: missingText(missing) })
    }
    return t(`errors.${error.code}`, { defaultValue: t('errors.unknown') })
  }

  // ---- Действия: карточка меняется сразу, отказ возвращает кэш колонок как был ----------------

  const columnsKey = boardKey(projectId, 'column', pipeline.id)

  function editColumns(edit: (page: DealsPage, stageId: unknown, index: number) => DealsPage) {
    for (const query of queryClient.getQueryCache().findAll({ queryKey: columnsKey })) {
      const stageId = query.queryKey[STAGE_IN_KEY]
      queryClient.setQueryData<InfiniteData<DealsPage>>(query.queryKey, (data) =>
        data ? { ...data, pages: data.pages.map((page, i) => edit(page, stageId, i)) } : data,
      )
    }
  }

  const withoutDeal = (dealId: string) => (page: DealsPage) => ({
    ...page,
    items: page.items.filter((d) => d.id !== dealId),
  })

  /**
   * Действие с карточкой: `onMissing` — что делать с отказом о незаполненных обязательных
   * полях (открыть форму заполнения); без него отказ — сообщением.
   */
  async function perform(
    change: () => Promise<void>,
    optimistic: () => void,
    done: string,
    onMissing?: (missing: RequiredFieldsMissing) => void,
  ) {
    setNotice(null)
    await queryClient.cancelQueries({ queryKey: columnsKey })
    const snapshot = queryClient.getQueriesData<InfiniteData<DealsPage>>({ queryKey: columnsKey })
    optimistic()
    try {
      await change()
      setNotice({ kind: 'status', text: done })
    } catch (error) {
      for (const [key, data] of snapshot) queryClient.setQueryData(key, data)
      const missing =
        error instanceof DealsApiError ? readRequiredFieldsMissing(error.code, error.details) : null
      if (missing && onMissing) onMissing(missing)
      else setNotice({ kind: 'alert', text: errorText(error) })
    } finally {
      void queryClient.invalidateQueries({ queryKey: boardKey(projectId) })
    }
  }

  function moveDeal(deal: BoardDeal, stage: StageSummary, custom?: CustomValues) {
    if (deal.stageId === stage.id) return
    const moved = { ...deal, stageId: stage.id }
    void perform(
      () => api.changeStage(projectId, deal.id, stage.id, custom),
      () => {
        const remove = withoutDeal(deal.id)
        editColumns((page, stageId, index) => {
          const rest = remove(page)
          return stageId === stage.id && index === 0
            ? { ...rest, items: [moved, ...rest.items] }
            : rest
        })
      },
      t('kanban.moved', { title: deal.title, stage: stage.name }),
      (missing) =>
        setFilling({
          title: t('fill.stage', { stage: stage.name }),
          deal,
          missing,
          retry: (values) => moveDeal(deal, stage, values),
        }),
    )
  }

  function winDeal(deal: BoardDeal, custom?: CustomValues) {
    void perform(
      () => api.win(projectId, deal.id, custom),
      () => editColumns(withoutDeal(deal.id)),
      t('kanban.won', { title: deal.title }),
      (missing) =>
        setFilling({
          title: t('fill.win'),
          deal,
          missing,
          retry: (values) => winDeal(deal, values),
        }),
    )
  }

  function loseDeal(deal: BoardDeal, lostReasonId: string) {
    setLosing(null)
    void perform(
      () => api.lose(projectId, deal.id, lostReasonId),
      () => editColumns(withoutDeal(deal.id)),
      t('kanban.lost', { title: deal.title }),
    )
  }

  function takeDeal(deal: BoardDeal) {
    void perform(
      () => api.take(projectId, deal.id),
      () => undefined,
      t('kanban.taken', { title: deal.title }),
    )
  }

  function actionsFor(deal: BoardDeal): MenuItem[] {
    return [
      ...stages
        .filter((stage) => stage.id !== deal.stageId)
        .map((stage) => ({
          id: `stage-${stage.id}`,
          label: t('card.moveTo', { stage: stage.name }),
          onSelect: () => moveDeal(deal, stage),
        })),
      { id: 'win', label: t('card.win'), onSelect: () => winDeal(deal) },
      { id: 'lose', label: t('card.lose'), danger: true, onSelect: () => setLosing(deal) },
    ]
  }

  const column = (stage: StageSummary) => (
    <StageColumn
      key={stage.id}
      api={api}
      projectId={projectId}
      projectCode={projectCode}
      pipeline={pipeline}
      stage={stage}
      owner={owner}
      filter={filter}
      aggregate={aggregateOf(stage.id)}
      phone={phone}
      dragged={dragged}
      onDragStart={setDragged}
      onDragEnd={() => setDragged(null)}
      onDrop={(deal) => {
        // Карточка уезжает из колонки сразу: dragend с убранного узла может не прийти.
        setDragged(null)
        moveDeal(deal, stage)
      }}
      actionsFor={actionsFor}
      onTake={takeDeal}
      cardFields={cardFields}
      cardFormat={cardFormat}
    />
  )

  return (
    <section className="kanban">
      {header}
      {notice && (
        <p className="ui-notice" role={notice.kind}>
          {notice.text}
        </p>
      )}
      {stages.length === 0 ? (
        <p>{t('kanban.noStages')}</p>
      ) : phone ? (
        <Tabs
          label={t('kanban.stages')}
          tabs={stages.map((stage) => ({
            id: stage.id,
            label: (
              <>
                {stage.name} <Badge>{aggregateOf(stage.id)?.count ?? 0}</Badge>
              </>
            ),
            content: column(stage),
          }))}
        />
      ) : (
        <section className="kanban-board" aria-label={t('kanban.board', { name: pipeline.name })}>
          {stages.map(column)}
        </section>
      )}
      {dragged && !phone && (
        <DropZones
          onWin={() => {
            winDeal(dragged)
            setDragged(null)
          }}
          onLose={() => {
            setLosing(dragged)
            setDragged(null)
          }}
        />
      )}
      {filling && (
        <RequiredFieldsDialog
          // Новый отказ — новая форма: черновики берутся из нового списка полей.
          key={JSON.stringify(filling.missing)}
          title={filling.title}
          missing={filling.missing}
          fields={customFields}
          values={filling.deal.custom ?? {}}
          permissions={access.data?.permissions ?? null}
          members={(owners.data ?? []).map((o) => ({
            userId: o.id,
            name: o.name,
            disabled: false,
          }))}
          onCancel={() => setFilling(null)}
          onSubmit={(custom) => {
            setFilling(null)
            filling.retry(custom)
          }}
        />
      )}
      {losing && (
        <LostDialog
          deal={losing}
          groups={lostReasons.data}
          onClose={() => setLosing(null)}
          onSubmit={(reasonId) => loseDeal(losing, reasonId)}
        />
      )}
      {creating && (
        <NewDealDialog
          api={api}
          projectId={projectId}
          pipelines={active}
          pipelineId={pipeline.id}
          owners={owners.data ?? []}
          userId={userId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            setNotice({ kind: 'status', text: t('kanban.created') })
            void queryClient.invalidateQueries({ queryKey: boardKey(projectId) })
          }}
        />
      )}
    </section>
  )
}

/** Цель перетаскивания: dragover с preventDefault разрешает бросить сюда. */
function dropTarget(onDrop: () => void, setOver: (over: boolean) => void) {
  return {
    onDragOver: (event: DragEvent) => {
      event.preventDefault()
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      setOver(false)
      onDrop()
    },
  }
}

function DropZones({ onWin, onLose }: { onWin: () => void; onLose: () => void }) {
  const { t } = useTranslation('deals')
  const [over, setOver] = useState<'won' | 'lost' | null>(null)
  return (
    <div className="kanban-dropzones">
      <div
        className={cx('kanban-dropzone', over === 'won' && 'kanban-dropzone--over')}
        {...dropTarget(onWin, (on) => setOver(on ? 'won' : null))}
      >
        {t('kanban.dropWon')}
      </div>
      <div
        className={cx(
          'kanban-dropzone',
          'kanban-dropzone--lost',
          over === 'lost' && 'kanban-dropzone--over',
        )}
        {...dropTarget(onLose, (on) => setOver(on ? 'lost' : null))}
      >
        {t('kanban.dropLost')}
      </div>
    </div>
  )
}

function StageColumn({
  api,
  projectId,
  projectCode,
  pipeline,
  stage,
  owner,
  filter,
  aggregate,
  phone,
  dragged,
  onDragStart,
  onDragEnd,
  onDrop,
  actionsFor,
  onTake,
  cardFields,
  cardFormat,
}: {
  api: DealsApi
  projectId: string
  projectCode: string
  pipeline: PipelineSummary
  stage: StageSummary
  owner: OwnerFilter | undefined
  filter: FilterGroup
  aggregate: StageAggregate | undefined
  phone: boolean
  dragged: BoardDeal | null
  onDragStart: (deal: BoardDeal) => void
  onDragEnd: () => void
  onDrop: (deal: BoardDeal) => void
  actionsFor: (deal: BoardDeal) => MenuItem[]
  onTake: (deal: BoardDeal) => void
  /** Поля карточки канбана воронки, видимые пользователю, по порядку. */
  cardFields: readonly FieldDefinitionSummary[]
  cardFormat: CustomFormat
}) {
  const { t, i18n } = useTranslation('deals')
  const [over, setOver] = useState(false)
  const deals = useInfiniteQuery({
    queryKey: boardKey(
      projectId,
      'column',
      pipeline.id,
      stage.id,
      owner ?? 'all',
      JSON.stringify(filter),
    ),
    queryFn: ({ pageParam }) =>
      api.stagePage(projectId, {
        pipelineId: pipeline.id,
        stageId: stage.id,
        ...(owner === undefined ? {} : { owner }),
        ...(conditionCount(filter) > 0 ? { filter } : {}),
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  })
  const items = deals.data?.pages.flatMap((page) => page.items) ?? []
  const count = aggregate?.count ?? 0
  const canLoadMore = deals.hasNextPage && items.length < COLUMN_LIMIT
  const rest = count - items.length

  // Подгрузка при прокрутке: метка в конце колонки показалась — следующая страница. Метка видна
  // и при прокрутке самой колонки, и при прокрутке страницы (телефон).
  const sentinel = useRef<HTMLDivElement>(null)
  const { fetchNextPage, isFetchingNextPage } = deals
  useEffect(() => {
    const node = sentinel.current
    if (!node || !canLoadMore || isFetchingNextPage) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage()
      },
      { rootMargin: '200px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [canLoadMore, isFetchingNextPage, fetchNextPage])

  const sums = Object.entries(aggregate?.sums ?? {})
  const dropProps =
    phone || !dragged
      ? {}
      : dropTarget(() => {
          if (dragged) onDrop(dragged)
        }, setOver)

  return (
    <section
      className={cx('kanban-col', over && 'kanban-col--over')}
      aria-label={t('kanban.column', { name: stage.name })}
      {...dropProps}
    >
      <header className="kanban-col__head">
        <div className="kanban-col__name">
          <h2>{stage.name}</h2>
          <span className="kanban-col__count">{count}</span>
        </div>
        <div className="kanban-col__sums">
          {sums.length === 0
            ? t('kanban.noSums')
            : sums.map(([currency, amount]) => (
                <span key={currency}>{formatMoney(amount ?? 0, currency, i18n.language)}</span>
              ))}
        </div>
      </header>
      <div className="kanban-col__cards">
        {deals.isPending ? (
          <Skeleton lines={2} />
        ) : deals.isError ? (
          <p className="ui-notice" role="alert">
            {t('kanban.loadFailed')}
          </p>
        ) : items.length === 0 ? (
          <p className="kanban-col__empty">{t('kanban.empty')}</p>
        ) : (
          items.map((deal) => (
            <div key={deal.id} className="kanban-card">
              <DealCard
                deal={deal}
                href={projectHref(projectCode, `/deals/${deal.id}`)}
                draggable={!phone}
                dragging={dragged?.id === deal.id}
                onDragStart={() => onDragStart(deal)}
                onDragEnd={onDragEnd}
                actions={actionsFor(deal)}
                {...(deal.ownerId === null ? { onTake: () => onTake(deal) } : {})}
              />
              <CardFieldValues deal={deal} fields={cardFields} format={cardFormat} />
            </div>
          ))
        )}
        {canLoadMore && (
          <div ref={sentinel} className="kanban-col__more">
            <Button
              variant="quiet"
              size="sm"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? t('kanban.loadingMore') : t('kanban.loadMore')}
            </Button>
          </div>
        )}
        {!canLoadMore && deals.hasNextPage && rest > 0 && (
          <a
            className="kanban-col__list"
            href={listHref(projectCode, pipeline.id, stage.id, filter, owner)}
          >
            {t('kanban.openAsList', { count: rest })}
          </a>
        )}
      </div>
    </section>
  )
}

/**
 * Значения полей карточки канбана (до 3, тикет crm-fields/07) под карточкой сделки. Пустое
 * поле не показывается; скрытое от роли сервер не отдаёт. Нет ни одного значения — ничего.
 */
function CardFieldValues({
  deal,
  fields,
  format,
}: {
  deal: BoardDeal
  fields: readonly FieldDefinitionSummary[]
  format: CustomFormat
}) {
  const shown = fields
    .map((field) => ({ field, text: formatCustomValue(field, deal.custom?.[field.code], format) }))
    .filter((item) => item.text !== '')
  if (shown.length === 0) return null
  return (
    <dl className="kanban-card__fields">
      {shown.map(({ field, text }) => (
        <div key={field.id} className="kanban-card__field">
          <dt>{customFieldName(field, format.language)}</dt>
          <dd>{text}</dd>
        </div>
      ))}
    </dl>
  )
}
