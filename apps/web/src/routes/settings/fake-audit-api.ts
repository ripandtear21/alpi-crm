import type { AuditActor, AuditEntry, ProjectAuditAction } from '@alpi/shared'
import { type AuditApi, AuditApiError, type AuditFilter } from './audit-api.ts'

// Подставной клиент журнала для тестов: записи в памяти (новые первыми), страницы по
// `pageSize`; `deny` — ответ 403, как без права «настройки проекта»; `first` — записи перед
// остальными (например, автор — ключ API).

export interface FakeAuditApi extends AuditApi {
  /** Запрошенные страницы — с какими фильтрами. */
  calls: AuditFilter[]
}

export const FAKE_ACTORS: AuditActor[] = [
  { id: 'u-admin', name: 'Олена', email: 'olena@example.test' },
  { id: 'u-head', name: 'Петро', email: 'petro@example.test' },
]

function entry(
  n: number,
  action: ProjectAuditAction,
  actor: AuditActor,
  details: Record<string, unknown>,
  entity: { type: string; id: string; name?: string },
): AuditEntry<ProjectAuditAction> {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    occurredAt: new Date(Date.UTC(2026, 10, 4, 12, 0, 60 - n)).toISOString(),
    actor,
    apiKey: null,
    ip: '203.0.113.7',
    action,
    entityType: entity.type,
    entityId: entity.id,
    entityName: entity.name ?? null,
    details,
  }
}

export function fakeAuditEntries(): AuditEntry<ProjectAuditAction>[] {
  const [admin, head] = FAKE_ACTORS as [AuditActor, AuditActor]
  return [
    entry(
      1,
      'member.role_changed',
      admin,
      {
        before: { roleId: 'r-manager', roleName: 'Менеджер' },
        after: { roleId: 'r-head', roleName: 'Керівник' },
      },
      { type: 'user', id: 'u-ivan', name: 'Іван' },
    ),
    entry(2, 'role.created', head, { after: { name: 'Стажер' } }, { type: 'role', id: 'r-1' }),
    entry(
      3,
      'role.updated',
      admin,
      { before: { name: 'Стажер' }, after: { name: 'Практикант' } },
      { type: 'role', id: 'r-1' },
    ),
  ]
}

export function fakeAuditApi({
  deny = false,
  pageSize = 50,
  first = [],
}: {
  deny?: boolean
  pageSize?: number
  first?: AuditEntry<ProjectAuditAction>[]
} = {}): FakeAuditApi {
  const entries = [...first, ...fakeAuditEntries()]

  const api: FakeAuditApi = {
    calls: [],
    async page(_projectId, filter) {
      api.calls.push(filter)
      if (deny) throw new AuditApiError(403, 'PERMISSION_DENIED')
      const matching = entries.filter(
        (e) =>
          (!filter.action || e.action === filter.action) &&
          (!filter.actor || e.actor?.id === filter.actor),
      )
      const start = filter.cursor ? Number(filter.cursor) : 0
      const items = matching.slice(start, start + pageSize)
      const next = start + pageSize
      return { items, nextCursor: next < matching.length ? String(next) : null }
    },
    async actors() {
      if (deny) throw new AuditApiError(403, 'PERMISSION_DENIED')
      return FAKE_ACTORS
    },
  }
  return api
}
