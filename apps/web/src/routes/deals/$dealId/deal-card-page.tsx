import type { LostReasonGroupSummary, MemberSummary, PipelineSummary } from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../../components/project-switcher/current-project.tsx'
import { Timeline, timelineQueryKey } from '../../../components/timeline/timeline.tsx'
import type { TimelineApi } from '../../../components/timeline/timeline-api.ts'
import { NoAccess } from '../../../layout/no-access.tsx'
import { Skeleton } from '../../../ui/feedback.tsx'
import {
  type ContactCard,
  type DealCard,
  type DealCardApi,
  DealCardApiError,
} from './deal-card-api.ts'
import { useDescribeChange } from './deal-changes.tsx'
import { DealHeader } from './deal-header.tsx'
import { type DealRights, dealRights } from './deal-rights.ts'
import { DealSidebar } from './deal-sidebar.tsx'
import './deal-card.css'

// Карточка сделки (тикет crm-deals/13; spec.md MVP, раздел 5.2): раскладка Pipedrive в стиле
// Actum — шапка на всю ширину (название, ответственный, статусы, путь этапов, воронка), слева
// колонка полей и блоков, справа панель ввода, «Фокус» и «Історія».
//
// Сделка — отдельным запросом `GET /v1/deals/:id`, контакт, организация, воронки, причины и
// товары — своими (ответ карточки одним запросом не делали: решение в результате тикета).
// Карточка меняет сделку только действием пользователя (ADR 0003); ответ действия — новая
// сделка — сразу встаёт в кэш, лента перечитывается.
//
// Сделка вне охвата, удалённая и несуществующая — один экран «немає доступу» без её данных:
// API отвечает на всё это одинаковым 404.

export interface CardUser {
  id: string
  name: string
}

/** Всё, что нужно частям карточки: сделка, права, справочники и действия. */
export interface DealCardModel {
  api: DealCardApi
  projectId: string
  deal: DealCard
  rights: DealRights
  user: CardUser
  /** Основной контакт; null — загружается или вне доступа (`contactHidden`). */
  contact: ContactCard | null
  contactHidden: boolean
  pipelines: PipelineSummary[]
  reasons: LostReasonGroupSummary[]
  /** Участники проекта; null — список недоступен (нет права «пользователи и роли»). */
  members: MemberSummary[] | null
  /** Имя ответственного или нейтральная подпись. */
  ownerName: (ownerId: string | null) => string
  /**
   * Действие со сделкой. Ответ — сделка (кладётся в кэш) или ничего (сделка перечитывается).
   * Возвращает отказ API или null.
   */
  act: (action: () => Promise<DealCard | undefined>) => Promise<unknown>
  busy: boolean
}

export function DealCardPage({
  api,
  timeline,
  dealId,
  user,
}: {
  api: DealCardApi
  timeline: TimelineApi
  dealId: string
  user: CardUser
}) {
  const { current } = useCurrentProject()
  if (!current) return <NoAccess />
  return (
    <DealCardScreen
      key={`${current.id}|${dealId}`}
      api={api}
      timeline={timeline}
      projectId={current.id}
      dealId={dealId}
      user={user}
    />
  )
}

function DealCardScreen({
  api,
  timeline,
  projectId,
  dealId,
  user,
}: {
  api: DealCardApi
  timeline: TimelineApi
  projectId: string
  dealId: string
  user: CardUser
}) {
  const { t } = useTranslation('deal-card')
  const queryClient = useQueryClient()
  const dealKey = projectQueryKey(projectId, 'deal', dealId)
  const deal = useQuery({
    queryKey: dealKey,
    queryFn: () => api.deal(projectId, dealId),
    retry: false,
  })
  const primaryContactId = deal.data?.primaryContactId
  const contact = useQuery({
    queryKey: projectQueryKey(projectId, 'contact', primaryContactId),
    queryFn: () => api.contact(projectId, primaryContactId ?? ''),
    enabled: primaryContactId !== undefined,
    retry: false,
  })
  const access = useQuery({
    queryKey: projectQueryKey(projectId, 'access'),
    queryFn: () => api.access(projectId),
    retry: false,
  })
  const pipelines = useQuery({
    queryKey: projectQueryKey(projectId, 'pipelines'),
    queryFn: () => api.pipelines(projectId),
    retry: false,
  })
  const reasons = useQuery({
    queryKey: projectQueryKey(projectId, 'lost-reasons'),
    queryFn: () => api.lostReasons(projectId),
    retry: false,
  })
  // Список участников проекта — только с правом «пользователи и роли»; без него имена чужих
  // ответственных не показываются (ждёт решения владельца, см. результат тикета).
  const members = useQuery({
    queryKey: projectQueryKey(projectId, 'members'),
    queryFn: () => api.members(projectId),
    retry: false,
  })

  const action = useMutation({
    mutationFn: (run: () => Promise<DealCard | undefined>) => run(),
    onSuccess: (changed) => {
      if (changed) queryClient.setQueryData(dealKey, changed)
      else queryClient.invalidateQueries({ queryKey: dealKey })
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: timelineQueryKey(projectId, 'deals', dealId) }),
  })
  const describeChange = useDescribeChange({
    pipelines: pipelines.data ?? [],
    reasons: reasons.data ?? [],
    ownerName: (ownerId) => ownerName(ownerId),
  })

  function ownerName(ownerId: string | null): string {
    if (ownerId === null) return t('owner.queue')
    if (ownerId === user.id) return user.name
    return members.data?.find((member) => member.userId === ownerId)?.name ?? t('owner.hidden')
  }

  if (deal.isError) {
    const status = deal.error instanceof DealCardApiError ? deal.error.status : 0
    if (status === 404 || status === 403) return <NoAccess />
    return (
      <p className="ui-notice" role="alert">
        {t('errors.unknown')}
      </p>
    )
  }
  if (access.isError || pipelines.isError) {
    return (
      <p className="ui-notice" role="alert">
        {t('errors.unknown')}
      </p>
    )
  }
  if (deal.isPending || access.isPending || pipelines.isPending) {
    return <Skeleton lines={5} label={t('loading')} />
  }

  const model: DealCardModel = {
    api,
    projectId,
    deal: deal.data,
    rights: dealRights(access.data, deal.data),
    user,
    contact: contact.data ?? null,
    contactHidden: contact.isError,
    pipelines: pipelines.data,
    reasons: reasons.data ?? [],
    members: members.data ?? null,
    ownerName,
    act: (run) =>
      action.mutateAsync(run).then(
        () => null,
        (error: unknown) => error,
      ),
    busy: action.isPending,
  }

  return (
    <article className="deal-card" aria-label={deal.data.title}>
      <DealHeader card={model} />
      <div className="deal-card__body">
        <DealSidebar card={model} />
        <div className="deal-card__main">
          <Timeline
            api={timeline}
            projectId={projectId}
            entity="deals"
            id={dealId}
            currentUserId={user.id}
            canWrite={model.rights.edit}
            canDeleteOthers={model.rights.remove}
            describeChange={describeChange}
            focus={
              <section className="deal-card__focus" aria-labelledby="deal-focus">
                <h2 id="deal-focus" className="deal-card__focus-title">
                  {t('focus.title')}
                </h2>
                <p className="deal-card__stub">{t('focus.next')}</p>
              </section>
            }
          />
        </div>
      </div>
    </article>
  )
}
