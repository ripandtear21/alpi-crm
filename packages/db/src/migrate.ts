import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Kysely } from 'kysely'
import { FileMigrationProvider, type MigrationResult, Migrator } from 'kysely/migration'
import type { Database } from './index.ts'

/** Папка миграций пакета: packages/db/migrations. */
export const migrationFolder = fileURLToPath(new URL('../migrations', import.meta.url))

/**
 * Применяет все ещё не применённые миграции. При ошибке бросает исключение:
 * частично применённый набор не должен выглядеть успехом.
 */
export async function migrateToLatest(
  db: Kysely<Database>,
  folder: string = migrationFolder,
): Promise<MigrationResult[]> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: folder,
      // import() в ESM не принимает абсолютный путь Windows (E:\...), только file:// URL.
      import: (file) => import(pathToFileURL(file).href),
    }),
  })
  const { error, results = [] } = await migrator.migrateToLatest()
  if (error) {
    throw new Error('Миграции не применены', { cause: error })
  }
  return results
}
