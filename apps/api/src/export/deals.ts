import { type Database, withProject } from '@alpi/db'
import type { Kysely } from 'kysely'
import { recordInRequest } from '../audit/record.ts'
import { type Ctx, fail, refuse } from '../contacts/http.ts'
import { type BoardDeal, decodeCursor, listDealsPage, readDealsQuery } from '../deals/board.ts'
import { dealContext } from '../deals/store.ts'
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

// Выгрузка списка сделок: `GET /v1/deals/export.csv` с теми же параметрами, что у списка
// (filter, sort, pipeline, status, archived…), плюс columns=a,b,c и lang=uk|ru. Строки берёт
// та же функция выдачи, что у списка и канбана (deals/board.ts, listDealsPage), — значит, и тот
// же охват.

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
): CsvValue {
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
  const query = readDealsQuery(c, ctx)
  if (!query.ok) return fail(c, query)
  const chosen = readColumns('deals', c.req.query('columns'))
  if (!chosen) return fail(c, refuse(400, 'INVALID_DEAL', { path: 'columns' }))
  const lang = readLanguage(c.req.query('lang'))
  if (!lang) return fail(c, refuse(400, 'INVALID_DEAL', { path: 'lang' }))
  const columns: readonly string[] = chosen
  const language: ExportLanguage = lang
  const { filters, sort, cursor: start } = query.value
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
    yield UTF8_BOM + csvHeader(columns, language)
    let cursor = start
    while (true) {
      const page = await withProject(rootDb, projectId, (trx) =>
        listDealsPage({ ...ctx, db: trx }, filters, {
          limit: EXPORT_BATCH,
          sort,
          ...(cursor ? { cursor } : {}),
        }),
      )
      if (page.items.length > 0) {
        yield page.items
          .map((deal) => csvRow(columns.map((column) => dealCell(deal, column, names, language))))
          .join('')
      }
      if (page.nextCursor === null) return
      cursor = decodeCursor(page.nextCursor, sort)
      if (!cursor) throw new Error('выгрузка: курсор своей же страницы не разобрался')
    }
  }
  return csvResponse(exportFilename('deals'), rows())
}
