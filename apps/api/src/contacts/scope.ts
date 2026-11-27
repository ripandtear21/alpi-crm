import type { Database } from '@alpi/db'
import type { Scope } from '@alpi/shared'
import { type Expression, type ExpressionBuilder, type SqlBool, sql } from 'kysely'
import { dealInScope } from '../deals/scope.ts'
import { scopePredicate, type Viewer } from '../roles/scope.ts'

// Охват контактов (spec.md, раздел 4; ответ владельца, пункт 13). У контакта нет
// ответственного: «свой» контакт — основной или участник в доступной пользователю сделке либо
// созданный им. «Команды» — то же для пользователей его команды. Доступная сделка — не в
// корзине (или ушла в корзину вместе с контактом), её ответственный в том же охвате (свои /
// команда) или его нет (общая очередь видна всем, deals/scope.ts). Привязать контакт к сделке
// можно только из охвата изменения контактов (deals/deals.ts, liveContact). Контакт без создателя и без сделок (придёт из приёма регистраций)
// виден только в «все».

/** Одно правило «контакт свой»: условие на строку `contact` для охвата `scope` (не 'all'). */
export type ContactScopeRule = (
  eb: ExpressionBuilder<Database, 'contact'>,
  scope: Exclude<Scope, 'all'>,
  viewer: Viewer,
) => Expression<SqlBool>

/**
 * Контакт создан пользователем (охват «свои») или пользователем его команды («команда»). У ключа
 * API команды нет: и «свои», и «команда» — контакты, созданные этим ключом (тикет crm-api/04;
 * решено без владельца — подтвердить). Так ключ с таким охватом видит контакт, который только
 * что создал, и может создать сделку с новым контактом.
 */
export const CREATED_BY_RULE: ContactScopeRule = (eb, scope, viewer) =>
  viewer.apiKeyId === undefined
    ? scopePredicate(eb, scope, viewer, 'contact.created_by')
    : eb('contact.created_by_api_key_id', '=', viewer.apiKeyId)

/**
 * Контакт — основной или участник в сделке, доступной в том же охвате (её ответственный —
 * пользователь, его команда или никто); слитая сделка скрыта и охвата не даёт (тикет
 * crm-intake/02). Сделка не в корзине — или ушла в корзину вместе с
 * этим контактом (та же отметка deleted_at): так контакт в корзине виден тем же, кому был
 * виден до удаления, и они могут его восстановить.
 */
export const DEAL_RULE: ContactScopeRule = (_eb, scope, viewer) => sql<SqlBool>`exists (
    select 1 from deal d
    where (d.deleted_at is null or d.deleted_at = contact.deleted_at)
      and d.merged_into_id is null
      and ${dealInScope(sql.ref('d.owner_id'), scope, viewer)}
      and (d.primary_contact_id = contact.id or exists (
        select 1 from deal_participant p where p.deal_id = d.id and p.contact_id = contact.id
      ))
  )`

/** Правила охвата контактов: контакт виден, если подходит хотя бы одно. */
export const CONTACT_SCOPE_RULES: readonly ContactScopeRule[] = [CREATED_BY_RULE, DEAL_RULE]

/**
 * Условие WHERE охвата контактов:
 *   .where((eb) => contactScopePredicate(eb, scope, viewer))
 *
 * Контакт, слитый с другим (тикет crm-intake/01, `merged_into_id`), скрыт при любом охвате: его
 * нет в списках, поиске, корзине и выборках охвата. Его самого ищет только слияние и откат —
 * `includeMerged` (merge/).
 */
export function contactScopePredicate(
  eb: ExpressionBuilder<Database, 'contact'>,
  scope: Scope,
  viewer: Viewer,
  rules: readonly ContactScopeRule[] = CONTACT_SCOPE_RULES,
  { includeMerged = false }: { includeMerged?: boolean } = {},
): Expression<SqlBool> {
  const inScope =
    scope === 'all' ? sql<SqlBool>`true` : eb.or(rules.map((rule) => rule(eb, scope, viewer)))
  return includeMerged ? inScope : eb.and([eb('contact.merged_into_id', 'is', null), inScope])
}
