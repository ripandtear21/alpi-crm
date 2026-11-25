import {
  can,
  FIELD_ENTITIES,
  FIELD_PURGE_AFTER_DAYS,
  type FieldDefinitionSummary,
  type RolePermissions,
} from '@alpi/shared'
import { useQueries } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../../ui/badge.tsx'
import { Button } from '../../../ui/button.tsx'
import { EmptyState, Notice, Skeleton } from '../../../ui/feedback.tsx'
import { purgeAvailableAt } from './field-form.ts'
import type { FieldsSettingsApi } from './fields-api.ts'
import {
  fieldsSettingsKey,
  useDateText,
  useErrorText,
  useLocalName,
  useRefresh,
} from './fields-data.ts'
import { ConfirmDialog } from './group-dialogs.tsx'

// Вкладка «Архів» экрана полей (тикет crm-fields/05): архивные поля всех сущностей с датой
// архивирования; «Повернути» и «Видалити остаточно» — через 30 дней после архивирования
// (у поля без значений — сразу), с вводом кода поля для подтверждения.

export function ArchiveTab({
  api,
  projectId,
  permissions,
}: {
  api: FieldsSettingsApi
  projectId: string
  permissions: RolePermissions
}) {
  const { t } = useTranslation('fields-settings')
  const localName = useLocalName()
  const dateText = useDateText()
  const errorText = useErrorText()
  const refresh = useRefresh(projectId)
  const [purging, setPurging] = useState<FieldDefinitionSummary | null>(null)
  const [notice, setNotice] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)
  const [pending, setPending] = useState(false)
  // Те же запросы, что у вкладок сущностей: сущность без права смотреть (403) — без полей.
  const results = useQueries({
    queries: FIELD_ENTITIES.map((entity) => ({
      queryKey: fieldsSettingsKey(projectId, 'fields', entity),
      queryFn: () => api.fields(projectId, entity),
      retry: false,
    })),
  })

  if (results.some((r) => r.isPending)) return <Skeleton lines={3} label={t('loading')} />
  const archived = results
    .flatMap((r) => r.data ?? [])
    .filter((f) => f.archivedAt !== null)
    .sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)))
  const mayEdit = can(permissions, 'fields', 'edit')
  const mayDelete = can(permissions, 'fields', 'delete')
  const now = Date.now()

  async function restore(field: FieldDefinitionSummary) {
    setPending(true)
    setNotice(null)
    try {
      await api.restoreField(projectId, field.id)
      setNotice({ kind: 'status', text: t('saved') })
      await refresh()
    } catch (error) {
      setNotice({ kind: 'alert', text: errorText(error) })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="fields-tab">
      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {archived.length === 0 ? (
        <EmptyState title={t('archive.empty')} />
      ) : (
        <ul className="fields-list settings-panel" aria-label={t('archive.listLabel')}>
          {archived.map((field) => {
            const name = localName(field)
            const availableAt = purgeAvailableAt(field, FIELD_PURGE_AFTER_DAYS)
            const purgeReady = availableAt !== null && availableAt.getTime() <= now
            const purgePending = field.purgeRequestedAt !== null
            return (
              <li key={field.id} className="fields-row">
                <div className="fields-row__main">
                  <span className="fields-row__name">{name}</span>
                  <code className="fields-row__code">{field.code}</code>
                  <span className="fields-row__type">{t(`tabs.${field.entity}`)}</span>
                </div>
                <div className="fields-row__badges">
                  <span>
                    {t('archive.archivedAt', { date: dateText(field.archivedAt as string) })}
                  </span>
                  {purgePending ? (
                    <Badge tone="danger">{t('archive.purgePending')}</Badge>
                  ) : (
                    !purgeReady &&
                    availableAt && (
                      <span>{t('archive.purgeAvailable', { date: dateText(availableAt) })}</span>
                    )
                  )}
                </div>
                <div className="fields-row__actions">
                  {mayEdit && (
                    <Button
                      type="button"
                      size="sm"
                      aria-label={t('archive.restoreLabel', { name })}
                      disabled={pending || purgePending}
                      onClick={() => restore(field)}
                    >
                      {t('archive.restore')}
                    </Button>
                  )}
                  {mayDelete && (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      aria-label={t('archive.purgeLabel', { name })}
                      disabled={pending || purgePending || !purgeReady}
                      onClick={() => setPurging(field)}
                    >
                      {t('archive.purge')}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {purging && (
        <ConfirmDialog
          title={t('archive.purgeTitle', { name: localName(purging) })}
          text={t('archive.purgeText', { code: purging.code })}
          confirmLabel={t('archive.purgeConfirm')}
          confirmCode={purging.code}
          codeLabel={t('archive.purgeCode')}
          onClose={() => setPurging(null)}
          onConfirm={async () => {
            try {
              await api.removeField(projectId, purging.id)
              setPurging(null)
              setNotice({ kind: 'status', text: t('saved') })
              void refresh()
              return null
            } catch (error) {
              return errorText(error)
            }
          }}
        />
      )}
    </div>
  )
}
