import {
  FIELD_GROUP_ACCESS,
  type FieldEntity,
  type FieldGroupAccess,
  type FieldGroupSummary,
  fieldGroupAccess,
  type RoleSummary,
} from '@alpi/shared'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../ui/button.tsx'
import { Dialog } from '../../../ui/dialog.tsx'
import { Notice } from '../../../ui/feedback.tsx'
import { Field, Input, Select } from '../../../ui/field.tsx'
import type { FieldsSettingsApi } from './fields-api.ts'
import { useErrorText, useLocalName, useRoles } from './fields-data.ts'

// Диалоги групп полей (тикет crm-fields/05): создать и переименовать (uk, ru), доступ ролей к
// группе (права ролей тикета crm-fields/03 — тот же запрос, что у редактора ролей) и общее
// подтверждение опасного действия.

export function GroupDialog({
  api,
  projectId,
  entity,
  group,
  onClose,
  onSaved,
}: {
  api: FieldsSettingsApi
  projectId: string
  entity: FieldEntity
  /** null — новая группа. */
  group: FieldGroupSummary | null
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation('fields-settings')
  const errorText = useErrorText()
  const localName = useLocalName()
  const formId = useId()
  const [nameUk, setNameUk] = useState(group?.nameUk ?? '')
  const [nameRu, setNameRu] = useState(group?.nameRu ?? '')
  const [error, setError] = useState<{ nameUk?: string; form?: string }>({})
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (nameUk.trim() === '') {
      setError({ nameUk: t('errors.nameRequired') })
      return
    }
    const names = { nameUk: nameUk.trim(), nameRu: nameRu.trim() === '' ? null : nameRu.trim() }
    setPending(true)
    try {
      if (group) await api.updateGroup(projectId, group.id, names)
      else await api.createGroup(projectId, { entity, ...names })
      onSaved()
    } catch (e) {
      setError({ form: errorText(e) })
      setPending(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      className="fields-dialog"
      title={group ? t('group.editTitle', { name: localName(group) }) : t('group.createTitle')}
      footer={
        <>
          <Button type="button" variant="quiet" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" form={formId} disabled={pending}>
            {group ? t('group.save') : t('group.create')}
          </Button>
        </>
      }
    >
      <form id={formId} className="fields-form" onSubmit={submit} noValidate>
        <Field label={t('names.uk')} error={error.nameUk}>
          <Input value={nameUk} maxLength={100} onChange={(e) => setNameUk(e.target.value)} />
        </Field>
        <Field label={t('names.ru')} hint={t('names.ruHint')}>
          <Input value={nameRu} maxLength={100} onChange={(e) => setNameRu(e.target.value)} />
        </Field>
        {error.form && <Notice kind="alert">{error.form}</Notice>}
      </form>
    </Dialog>
  )
}

/**
 * Доступ ролей к группе: «видно і можна змінювати» / «тільки читання» / «приховано». Выбор
 * сохраняется сразу — запись роли о группе. У администратора выбора нет.
 */
export function GroupAccessDialog({
  api,
  projectId,
  group,
  onClose,
  onSaved,
}: {
  api: FieldsSettingsApi
  projectId: string
  group: FieldGroupSummary
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation('fields-settings')
  const errorText = useErrorText()
  const localName = useLocalName()
  const roles = useRoles(api, projectId)
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)

  async function change(role: RoleSummary, access: FieldGroupAccess) {
    setPending(role.id)
    setNotice(null)
    try {
      await api.updateRole(projectId, role.id, {
        name: role.name,
        permissions: {
          ...role.permissions,
          fieldGroups: { ...role.permissions.fieldGroups, [group.id]: access },
        },
      })
      setNotice({ kind: 'status', text: t('saved') })
      onSaved()
    } catch (e) {
      setNotice({ kind: 'alert', text: errorText(e) })
    } finally {
      setPending(null)
    }
  }

  let body: ReactNode
  if (roles.isPending) body = <p>{t('loading')}</p>
  else if (roles.isError) body = <Notice kind="alert">{t('access.noRolesRight')}</Notice>
  else {
    body = (
      <table className="fields-access">
        <thead>
          <tr>
            <th scope="col">{t('access.role')}</th>
            <th scope="col">{t('access.level')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.data.map((role) => (
            <tr key={role.id}>
              <th scope="row">{role.name}</th>
              <td>
                {role.isAdmin ? (
                  <span title={t('access.admin')}>{t('access.levels.edit')}</span>
                ) : (
                  <Select
                    size="sm"
                    aria-label={t('access.selectLabel', { name: role.name })}
                    value={fieldGroupAccess(role.permissions, group)}
                    disabled={pending !== null}
                    onChange={(e) => change(role, e.target.value as FieldGroupAccess)}
                  >
                    {FIELD_GROUP_ACCESS.map((access) => (
                      <option key={access} value={access}>
                        {t(`access.levels.${access}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      className="fields-dialog"
      title={t('group.accessLabel', { name: localName(group) })}
      footer={
        <Button type="button" variant="primary" onClick={onClose}>
          {t('access.close')}
        </Button>
      }
    >
      {body}
      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
    </Dialog>
  )
}

/** Подтверждение опасного действия; `confirmCode` — действие доступно после ввода этого кода. */
export function ConfirmDialog({
  title,
  text,
  confirmLabel,
  confirmCode,
  codeLabel,
  onConfirm,
  onClose,
}: {
  title: string
  text: string
  confirmLabel: string
  confirmCode?: string
  codeLabel?: string
  /** Отказ — текст ошибки, диалог остаётся открытым. */
  onConfirm: () => Promise<string | null>
  onClose: () => void
}) {
  const { t } = useTranslation('fields-settings')
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = confirmCode === undefined || typed.trim() === confirmCode

  async function confirm() {
    setPending(true)
    const failure = await onConfirm()
    if (failure !== null) {
      setError(failure)
      setPending(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      className="fields-dialog"
      title={title}
      footer={
        <>
          <Button type="button" variant="quiet" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="button" variant="danger" disabled={!ready || pending} onClick={confirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{text}</p>
      {confirmCode !== undefined && (
        <Field label={codeLabel ?? ''}>
          <Input
            value={typed}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>
      )}
      {error && <Notice kind="alert">{error}</Notice>}
    </Dialog>
  )
}
