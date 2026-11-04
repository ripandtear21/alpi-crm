import { ROLE_TEMPLATES, type RoleSummary } from '@alpi/shared'
import { type RoleInput, type RolesApi, RolesApiError } from './roles-api.ts'

// Подставной клиент ролей для тестов: роли-шаблоны нового проекта в памяти, вызовы
// записываются; `deny` — ответ 403, как без права «пользователи и роли».

export interface FakeRolesApi extends RolesApi {
  calls: { method: 'create' | 'update' | 'remove'; roleId?: string; input?: RoleInput }[]
  /** Следующее изменение отклоняется с этим кодом (409). */
  failNextWith: string | null
}

function fakeId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

export function fakeRolesApi({ deny = false }: { deny?: boolean } = {}): FakeRolesApi {
  let roles: RoleSummary[] = ROLE_TEMPLATES.map((template, index) => ({
    id: fakeId(index + 1),
    name: template.name,
    templateKey: template.key,
    isAdmin: template.key === 'admin',
    permissions: structuredClone(template.permissions),
    memberCount: template.key === 'admin' ? 1 : 0,
  }))
  let nextId = 100

  function failIfAsked() {
    const code = api.failNextWith
    if (code) {
      api.failNextWith = null
      throw new RolesApiError(409, code)
    }
  }

  const api: FakeRolesApi = {
    calls: [],
    failNextWith: null,
    async list() {
      if (deny) throw new RolesApiError(403, 'PERMISSION_DENIED')
      return structuredClone(roles)
    },
    async create(_projectId, input) {
      api.calls.push({ method: 'create', input })
      failIfAsked()
      const role: RoleSummary = {
        id: fakeId(nextId++),
        name: input.name,
        templateKey: null,
        isAdmin: false,
        permissions: input.permissions,
        memberCount: 0,
      }
      roles = [...roles, role]
      return structuredClone(role)
    },
    async update(_projectId, roleId, input) {
      api.calls.push({ method: 'update', roleId, input })
      failIfAsked()
      roles = roles.map((r) => (r.id === roleId ? { ...r, ...input } : r))
      const updated = roles.find((r) => r.id === roleId)
      if (!updated) throw new RolesApiError(404, 'ROLE_NOT_FOUND')
      return structuredClone(updated)
    },
    async remove(_projectId, roleId) {
      api.calls.push({ method: 'remove', roleId })
      failIfAsked()
      roles = roles.filter((r) => r.id !== roleId)
    },
  }

  return api
}
