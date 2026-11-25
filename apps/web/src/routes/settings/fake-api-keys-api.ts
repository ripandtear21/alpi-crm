import {
  type ApiKeySummary,
  type ApiKeyWithSecret,
  ROLE_TEMPLATES,
  type RoleSummary,
} from '@alpi/shared'
import type { ApiKeysApi } from './api-keys-api.ts'
import { RolesApiError } from './roles-api.ts'

// Подставной клиент ключей API для тестов: ключи и роли-шаблоны в памяти, секреты выдуманные.
// `deny` — список отвечает 403, как без права «интеграции: смотреть»; `failNextWith` —
// следующее изменение отклоняется с этим кодом (409); `calls` — что вызывали.

export interface FakeApiKeysApi extends ApiKeysApi {
  keys: ApiKeySummary[]
  calls: { method: 'create' | 'reissue' | 'revoke'; keyId?: string }[]
  failNextWith: string | null
}

let counter = 0
function fakeId(): string {
  counter += 1
  return `00000000-0000-4000-9200-${String(counter).padStart(12, '0')}`
}

/** Выдуманный секрет нужной формы: `alpi_` и 43 символа. */
function fakeSecret(): string {
  counter += 1
  return `alpi_test${String(counter).padStart(39, 'x')}`
}

const ROLES: RoleSummary[] = ROLE_TEMPLATES.map((template, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  name: template.name,
  templateKey: template.key,
  isAdmin: template.key === 'admin',
  permissions: structuredClone(template.permissions),
  memberCount: 0,
}))

/** Один действующий ключ «n8n» с ролью «Керівник». */
export function fakeApiKeysApi({ deny = false }: { deny?: boolean } = {}): FakeApiKeysApi {
  const head = ROLES.find((r) => r.templateKey === 'head') as RoleSummary

  function failIfAsked() {
    const code = api.failNextWith
    if (code) {
      api.failNextWith = null
      throw new RolesApiError(409, code)
    }
  }

  function key(id: string): ApiKeySummary {
    const found = api.keys.find((k) => k.id === id)
    if (!found) throw new RolesApiError(404, 'API_KEY_NOT_FOUND')
    return found
  }

  function withSecret(found: ApiKeySummary): ApiKeyWithSecret {
    const secret = fakeSecret()
    found.secretPrefix = secret.slice(0, 8)
    return { key: structuredClone(found), secret }
  }

  const api: FakeApiKeysApi = {
    keys: [
      {
        id: fakeId(),
        name: 'n8n',
        role: { id: head.id, name: head.name, templateKey: 'head' },
        secretPrefix: 'alpi_n8n',
        createdAt: '2026-11-01T10:00:00.000Z',
        createdBy: { id: 'user-1', name: 'Ірина Тестова' },
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
    calls: [],
    failNextWith: null,
    async list() {
      if (deny) throw new RolesApiError(403, 'PERMISSION_DENIED')
      return structuredClone(api.keys)
    },
    async roles() {
      return structuredClone(ROLES)
    },
    async create(_projectId, input) {
      api.calls.push({ method: 'create' })
      failIfAsked()
      const role = ROLES.find((r) => r.id === input.roleId)
      if (!role) throw new RolesApiError(422, 'ROLE_NOT_FOUND')
      const created: ApiKeySummary = {
        id: fakeId(),
        name: input.name,
        role: { id: role.id, name: role.name, templateKey: role.templateKey },
        secretPrefix: '',
        createdAt: new Date().toISOString(),
        createdBy: { id: 'user-1', name: 'Ірина Тестова' },
        expiresAt: input.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
      }
      api.keys.unshift(created)
      return withSecret(created)
    },
    async reissue(_projectId, keyId) {
      api.calls.push({ method: 'reissue', keyId })
      failIfAsked()
      return withSecret(key(keyId))
    },
    async revoke(_projectId, keyId) {
      api.calls.push({ method: 'revoke', keyId })
      failIfAsked()
      const found = key(keyId)
      found.revokedAt = new Date().toISOString()
      return structuredClone(found)
    },
  }
  return api
}
