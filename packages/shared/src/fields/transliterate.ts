// Транслитерация украинского текста латиницей — официальная таблица (постановление Кабинета
// Министров Украины № 55 от 27.01.2010): «Головний мотив» → «Holovnyi motyv». По ней строится
// код пользовательского поля из украинского названия (code.ts).
//
// Правила таблицы:
// - є, ї, й, ю, я в начале слова — ye, yi, y, yu, ya; в остальных позициях — ie, i, i, iu, ia;
// - сочетание «зг» — zgh (чтобы не спутать с «жг» → zh);
// - мягкий знак и апостроф не передаются.
// Русские буквы, которых нет в украинском алфавите (ё, ы, э, ъ), передаются по смыслу: yo, y,
// e и ничего — русское название поля бывает вписано в украинское.

const LETTERS: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ie',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ю: 'iu',
  я: 'ia',
  ё: 'io',
  ы: 'y',
  э: 'e',
  ъ: '',
}

/** Буквы, которые в начале слова пишутся иначе. */
const WORD_START: Record<string, string> = {
  є: 'ye',
  ї: 'yi',
  й: 'y',
  ю: 'yu',
  я: 'ya',
  ё: 'yo',
}

/** Апостроф украинского письма (прямой, типографский, буква-модификатор) не передаётся. */
const APOSTROPHES = new Set(["'", '’', 'ʼ', '`'])

const isLetter = (ch: string | undefined) => ch !== undefined && /\p{L}/u.test(ch)

/** Текст латиницей в нижнем регистре; знаки, кроме букв кириллицы, остаются как есть. */
export function transliterateUk(text: string): string {
  const chars = [...text.toLowerCase()].filter((ch) => !APOSTROPHES.has(ch))
  let out = ''
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? ''
    if (ch === 'г' && chars[i - 1] === 'з') {
      out += 'gh'
      continue
    }
    const atWordStart = !isLetter(chars[i - 1])
    out += (atWordStart ? WORD_START[ch] : undefined) ?? LETTERS[ch] ?? ch
  }
  return out
}
