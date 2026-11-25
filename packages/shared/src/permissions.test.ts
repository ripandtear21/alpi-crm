import { describe, expect, it } from 'vitest'
import { fieldGroupAccess } from './fields/index.ts'
import {
  FIELD_GROUP_ACCESS,
  fieldGroupAccessRank,
  fullPermissions,
  parseRolePermissions,
  ROLE_TEMPLATES,
  type RolePermissions,
} from './permissions.ts'

// Права на группы полей в каталоге прав (тикет crm-fields/03): форма `fieldGroups` и доступ к
// группе без записи.

const GROUP = '0b9a3c1e-7d4f-4a6b-9c2d-5e8f1a2b3c4d'
const OTHER = '1c8b4d2f-6e5a-4b7c-8d3e-6f9a2b3c4d5e'

function parsed(input: unknown): RolePermissions {
  const result = parseRolePermissions(input)
  if (!result.ok) throw new Error(`${result.error.path}: ${result.error.message}`)
  return result.permissions
}

describe('parseRolePermissions — fieldGroups', () => {
  it('принимает { id группы: доступ } для каждого доступа каталога', () => {
    for (const access of FIELD_GROUP_ACCESS) {
      expect(parsed({ fieldGroups: { [GROUP]: access } }).fieldGroups).toEqual({
        [GROUP]: access,
      })
    }
  })

  it('приводит id к нижнему регистру и упорядочивает ключи', () => {
    const result = parsed({ fieldGroups: { [OTHER]: 'hidden', [GROUP.toUpperCase()]: 'read' } })
    expect(Object.entries(result.fieldGroups)).toEqual([
      [GROUP, 'read'],
      [OTHER, 'hidden'],
    ])
  })

  it('отклоняет неизвестный доступ, ключ не-id и не объект', () => {
    expect(parseRolePermissions({ fieldGroups: { [GROUP]: 'secret' } })).toEqual({
      ok: false,
      error: { path: `fieldGroups.${GROUP}`, message: 'неизвестный доступ "secret"' },
    })
    expect(parseRolePermissions({ fieldGroups: { [GROUP]: null } }).ok).toBe(false)
    expect(parseRolePermissions({ fieldGroups: { g1: 'edit' } })).toEqual({
      ok: false,
      error: { path: 'fieldGroups.g1', message: 'ожидается id группы полей' },
    })
    expect(parseRolePermissions({ fieldGroups: [] }).ok).toBe(false)
  })
})

describe('fieldGroupAccess', () => {
  const deals = (actions: string[]) => parsed({ actions: { deals: actions } })

  it('группа без записи: «изменять» с правом изменять сущность, иначе «только чтение»', () => {
    expect(fieldGroupAccess(deals(['view', 'edit']), { id: GROUP, entity: 'deal' })).toBe('edit')
    expect(fieldGroupAccess(deals(['view', 'create']), { id: GROUP, entity: 'deal' })).toBe('read')
    expect(fieldGroupAccess(deals(['view']), { id: GROUP, entity: 'deal' })).toBe('read')
    // Право изменять сделки не открывает группы контактов.
    expect(fieldGroupAccess(deals(['view', 'edit']), { id: GROUP, entity: 'contact' })).toBe('read')
    const orgs = parsed({ actions: { organizations: ['view', 'edit'] } })
    expect(fieldGroupAccess(orgs, { id: GROUP, entity: 'organization' })).toBe('edit')
  })

  it('запись о группе решает сама, в обе стороны', () => {
    const editor = parsed({
      actions: { deals: ['view', 'edit'] },
      fieldGroups: { [GROUP]: 'hidden' },
    })
    expect(fieldGroupAccess(editor, { id: GROUP, entity: 'deal' })).toBe('hidden')
    expect(fieldGroupAccess(editor, { id: OTHER, entity: 'deal' })).toBe('edit')
    const viewer = parsed({ actions: { deals: ['view'] }, fieldGroups: { [GROUP]: 'edit' } })
    expect(fieldGroupAccess(viewer, { id: GROUP, entity: 'deal' })).toBe('edit')
  })

  it('администратор — «изменять» на любую группу; шаблоны ролей записей не несут', () => {
    for (const entity of ['deal', 'contact', 'organization'] as const) {
      expect(fieldGroupAccess(fullPermissions(), { id: GROUP, entity })).toBe('edit')
    }
    for (const template of ROLE_TEMPLATES) expect(template.permissions.fieldGroups).toEqual({})
  })

  it('ранг: «скрыто» < «только чтение» < «изменять»', () => {
    expect(fieldGroupAccessRank('hidden')).toBeLessThan(fieldGroupAccessRank('read'))
    expect(fieldGroupAccessRank('read')).toBeLessThan(fieldGroupAccessRank('edit'))
  })
})
