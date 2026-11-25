import {
  type FieldEntity,
  fieldGroupAccess,
  type RequiredFieldName,
  type RequiredFieldsMissing,
} from '@alpi/shared'
import { sql } from 'kysely'
import { type Outcome, ok, refuse } from '../contacts/http.ts'
import type { FieldViewer } from './access.ts'
import type { CustomValues, CustomWrite } from './values.ts'

// Обязательность пользовательских полей (тикет crm-fields/04; spec.md MVP, разделы 5.1 и 13.0.4;
// ADR 0003) — одна функция сервера: по записи, месту, куда её ставят, и значениям после
// изменения возвращает незаполненные обязательные поля. Её зовут создание записей, смена этапа,
// выигрыш и перенос сделки (deals/deals.ts через точку расширения deals/stage-requirements.ts)
// и массовая смена этапа (deals/bulk.ts). Правило одно для менеджера и запроса API;
// администратор его не обходит. Проверка ничего не пишет и сделку не двигает.
//
// - «Всегда»: запись (сделку, контакт, организацию) нельзя создать без значения и нельзя
//   очистить поле. Старую запись с пустым полем правка других полей не блокирует, а смену этапа
//   и выигрыш сделки — блокирует (решено без владельца, подтвердить).
// - «С этапа X» воронки P: сделку воронки P нельзя поставить на X и любой этап после него по
//   порядку (position, created_at, id — как в pipelines) и нельзя выиграть, пока поле пусто.
//   Правило на «выигрыш» (stage_id null) действует только при выигрыше.
// - Учитываются только действующие поля (не архивные, не удаляемые) и у сделки — видимые в её
//   воронке (после переноса — в новой).
// - Пустое значение — отсутствие ключа в `custom` (тикет 02: пустое значение ключ убирает).
// - Поля групп, скрытых от роли, в ответе — только числом (решено без владельца, подтвердить).

/** Куда ставится запись. Сделка — на этап воронки или в выигрыш (этап не меняется). */
export type RequirementTarget =
  | { entity: 'contact' | 'organization' }
  | { entity: 'deal'; pipelineId: string; stageId: string }
  | { entity: 'deal'; pipelineId: string; won: true }

/** Незаполненные обязательные поля: видимые роли — с кодом и названием, скрытые — числом. */
export interface MissingFields {
  fields: RequiredFieldName[]
  hiddenCount: number
}

export const NOTHING_MISSING: MissingFields = { fields: [], hiddenCount: 0 }

export function anyMissing(missing: MissingFields): boolean {
  return missing.fields.length > 0 || missing.hiddenCount > 0
}

/** `details` ответа 422 (packages/shared, RequiredFieldsMissing). */
export function missingDetails(missing: MissingFields): RequiredFieldsMissing {
  return {
    fields: missing.fields.map((f) => f.code),
    names: missing.fields,
    hiddenCount: missing.hiddenCount,
  }
}

const isEmpty = (value: unknown) => value === undefined || value === null

/**
 * Незаполненные обязательные поля записи, которую ставят в `target`, со значениями `values`
 * (значения после изменения: текущие плюс переданные в том же запросе).
 */
