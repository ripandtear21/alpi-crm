import type { Database } from '@alpi/db'
import { type Kysely, sql } from 'kysely'
import { fromKysely, type PgBoss } from 'pg-boss'

// Очередь поиска дублей одной записи (тикет crm-intake/05; пункт 34): задачу ставит каждое
// изменение, от которого зависят пары, той же транзакцией, что изменение (`fromKysely(trx)`):
// откат транзакции откатывает и задачу.
//
// - Создание контакта и смена его телефонов, email, имени или отметки «возможный дубль» — все
//   идут через replaceContactKeys (contacts/contacts.ts): ручные создание и правка и приём
//   регистраций; восстановление контакта из корзины — restoreContact там же.
// - Регистрация (intake/process.ts): контакт и его сделки, даже если ключи не менялись —
//   регистрация могла создать вторую открытую сделку в воронке.
// - Слияние и откат слияния контактов и сделок (merge/store.ts: insertMerge, markUndone).
// Остальное (смена основного контакта сделки, архив, корзина сделки) догоняет ночной проход.
//
// Очередь одна на процесс, как очередь событий (events/queue.ts): ядро контактов, приём
// регистраций и слияние ставят задачу, не протаскивая pg-boss через свои контексты. Подключают
// её startJobs и startEventQueue (jobs/jobs.ts). Не подключена — изменение падает и
// откатывается: изменение без задачи оставило бы пары устаревшими до ночи без следа.
//
// Ключ задачи — запись и транзакция (`txid_current()`), политика очереди `short`: постановки одной
// записи в одной транзакции (правка контакта, затем его регистрация) дают одну задачу, а каждая
// зафиксированная транзакция — свою. Ключ по одной записи терял бы правку: задачу первой правки
// фоновая задача берёт, пока вторая ещё не зафиксирована, а постановка второй пропущена — ждущая
// задача той же записи уже была. Цена: серия правок одного контакта — по задаче на правку.

export const DUPLICATE_SCAN_QUEUE = 'duplicate-scan'

/** Задача поиска: запись и её проект. Сделка пересчитывается через свой основной контакт. */
export interface DuplicateScanMessage {
  projectId: string
  entity: 'contact' | 'deal'
  id: string
}

/** Подключённые pg-boss; задачи ставит последний. Отключение возвращает предыдущий. */
const attached: PgBoss[] = []

/** Создаёт очередь поиска дублей (есть — оставляет) и ставит задачи через `boss`. */
export async function attachDuplicateQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(DUPLICATE_SCAN_QUEUE, {
    policy: 'short',
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 5 * 60,
  })
  attached.push(boss)
}

/** Отключает `boss` после его остановки (как detachEventQueue). */
export function detachDuplicateQueue(boss: PgBoss): void {
  const index = attached.lastIndexOf(boss)
  if (index !== -1) attached.splice(index, 1)
}

/**
 * Ставит поиск дублей записей `records` транзакцией `trx` — той же, что их изменила. Повтор
 * записи в списке и задача той же записи, уже поставленная этой транзакцией, новой задачи не дают.
 */
export async function enqueueDuplicateScan(
  trx: Kysely<Database>,
  projectId: string,
  records: readonly { entity: DuplicateScanMessage['entity']; id: string }[],
): Promise<void> {
  const boss = attached.at(-1)
  if (boss === undefined) {
    throw new Error(
      'очередь поиска дублей не подключена: attachDuplicateQueue (duplicates/queue.ts)',
    )
  }
  const { rows } = await sql<{ txid: string }>`select txid_current()::text as txid`.execute(trx)
  const txid = rows[0]?.txid ?? ''
  const seen = new Set<string>()
  for (const { entity, id } of records) {
    const key = `${entity}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    const message: DuplicateScanMessage = { projectId, entity, id }
    await boss.send(DUPLICATE_SCAN_QUEUE, message, {
      db: fromKysely(trx),
      singletonKey: `${key}:${txid}`,
    })
  }
}
