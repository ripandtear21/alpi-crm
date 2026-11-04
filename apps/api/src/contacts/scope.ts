import type { Database } from '@alpi/db'
import type { Scope } from '@alpi/shared'
import { type Expression, type ExpressionBuilder, type SqlBool, sql } from 'kysely'
import { dealInScope } from '../deals/scope.ts'
import { scopePredicate, type Viewer } from '../roles/scope.ts'

// Охват контактов (spec.md, раздел 4; ответ владельца, пункт 13). У контакта нет
// ответственного: «свой» контакт — основной или участник в доступной пользователю сделке либо
// созданный им. «Команды» — то же для пользователей его команды. Доступная сделка — не в
// корзине, её ответственный в том же охвате (свои / команда) или её нет (общая очередь видна
// всем, deals/scope.ts). Контакт без создателя и без сделок (придёт из приёма регистраций)
// виден только в «все».

/** Одно правило «контакт свой»: условие на строку `contact` для охвата `scope` (не 'all'). */
export type ContactScopeRule = (
  eb: ExpressionBuilder<Database, 'contact'>,
  scope: Exclude<Scope, 'all'>,
  viewer: Viewer,
) => Expression<SqlBool>

/** Контакт создан пользователем (охват «свои») или пользователем его команды («команда»). */
export const CREATED_BY_RULE: ContactScopeRule = (eb, scope, viewer) =>
  scopePredicate(eb, scope, viewer, 'contact.created_by')

/**
 * Контакт — основной или участник в сделке, доступной в том же охвате (сделка не в корзине;
 * её ответственный — пользователь, его команда или никто).
 */
export const DEAL_RULE: ContactScopeRule = (_eb, scope, viewer) => sql<SqlBool>`exists (
    select 1 from deal d
    where d.deleted_at is null
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
 */
export function contactScopePredicate(
  eb: ExpressionBuilder<Database, 'contact'>,
  scope: Scope,
  viewer: Viewer,
  rules: readonly ContactScopeRule[] = CONTACT_SCOPE_RULES,
): Expression<SqlBool> {
  if (scope === 'all') return sql<SqlBool>`true`
  return eb.or(rules.map((rule) => rule(eb, scope, viewer)))
}
