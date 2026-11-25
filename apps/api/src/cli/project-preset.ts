// Стартовая настройка проекта (тикет crm-deals/02) — воронки с этапами и причины проигрыша, у
// ALPI ещё пользовательские поля (тикет crm-fields/08):
//   pnpm project-preset <alpi|franch> <id проекта>
// Работает служебной ролью (владелец таблиц) из MIGRATION_DATABASE_URL, как мигратор.
// Повторный запуск ничего не дублирует: что уже есть в проекте, не трогается.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  applyProjectPreset,
  createDb,
  type Database,
  isPresetKey,
  PRESET_KEYS,
  presetCreatedAnything,
  withProject,
} from '@alpi/db'
import type { Kysely } from 'kysely'
import { audit } from '../audit/record.ts'

const USAGE = `Использование: pnpm project-preset <${PRESET_KEYS.join('|')}> <id проекта>`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Output {
  log(message: string): void
  error(message: string): void
}

/**
 * Применяет настройку из аргументов `args` (`<настройка> <id проекта>`) одной транзакцией в
 * контексте проекта и пишет в журнал проекта, что создано. Код выхода: 0 — готово (в том
 * числе «ничего нового»), 1 — проекта нет, 2 — неверные аргументы.
 */
export async function runProjectPreset(
  serviceDb: Kysely<Database>,
  args: string[],
  out: Output = console,
): Promise<number> {
  const [key, projectId] = args
  if (!isPresetKey(key) || !projectId || !UUID.test(projectId)) {
    out.error(USAGE)
    return 2
  }
  const project = await serviceDb
    .selectFrom('project')
    .select(['id', 'name'])
    .where('id', '=', projectId)
    .executeTakeFirst()
  if (!project) {
    out.error(`Проект ${projectId} не найден`)
    return 1
  }
  const created = await withProject(serviceDb, project.id, async (trx) => {
    const result = await applyProjectPreset(trx, project.id, key)
    if (presetCreatedAnything(result)) {
      await audit.record(trx, project.id, {
        action: 'project.preset_applied',
        actorId: null,
        ip: null,
        entity: { type: 'project', id: project.id },
        details: { preset: key, after: result },
      })
    }
    return result
  })
  const list = (items: string[]) => items.join(', ') || '—'
  out.log(
    presetCreatedAnything(created)
      ? `«${project.name}»: созданы воронки ${list(created.pipelines)}, группы причин ${list(created.lostReasonGroups)}, группы полей ${list(created.fieldGroups)}, поля ${list(created.fields)}`
      : `«${project.name}»: настройка ${key} уже применена, ничего не создано`,
  )
  for (const warning of created.warnings) out.error(`Внимание: ${warning}`)
  return 0
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const url = process.env.MIGRATION_DATABASE_URL
  if (!url) {
    console.error('Не задана переменная окружения MIGRATION_DATABASE_URL (служебная роль)')
    process.exit(1)
  }
  const db = createDb(url)
  try {
    process.exitCode = await runProjectPreset(db, process.argv.slice(2))
  } finally {
    await db.destroy()
  }
}
