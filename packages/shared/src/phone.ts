import { parsePhoneNumberFromString } from 'libphonenumber-js'

// Ключи поиска контакта (тикет crm-deals/03; spec.md, раздел 3.2): телефон хранится в E.164,
// email — в нижнем регистре. По ним ищут совпадения при создании контакта и при приёме
// регистраций, поэтому сервер и клиент нормализуют одной функцией.

/** Страна номера без кода страны: CRM работает с украинскими клиентами. */
const DEFAULT_COUNTRY = 'UA'

/**
 * Телефон в E.164 (`+380671234567`) или null, если строка — не номер телефона.
 *
 * Номер без кода страны считается украинским (`067 123 45 67`, `(067) 123-45-67`). Номер с
 * кодом 380 без «+» (`380671234567`) — тоже украинский: так его часто пишут в формах. Номер
 * другой страны пишется с «+» и сохраняется своим (`+48 601 234 567` → `+48601234567`).
 *
 * shortcut: проверка по длине номера (метаданные libphonenumber-js «min»), а не по шаблонам
 * операторов, — несуществующий код оператора нужной длины пройдёт; перейти на метаданные «max»,
 * если мусорные номера правильной длины начнут попадать в базу.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const digits = trimmed.replace(/[\s().-]/g, '')
  const withPlus = /^380\d{9}$/.test(digits) ? `+${digits}` : trimmed
  const parsed = parsePhoneNumberFromString(withPlus, DEFAULT_COUNTRY)
  if (!parsed?.isValid()) return null
  return parsed.number
}

/** Наибольшая длина адреса email (RFC 5321, путь письма). */
const MAX_EMAIL_LENGTH = 254

/** Та же проверка, что у z.email() из zod 4 (ею Better Auth проверяет email входа). */
const EMAIL =
  /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/

/** Email в нижнем регистре без пробелов по краям или null, если строка — не email. */
export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase()
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return null
  return email
}
