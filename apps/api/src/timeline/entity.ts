import { type Action, can, type Resource } from '@alpi/shared'
import { sql } from 'kysely'
import { type Ctx, type Outcome, ok, refuse, UUID } from '../contacts/http.ts'
import { contactScopePredicate } from '../contacts/scope.ts'
import { dealInScope, ownerAllowed } from '../deals/scope.ts'
import { requestViewer } from '../roles/scope.ts'

// Запись, к которой относятся заметки, файлы и лента (тикет crm-deals/07): сделка, контакт или
// организация. Права — права на саму запись: читать — право «смотреть» её часть системы и
// запись в охвате чтения; добавлять и менять — право «изменять» и запись в охвате изменения.
// Вне охвата чтения или в корзине — 404, как несуществующая; в охвате чтения, но не изменения —
// 403 (как у сделок и контактов). У организаций охвата нет.

export const ENTITY_TYPES = ['deal', 'contact', 'organization'] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

/** Часть системы, права на которую — права на заметки, файлы и ленту записи. */
export const ENTITY_RESOURCE = {
  deal: 'deals',
  contact: 'contacts',
  organization: 'organizations',
} as const satisfies Record<EntityType, Resource>

/** Путь раздела в `/v1/...`. */
export const ENTITY_PATH = {
  deal: 'deals',
  contact: 'contacts',
  organization: 'organizations',
} as const satisfies Record<EntityType, string>

/** Столбец ссылки на запись в note и file. */
export const ENTITY_COLUMN = {
  deal: 'deal_id',
  contact: 'contact_id',
  organization: 'organization_id',
} as const satisfies Record<EntityType, string>

const NOT_FOUND = {
  deal: 'DEAL_NOT_FOUND',
  contact: 'CONTACT_NOT_FOUND',
  organization: 'ORGANIZATION_NOT_FOUND',
} as const satisfies Record<EntityType, string>

export type EntityErrorCode = (typeof NOT_FOUND)[EntityType] | 'PERMISSION_DENIED'

/** Запись, доступ к которой проверен. */
export interface EntityRef {
  type: EntityType
  id: string
}

/** Значения ссылок note и file на запись `entity`: одна заполнена, остальные null. */
export function targetValues(entity: EntityRef) {
  return {
    deal_id: entity.type === 'deal' ? entity.id : null,
    contact_id: entity.type === 'contact' ? entity.id : null,
    organization_id: entity.type === 'organization' ? entity.id : null,
  }
}

/** Роль пользователя разрешает действие `action` с частью системы записей вида `type`. */
export function entityCan(c: Ctx, type: EntityType, action: Action): boolean {
  return can(c.get('access').permissions, ENTITY_RESOURCE[type], action)
}

/**
 * Запись `id` вида `type` для чтения (`need: 'read'`) или изменения (`'write'`). Право на действие
 * с частью системы проверяет requirePermission на маршруте; здесь — существование, корзина и
 * охват.
 */
export async function entityFor(
  c: Ctx,
  type: EntityType,
  id: string,
  need: 'read' | 'write',
): Promise<Outcome<EntityRef, EntityErrorCode>> {
  const notFound = refuse(404, NOT_FOUND[type])
  if (!UUID.test(id)) return notFound
  const db = c.get('db')
  const ref: EntityRef = { type, id: id.toLowerCase() }
  if (type === 'organization') {
    const row = await db
      .selectFrom('organization')
      .select('id')
      .where('id', '=', ref.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    return row ? ok(ref) : notFound
  }
  // Автор запроса — участник или ключ API (тикет crm-api/04): сессии у ключа нет.
  const viewer = await requestViewer(db, c.get('actor'))
  const { permissions } = c.get('access')
  if (type === 'deal') {
    const scope = permissions.scopes.deals
    const row = await db
      .selectFrom('deal')
      .select('owner_id')
      .where('id', '=', ref.id)
      .where('deleted_at', 'is', null)
      .where(dealInScope(sql.ref('deal.owner_id'), scope.read, viewer))
      .executeTakeFirst()
    if (!row) return notFound
    if (need === 'write' && !ownerAllowed(row.owner_id, scope.write, viewer)) {
      return refuse(403, 'PERMISSION_DENIED')
    }
    return ok(ref)
  }
  const scope = permissions.scopes.contacts
  const contactIn = (contactScope: typeof scope.read) =>
    db
      .selectFrom('contact')
      .select('id')
      .where('id', '=', ref.id)
      .where('deleted_at', 'is', null)
      .where((eb) => contactScopePredicate(eb, contactScope, viewer))
      .executeTakeFirst()
  if (!(await contactIn(scope.read))) return notFound
  if (need === 'write' && scope.write !== scope.read && !(await contactIn(scope.write))) {
    return refuse(403, 'PERMISSION_DENIED')
  }
  return ok(ref)
}
