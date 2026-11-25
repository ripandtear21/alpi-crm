import {
  EMPTY_FILTER,
  type FilterGroup,
  type FilterNode,
  type PipelineSummary,
  parseFilter,
} from '@alpi/shared'
import type { FilterOptions } from './filter-editor.tsx'

// Варианты значений полей-справочников фильтра сделок и начальный фильтр из адреса — общие
// для канбана и списка (тикет crm-deals/12).

/** Воронки, этапы (с именем воронки) и ответственные — для выпадающих списков фильтра. */
export function dealFilterOptions(
  pipelines: readonly PipelineSummary[],
  owners: readonly { id: string; name: string }[],
): FilterOptions {
  return {
    pipeline: pipelines.map((p) => ({ value: p.id, label: p.name })),
    stage: pipelines.flatMap((p) =>
      p.stages.map((s) => ({ value: s.id, label: `${p.name} — ${s.name}` })),
    ),
    owner: owners.map((o) => ({ value: o.id, label: o.name })),
  }
}

/** Только ответственные/авторы — для контактов и организаций. */
export function creatorFilterOptions(
  owners: readonly { id: string; name: string }[],
): FilterOptions {
  return { createdBy: owners.map((o) => ({ value: o.id, label: o.name })) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Начальный фильтр списка сделок из адреса: `filter` (JSON того же формата, что у API) и/или
 * `pipeline`, `stage` — так открывает список ссылка «ще N» из колонки канбана. Негодный
 * фильтр в адресе молча отбрасывается: адрес мог прийти из старой закладки. С условиями по
 * пользовательским полям фильтр проверяет сервер.
 */
export function dealFilterFromSearch(search: {
  filter?: unknown
  pipeline?: unknown
  stage?: unknown
}): FilterGroup {
  const parts: FilterNode[] = []
  if (typeof search.filter === 'string') {
    try {
      const raw: unknown = JSON.parse(search.filter)
      const parsed = parseFilter('deals', raw)
      if (parsed.ok) parts.push(parsed.filter)
      // Условия по пользовательским полям (тикет crm-fields/07) здесь проверить не по чему:
      // полей ещё нет. Такой фильтр уходит как есть — его проверяет сервер (неверный — 400/422).
      else if (parsed.error.unknownCustomField) parts.push(raw as FilterGroup)
    } catch {
      // не JSON — без фильтра из адреса
    }
  }
  if (typeof search.pipeline === 'string' && UUID.test(search.pipeline)) {
    parts.push({ field: 'pipeline', op: 'eq', value: search.pipeline })
  }
  if (typeof search.stage === 'string' && UUID.test(search.stage)) {
    parts.push({ field: 'stage', op: 'eq', value: search.stage })
  }
  if (parts.length === 0) return EMPTY_FILTER
  const [only] = parts
  if (parts.length === 1 && only && 'and' in only) return only
  return { and: parts }
}
