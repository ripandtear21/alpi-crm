import {
  can,
  type FieldDefinitionSummary,
  type FieldEntity,
  type FieldGroupSummary,
  type RolePermissions,
} from '@alpi/shared'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../../ui/badge.tsx'
import { Button } from '../../../ui/button.tsx'
import { EmptyState, Notice, Skeleton } from '../../../ui/feedback.tsx'
import { moved, OrderButtons } from '../directory-controls.tsx'
import { FieldDialog, IndexBadge } from './field-dialog.tsx'
import { FieldsApiError, type FieldsSettingsApi } from './fields-api.ts'
import {
  useErrorText,
  useFields,
  useGroups,
  useLocalName,
  usePipelines,
  useRefresh,
  useRoles,
} from './fields-data.ts'
import { ConfirmDialog, GroupAccessDialog, GroupDialog } from './group-dialogs.tsx'

// Вкладка сущности на экране полей (тикет crm-fields/05): группы по порядку, в каждой — поля
// по порядку со значками; создать, переименовать, переставить, удалить пустую группу, доступ
// ролей к группе; создать, изменить, переставить и удалить поле. Архивные поля — во вкладке
// «Архів».

type Opened =
  | { kind: 'field'; field: FieldDefinitionSummary | null; groupId: string }
  | { kind: 'group'; group: FieldGroupSummary | null }
  | { kind: 'access'; group: FieldGroupSummary }
  | { kind: 'removeGroup'; group: FieldGroupSummary }
  | { kind: 'removeField'; field: FieldDefinitionSummary }
  | null

export function EntityTab({
  api,
  projectId,
  entity,
  permissions,
}: {
  api: FieldsSettingsApi
  projectId: string
  entity: FieldEntity
  permissions: RolePermissions
}) {
  const { t } = useTranslation('fields-settings')
  const groups = useGroups(api, projectId, entity)
  const fields = useFields(api, projectId, entity)
  const pipelines = usePipelines(api, projectId, entity === 'deal')
  const roles = useRoles(api, projectId)
  const refresh = useRefresh(projectId)
  const errorText = useErrorText()
  const [opened, setOpened] = useState<Opened>(null)
  const [notice, setNotice] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)
  const [pending, setPending] = useState(false)

  if (groups.isPending || fields.isPending) return <Skeleton lines={4} label={t('loading')} />
  if (groups.isError || fields.isError) {
    const denied = [groups.error, fields.error].some(
      (e) => e instanceof FieldsApiError && e.status === 403,
    )
    return <Notice kind="alert">{denied ? t('noEntityAccess') : t('loadFailed')}</Notice>
  }

  const mayCreate = can(permissions, 'fields', 'create')
  const mayEdit = can(permissions, 'fields', 'edit')
  const mayDelete = can(permissions, 'fields', 'delete')
  const groupList = groups.data
  const allFields = fields.data

  async function run(action: () => Promise<unknown>) {
    setPending(true)
    setNotice(null)
    try {
      await action()
      await refresh()
    } catch (error) {
      setNotice({ kind: 'alert', text: errorText(error) })
    } finally {
      setPending(false)
    }
  }

  const saved = () => {
    setOpened(null)
    setNotice({ kind: 'status', text: t('saved') })
    void refresh()
  }

  return (
    <div className="fields-tab">
      {mayCreate && (
        <div className="fields-tab__toolbar">
          <Button type="button" onClick={() => setOpened({ kind: 'group', group: null })}>
            {t('group.add')}
          </Button>
        </div>
      )}
      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {groupList.length === 0 ? (
        <EmptyState title={t('group.none')} />
      ) : (
        <ol className="fields-groups" aria-label={t('group.listLabel')}>
          {groupList.map((group, index) => (
            <GroupCard
              key={group.id}
              group={group}
              index={index}
              count={groupList.length}
              fields={allFields.filter((f) => f.groupId === group.id)}
              pipelineNames={new Map((pipelines.data ?? []).map((p) => [p.id, p.name]))}
              pending={pending}
              rights={{ create: mayCreate, edit: mayEdit, delete: mayDelete }}
              onMoveGroup={(delta) =>
                run(() =>
                  api.reorderGroups(
                    projectId,
                    entity,
                    moved(
                      groupList.map((g) => g.id),
                      index,
                      delta,
                    ),
                  ),
                )
              }
              onMoveField={(ids) => run(() => api.reorderFields(projectId, group.id, ids))}
              onOpen={setOpened}
            />
          ))}
        </ol>
      )}

      {opened?.kind === 'field' && (
        <FieldDialog
          api={api}
          projectId={projectId}
          entity={entity}
          groups={groupList}
          field={opened.field}
          initialGroupId={opened.groupId}
          pipelines={pipelines.data ?? []}
          roles={roles.data}
          onClose={() => setOpened(null)}
          onSaved={saved}
          onPartlySaved={() => void refresh()}
        />
      )}
      {opened?.kind === 'group' && (
        <GroupDialog
          api={api}
          projectId={projectId}
          entity={entity}
          group={opened.group}
          onClose={() => setOpened(null)}
          onSaved={saved}
        />
      )}
      {opened?.kind === 'access' && (
        <GroupAccessDialog
          api={api}
          projectId={projectId}
          group={opened.group}
          onClose={() => setOpened(null)}
          onSaved={() => void refresh()}
        />
      )}
      {opened?.kind === 'removeGroup' && (
        <RemoveGroup
          api={api}
          projectId={projectId}
          group={opened.group}
          onClose={() => setOpened(null)}
          onDone={saved}
        />
      )}
      {opened?.kind === 'removeField' && (
        <RemoveField
          api={api}
          projectId={projectId}
          field={opened.field}
          onClose={() => setOpened(null)}
          onDone={saved}
        />
      )}
    </div>
  )
}

