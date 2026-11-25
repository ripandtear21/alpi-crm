import { type Database, withProject } from '@alpi/db'
import type { Kysely } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import { type Ctx, fail, refuse } from '../contacts/http.ts'
import { type BoardDeal, decodeCursor, listDealsPage, readDealsQuery } from '../deals/board.ts'
import { dealContext } from '../deals/store.ts'
import type { CatalogField } from '../filters/custom.ts'
import {
  type CsvValue,
  csvHeader,
  csvResponse,
  csvRow,
  EXPORT_BATCH,
  type ExportLanguage,
  exportFilename,
  QUEUE_LABEL,
  readColumns,
  readLanguage,
  STATUS_LABELS,
  UTF8_BOM,
} from './csv.ts'
import {
  type CustomNames,
  customCell,
  customColumnField,
  customHeaders,
  loadCustomNames,
} from './custom.ts'

// Выгрузка списка сделок: `GET /v1/deals/export.csv` с теми же параметрами, что у списка
// (filter, sort, pipeline, status, archived…), плюс columns=a,b,c и lang=uk|ru. Строки берёт
// та же функция выдачи, что у списка и канбана (deals/board.ts, listDealsPage), — значит, и тот
// же охват. Колонки пользовательских полей — `custom.<id|код>` (export/custom.ts).

interface Names {
  pipelines: Map<string, string>
  stages: Map<string, string>
  lostReasons: Map<string, string>
}

async function loadNames(db: Kysely<Database>): Promise<Names> {
  const [pipelines, stages, reasons] = await Promise.all([
    db.selectFrom('pipeline').select(['id', 'name']).execute(),
    db.selectFrom('stage').select(['id', 'name']).execute(),
    db.selectFrom('lost_reason').select(['id', 'name']).execute(),
  ])
  const map = (rows: { id: string; name: string }[]) => new Map(rows.map((r) => [r.id, r.name]))
  return { pipelines: map(pipelines), stages: map(stages), lostReasons: map(reasons) }
}

function dealCell(
  deal: BoardDeal,
  column: string,
  names: Names,
  language: ExportLanguage,
  custom: { fields: readonly CatalogField[]; names: CustomNames },
): CsvValue {
  const field = customColumnField(column, custom.fields)
  if (field) return customCell(field, deal.custom[field.code], custom.names, language)
  switch (column) {
    case 'title':
      return deal.title
    case 'pipeline':
      return names.pipelines.get(deal.pipelineId) ?? null
    case 'stage':
      return names.stages.get(deal.stageId) ?? null
    case 'status':
      return STATUS_LABELS[language][deal.status] ?? deal.status
    case 'amount':
      return deal.amount
    case 'currency':
      return deal.currency
    case 'owner':
      return deal.ownerId === null ? QUEUE_LABEL[language] : deal.ownerName
    case 'contact':
      return deal.contactName
    case 'organization':
      return deal.organizationName
    case 'createdAt':
      return deal.createdAt
    case 'stageChangedAt':
      return deal.stageChangedAt
    case 'wonAt':
      return deal.wonAt
    case 'lostAt':
      return deal.lostAt
    case 'lostReason':
      return deal.lostReasonId === null ? null : (names.lostReasons.get(deal.lostReasonId) ?? null)
    case 'archivedAt':
      return deal.archivedAt
    default:
      return null
  }
}

/**
 * `GET /v1/deals/export.csv`. `rootDb` — подключение ролью приложения: порции читаются каждая
 * в своей транзакции проекта (withProject), потому что транзакция запроса закрывается, как
 * только обработчик вернул ответ, а файл ещё идёт.
 */
export async function exportDeals(c: Ctx, rootDb: Kysely<Database>): Promise<Response> {
  const ctx = await dealContext(c)
  const query = await readDealsQuery(c, ctx)
  if (!query.ok) return fail(c, query)
  const { filters, sort, cursor: start } = query.value
  const catalog = filters.custom ?? []
  const chosen = readColumns('deals', c.req.query('columns'), catalog)
  if (!chosen.ok) {
    return fail(
      c,
      chosen.unknownCustomField === undefined
        ? refuse(400, 'INVALID_DEAL', { path: 'columns' })
        : refuse(422, 'CUSTOM_FIELD_UNKNOWN', { field: chosen.unknownCustomField }),
    )
  }
  const lang = readLanguage(c.req.query('lang'))
  if (!lang) return fail(c, refuse(400, 'INVALID_DEAL', { path: 'lang' }))
  const columns: readonly string[] = chosen.columns
  const language: ExportLanguage = lang
  const customFields = catalog.filter((field) => columns.includes(`custom.${field.id}`))
  const names = await loadNames(ctx.db)
  await recordInRequest(c, {
    action: 'export.downloaded',
    details: {
      list: 'deals',
      columns,
      sort: `${sort.column}:${sort.direction}`,
      status: filters.status,
      archived: filters.archived,
      ...(filters.filter ? { filter: filters.filter } : {}),
    },
  })

  const { projectId } = ctx
  async function* rows(): AsyncGenerator<string> {
    yield UTF8_BOM + csvHeader(columns, language, customHeaders(columns, catalog, language))
    let cursor = start
    while (true) {
      const { page, customNames } = await withProject(rootDb, projectId, async (trx) => {
        const page = await listDealsPage({ ...ctx, db: trx }, filters, {
          limit: EXPORT_BATCH,
          sort,
          ...(cursor ? { cursor } : {}),
        })
        const values = page.data.map((deal) => deal.custom)
        return { page, customNames: await loadCustomNames(trx, customFields, values) }
      })
      const custom = { fields: customFields, names: customNames }
      if (page.data.length > 0) {
        yield page.data
          .map((deal) =>
            csvRow(columns.map((column) => dealCell(deal, column, names, language, custom))),
          )
          .join('')
      }
      if (page.next_cursor === null) return
      cursor = decodeCursor(page.next_cursor, sort, catalog)
      if (!cursor) throw new Error('выгрузка: курсор своей же страницы не разобрался')
    }
  }
  return csvResponse(exportFilename('deals'), rows())
}
