import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../components/project-switcher/current-project.tsx'
import type { DuplicatesApi } from '../routes/duplicates/duplicates-api.ts'

// Счётчик «Дублів: N» в шапке и пункт меню «Дублі» (тикет crm-intake/05): число групп похожих
// записей, видимых пользователю (`GET /api/v1/duplicates/count`). Только у того, у кого есть
// «контакти: змінювати» или «угоди: змінювати»: без обоих прав API отвечает 403, и счётчика
// и пункта меню нет. Счётчик ведёт на экран «Дублі».

/** Как часто перечитывать число, мс: пары находит фоновая задача, без действия пользователя. */
const REFRESH_MS = 5 * 60 * 1000

/** Ключ кэша всего, что показывает экран «Дублі»: слияние и «не дубль» сбрасывают его целиком. */
export const duplicatesQueryKey = (projectId: string) => projectQueryKey(projectId, 'duplicates')

/** Число групп по типам текущего проекта; data null — нет права ни на один тип. */
export function useDuplicateCounts(api: DuplicatesApi | undefined) {
  const { current } = useCurrentProject()
  const projectId = current?.id ?? ''
  return useQuery({
    queryKey: [...duplicatesQueryKey(projectId), 'count'],
    queryFn: () => (api ? api.counts(projectId) : null),
    enabled: projectId !== '' && api !== undefined,
    retry: false,
    staleTime: 60_000,
    refetchInterval: REFRESH_MS,
  })
}

/** Сумма видимых групп; null — счётчика нет (нет права или ещё не загрузилось). */
export function duplicatesTotal(counts: ReturnType<typeof useDuplicateCounts>['data']) {
  if (!counts) return null
  return (counts.contact ?? 0) + (counts.deal ?? 0)
}

export function DuplicatesCounter({ api }: { api: DuplicatesApi }) {
  const { t } = useTranslation('layout')
  const { current } = useCurrentProject()
  const total = duplicatesTotal(useDuplicateCounts(api).data)
  if (total === null || !current) return null
  return (
    <Link
      to="/p/$code/duplicates"
      params={{ code: current.code }}
      className="app-header__duplicates"
      data-empty={total === 0}
    >
      {t('duplicates.counter', { count: total })}
    </Link>
  )
}