function GroupCard({
  group,
  index,
  count,
  fields,
  pipelineNames,
  pending,
  rights,
  onMoveGroup,
  onMoveField,
  onOpen,
}: {
  group: FieldGroupSummary
  index: number
  count: number
  /** Поля группы вместе с архивными: группу с архивными полями удалить нельзя. */
  fields: FieldDefinitionSummary[]
  pipelineNames: Map<string, string>
  pending: boolean
  rights: { create: boolean; edit: boolean; delete: boolean }
  onMoveGroup: (delta: -1 | 1) => void
  onMoveField: (ids: string[]) => void
  onOpen: (opened: Opened) => void
}) {
  const { t } = useTranslation('fields-settings')
  const localName = useLocalName()
  const name = localName(group)
  const active = fields.filter((f) => f.archivedAt === null).sort((a, b) => a.position - b.position)

  return (
    <li className="fields-group settings-panel">
      <div className="fields-group__head">
        <h2>{name}</h2>
        {rights.edit && (
          <OrderButtons
            name={name}
            index={index}
            count={count}
            pending={pending}
            onMove={onMoveGroup}
          />
        )}
      </div>
      <div className="fields-group__actions">
        {rights.create && (
          <Button
            type="button"
            size="sm"
            variant="primary"
            aria-label={t('group.addFieldLabel', { name })}
            onClick={() => onOpen({ kind: 'field', field: null, groupId: group.id })}
          >
            {t('group.addField')}
          </Button>
        )}
        {rights.edit && (
          <Button
            type="button"
            size="sm"
            aria-label={t('group.renameLabel', { name })}
            onClick={() => onOpen({ kind: 'group', group })}
          >
            {t('group.rename')}
          </Button>
        )}
        {rights.edit && (
          <Button
            type="button"
            size="sm"
            aria-label={t('group.accessLabel', { name })}
            onClick={() => onOpen({ kind: 'access', group })}
          >
            {t('group.access')}
          </Button>
        )}
        {rights.delete && fields.length === 0 && (
          <Button
            type="button"
            size="sm"
            variant="quiet"
            aria-label={t('group.removeLabel', { name })}
            onClick={() => onOpen({ kind: 'removeGroup', group })}
          >
            {t('group.remove')}
          </Button>
        )}
      </div>
      {active.length === 0 ? (
        <p className="fields-group__empty">{t('group.empty')}</p>
      ) : (
        <ul className="fields-list" aria-label={t('group.fieldsLabel', { name })}>
          {active.map((field, fieldIndex) => (
            <FieldRow
              key={field.id}
              field={field}
              pipelineNames={pipelineNames}
              order={
                rights.edit ? (
                  <OrderButtons
                    name={localName(field)}
                    index={fieldIndex}
                    count={active.length}
                    pending={pending}
                    onMove={(delta) =>
                      onMoveField(
                        moved(
                          active.map((f) => f.id),
                          fieldIndex,
                          delta,
                        ),
                      )
                    }
                  />
                ) : null
              }
              rights={rights}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function FieldRow({
  field,
  pipelineNames,
  order,
  rights,
  onOpen,
}: {
  field: FieldDefinitionSummary
  pipelineNames: Map<string, string>
  order: ReactNode
  rights: { edit: boolean; delete: boolean }
  onOpen: (opened: Opened) => void
}) {
  const { t } = useTranslation('fields-settings')
  const { t: tTypes } = useTranslation('custom-fields')
  const localName = useLocalName()
  const name = localName(field)
  return (
    <li className="fields-row">
      <div className="fields-row__main">
        <span className="fields-row__name">{name}</span>
        <code className="fields-row__code">{field.code}</code>
        <span className="fields-row__type">{tTypes(`types.${field.type}`)}</span>
      </div>
      <div className="fields-row__badges">
        {field.required.mode !== 'none' && <Badge tone="ask">{t('field.badges.required')}</Badge>}
        {field.isImportant && <Badge tone="accent">{t('field.badges.important')}</Badge>}
        {field.isFrequentlyFiltered && <Badge>{t('field.badges.frequentlyFiltered')}</Badge>}
        {field.isFrequentlyFiltered && field.indexState && (
          <IndexBadge state={field.indexState} error={field.indexError} />
        )}
        {field.convertingTo && (
          <Badge>{t('field.converting', { type: tTypes(`types.${field.convertingTo}`) })}</Badge>
        )}
        {field.entity === 'deal' && (
          <span className="fields-row__pipelines">
            {field.pipelines === 'all'
              ? t('field.visibleAll')
              : t('field.visibleIn', {
                  names: field.pipelines.map((id) => pipelineNames.get(id) ?? '…').join(', '),
                })}
          </span>
        )}
      </div>
      <div className="fields-row__actions">
        {order}
        {rights.edit && (
          <Button
            type="button"
            size="sm"
            aria-label={t('field.editLabel', { name })}
            onClick={() => onOpen({ kind: 'field', field, groupId: field.groupId })}
          >
            {t('field.edit')}
          </Button>
        )}
        {rights.delete && (
          <Button
            type="button"
            size="sm"
            variant="quiet"
            aria-label={t('field.removeLabel', { name })}
            onClick={() => onOpen({ kind: 'removeField', field })}
          >
            {t('field.remove')}
          </Button>
        )}
      </div>
    </li>
  )
}

function RemoveGroup({
  api,
  projectId,
  group,
  onClose,
  onDone,
}: {
  api: FieldsSettingsApi
  projectId: string
  group: FieldGroupSummary
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation('fields-settings')
  const errorText = useErrorText()
  const localName = useLocalName()
  return (
    <ConfirmDialog
      title={t('group.removeTitle', { name: localName(group) })}
      text={t('group.removeText')}
      confirmLabel={t('group.remove')}
      onClose={onClose}
      onConfirm={async () => {
        try {
          await api.removeGroup(projectId, group.id)
          onDone()
          return null
        } catch (error) {
          return errorText(error)
        }
      }}
    />
  )
}

function RemoveField({
  api,
  projectId,
  field,
  onClose,
  onDone,
}: {
  api: FieldsSettingsApi
  projectId: string
  field: FieldDefinitionSummary
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation('fields-settings')
  const errorText = useErrorText()
  const localName = useLocalName()
  return (
    <ConfirmDialog
      title={t('field.removeTitle', { name: localName(field) })}
      text={field.firstValueAt === null ? t('field.removeNoValues') : t('field.removeWithValues')}
      confirmLabel={t('field.removeConfirm')}
      onClose={onClose}
      onConfirm={async () => {
        try {
          await api.removeField(projectId, field.id)
          onDone()
          return null
        } catch (error) {
          return errorText(error)
        }
      }}
    />
  )
}
