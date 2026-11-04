import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Kysely } from 'kysely'
import { FileMigrationProvider, type MigrationResult, Migrator } from 'kysely/migration'
import type { Database } from './schema.ts'

/** Папка миграций пакета: packages/db/migrations. */
export const migrationFolder = fileURLToPath(new URL('../migrations', import.meta.url))

/** Мигратор Kysely по файлам из папки: для отката (`migrateTo(NO_MIGRATIONS)`) и прогона. */
export function createMigrator(db: Kysely<Database>, folder: string = migrationFolder): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: folder,
      // import() в ESM не принимает абсолютный путь Windows (E:\...), только file:// URL.
      import: (file) => import(pathToFileURL(file).href),
    }),
  })
}

/**
 * Применяет все ещё не применённые миграции. При ошибке бросает исключение:
 * частично применённый набор не должен выглядеть успехом.
 */
export async function migrateToLatest(
  db: Kysely<Database>,
  folder: string = migrationFolder,
): Promise<MigrationResult[]> {
  const { error, results = [] } = await createMigrator(db, folder).migrateToLatest()
  if (error) {
    throw new Error('Миграции не применены', { cause: error })
  }
  return results
}
