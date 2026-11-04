import { type Database, withProject } from '@alpi/db'
import { PROJECT_HEADER } from '@alpi/shared'
import { createMiddleware } from 'hono/factory'
import type { Kysely, Transaction } from 'kysely'
import type { AccessEnv } from '../auth/access-guard.ts'

// Контекст проекта для запроса (docs/adr/0001-izolyatsiya-proektov.md): клиент присылает
// выбранный проект в заголовке X-Project-Id, промежуточный слой проверяет участие пользователя
// и выполняет обработчик внутри withProject — row-level security базы показывает обработчику
// только строки этого проекта, без фильтров в коде.
//
// Заголовок, а не префикс пути /projects/:id/…: маршруты разделов не повторяют параметр
// проекта, клиент выставляет его в одном месте, а нестандартный заголовок браузер не пошлёт с
// чужого сайта без разрешения CORS (дополнительная защита от подделки запросов).

/** Переменные контекста Hono внутри проекта. */
export type ProjectEnv = {
  Variables: AccessEnv['Variables'] & {
    /** id текущего проекта: пользователь в нём состоит. */
    projectId: string
    /** Транзакция с выставленным проектом: все запросы обработчика — через неё. */
    db: Transaction<Database>
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Действует на все маршруты, зарегистрированные после него; ставится после accessGuard.
 * - нет сессии с пройденной 2FA — 401 (accessGuard пропускает дальше без сессии открытые пути
 *   входа, и если такой путь не совпал с маршрутом Better Auth, он доходит сюда);
 * - нет заголовка — 400 PROJECT_REQUIRED;
 * - проекта нет, пользователь в нём не состоит или его участие отключено — одинаковый 403 PROJECT_FORBIDDEN, чтобы
 *   ответ не выдавал, существует ли проект.
 * Ошибка обработчика откатывает транзакцию проекта.
 */
export function projectContext(db: Kysely<Database>) {
  return createMiddleware<ProjectEnv>(async (c, next) => {
    const session = c.get('session')
    if (!session?.user.twoFactorEnabled || session.session.twoFactorVerified !== true) {
      return c.json({ code: 'UNAUTHORIZED' }, 401)
    }
    const projectId = c.req.header(PROJECT_HEADER)
    if (!projectId) {
      return c.json({ code: 'PROJECT_REQUIRED' }, 400)
    }
    if (!UUID.test(projectId)) {
      return c.json({ code: 'PROJECT_FORBIDDEN' }, 403)
    }

    let member = false
    try {
      await withProject(db, projectId, async (trx) => {
        // project_id в условии — не замена политике, а вторая линия: решение о доступе не
        // держится на одном механизме.
        const row = await trx
          .selectFrom('project_member')
          .select('id')
          .where('project_id', '=', projectId)
          .where('user_id', '=', session.user.id)
          // Отключённое участие (тикет crm-foundation/06) — как его отсутствие.
          .where('disabled_at', 'is', null)
          .executeTakeFirst()
        if (!row) return
        member = true
        c.set('projectId', projectId)
        c.set('db', trx)
        await next()
        // Hono перехватывает ошибку обработчика сам (ответ 500 уже готов) и не пробрасывает её
        // сюда: без этой строки транзакция с частью изменений зафиксировалась бы.
        if (c.error) throw c.error
      })
    } catch (error) {
      if (c.error !== undefined && error === c.error) return
      throw error
    }
    if (!member) {
      return c.json({ code: 'PROJECT_FORBIDDEN' }, 403)
    }
  })
}
