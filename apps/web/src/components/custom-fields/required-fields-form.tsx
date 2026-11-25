import { type FieldDefinitionSummary, fieldName, type RequiredFieldsMissing } from '@alpi/shared'
import { type FormEvent, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { Field } from '../../ui/field.tsx'
import type { CustomValues } from './custom-fields-api.tsx'
import { FieldEditor, type FieldMember, useFieldLocale } from './field-editor.tsx'
import { type FieldDraft, problemKey } from './field-values.ts'
import { collectRequired, type RequiredFieldProblem, requiredDrafts } from './required-fields.ts'
import './custom-fields.css'

// Форма заполнения обязательных полей (тикет crm-fields/04; spec.md MVP, раздел 5.1): канбан и
// карточка сделки открывают её на ответ 422 о незаполненных полях, «Зберегти» повторяет то же
// действие (смену этапа, выигрыш) вместе со значениями, отмена ничего не меняет. Поля ввода —
// общие редакторы тикета 06 (field-editor.tsx). Те же поля ввода показывают формы создания
// записей (RequiredFieldInputs).

/**
 * Список незаполненных полей для сообщения об отказе: названия на языке интерфейса и «ще N
 * полів, недоступних вашій ролі».
 */
export function useMissingFieldsText(): (missing: RequiredFieldsMissing) => string {
  const { t } = useTranslation('custom-fields')
  const locale = useFieldLocale()
  return (missing) =>
    [
      ...missing.names.map((name) => fieldName(name, locale)),
      ...(missing.hiddenCount > 0 ? [t('fill.more', { count: missing.hiddenCount })] : []),
    ].join(', ')
}

/** Поля ввода обязательных полей с подписью и текстом ошибки у каждого. */
export function RequiredFieldInputs({
  fields,
  drafts,
  onDraft,
  problems,
  members,
  values = {},
  autoFocus = false,
}: {
  fields: readonly FieldDefinitionSummary[]
  drafts: Readonly<Record<string, FieldDraft>>
  onDraft: (code: string, draft: FieldDraft) => void
  problems: Readonly<Record<string, RequiredFieldProblem>>
  members: readonly FieldMember[]
  values?: CustomValues
  /** Фокус на первое поле (форма заполнения); в форме создания — нет. */
  autoFocus?: boolean
}) {
  const { t } = useTranslation('custom-fields')
  const locale = useFieldLocale()
  return (
    <>
      {fields.map((field, index) => {
        const label = fieldName(field, locale)
        const problem = problems[field.code]
        return (
          <Field
            key={field.id}
            label={t('fill.label', { field: label })}
            error={
              problem === undefined
                ? undefined
                : problem === 'required'
                  ? t('fill.required')
                  : t(`problems.${problemKey(field.type, problem)}`)
            }
          >
            <FieldEditor
              field={field}
              label={label}
              draft={drafts[field.code] ?? ''}
              onDraft={(draft) => onDraft(field.code, draft)}
              value={values[field.code]}
              members={members}
              invalid={problem !== undefined}
              autoFocus={autoFocus && index === 0}
            />
          </Field>
        )
      })}
    </>
  )
}

/**
 * Форма заполнения полей из ответа 422 (`missing`). `fields` — описания полей сущности, которые
 * пользователь видит: по ним — редакторы. Поле из ответа без описания (описания устарели) и
 * поля скрытых от роли групп заполнить здесь нельзя — о них только строка.
 */
export function RequiredFieldsDialog({
  title,
  missing,
  fields,
  values = {},
  members,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  title: string
  missing: RequiredFieldsMissing
  fields: readonly FieldDefinitionSummary[]
  values?: CustomValues
  members: readonly FieldMember[]
  busy?: boolean
  /** Отказ повторного запроса, кроме обязательных полей. */
  error?: string | null
  onCancel: () => void
  onSubmit: (custom: CustomValues) => void
}) {
  const { t } = useTranslation('custom-fields')
  const locale = useFieldLocale()
  const formId = useId()
  const shown = missing.fields.flatMap((code) => fields.filter((f) => f.code === code))
  const unknown = missing.names.filter((name) => !shown.some((f) => f.code === name.code))
  // Описания полей могут прийти позже формы: черновика поля нет — он из значения записи.
  const [edited, setEdited] = useState<Record<string, FieldDraft>>({})
  const drafts = { ...requiredDrafts(shown, values), ...edited }
  const [problems, setProblems] = useState<Record<string, RequiredFieldProblem>>({})

  function submit(event: FormEvent) {
    event.preventDefault()
    const collected = collectRequired(shown, drafts, values)
    if (!collected.ok) {
      setProblems(collected.problems)
      return
    }
    setProblems({})
    onSubmit(collected.custom)
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t('cancel')}
          </Button>
          {shown.length > 0 && (
            <Button variant="primary" type="submit" form={formId} busy={busy ?? false}>
              {t('save')}
            </Button>
          )}
        </>
      }
    >
      <form id={formId} className="custom-fields__fill" onSubmit={submit} noValidate>
        <p>{t('fill.intro')}</p>
        <RequiredFieldInputs
          fields={shown}
          drafts={drafts}
          onDraft={(code, draft) => setEdited((current) => ({ ...current, [code]: draft }))}
          problems={problems}
          members={members}
          values={values}
          autoFocus
        />
        {unknown.length > 0 && (
          <p className="ui-notice">
            {t('fill.reload', {
              fields: unknown.map((name) => fieldName(name, locale)).join(', '),
            })}
          </p>
        )}
        {missing.hiddenCount > 0 && (
          <p className="ui-notice">{t('fill.hidden', { count: missing.hiddenCount })}</p>
        )}
        {error && (
          <p className="ui-notice" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
