import type { Database } from '@alpi/db'
import type { Scope } from '@alpi/shared'
import { type Expression, type ExpressionBuilder, type SqlBool, sql } from 'kysely'
import { scopePredicate, type Viewer } from '../roles/scope.ts'

// Охват контактов (spec.md, раздел 4; ответ владельца, пункт 13). У контакта нет
// ответственного: «свой» контакт — основной или участник в доступной пользователю сделке либо
// созданный им. «Команды» — то же для пользователей его команды. Сделок ещё нет, поэтому здесь
// одно правило — «создан мной / моей командой» (contact.created_by). Тикет 05 добавит в
// CONTACT_SCOPE_RULES правило «основной или участник в сделке, доступной по охвату сделок».
// Контакт без создателя (придёт из приёма регистраций) по этому правилу виден только в «все».

/** Одно правило «контакт свой»: условие на строку `contact` для охвата `scope` (не 'all'). */
export type ContactScopeRule = (
  eb: ExpressionBuilder<Database, 'contact'>,
  scope: Exclude<Scope, 'all'>,
  viewer: Viewer,
) => Expression<SqlBool>

/** Контакт создан пользователем (охват «свои») или пользователем его команды («команда»). */
export const CREATED_BY_RULE: ContactScopeRule = (eb, scope, viewer) =>
  scopePredicate(eb, scope, viewer, 'contact.created_by')

/** Правила охвата контактов: контакт виден, если подходит хотя бы одно. */
export const CONTACT_SCOPE_RULES: readonly ContactScopeRule[] = [CREATED_BY_RULE]

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
