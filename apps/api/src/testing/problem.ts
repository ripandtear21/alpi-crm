import { expect } from 'vitest'

// Только для тестов: тело ответа с ошибкой (RFC 9457, тикет crm-api/02) без общей части —
// `type`, `title`, `status`. Общую часть функция проверяет сама, а остаток (`code`, `details`,
// `errors`, `detail`) тест сравнивает строго, через toEqual: лишнее поле в теле ответа —
// например, утёкший идентификатор скрытой записи — делает тест красным. Ожидаемое значение
// тест пишет буквально, а не через problemBody из apps/api/src/http/problem.ts: иначе ошибка
// в problemBody попала бы и в ожидание.

/** Остаток тела ошибки после проверки `type`, `title` и `status` (статус ответа — `status`). */
export function problemFields(body: unknown, status: number): Record<string, unknown> {
  expect(body).toMatchObject({ type: 'about:blank', title: expect.any(String), status })
  const { type: _type, title: _title, status: _status, ...rest } = body as Record<string, unknown>
  return rest
}

/** Ожидаемый остаток тела отказа по одному полю запроса `path`: подробности и ошибка поля. */
export function pathError(code: string, path: string) {
  return { code, details: { path }, errors: [{ field: path, code, message: 'Invalid value' }] }
}

/** Ожидаемые ошибки полей отказа «не заполнены обязательные поля» с кодами `codes`. */
export function requiredErrors(...codes: string[]) {
  return codes.map((code) => ({
    field: `custom.${code}`,
    code: 'REQUIRED',
    message: 'Field is required',
  }))
}

/** То же для ответа: читает тело и сверяет `status` тела со статусом ответа. */
export async function problemOf(res: Response): Promise<Record<string, unknown>> {
  return problemFields(await res.json(), res.status)
}
