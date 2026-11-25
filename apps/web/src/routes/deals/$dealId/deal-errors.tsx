import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { readRequiredFieldsMissing } from '../../../components/custom-fields/required-fields.ts'
import { useMissingFieldsText } from '../../../components/custom-fields/required-fields-form.tsx'
import { useProjectCode } from '../../../components/project-switcher/current-project.tsx'
import { DealCardApiError } from './deal-card-api.ts'

// Отказы API на действия карточки. «Одна открытая сделка у человека в воронке» (409
// OPEN_DEAL_EXISTS) — подсказка со ссылкой на мешающую сделку, если она видна пользователю,
// иначе имя менеджера, у которого клиент в работе (apps/api/src/deals/store.ts).

/**
 * Текст отказа по коду; неизвестный код — общий текст. Незаполненные обязательные поля
 * (тикет crm-fields/04) — со списком названий.
 */
export function useCardErrorText() {
  const { t } = useTranslation('deal-card')
  const missingText = useMissingFieldsText()
  return (error: unknown): string => {
    const code = error instanceof DealCardApiError ? error.code : ''
    const missing =
      error instanceof DealCardApiError ? readRequiredFieldsMissing(code, error.details) : null
    if (missing) {
      return t(`errors.${code}`, {
        fields: missingText(missing),
        defaultValue: t('errors.unknown'),
      })
    }
    return t(`errors.${code}`, { defaultValue: t('errors.unknown') })
  }
}

export function ActionError({ error }: { error: unknown }) {
  const { t } = useTranslation('deal-card')
  const errorText = useCardErrorText()
  const code = useProjectCode()
  if (error === null || error === undefined) return null
  if (error instanceof DealCardApiError && error.code === 'OPEN_DEAL_EXISTS') {
    const dealId = typeof error.details?.dealId === 'string' ? error.details.dealId : null
    const manager =
      typeof error.details?.managerName === 'string' ? error.details.managerName : null
    return (
      <p className="ui-notice deal-card__conflict" role="alert">
        {t('errors.OPEN_DEAL_EXISTS')}{' '}
        {dealId ? (
          <Link to="/p/$code/deals/$dealId" params={{ code, dealId }}>
            {t('conflict.open')}
          </Link>
        ) : (
          manager && t('conflict.manager', { name: manager })
        )}
      </p>
    )
  }
  return (
    <p className="ui-notice" role="alert">
      {errorText(error)}
    </p>
  )
}
