import type { Database } from '@alpi/db'
import type { ListCount } from '@alpi/shared'
import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import { fail } from '../contacts/http.ts'
import { exportDeals } from '../export/deals.ts'
import {
  type PermissionsEnv,
  requirePermission,
  requireStandalone,
} from '../middleware/permissions.ts'
import { countDeals } from './board.ts'
import { dealContext } from './store.ts'

/**
 * Список сделок (тикет crm-deals/12) сверх выдачи `GET /v1/deals`: `/v1/deals/count` — счётчик
 * результатов, `/v1/deals/export.csv` — выгрузка (право export). Параметры — те же, что у
 * выдачи (deals/board.ts). Монтируется до dealsRoutes, иначе `count` разобрался бы как id
 * сделки. `rootDb` — для порций выгрузки.
 */
export function dealListRoutes(rootDb: Kysely<Database>) {
  const view = requirePermission('deals', 'view')
  return new Hono<PermissionsEnv>()
    .get('/count', view, async (c) => {
      const outcome = await countDeals(c, await dealContext(c))
      return outcome.ok ? c.json<ListCount>(outcome.value) : fail(c, outcome)
    })
    .get('/export.csv', view, requireStandalone('export'), (c) => exportDeals(c, rootDb))
}
