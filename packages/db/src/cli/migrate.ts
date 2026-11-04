// Применяет миграции служебной ролью (владелец таблиц) из MIGRATION_DATABASE_URL:
// `pnpm --filter @alpi/db migrate`.
// Если задана DATABASE_URL (подключение API), после миграций создаёт или обновляет роль входа
// приложения из неё — член alpi_app без SUPERUSER и BYPASSRLS — и проверяет её.
import { assertRestrictedRole, ensureAppLoginRole } from '../app-role.ts'
import { createDb } from '../index.ts'
import { migrateToLatest } from '../migrate.ts'

const serviceUrl = process.env.MIGRATION_DATABASE_URL
if (!serviceUrl) {
  console.error('Не задана переменная окружения MIGRATION_DATABASE_URL (служебная роль миграций)')
  process.exit(1)
}
const appUrl = process.env.DATABASE_URL

const db = createDb(serviceUrl)
try {
  const results = await migrateToLatest(db)
  for (const r of results) {
    console.log(`${r.status}: ${r.migrationName}`)
  }
  if (results.length === 0) {
    console.log('Новых миграций нет')
  }
  if (appUrl) {
    const url = new URL(appUrl)
    const user = decodeURIComponent(url.username)
    await ensureAppLoginRole(db, { user, password: decodeURIComponent(url.password) })
    const appDb = createDb(appUrl)
    try {
      await assertRestrictedRole(appDb)
    } finally {
      await appDb.destroy()
    }
    console.log(`Роль приложения «${user}» готова`)
  }
} finally {
  await db.destroy()
}