export async function missingRequired(
  viewer: FieldViewer,
  target: RequirementTarget,
  values: CustomValues,
): Promise<MissingFields> {
  const { db } = viewer
  let query = db
    .selectFrom('field_definition as f')
    .innerJoin('field_group as g', 'g.id', 'f.group_id')
    .select(['f.code', 'f.name_uk', 'f.name_ru', 'f.group_id'])
    .where('f.entity', '=', target.entity)
    .where('f.archived_at', 'is', null)
    .where('f.purge_requested_at', 'is', null)
  if (target.entity === 'deal') {
    const { pipelineId } = target
    query = query
      .where((eb) =>
        eb.or([
          eb('f.pipeline_visibility', '=', 'all'),
          eb.exists(
            eb
              .selectFrom('field_pipeline as fp')
              .select('fp.field_id')
              .whereRef('fp.field_id', '=', 'f.id')
              .where('fp.pipeline_id', '=', pipelineId),
          ),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('f.required', '=', 'always'),
          eb.and([
            eb('f.required', '=', 'stages'),
            eb.exists(
              eb
                .selectFrom('field_required_stage as r')
                .select('r.field_id')
                .whereRef('r.field_id', '=', 'f.id')
                .where('r.pipeline_id', '=', pipelineId)
                .where(
                  'won' in target
                    ? sql<boolean>`true`
                    : // Этап правила — не позже целевого по порядку этапов воронки.
                      sql<boolean>`r.stage_id is not null and exists (
                        select from stage rs, stage ts
                        where rs.id = r.stage_id and ts.id = ${target.stageId}
                          and (rs.position, rs.created_at, rs.id)
                            <= (ts.position, ts.created_at, ts.id)
                      )`,
                ),
            ),
          ]),
        ]),
      )
  } else {
    query = query.where('f.required', '=', 'always')
  }
  const rows = await query
    .orderBy('g.position')
    .orderBy('g.created_at')
    .orderBy('f.position')
    .orderBy('f.created_at')
    .orderBy('f.id')
    .execute()
  return split(
    viewer,
    target.entity,
    rows.filter((row) => isEmpty(values[row.code])),
  )
}

/**
 * Поля «всегда», которые запрос очищает (`write.removed`). У сделки — только видимые в её воронке
 * `pipelineId`: невидимое поле сделки не обязательно.
 */
export async function clearedRequired(
  viewer: FieldViewer,
  entity: FieldEntity,
  pipelineId: string | null,
  write: Pick<CustomWrite, 'removed'>,
): Promise<MissingFields> {
  if (write.removed.length === 0) return NOTHING_MISSING
  let query = viewer.db
    .selectFrom('field_definition as f')
    .innerJoin('field_group as g', 'g.id', 'f.group_id')
    .select(['f.code', 'f.name_uk', 'f.name_ru', 'f.group_id'])
    .where('f.entity', '=', entity)
    .where('f.required', '=', 'always')
    .where('f.code', 'in', write.removed)
  if (entity === 'deal' && pipelineId !== null) {
    query = query.where((eb) =>
      eb.or([
        eb('f.pipeline_visibility', '=', 'all'),
        eb.exists(
          eb
            .selectFrom('field_pipeline as fp')
            .select('fp.field_id')
            .whereRef('fp.field_id', '=', 'f.id')
            .where('fp.pipeline_id', '=', pipelineId),
        ),
      ]),
    )
  }
  const rows = await query.orderBy('g.position').orderBy('f.position').orderBy('f.id').execute()
  return split(viewer, entity, rows)
}

function split(
  viewer: FieldViewer,
  entity: FieldEntity,
  rows: readonly { code: string; name_uk: string; name_ru: string | null; group_id: string }[],
): MissingFields {
  const missing: MissingFields = { fields: [], hiddenCount: 0 }
  for (const row of rows) {
    if (fieldGroupAccess(viewer.permissions, { id: row.group_id, entity }) === 'hidden') {
      missing.hiddenCount += 1
    } else {
      missing.fields.push({ code: row.code, nameUk: row.name_uk, nameRu: row.name_ru })
    }
  }
  return missing
}

/** Отказ 422 REQUIRED_FIELDS_MISSING, если что-то не заполнено. */
export function requiredFieldsOutcome(
  missing: MissingFields,
): Outcome<null, 'REQUIRED_FIELDS_MISSING'> {
  return anyMissing(missing)
    ? refuse(422, 'REQUIRED_FIELDS_MISSING', { ...missingDetails(missing) })
    : ok(null)
}

/** Значения записи после записи `write` поверх `current`. */
export function customAfter(current: CustomValues, write: CustomWrite): CustomValues {
  const next: CustomValues = { ...current, ...write.set }
  for (const code of write.removed) delete next[code]
  return next
}
