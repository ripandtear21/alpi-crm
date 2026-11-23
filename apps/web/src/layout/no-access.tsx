import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Skeleton } from '../ui/feedback.tsx'

// Один нейтральный экран «немає доступу» (тикет crm-deals/15) для всего, что ссылка открыть
// не может: проект, где пользователь не участник, несуществующий код проекта, запись, которой
// нет, она удалена или вне охвата. Ни названия проекта, ни записи: по экрану эти случаи
// не различить. Ссылка ведёт к сделкам последнего открытого проекта.
export function NoAccess() {
  const { t } = useTranslation('layout')
  return (
    <section className="no-access">
      <h1>{t('noAccess.title')}</h1>
      <p>{t('noAccess.text')}</p>
      <Link to="/$" params={{ _splat: 'deals' }}>
        {t('noAccess.back')}
      </Link>
    </section>
  )
}

/**
 * Сколько ждёт адрес с кодом проекта, которого у пользователя нет. Ответ «записи нет» приходит
 * после запроса к API; чужой и несуществующий код клиент узнаёт сразу из своего списка
 * проектов — без паузы такой экран появлялся бы мгновенно и отличался от отказа по записи.
 */
export const NO_ACCESS_DELAY_MS = 300

/** Экран «немає доступу» после той же загрузки, что у карточки записи. */
export function DelayedNoAccess() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), NO_ACCESS_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])
  return shown ? <NoAccess /> : <Skeleton lines={5} />
}
