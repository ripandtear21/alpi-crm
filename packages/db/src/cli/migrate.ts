// Применяет миграции к базе из DATABASE_URL: `pnpm --filter @alpi/db migrate`.
import { createDb } from '../index.ts'
import { migrateToLatest } from '../migrate.ts'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('Не задана переменная окружения DATABASE_URL')
  process.exit(1)
}

const db = createDb(connectionString)
try {
  const results = await migrateToLatest(db)
  for (const r of results) {
    console.log(`${r.status}: ${r.migrationName}`)
  }
  if (results.length === 0) {
    console.log('Новых миграций нет')
  }
} finally {
  await db.destroy()
}
