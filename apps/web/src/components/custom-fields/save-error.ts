import type { FieldType, FieldValueProblem } from '@alpi/shared'
import { useTranslation } from 'react-i18next'
import { CustomFieldsApiError } from './custom-fields-api.tsx'
import { problemKey } from './field-values.ts'

// Текст отказа API на правку значения (тикет crm-fields/06): 422 CUSTOM_FIELD_INVALID — по
// причине из `details.reason` (те же тексты, что у проверки в браузере), остальные коды
// (packages/shared/src/fields/index.ts, CustomFieldErrorCode) — своим текстом.

const PROBLEMS: readonly FieldValueProblem[] = [
  'type',
  'too_long',
  'format',
  'scheme',
  'range',
  'precision',
  'currency',
  'unknown_option',
  'archived_option',
  'unknown_user',
  'disabled_user',
]

const KNOWN_CODES = [
  'PERMISSION_DENIED',
  'CUSTOM_FIELD_UNKNOWN',
  'CUSTOM_FIELD_READ_ONLY',
  'CUSTOM_FIELD_CONVERTING',
] as const

export function useSaveErrorText(): (error: unknown, type: FieldType) => string {
  const { t } = useTranslation('custom-fields')
  return (error, type) => {
    if (!(error instanceof CustomFieldsApiError)) return t('errors.unknown')
    if (error.code === 'CUSTOM_FIELD_INVALID') {
      const problem = PROBLEMS.find((item) => item === error.details?.reason)
      return problem ? t(`problems.${problemKey(type, problem)}`) : t('problems.type')
    }
    const code = KNOWN_CODES.find((item) => item === error.code)
    return code ? t(`errors.${code}`) : t('errors.unknown')
  }
}
