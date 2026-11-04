# Actum: дизайн-система

Здесь описано, как выглядит Actum (actum.work), чтобы этот вид можно было повторить в другом проекте. Описание собрано 03.11.2026 по коду этого репозитория: `src/styles/*.css`, CSS-модулям компонентов и их `.tsx`. Каждое значение сверено с исходниками. Где код не даёт однозначного ответа, стоит пометка «(не проверено)». В браузере приложение для этого не запускалось.

`docs/DESIGN.md` описывает старый вид «Бланк» (кремовая бумага, засечки, печати), от которого отказались, поэтому по нему не собирайте. Если этот файл разойдётся с кодом, правильный вариант в коде.

## Как пользоваться

- Чтобы повторить вид целиком, достаточно части 1 и приложения А: шрифты, цвета обеих тем, шкалы, фон, движение и фокус.
- Части 2–4 — справочник по компонентам и экранам: размеры, состояния, адаптив, доступность, примеры CSS.
- В другом проекте можно отдать этот файл Claude целиком или по частям и попросить собрать экран по нужным разделам. Разделы ссылаются друг на друга по названиям, поэтому заголовки не переименовывайте.
- Пути вида `src/...` ведут к исходникам Actum. Там лежит то, что трудно передать словами, в основном поведение на JS (список в приложении Б).
- Подписи интерфейса даны на языке экрана: украинском у коллеги, русском у владельца.

## Быстрый старт

1. Скопируйте шрифты из `src/app/fonts/fixel/` и `src/app/fonts/martian-mono/` вместе с файлами `OFL.txt`.
2. Подключите их блоком из раздела «Шрифты» → «То же на чистом CSS, без next/font». В Next.js можно взять `next/font/local`, как в `src/app/fonts.ts`.
3. Возьмите `tokens.css`, `base.css` и `motion.css` из приложения А и подключите в этом порядке. Если вы не используете `next/font`, замените в `tokens.css` четыре стека `--ff-*` на стеки из шага 2.
4. Ставьте `data-theme="dark"`, `"light"` или `"system"` на `<html>` ещё на сервере, иначе при загрузке будет вспышка (раздел «Тема и переключатель»). Без атрибута действует тёмная тема.
5. Сетка и свечение на фоне страницы появятся сами из `base.css`. Свет у курсора подключается отдельным компонентом (раздел «Фон страницы»).
6. Собирайте компоненты только на токенах, без сырых цветов и размеров. Удобно начать с `Button`, `Panel`, `Block`, `MetaList` и полей форм (часть 2).
7. Главные правила:
   - акцент один, плоский, без градиентов;
   - статус показывайте текстом и маленькой цветной точкой, а не плашкой;
   - для мелких меток берите `--accent-solid`, текст на заливке акцента всегда `--accent-ink`;
   - заголовки набирайте Display с отрицательным трекингом;
   - цифры, даты и суммы набирайте через `--ff-meta`.
8. Проверьте обе темы, ширину 390 px, режим `prefers-reduced-motion` и фокус с клавиатуры.

## Содержание

- [Часть 1. Основа](#часть-1-основа)
  - [Характер](#характер)
  - [Шрифты](#шрифты)
  - [Цвет](#цвет)
  - [Типографика](#типографика)
  - [Отступы, радиусы, раскладка, слои](#отступы-радиусы-раскладка-слои)
  - [Поверхности и тени](#поверхности-и-тени)
  - [Фон страницы](#фон-страницы)
  - [Движение](#движение)
  - [Фокус и доступность](#фокус-и-доступность)
  - [Тема и переключатель](#тема-и-переключатель)
  - [Логотип и иконки](#логотип-и-иконки)
- [Часть 2. Базовые компоненты и формы](#часть-2-базовые-компоненты-и-формы)
  - [Базовые компоненты](#базовые-компоненты)
  - [Формы и поля](#формы-и-поля)
- [Часть 3. Шапка и кабинет владельца](#часть-3-шапка-и-кабинет-владельца)
  - [Шапка и навигация](#шапка-и-навигация)
  - [Экраны владельца](#экраны-владельца)
  - [Компоненты владельца](#компоненты-владельца)
  - [Тон текстов владельца](#тон-текстов-владельца)
- [Часть 4. Сторона коллеги](#часть-4-сторона-коллеги)
  - [Экраны коллеги](#экраны-коллеги)
  - [Компоненты формы задачи](#компоненты-формы-задачи)
  - [Вложения и просмотр](#вложения-и-просмотр)
  - [Знакомство с сервисом](#знакомство-с-сервисом)
  - [Тон текстов коллеги](#тон-текстов-коллеги)
- [Приложение А. Готовые файлы стилей](#приложение-а-готовые-файлы-стилей)
  - [globals.css](#globalscss)
  - [tokens.css](#tokenscss)
  - [base.css](#basecss)
  - [motion.css](#motioncss)
- [Приложение Б. Что ещё взять из репозитория](#приложение-б-что-ещё-взять-из-репозитория)
- [Приложение В. Что стоит проверить в браузере](#приложение-в-что-стоит-проверить-в-браузере)

# Часть 1. Основа

## Характер

Источник: `docs/SPEC-DELTA.md` §5 (вступление), `docs/DECISIONS.md` §3b, §3e, `docs/SPEC.md` §6.8, `src/styles/tokens.css`, `src/styles/base.css`.

Тёмная тема по умолчанию. Фон почти чёрный (`#07080A`), поверхности на один-два шага светлее, рамок нет: вместо них тонкие кольца-линии, у панелей радиус 20. Один акцент, сирень «Бузок» (`#C9B8FF` в тёмной теме). Акцент всегда плоский, это заливка, а не градиент. Янтарь (`--ask`) для вопросов, «не хватает» и предупреждений, красный (`--danger`) для ошибок. Под всем лежит еле заметная сетка 48 px. Сверху очень медленно (цикл 48 с) дышит мягкое сиреневое свечение, а за мышью ходит маленькое сиреневое пятно света 48 px. Слова набраны Fixel (Display в заголовках, Text в интерфейсе), цифры набраны Martian Mono, в той же строке. Движение тихое и «дорогое»: без мультяшности, конфетти и параллакса (DECISIONS §3e).

Запрещено: glassmorphism, фиолетовые градиенты, эмодзи, иконки-«искры», формулировка «AI-powered», шрифты с засечками и кремовый «бумажный» фон старого вида «Бланк», терракотовый и красно-оранжевый акцент, точки «·» как разделители (разделяют отступами), наборы иконок. Статус показывают текстом и маленькой цветной точкой, а не плашкой (SPEC §6.8). Свечение сверху и сетка 48 px разрешены явно (SPEC-DELTA §5).

### Файлы глобальных стилей

Источник: `src/styles/globals.css`, корневые `layout.tsx`.

Глобальный CSS один: `globals.css`. Он подключает три слоя строго в этом порядке: `tokens.css` (токены обеих тем), `base.css` (сброс, фон страницы, фокус, помощники `.meta`, `.vh`, `kbd`, skip-ссылка), `motion.css` (общие keyframes и `prefers-reduced-motion`). Каждый корневой layout импортирует его один раз (`import "@/styles/globals.css"`). Файл `src/app/globals.css` нарочно не используется. Всё остальное лежит в CSS-модулях рядом с компонентами.

```css
/* globals.css */
@import "./tokens.css";
@import "./base.css";
@import "./motion.css";
```

## Шрифты

Источник: `src/app/fonts.ts`, `src/app/fonts/fixel/*`, `src/app/fonts/martian-mono/*`, `src/styles/tokens.css`, `src/styles/base.css`.

### Файлы и начертания

| Семейство | Файл | Вес | Для чего |
|---|---|---|---|
| Fixel Display | `fixel/FixelDisplay-Medium.woff2` | 500 | заголовки h1, h2, h3 (исключение: заголовок FileDrop задан весом 600, такого файла у Display нет, браузер возьмёт ближайший больший, Bold 700) |
| Fixel Display | `fixel/FixelDisplay-Bold.woff2` | 700 | логотип (текст запасного варианта) |
| Fixel Display | `fixel/FixelDisplay-Black.woff2` | 900 | подключён, в CSS нигде не используется |
| Fixel Display | `fixel/FixelDisplay-ExtraBold.woff2` | 800 | лежит в репозитории, не подключается |
| Fixel Text | `fixel/FixelText-Regular.woff2` | 400 | основной текст |
| Fixel Text | `fixel/FixelText-Medium.woff2` | 500 | метки, `<b>` в meta, kbd |
| Fixel Text | `fixel/FixelText-SemiBold.woff2` | 600 | primary-кнопка, skip-ссылка, заголовок части настроек (`.partTitle`), заголовок непрочитанной строки «Входящих», слово «Спробуй:» / «Спробуйте:» в задании тура (`.try`) |
| Martian Mono | `martian-mono/MartianMono-latin.woff2` | вариативный 300–500 | цифры («Num») и целые строки (mono) |
| Martian Mono | `martian-mono/MartianMono-cyrillic.woff2` | вариативный 300–500 | только в `--ff-mono`: кириллица и «№» |

Все грузятся с `display: swap`. Вес 300 используется один раз, у большого номера. Веса в CSS по частоте: 500, 400, 600, 700, 300.

Лицензии. Fixel: «Copyright (c) 2023 MacPaw Way Ltd., (https://macpaw.com)», SIL Open Font License 1.1 (`src/app/fonts/fixel/OFL.txt`). Martian Mono: «Copyright 2021 The Martian Mono Project Authors (https://github.com/evilmartians/mono)», SIL OFL 1.1 (`src/app/fonts/martian-mono/OFL.txt`). OFL разрешает использовать, менять и распространять шрифты, но не продавать их отдельно. Кладите `OFL.txt` рядом с файлами, как в репозитории.

Расхождение с DECISIONS §3b: там Martian Mono через `next/font/google` с весами 400/500. В коде он вендорен локально, вариативный 300–500.

### Роли

| Токен | Стек | Где |
|---|---|---|
| `--ff-display` | `var(--font-fixel-display), system-ui, sans-serif` | логотип, все h1–h3, заголовок AcceptedCard, заголовок Empty |
| `--ff-text` | `var(--font-fixel-text), system-ui, sans-serif` | `body` и всё, что наследует: поля, Composer, кнопки, значения |
| `--ff-meta` | `var(--font-num), var(--font-fixel-text), system-ui, sans-serif` | `.meta`, `kbd`, лог агента, даты, время, номера в списках, деньги, проценты |
| `--ff-mono` | `var(--font-mono), var(--font-mono-cyr), ui-monospace, monospace` | большой «№ 0148» в AcceptedCard |

По SPEC-DELTA §5.1 `--ff-mono` нужен только большому номеру. В коде он также стоит на полях кода входа (`login.module.css`, `enter.module.css`, `settings.module.css`, letter-spacing `.16em`), на отдельных полях форм админки (класс `.mono` в `forms.module.css`: 13px, −0.01em; поля в бланке приглашения, на странице агентов и в настройках), на ключах агентов (12px), на команде, файлах и выводе агента (12.5px/1.6), на JSON песочницы стандарта (12px/1.6) и на блоке `.code` с секретом (13px/1.7).

### Трюк «Num»: цифры Martian внутри текста Fixel

Это отдельный `@font-face` над тем же латинским файлом Martian Mono, у которого есть только эти символы:

- `unicode-range: U+0030-0039, U+003A, U+002F, U+0024, U+0025, U+002E`, то есть цифры 0–9 и `:` `/` `$` `%` `.`;
- `size-adjust: 90%`: Martian широкий, поэтому он на ~10% меньше соседнего Fixel (DECISIONS §3b).

В `--ff-meta` «Num» стоит первым. Браузер берёт из него цифры и эти пять знаков, а всё остальное отдаёт Fixel Text. Поэтому «14:20», «30.10», «3 / 5», «0.18 $» в одной строке выходят цифрами Martian и буквами Fixel без всякой разметки.

«№» (U+2116) в диапазон не входит и остаётся в Fixel: у Martian «№» при 12–14 px читается как «₱» (комментарии в `fonts.ts` и `tokens.css`). «№» из Martian есть только в большом номере: `--ff-mono` берёт его из кириллического файла. DECISIONS §3b просил «№» из Martian и в «Num», но код решил иначе, и прав код.

Ещё два правила:

- `adjustFontFallback: false` стоит на всех трёх экземплярах Martian, и для «Num» это обязательно. `next/font/local` по умолчанию создаёт запасной face `'Arial'` с подогнанными метриками. У этого face нет `unicode-range`, поэтому он перехватил бы все буквы и набрал их Arial раньше Fixel. Fixel оставлен с автоматическим запасным Arial по умолчанию, в чистом CSS его можно не воспроизводить.
- У экземпляров Martian никогда не задают `fallback`: он поставил бы `system-ui` перед Fixel для букв (комментарий в `fonts.ts`).

Имя семейства в `next/font` совпадает с именем JS-константы и не хешируется, поэтому CSS обращается только к переменным `--font-*`. Кириллический Martian загружается с `preload: false`, остальные файлы `next/font` предзагружает (по документации `preload` по умолчанию `true`).

### То же на чистом CSS, без next/font

Пути к файлам замените на свои. Имена семейств можно выбрать любые, CSS ссылается только на стеки `--ff-*`.

```css
/* Fixel Display */
@font-face { font-family: "Fixel Display"; src: url("/fonts/fixel/FixelDisplay-Medium.woff2") format("woff2"); font-weight: 500; font-style: normal; font-display: swap; }
@font-face { font-family: "Fixel Display"; src: url("/fonts/fixel/FixelDisplay-Bold.woff2") format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }
@font-face { font-family: "Fixel Display"; src: url("/fonts/fixel/FixelDisplay-Black.woff2") format("woff2"); font-weight: 900; font-style: normal; font-display: swap; }

/* Fixel Text */
@font-face { font-family: "Fixel Text"; src: url("/fonts/fixel/FixelText-Regular.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "Fixel Text"; src: url("/fonts/fixel/FixelText-Medium.woff2") format("woff2"); font-weight: 500; font-style: normal; font-display: swap; }
@font-face { font-family: "Fixel Text"; src: url("/fonts/fixel/FixelText-SemiBold.woff2") format("woff2"); font-weight: 600; font-style: normal; font-display: swap; }

/* "Num": Martian Mono only for 0-9 : / $ % . , 10% smaller. No fallback face: letters must fall through to Fixel Text */
@font-face {
  font-family: "Actum Num";
  src: url("/fonts/martian-mono/MartianMono-latin.woff2") format("woff2");
  font-weight: 300 500; font-style: normal; font-display: swap;
  unicode-range: U+0030-0039, U+003A, U+002F, U+0024, U+0025, U+002E;
  size-adjust: 90%;
}

/* whole strings in Martian Mono (the big serial); «№» and Cyrillic from the second file */
@font-face { font-family: "Martian Mono"; src: url("/fonts/martian-mono/MartianMono-latin.woff2") format("woff2"); font-weight: 300 500; font-style: normal; font-display: swap; }
@font-face {
  font-family: "Martian Mono Cyr";
  src: url("/fonts/martian-mono/MartianMono-cyrillic.woff2") format("woff2");
  font-weight: 300 500; font-style: normal; font-display: swap;
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}

:root {
  --ff-display: "Fixel Display", system-ui, sans-serif;
  --ff-text: "Fixel Text", system-ui, sans-serif;
  --ff-meta: "Actum Num", "Fixel Text", system-ui, sans-serif;
  --ff-mono: "Martian Mono", "Martian Mono Cyr", ui-monospace, monospace;
}
```

Предзагрузка, как у `next/font`: все файлы, кроме кириллического Martian.

```html
<link rel="preload" href="/fonts/fixel/FixelText-Regular.woff2" as="font" type="font/woff2" crossorigin>
<!-- the same for the other Fixel files and MartianMono-latin.woff2 -->
```

## Цвет

Источник: `src/styles/tokens.css`, `tests/design/tokens.test.ts`, `docs/SPEC-DELTA.md` §5.1, `docs/DECISIONS.md` §3b.

### Токены

Колонка «светлая» действует и для `data-theme="system"`, когда ОС в светлом режиме.

| Токен | Тёмная (по умолчанию) | Светлая | Для чего |
|---|---|---|---|
| `color-scheme` | `dark` | `light` | нативные контролы и скроллбары |
| `--bg` | `#07080A` | `#F6F7F8` | фон страницы (`html`) |
| `--surface` | `#0E0F12` | `#FFFFFF` | Panel, CommandBar, дорожка ThemeSwitch |
| `--raised` | `#141519` | `#FBFBFC` | Block, поля, чипы, тосты, InlineConfirm |
| `--hover` | `#1A1C21` | `#F1F2F4` | hover, выбранный вариант, полосы скелетона |
| `--line` | `rgb(255 255 255 / .07)` | `rgb(10 12 16 / .08)` | кольца панелей и блоков, разделители |
| `--line-2` | `rgb(255 255 255 / .12)` | `rgb(10 12 16 / .14)` | кольца контролов и всплывающих слоёв, `kbd`, подчёркивание ссылок |
| `--ink` | `#F3F4F6` | `#0A0C10` | основной текст |
| `--ink-2` | `#A3A9B3` | `#555C68` | вторичный текст, лид, лог |
| `--ink-3` | `#7E848E` | `#676D77` | meta, плейсхолдер, тихие кнопки |
| `--accent` | `#C9B8FF` | `#D9CCFF` | заливка: primary-кнопка, skip-ссылка |
| `--accent-ink` | `#0A0B0C` | `#0A0B0C` | текст на заливке акцента, всегда тёмный |
| `--accent-text` | `#D3C6FF` | `#5537C2` | текст цвета акцента: метки подсветок, ссылки в задаче, «ok» |
| `--accent-wash` | `rgb(201 184 255 / .11)` | `rgb(150 120 255 / .14)` | подложки, `::selection`, свечение, вспышка новой строки |
| `--accent-line` | `rgb(201 184 255 / .55)` | `#7E62E0` | кольцо фокуса, кольцо `:focus-within`, пульс |
| `--accent-solid` | `#C9B8FF` | `#7E62E0` | мелкие метки: точки статуса, каретка, выбранный край, знак логотипа |
| `--ask` | `#FFB45C` | `#B45309` | вопрос, «не хватает», просрочено, предупреждение; также ошибки на экранах коллеги (SendBar, «Мої завдання») и кольцо `aria-invalid` поля «надіслати як є» |
| `--ask-wash` | `rgb(255 180 92 / .08)` | `rgb(245 158 11 / .09)` | подложка ask-строк и заметок |
| `--ask-line` | `rgb(255 180 92 / .55)` | `rgb(180 83 9 / .6)` | кольцо или пунктир ask |
| `--danger` | `#FF7A7A` | `#B42318` | ошибки: текст ошибки в формах админки и `/enter`, кольцо `aria-invalid` там же, строка `error` в логе агента, край тоста ошибки |
| `--danger-wash` | `rgb(255 122 122 / .09)` | `rgb(180 35 24 / .07)` | подложка ошибки (в модулях пока не используется) |
| `--nav-on` | `var(--hover)` | `#E4DAFF` | фон текущего пункта меню и вкладки «Входящих», выбранный сегмент служебной панели `/demo` |
| `--nav-on-ink` | `var(--ink)` | `#5537C2` | текст текущего пункта |
| `--nav-on-meta` | `var(--ink-3)` | `#5537C2` | счётчик в текущем пункте |
| `--grid` | `rgb(255 255 255 / .035)` | `rgb(10 12 16 / .025)` | линии фоновой сетки |
| `--glow` | `var(--accent-wash)` | `var(--accent-wash)` | свечение сверху |
| `--cursor-rgb` | `201 184 255` | `126 98 224` | цвет пятна у курсора (каналы RGB) |
| `--cursor-a` | `.30` | `.22` | прозрачность центра пятна |
| `--cursor-wave-a` | `.6` | `.45` | прозрачность волны от клика |
| `--cursor-blend` | `screen` | `multiply` | режим смешивания пятна и волны |
| `--shadow-drop` | `0 24px 48px -24px rgb(0 0 0 / .6)` | `0 24px 48px -28px rgb(10 12 16 / .25)` | тень без кольца |
| `--shadow` | `0 0 0 1px var(--line), var(--shadow-drop)` | то же | кольцо и тень поверхности |
| `--shadow-accent` | `0 0 0 1px rgb(0 0 0 / .1), 0 8px 24px -10px var(--accent-line)` | то же | primary-кнопка |

### Правила

- Тёмная тема задана на `:root` и на `:root[data-theme="dark"]`, поэтому она работает без атрибута и без куки.
- Тему задаёт атрибут `data-theme` на `<html>`: `dark`, `light` или `system`. Светлый блок висит на `:root[data-theme="light"]`. Его точная копия лежит внутри `@media (prefers-color-scheme: light) { :root[data-theme="system"] { … } }`. Тест `tests/design/tokens.test.ts` проверяет, что два блока совпадают. Если ОС тёмная, `system` просто остаётся на тёмных значениях `:root`.
- `--accent-solid` нужен потому, что светлая заливка `#D9CCFF` почти не видна на светлой странице, и маленькая метка пропадает. Комментарий в `tokens.css` называет ~1.4:1 на белом; по формуле WCAG выходит 1.50:1 к `#FFFFFF` и 1.40:1 к `--bg`. Замена `#7E62E0` даёт 4.46:1 к белому. В тёмной теме он равен `--accent`, в светлой равен `--accent-line` (`#7E62E0`). Для точек, каретки и выбранного края берите `--accent-solid`, а не `--accent`. В модулях часто пишут `var(--accent-solid, var(--accent))`.
- `--nav-on*` нужен потому, что серый `--hover` на светлой странице даёт ~1.04:1 (комментарий в `tokens.css`, в тесте ~1.05:1; пересчёт `#F1F2F4` к `#F6F7F8`: 1.04:1), и текущий пункт не виден. В тёмной теме `--nav-on*` равны `--hover`, `--ink` и `--ink-3`, в светлой это сиреневая пилюля.
- `--ask` (янтарь) обозначает внимание: вопросы, недостающее, просрочку, предупреждения, неудачную загрузку файла, отказ в логе агента. `--danger` обозначает ошибки: формы админки и `/enter`, строка `error` лога, тост ошибки. На экранах коллеги текст ошибки (SendBar, «Мої завдання») набран `--ask`, а не `--danger`.
- Текст на заливке `--accent` всегда `--accent-ink` (`#0A0B0C`).
- Светлый `--grid` (`.025`) светлее, чем в макете (`.04`): на светлой странице линии читаются сильнее, и `.025` выглядит так же еле заметно, как тёмная сетка (комментарий в `tokens.css`).

### Контраст: что зафиксировано

- `--ink-3` специально отличается от макета. У макета `#686E78` (тёмная) и `#8C929C` (светлая) давали 3.7:1 и 3.1:1 для meta 13px. Текущие значения дают не меньше 4.5:1 на каждой поверхности своей темы (SPEC-DELTA §5.1). Пересчёт по формуле WCAG: тёмная от 5.32:1 на `--bg` до 4.53:1 на `--hover`, светлая от 5.21:1 на `--surface` до 4.65:1 на `--hover`.
- `#5537C2` на `#E4DAFF` даёт 5.8:1 (пересчёт: 5.82:1). Сама пилюля `#E4DAFF` бледнее заливки `#D9CCFF` и к странице даёт 1.24:1 (комментарий в `tokens.css`; пересчёт подтверждает: 1.24:1 к `--bg`, 1.33:1 к `--surface`).
- Тест `tests/design/tokens.test.ts` требует, чтобы `--nav-on-ink` и `--nav-on-meta` на `--nav-on` давали не меньше 4.5:1 в обеих темах. В тёмной теме запас минимальный: `--ink-3` на `--hover` даёт 4.53:1.
- Тот же тест требует, чтобы светлый `--nav-on` к `--bg` и к `--surface` давал не меньше 1.2:1, и проверяет, что блок `system` совпадает со светлым.

## Типографика

Источник: `src/styles/tokens.css`, `src/styles/base.css`, CSS-модули из списка ниже.

### Шкала

| Токены | Значение | Где используется |
|---|---|---|
| `--fs-h1` / `--lh-h1` / `--tr-h1` | 52px / 1.02 / −0.045em | h1 вступления на экране коллеги «/» (`PageIntro`): Display 500, `max-width: 14ch` (`18ch` для `:lang(en)`), `text-wrap: balance`, вторая фраза в `<em>` обычным начертанием цвета `--ink-3` |
| `--fs-h2` / `--lh-h2` / `--tr-h2` | 24px / 1.15 / −0.025em | заголовок задачи в `TaskSide`, страница задачи коллеги (`mine`) |
| `--fs-h3` / `--lh-h3` / `--tr-h3` | 20px / 1.2 / −0.02em | заголовок AcceptedCard, `Empty`, FileDrop, карточка тура, диалог на экране коллеги, в админке: плашка секрета, бланк приглашения, вердикт песочницы стандарта |
| `--fs-logo` / `--tr-logo` | 21px / −0.035em | логотип: Display 700, line-height 1 |
| `--fs-write` / `--lh-write` / `--tr-write` | 19px / 2.35 / −0.005em | поле Composer (`HighlightTextarea`), Text 400 |
| `--fs-body` / `--lh-body` | 15px / 1.55 | `body`, primary-кнопка, значения спецификации, поля кода входа |
| `--fs-ui` | 14px | ghost- и quiet-кнопки, поля форм, тосты, Facts, TaskSide, CommandBar |
| `--fs-small` | 13.5px | пункты меню TopBar, OptionChips, InboxTabs, строки лога, маленькие ghost/quiet-кнопки |
| `--fs-meta` / `--lh-meta` | 13px / 1.4 | `.meta`, `.meta-prose`, ошибки форм |
| `--fs-chip` | 12.5px | AgentChip, RunnerStatus, статус сервиса в шапке админки |
| `--fs-label` | 11px | `kbd`, метки подсветок в Composer (Text 500 11/1, `--accent-text`), подписи типов файлов |
| `--fs-num-xl` / `--tr-num-xl` | 64px / −0.07em | большой номер «№ 0148» в AcceptedCard: `--ff-mono` 300, line-height 1 |
| `--lh-log` | 1.9 | шаг строки лога агента: `--log-line: calc(var(--fs-small) * var(--lh-log))`, а где браузер умеет `round()` (`@supports`), то `round(var(--fs-small) * var(--lh-log), 1px)` |

Переопределения по ширине (в `tokens.css`):

- `max-width: 640px`: `--fs-write` 17px (и `--gutter` 16px);
- `max-width: 760px`: `--fs-h1` 40px, `--fs-num-xl` 48px.

Размеры вне шкалы, которые стоит повторить:

- h1 остальных страниц (мои задачи, страницы админки, вход, `/enter`, `/no-access`): Display 500 40px/1.05, −0.04em. На узких экранах 32px (≤760 в `mine` и админке, ≤640 в `/enter` и `/no-access`), на входе в админку 34px при ≤640.
- h2 секций админки: Display 500 17px/1.25, −0.015em (`shell.module.css`).
- ThemeSwitch: варианты 13px/1.3, подпись группы 12px. Счётчик в меню: 12px. Кнопка-«пилюля»: 13px.

### Роли

- Заголовки набраны `--ff-display` весом 500, у всех отрицательный трекинг, тем сильнее, чем крупнее кегль.
- Основной текст набран `--ff-text` 400 15/1.55 цвета `--ink`. Лид: 15/1.55, `--ink-2`, `max-width: 36ch`.
- Meta: 13/1.4 `--ff-meta` цвета `--ink-3`. Внутри `<b>` вес 500 и цвет `--ink-2`.
- Метки: 11px, вес 500.
- Большой номер: Martian Mono 300 64px, −0.07em, «№» цвета `--ink-3` с `margin-right: .14em`, без пробела перед цифрами.
- Сглаживание на `body`: `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`.
- У `button, input, textarea, select` стоит `font: inherit; color: inherit; letter-spacing: inherit`.

### Глобальные помощники

```css
.meta { font: 400 var(--fs-meta)/var(--lh-meta) var(--ff-meta); color: var(--ink-3); }
.meta b { font-weight: 500; color: var(--ink-2); }
/* meta that is a sentence: letters and punctuation in Fixel (a "." in Num looks detached) */
.meta-prose { font: 400 var(--fs-meta)/var(--lh-meta) var(--ff-text); color: var(--ink-3); }
/* digits in Martian Mono inside any text run, e.g. a date inside a sentence */
.num { font-family: var(--ff-meta); }
kbd {
  font: 500 var(--fs-label) var(--ff-meta); padding: 2px 6px; border-radius: var(--r-tag);
  box-shadow: 0 0 0 1px var(--line-2); color: var(--ink-2); white-space: nowrap;
}
```

`.meta` подходит для дат, номеров и коротких меток с цифрами. `.meta-prose` подходит для фразы того же размера, например «Actum розбирає текст…». Внутри primary-кнопки `kbd` получает `box-shadow: 0 0 0 1px rgb(0 0 0 / .18); color: var(--accent-ink)` (`Button.module.css`).

## Отступы, радиусы, раскладка, слои

Источник: `src/styles/tokens.css`, `src/styles/base.css`, `@media` во всех `*.module.css`.

### Отступы (база 4 px)

| Токен | Значение | Использований (grep) |
|---|---|---|
| `--s-1` | 4px | 1 |
| `--s-2` | 8px | 50 |
| `--s-3` | 12px | 60 |
| `--s-4` | 16px | 32 |
| `--s-5` | 20px | 23 |
| `--s-6` | 24px | 10 |
| `--s-7` | 28px | 7 |
| `--s-8` | 40px | 4 |
| `--s-9` | 56px | 1 |
| `--s-10` | 90px | 0 |

Токены в основном идут на `gap`. Внутренние отступы чаще записаны в px прямо в модулях: шапка Panel `14px 18px`, Block `14px`, отступы страницы `40px var(--gutter) 90px` у коллеги и `8px var(--gutter) 60px` у владельца.

### Радиусы

| Токен | Значение | Для чего |
|---|---|---|
| `--r-panel` | 20px | Panel, диалог и превью CommandBar, FileDrop, боковая колонка «Входящих», диалог на экране коллеги, карточка тура в виде листа при ≤640 (скруглены только два угла) |
| `--r-block` | 14px | Block, кнопка-триггер CommandBar, тосты, InlineConfirm, плавающая SendBar, карточка тура на широком экране |
| `--r-control` | 11px | дорожка ThemeSwitch, кнопки primary и ghost, кнопки панели Lightbox, skip-ссылка |
| `--r-chip` | 9px | чипы вариантов, поля ввода |
| `--r-inner` | 8px | сегменты ThemeSwitch, вкладки, пункты меню, фокус-контур логотипа |
| `--r-tag` | 6px | `kbd`, полосы скелетона, коробка лога, мелкие кнопки строки спецификации (AgentChip, вопреки комментарию токена, использует `7px`) |
| `--r-pill` | 999px | круглые кнопки (Lightbox, удаление файла), кнопка-«пилюля» |

Ссылка при `:focus-visible` получает `border-radius: 4px`. Контур фокуса повторяет радиус своего элемента.

### Раскладка

| Токен | Значение | Где |
|---|---|---|
| `--page-colleague` | 1180px | `main` экрана коллеги «/»: `padding: 40px var(--gutter) 90px`, сетка `minmax(0, 1.05fr) minmax(0, .95fr)`, `gap: var(--s-7)` |
| `--page-owner` | 1280px | контейнер TopBar на обеих поверхностях, и у коллеги тоже (`padding: 18px var(--gutter)`), страница админки (`padding: 8px var(--gutter) 60px`), вход |
| `--side-w` | 460px | правая колонка «Входящих»: `minmax(0, 1fr) minmax(0, var(--side-w))`, `gap: var(--s-5)` |
| `--side-page` | `clamp(340px, 34vw, var(--side-w))` | боковая колонка остальных страниц админки (≥1024) |
| `--gutter` | 24px, при ≤640 16px | боковые поля страниц, отступ тостов и skip-ссылки |

Страница «Мои задачи» у коллеги ограничена 880px (в px, не токеном).

### Брейкпоинты, которые реально есть в коде

| Запрос | Что меняется |
|---|---|
| `max-width: 380px` | Facts: колонка подписи сужается до `80px` |
| `max-width: 560px` | AcceptedCard: шапка в одну колонку; полоса Telegram с меньшими отступами |
| `max-width: 640px` | токены (`--gutter` 16px, `--fs-write` 17px). TopBar переносится, меню уходит второй строкой и прокручивается вбок. ThemeSwitch показывает короткие подписи. Скрываются имя в PersonMenu и подсказка клавиш в CommandBar. Строки списков становятся сеткой `44px minmax(0, 1fr)`. Отступы панелей сжимаются до 16px. Формы `grid2`/`grid3` идут в одну колонку. SendBar становится плавающей липкой панелью снизу. Тур становится нижним листом. Плитки файлов уменьшаются |
| `max-width: 760px` | токены (`--fs-h1` 40px, `--fs-num-xl` 48px); h1 страниц 40→32px; у AcceptedCard отступы `22px 20px` |
| `max-width: 980px` | экран коллеги: одна колонка (Composer, под ним спецификация) |
| `min-width: 1024px` | страницы админки получают боковую колонку `minmax(0, var(--side-page))`; песочница стандарта становится липкой; полноэкранная задача с колонкой агента `clamp(320px, 32vw, 440px)` |
| `max-width: 1060px` | «Входящие»: одна колонка, боковая карточка скрыта, задача открывается отдельной страницей |
| `max-width: 1100px` | TopBar владельца переносится, меню уходит на вторую строку |
| `pointer: coarse` | цели касания не меньше 44px (ниже) |
| `hover: none` | действия, видимые только по hover, показаны всегда (удаление файла, кнопки строки спецификации); у сцены Lightbox курсор `default` вместо `zoom-in` |
| `forced-colors: active` | подсветка тура рисуется контуром `Highlight` |
| `prefers-reduced-motion: reduce` | см. «Движение» |
| `prefers-color-scheme: light` | тема `system` |
| `@container (max-width: 30rem)` | формы `grid2`/`grid3` в узкой боковой колонке идут в одну колонку |

SPEC-DELTA §5.7 называет брейкпоинты 640, 760, 980, 1060. В коде к ним добавились 380, 560, 1024 (min) и 1100. Требование из SPEC-DELTA: на ширине 360 px нет горизонтальной прокрутки страницы.

### Слои

| Токен | Значение | Кто |
|---|---|---|
| (без токена) | `-1` | свечение `body::before` |
| `--z-top` | 10 | TopBar, липкая SendBar (≤640), панель сохранения стандарта |
| `--z-dialog` | 40 | оверлей FileDrop, поповер InlineConfirm; тур `calc(var(--z-dialog) + 2)` |
| (без токена) | `calc(var(--z-toast) - 1)` | служебная панель `/demo` и `/kit/onboarding`: выше тура, ниже тостов |
| `--z-toast` | 50 | тосты, skip-ссылка |
| `--z-cursor` | 60 | пятно и волны CursorLight, выше всего, клики не перехватывает |

Модальные окна (палитра CommandBar, окно «Як писати завдання», Lightbox) сделаны нативным `<dialog>` с `showModal()` и живут в top layer, вне этой шкалы.

### Цели касания

```css
@media (pointer: coarse) { button, [role="radio"], .opt, .tab { min-height: 44px; } }
```

Модули добавляют то же для своих контролов: поля и селекты форм, поле кода, ссылки TopBar. Свободное поле в OptionChips и поле в SpecRow получают `min-height: 44px; font-size: 16px`. Мелкие кнопки получают невидимую зону нажатия через `::after` с отрицательным `inset`.

## Поверхности и тени

Источник: `src/styles/tokens.css`, `src/components/ui/Panel.module.css`, `src/components/ui/Block.module.css`, `src/components/ui/Button.module.css`, `src/components/intake/Composer.module.css`, `src/components/ui/InlineConfirm.module.css`.

### Иерархия

1. `--bg`: холст страницы под сеткой и свечением.
2. `--surface`: первый уровень. Panel, триггер и диалог CommandBar, дорожка ThemeSwitch, плавающая SendBar, полоса приветствия.
3. `--raised`: второй уровень внутри панели. Block, поля форм, OptionChips, InlineConfirm, тосты, блок «надіслати як є», кнопка-«пилюля».
4. `--hover`: наведение и «выбрано». Hover ghost-кнопки, включённый вариант ThemeSwitch, выбранная строка CommandBar, полосы скелетона, текущий пункт меню в тёмной теме.

В светлой теме `--surface` белый, а `--raised` (`#FBFBFC`) чуть темнее его, поэтому второй уровень читается как лёгкая подложка внутри белой панели.

### Тени

- `--shadow` (кольцо 1px `--line` плюс `--shadow-drop`) стоит на всём, что лежит на странице: Panel, триггер CommandBar, тосты, плавающая SendBar, карточка тура, панель сохранения стандарта, диалог на экране коллеги.
- `--shadow-drop` без кольца используют, когда кольцо заменено другим: `box-shadow: 0 0 0 1px var(--accent-line), var(--shadow-drop)` у Composer при `:focus-within` и у карточки FileDrop; `0 0 0 1px var(--line-2), var(--shadow-drop)` у всплывающих слоёв (плавающий InlineConfirm, статичное превью CommandBar в `/kit`, картинка Lightbox, триггер CommandBar при hover, служебная панель `/demo`). У открытого диалога CommandBar своя тень: `0 0 0 1px var(--line-2), 0 40px 80px -30px rgb(0 0 0 / .55)`.
- `--shadow-accent` стоит только на primary-кнопке.
- Block получает только кольцо `0 0 0 1px var(--line)`, без тени.

### Кольцо или граница

- Внешний контур поверхности рисуют кольцом `box-shadow: 0 0 0 1px …`, а не `border`. Кольцо не занимает места, повторяет радиус и складывается с тенью. Пассивные контейнеры получают `--line`, контролы и всплывающие слои получают `--line-2`.
- Разделители внутри поверхности рисуют `border-top`/`border-bottom: 1px solid var(--line)`: под шапкой панели, между строками, над действиями.
- Акцентный край ставят как `inset`-тень слева. `inset 2px 0 0 var(--accent-solid)` у полосы приветствия, выбранной строки CommandBar, открытой строки «Входящих» (`[aria-current]`, вместе с фоном `--hover`) и задания в туре (вместе с фоном `--accent-wash`). `inset 2px 0 0 var(--ask)` плюс фон `--ask-wash` у заметок и предупреждений: блок доработки в SpecList, предупреждения карточки задачи владельца (`TaskSide`), «Что нужно от вас» в блоке агента, полоса «в архиве» на карточке человека. У строки черновика в «Мої завдання» та же кромка `--ask`, но без фона. Строка спецификации в состоянии `ask` получает только фон `--ask-wash`, кромки у неё нет. `inset 3px 0 0 var(--danger), var(--shadow)` у тоста ошибки.
- «Включённая» точка статуса: заливка `--accent-solid` и ореол `box-shadow: 0 0 0 3px var(--accent-wash)`.

### Panel: волосяная линия сверху

У Panel поверх верхнего края лежит 1px `::before` с `linear-gradient(90deg, transparent, var(--line-2), transparent)`. Это мягкий блик по центру верхней грани, нейтральный, не акцентный. Подробности: раздел «Базовые компоненты» → «Panel и PanelHeader».

```css
.panel {
  position: relative; min-width: 0;
  background: var(--surface); border-radius: var(--r-panel); box-shadow: var(--shadow);
  overflow: hidden;
  overflow: clip; /* clips like hidden but is no scroll container, so sticky children still stick */
  transition: box-shadow var(--dur-base);
}
.panel::before {
  content: ""; position: absolute; inset: 0 0 auto; height: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--line-2), transparent);
}
```

## Фон страницы

Источник: `src/styles/base.css`, `src/styles/motion.css`, `src/components/theme/ThemeSwitch.tsx` (флаг `data-hidden`), `src/components/shell/CursorLight.tsx`, `src/components/shell/CursorLight.module.css`.

### Сетка и свечение

Для чего: еле заметная клетчатая подложка и мягкое сиреневое пятно сверху, которое медленно дышит.

Анатомия:

- `html` залит `--bg`.
- У `body` два `linear-gradient` по 1px шириной `--grid`, клетка 48 × 48, `background-attachment: fixed`. Между линиями прозрачно.
- `body::before` даёт свечение: `position: fixed`, `inset: -20% -10% auto`, высота `70vh`, `z-index: -1`. Это радиальный градиент `closest-side` от `--glow` (`--accent-wash`) в прозрачность.
- Порядок слоёв: фон `html`, над ним свечение, над ним сетка `body`, над ней контент.

Движение: `actum-glow 48s ease-in-out infinite`. На середине цикла пятно смещается на 6% и 4%, растёт до 1.08 и гаснет до `.75`. Пока вкладка скрыта, цикл на паузе: ThemeSwitch ставит `data-hidden` на `<html>` по `visibilitychange`, переключатель есть на каждой поверхности. При reduced motion анимации нет, пятно стоит на месте.

```css
html { background: var(--bg); }
body {
  margin: 0; min-height: 100vh; color: var(--ink);
  font: 400 var(--fs-body)/var(--lh-body) var(--ff-text);
  background:
    linear-gradient(var(--grid) 1px, transparent 1px) 0 0 / 48px 48px,
    linear-gradient(90deg, var(--grid) 1px, transparent 1px) 0 0 / 48px 48px;
  background-attachment: fixed;
}
body::before {
  content: ""; position: fixed; inset: -20% -10% auto; height: 70vh; z-index: -1; pointer-events: none;
  background: radial-gradient(closest-side, var(--glow), transparent);
  animation: actum-glow 48s ease-in-out infinite;
}
:root[data-hidden] body::before { animation-play-state: paused; }
@keyframes actum-glow { 50% { transform: translate3d(6%, 4%, 0) scale(1.08); opacity: .75; } }
```

```js
// keeps the glow paused in a hidden tab
const sync = () => document.documentElement.toggleAttribute("data-hidden", document.visibilityState === "hidden");
sync(); document.addEventListener("visibilitychange", sync);
```

Отличие от SPEC-DELTA §5.1: там свечение было третьим слоем фона `body` (`radial-gradient(1200px 420px at 50% -120px, …)`). В коде оно вынесено в `body::before` с анимацией.

### CursorLight: свет у курсора

Источник: `src/components/shell/CursorLight.tsx`, `src/components/shell/CursorLight.module.css`. Компонент стоит последним в `<body>` каждого корневого layout.

Для чего: маленькое сиреневое пятно следует за мышью, а клик пускает мягкую волну. Это украшение.

Анатомия:

- Обёртка `.layer` с `aria-hidden="true"`, без `position` и `z-index`, чтобы не создавать контекст наложения. Так каждое пятно смешивается прямо со страницей под ним.
- Пятно `.spot`: `position: fixed`, `left: 0; top: 0`, размер `--cursor-size` (48px), центр сдвинут отрицательными полями на половину размера, `border-radius: 50%`, `z-index: var(--z-cursor)`, `pointer-events: none`. Позиция пишется в свойство `translate` (не `transform`) в `requestAnimationFrame`.
- Волна `<i class="wave">` создаётся на каждый клик в точке клика. Её размер и форма как у пятна, одновременно живёт не больше 4 волн.

Поверхность:

- Пятно: `radial-gradient(closest-side, rgb(var(--cursor-rgb) / var(--cursor-a)), rgb(var(--cursor-rgb) / calc(var(--cursor-a) * .35)) 55%, transparent)`.
- Волна: `radial-gradient(closest-side, transparent 45%, rgb(var(--cursor-rgb) / var(--cursor-wave-a)) 75%, transparent)` и `filter: blur(2px)`. Это размытый обод, а не чёткая линия.
- Смешивание `mix-blend-mode: var(--cursor-blend)`: `screen` в тёмной теме, `multiply` в светлой. Поэтому текст под пятном читается, ничего не закрашено.

Состояния:

- Пятно скрыто (`opacity: 0`), пока нет движения мыши.
- `[data-on]` (мышь двигалась) даёт `opacity: 1`, переход `opacity var(--dur-base) var(--ease)`.
- Пятно гаснет, когда указатель ушёл из окна (`pointerout` без `relatedTarget`) или окно потеряло фокус.
- `[data-typing]` даёт `opacity: 0`, пока человек печатает в поле ввода, и ещё 1200 мс после последней клавиши.
- Волна не появляется от клика в `input`, `textarea`, `select`, `[contenteditable]`, от касания (touch) и от кнопок мыши, кроме левой.

Движение волны: `wave-grow 700ms var(--ease) forwards` (scale .3 → 1) и одновременно `wave-fade 700ms cubic-bezier(.5, 0, .75, 0) forwards` (opacity 1 → 0). По `animationend` элемент удаляется.

Когда выключено: компонент ничего не рендерит, если не выполнено `(hover: hover) and (pointer: fine)` (сенсорные экраны, грубый указатель) или если включено `prefers-reduced-motion: reduce`. Он следит за изменением обоих запросов.

```css
.layer { pointer-events: none; }
.spot, .wave {
  position: fixed; left: 0; top: 0; z-index: var(--z-cursor); pointer-events: none;
  width: var(--cursor-size); height: var(--cursor-size);
  margin: calc(var(--cursor-size) / -2) 0 0 calc(var(--cursor-size) / -2);
  border-radius: 50%; mix-blend-mode: var(--cursor-blend);
}
.spot {
  background: radial-gradient(closest-side, rgb(var(--cursor-rgb) / var(--cursor-a)), rgb(var(--cursor-rgb) / calc(var(--cursor-a) * .35)) 55%, transparent);
  opacity: 0; transition: opacity var(--dur-base) var(--ease); will-change: translate;
}
.layer[data-on] .spot { opacity: 1; }
.layer[data-typing] .spot { opacity: 0; }
.wave {
  background: radial-gradient(closest-side, transparent 45%, rgb(var(--cursor-rgb) / var(--cursor-wave-a)) 75%, transparent);
  filter: blur(2px);
  animation: wave-grow 700ms var(--ease) forwards, wave-fade 700ms cubic-bezier(.5, 0, .75, 0) forwards;
}
@keyframes wave-grow { from { scale: .3; } to { scale: 1; } }
@keyframes wave-fade { from { opacity: 1; } to { opacity: 0; } }
```

```js
// vanilla outline of CursorLight.tsx
const fine = matchMedia("(hover: hover) and (pointer: fine)");
const calm = matchMedia("(prefers-reduced-motion: reduce)");
if (fine.matches && !calm.matches) {
  const layer = Object.assign(document.createElement("div"), { className: "layer" });
  const spot = Object.assign(document.createElement("div"), { className: "spot" });
  layer.setAttribute("aria-hidden", "true"); layer.append(spot); document.body.append(layer);
  const editable = (t) => t instanceof Element && t.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
  let x = 0, y = 0, frame = 0, typing = 0;
  addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    x = e.clientX; y = e.clientY; layer.dataset.on = "";
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; spot.style.translate = `${x}px ${y}px`; });
  }, { passive: true });
  addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType === "touch" || editable(e.target) || layer.childElementCount > 4) return;
    const wave = Object.assign(document.createElement("i"), { className: "wave" });
    wave.style.left = `${e.clientX}px`; wave.style.top = `${e.clientY}px`;
    wave.addEventListener("animationend", () => wave.remove(), { once: true });
    layer.append(wave);
  }, { passive: true });
  document.addEventListener("pointerout", (e) => { if (!e.relatedTarget) delete layer.dataset.on; });
  addEventListener("blur", () => delete layer.dataset.on);
  addEventListener("keydown", (e) => {
    if (!editable(e.target)) return;
    layer.dataset.typing = ""; clearTimeout(typing);
    typing = setTimeout(() => delete layer.dataset.typing, 1200);
  }, true);
}
```

## Движение

Источник: `src/styles/tokens.css`, `src/styles/motion.css`, `animation`/`transition` во всех `*.module.css`, `src/components/theme/ThemeSwitch.tsx`, `src/app/(dev)/kit/_kit/MotionDemos.tsx`, `docs/DECISIONS.md` §3e.

### Токены

| Токен | Значение | Где |
|---|---|---|
| `--dur-fast` | 150ms | переходы цвета и фона при hover (больше 40 мест), проявление кольца фокуса |
| `--dur-base` | 220ms | тень Panel, fade, lift, смена карточки задачи, появление диалога, пятно курсора |
| `--dur-rise` | 600ms | подъём строк спецификации, панели входа и `/enter`, результат песочницы стандарта |
| `--dur-mark` | 500ms | рост подчёркивания подсветки в Composer |
| `--stagger-mark` | 80ms | задержка между новыми подсветками |
| `--stagger-row` | 110ms | задержка между строками спецификации |
| `--ease` | `cubic-bezier(.2, .8, .2, 1)` | основной easing везде |
| `--ease-spring` | `cubic-bezier(.34, 1.3, .5, 1)` | кольцо прогресса: `stroke-dashoffset .9s` |
| `--ease-pop` | `cubic-bezier(.3, 1.25, .5, 1)` | тосты: `toast-in 420ms` |

Ориентиры DECISIONS §3e: реакции интерфейса 120–240 мс, фирменные моменты 400–800 мс, метки по очереди через 60–80 мс. Анимировать только `transform`, `opacity`, `filter`, `clip-path`. В коде есть исключения: `box-shadow` (пульс), `background-size` (подсветка), `stroke-dashoffset` (логотип, кольцо прогресса, галочка), `color` и `text-shadow` (щелчок цифры номера). В блоке токенов SPEC-DELTA §5.1 записаны другие значения (`--dur-mark` 800ms, `--stagger-mark` 250ms, `--stagger-row` 150ms, `--ease` `cubic-bezier(.2, .7, .2, 1)`), и `actum-mark` в SPEC-DELTA §5.4 тоже старый (через `border-bottom-color`); прав код. Библиотеку `motion` разрешили в DECISIONS §3e, но в `package.json` её нет: всё сделано на CSS и View Transitions.

### Keyframes из `src/styles/motion.css`

```css
@keyframes actum-mark   { from { background-size: 0 1.5px, 0 100%; } }
@keyframes actum-rise   { from { opacity: 0; transform: translateY(6px); filter: blur(3px); } }
@keyframes actum-pulse  { 0% { box-shadow: 0 0 0 0 var(--accent-line); } 50%, 100% { box-shadow: 0 0 0 5px transparent; } }
@keyframes actum-blink  { 50% { opacity: 0; } }
@keyframes actum-breathe { 50% { opacity: .5; } }
@keyframes actum-fade   { from { opacity: 0; } }
@keyframes actum-lift   { from { opacity: 0; transform: translateY(8px); } }
@keyframes actum-glow   { 50% { transform: translate3d(6%, 4%, 0) scale(1.08); opacity: .75; } }
@keyframes actum-focus  { from { outline-color: transparent; outline-offset: 5px; } }
@keyframes actum-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }
```

CSS Modules переименовывают имена анимаций. Поэтому глобальные keyframes напрямую используют только `base.css` (`actum-glow`, `actum-focus`), а модули держат локальные копии, иногда под другим именем. В проекте без CSS Modules хватит одного глобального набора.

| Keyframe | Кто использует | Как |
|---|---|---|
| `actum-mark` | новая подсветка в Composer (`HighlightTextarea`) | `var(--dur-mark) var(--ease) both`, задержка `calc(var(--i) * var(--stagger-mark))`; подчёркивание 1.5px и подложка растут слева направо |
| `actum-rise` | строка спецификации с первым значением (`SpecRow`); панели входа и `/enter`, результат стандарта (локальное имя `rise`) | `var(--dur-rise) var(--ease) both`, у строк задержка `calc(var(--i) * var(--stagger-row))` |
| `actum-pulse` | точка работающего агента (`AgentChip`), статус «в работе» у коллеги | `1.6s infinite` |
| `actum-blink` | каретка «▍» на последней строке лога (`RunLog`), цвет `--accent-solid` | `1s steps(1) infinite` |
| `actum-breathe` | точка «идёт разбор» в Composer и SpecList (`1.6s ease-in-out infinite`), точка ожидания в настройках и Telegram (`1.4s var(--ease) infinite`), «идёт» у агента и стандарта (локальное `breathe`) | opacity 1 → .5 → 1 |
| `actum-fade` | InlineConfirm, блок «надіслати як є» в SendBar, смена значения в SpecRow | `var(--dur-base) var(--ease)` |
| `actum-lift` | плашка с секретом в админке (`.secret`), бланк ссылки-приглашения (`.slip`), локальное имя `lift` | `var(--dur-base) var(--ease)` |
| `actum-glow` | свечение `body::before` | `48s ease-in-out infinite` |
| `actum-focus` | глобальное `:focus-visible` | `var(--dur-fast) var(--ease)`: кольцо проявляется и садится с 5px на 2px |
| `actum-shimmer` | напрямую не используется; Skeleton держит свой `shimmer` (`1.6s linear infinite`, градиент `--hover`/`--line-2`/`--hover` шириной 300%), SendBar держит свой (`translateX(-60%)` → 0, `1.4s linear infinite`) | |

Другие фирменные keyframes, локальные для компонентов (подробности в частях про компоненты):

- скан текста в Composer `scan-band 1.2s linear infinite`;
- импульс за AcceptedCard `pulse 1.1s var(--ease) .25s both`;
- номер AcceptedCard `num-in .45s` и щелчок цифры `lock .7s`;
- новая строка «Входящих» `fresh 1.2s` (въезд сверху на 8px с подложкой `--accent-wash`);
- смена карточки задачи `swap var(--dur-base)`;
- палитра Ctrl K `palette-in 160ms` (scale .96 → 1) и фон `backdrop-in 160ms linear`;
- строки лога `line-in .4s`;
- галочка ответа `tick-draw .45s .25s`;
- тосты `toast-in 420ms var(--ease-pop)`;
- точка шага статуса `fill .5s .9s`;
- метка подсветки в Composer `actum-label 450ms` (въезд на 4px, задержка на 60ms позже своей подсветки);
- подпись справа от номера AcceptedCard `side-in .5s var(--ease) .15s both` (въезд на 4px);
- ответ в строке спецификации `ans-in .4s var(--ease) .15s both` (въезд на 3px);
- диалог на экране коллеги `dialogIn var(--dur-base)` (scale .96 → 1);
- файлы в Composer `cf-in var(--dur-base)` (scale .92 → 1), файл в очереди `cf-breathe 1.6s`;
- оверлей FileDrop `fd-lift var(--dur-base)` (въезд на 6px и scale .98), фон `fd-fade`;
- панель и стрелки Lightbox `lb-chrome 260ms 120ms`, при закрытии `opacity` за 140ms `ease-in`;
- тур: `tour-in`, `body-in`, `ring-pulse 2.2s`, `dot-breathe 1.4s`, лист `sheet-in` / `sheet-in-top` (въезд на 16px);
- логотип (см. «Логотип и иконки»).

Нажатие: `:active` даёт `transform: scale(.97)` у Button (кроме disabled и busy), чипов OptionChips, миниатюр галереи и кнопок Lightbox; у маленьких кнопок повтора и удаления файла `scale(.94)`.

### Правило конечного состояния

Конечное состояние каждой анимации совпадает с обычным стилем элемента (заголовок `motion.css`). У одноразовых анимаций keyframes описывают только `from`, конец берётся из обычного стиля. У циклических (`actum-pulse`, `actum-blink`, `actum-breathe`, `actum-glow`) описана середина или начало цикла, а края совпадают с обычным стилем. Модули чаще всего ставят `both`, но не везде (например, `actum-fade` у InlineConfirm и `lift` у плашки секрета идут без него). Поэтому если анимацию отключить, сразу виден финальный вид.

### prefers-reduced-motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
```

Дополнительно при reduced motion:

- CursorLight не рендерится.
- Раскрытие темы не запускается (проверка в JS).
- В JS отключаются и другие движения: розшифровка номера AcceptedCard, морф ширины кнопки SendBar (обычно 450ms, `cubic-bezier(.2, .8, .2, 1)`), анимации Lightbox и тура, плавная прокрутка ScrollRow, View Transition из спецификации в AcceptedCard (`IntakeScreen`).
- У скана Composer `content: none`.
- Логотип не дорисовывается. У панели и стрелок Lightbox `animation: none`.
- Для загрузчика в `Logo.module.css` есть мягкая замена `logo-breathe-soft 3s` (только opacity, до `.55`), как просит DECISIONS §3f. Но она объявлена без `!important`, а глобальное правило `animation: none !important` по правилам каскада всегда побеждает обычное объявление. Поэтому в коде знак-загрузчик при reduced motion стоит неподвижно (в браузере не проверено). Если нужна мягкая замена, её надо объявить с `!important`.

### Раскрытие новой темы (ThemeSwitch)

Новая тема открывается кругом из точки клика за 550 мс. Под капотом View Transitions и `clip-path: circle()` на `::view-transition-new(root)`. Пока идёт переход, на `<html>` стоит `data-vt="theme"`, который отключает стандартный cross-fade именно этого перехода. Без `document.startViewTransition` или при reduced motion тема меняется сразу.

```css
:root[data-vt="theme"]::view-transition-old(root),
:root[data-vt="theme"]::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
:root[data-vt="theme"]::view-transition-new(root) { z-index: 1; }
```

```js
function revealTheme(x, y, update) {
  const root = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || typeof document.startViewTransition !== "function") { update(); return; }
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.dataset.vt = "theme";
  const vt = document.startViewTransition(update);
  vt.ready.then(() => root.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
    { duration: 550, easing: "cubic-bezier(.2, .8, .2, 1)", pseudoElement: "::view-transition-new(root)" },
  )).catch(() => {});
  vt.finished.finally(() => delete root.dataset.vt).catch(() => {});
}
```

Клик с клавиатуры приходит с координатами 0,0. Тогда круг идёт из центра кнопки.

### Замысел (галерея `/kit`, раздел «Рух»)

`MotionDemos.tsx` показывает каждую фирменную анимацию с кнопкой «Повторити». Повтор перемонтирует демо через `key`, поэтому компоненты проходят свой настоящий путь первого появления:

1. «Розбір тексту: скан, потім підсвітки по черзі»: скан около 2.4 с, затем подсветки по очереди.
2. «Специфікація: каскад, кільце, відповідь згортається».
3. «Логотип: кільце дорисовується, ніжка падає; завантажувач» (логотип 56px, загрузчик 22px с подписью «Actum розбирає текст…»).
4. «Надіслати → прийнято: кнопка, розшифровка номера, імпульс». Кнопка превращается в прогресс, затем View Transition в AcceptedCard.
5. «Дрібниці: тост на пружині, скелетон, натискання 0.97».
6. «Вхідні: нове завдання з підсвіткою, рядки лога з курсором».

## Фокус и доступность

Источник: `src/styles/base.css`, `src/components/ui/LiveRegion.tsx`, `src/components/shell/TopBar.tsx`, `src/components/ui/hooks.ts`, `src/components/ui/Button.tsx`, `src/components/intake/SendBar.tsx`, `src/components/owner/CommandBar.tsx`, `src/components/owner/AgentPlanBlock.tsx`.

### Кольцо фокуса

Одно глобальное правило. Контур `2px` цвета `--accent-line` с отступом `2px` повторяет радиус элемента. Кольцо «садится»: в начале анимации `actum-focus` оно прозрачное и с отступом 5px. У ссылок радиус 4px. Элементы `h1`–`h3` и элементы с `data-focus-target`, которым фокус переводят программно (`tabindex="-1"`), кольца не показывают. Строки списков («Входящие», «Мої завдання») рисуют кольцо внутрь: `outline-offset: -2px; border-radius: 0`.

```css
:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 2px; animation: actum-focus var(--dur-fast) var(--ease); }
a:focus-visible { border-radius: 4px; }
:is(h1, h2, h3, [data-focus-target])[tabindex="-1"]:focus { outline: none; }
```

Composer показывает фокус всей панели: `box-shadow: 0 0 0 1px var(--accent-line), var(--shadow-drop)` при `:focus-within`.

### Skip-ссылка

Первый фокусируемый элемент каждой страницы с TopBar: `<a class="skip" href="#main">`. Тексты: «Перейти до основного вмісту» (uk), «Перейти к содержимому» (ru). Пока ссылка не в фокусе, она сжата до 1px. В фокусе это кнопка-заливка акцента в левом верхнем углу.

```css
.skip {
  position: fixed; left: var(--gutter); top: 12px; z-index: var(--z-toast);
  padding: 10px 14px; border-radius: var(--r-control);
  background: var(--accent); color: var(--accent-ink); font-weight: 600; text-decoration: none;
}
.skip:not(:focus) { width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
```

Цель ссылки: `<main id="main">` на каждой странице. В панели админки у него ещё `tabIndex={-1}`.

### Скрытый текст, выделение, плейсхолдер

```css
.vh { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
::selection { background: var(--accent-wash); }
::placeholder { color: var(--ink-3); opacity: 1; }
[hidden] { display: none !important; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; }
a { color: inherit; text-decoration-color: var(--line-2); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
```

### Одна live-область на страницу

Источник: `src/components/ui/LiveRegion.tsx`.

На странице одна общая вежливая область для объявлений. Она есть с первой отрисовки, визуально скрыта (DESIGN 9.4), разметка `<div role="status" aria-live="polite" aria-atomic="true" class="vh">`. `AnnouncerProvider` рендерит её один раз (в layout коллеги, в панели админки и в `/kit`), дочерние компоненты сообщают через `useAnnounce()`. Перед каждым сообщением область очищается, а текст ставится через 60 мс, поэтому одна и та же фраза два раза подряд тоже озвучивается. Без провайдера `useAnnounce` бросает ошибку, так что компонент не может завести свою копию области молча.

Кроме неё в коде есть узкие живые места: абзацы ошибок форм с `role="alert"`, контейнер тостов (`aria-live="polite"`, `aria-relevant="additions"`), `RunnerStatus` (`role="status"`), счётчик Lightbox и результат песочницы стандарта (`aria-live="polite"`). Статус запуска агента своей области не имеет: он объявляется через общую (`announce`), лог агента не озвучивается.

### Клавиатура

- Отправка: Ctrl+Enter или Cmd+Enter (`isSubmitShortcut`). Enter, который завершает IME-ввод, игнорируется.
- Подпись модификатора: «Ctrl» на сервере, Windows и Linux, «⌘» на устройствах Apple (`useModKeyLabel`). Подсказка «Ctrl ↵» / «⌘ ↵» стоит после текста кнопки в `<kbd>`, скрыта от скринридеров, а на кнопке есть `aria-keyshortcuts="Control+Enter Meta+Enter"`.
- Ctrl K / ⌘ K открывает и закрывает палитру команд владельца: модальный `<dialog>` с combobox, стрелки вверх и вниз, Enter. Подсказку клавиш прячут при ≤640 и на грубом указателе.
- Esc закрывает или отменяет: «надіслати як є», правку строки спецификации, InlineConfirm, тур, Lightbox.
- R в панели задачи владельца открывает подтверждение запуска агента, если фокус внутри панели и не в текстовом поле.
- Lightbox: стрелки, `+`/`=`, `-`/`_`, `0`, Tab держится внутри.
- Радиогруппы (ThemeSwitch): стрелки двигают и сразу выбирают, Home и End прыгают на края, roving tabindex.

## Тема и переключатель

Источник: `src/lib/theme.ts`, `src/components/theme/get-theme.ts`, `src/components/theme/actions.ts`, `src/components/theme/ThemeSwitch.tsx`, `src/components/theme/ThemeSwitch.module.css`, корневые `layout.tsx`.

### Механика без вспышки

- Кука `tf_theme` со значениями `dark`, `light` или `system`. Без куки (или с неизвестным значением) тема `dark`.
- Атрибуты куки: `Path=/`, `Max-Age=31536000` (один год), `SameSite=Lax`, не `httpOnly` (её пишет и клиент). `Secure` ставится на https на клиенте и в production в серверном действии.
- Каждый корневой layout читает куку на сервере и сразу рендерит `<html lang="…" className={fontVariables} data-theme={theme} suppressHydrationWarning>`. Таких layout шесть: `(colleague)`, `admin`, `enter`, `no-access`, `demo`, `(dev)/kit`.
- Нет ни инлайн-скрипта, ни localStorage. Значение `system` обрабатывает CSS через `prefers-color-scheme`, поэтому первая отрисовка уже в нужной теме.
- Без JS переключатель остаётся `<form>`: его кнопки `type="submit" name="theme"` отправляют форму серверному действию `setThemeAction`, оно ставит куку, страница перерисовывается.
- С JS клик пишет `document.documentElement.dataset.theme` и `document.cookie` сразу, без перезагрузки.
- `theme-color` в `viewport` задан только в `admin/layout.tsx`: `#07080A` для тёмной схемы ОС, `#F6F7F8` для светлой.

### ThemeSwitch

Для чего: компактный переключатель «Тема: Темна / Світла / Як у системі» (uk) или «Тема: Тёмная / Светлая / Как в системе» (ru). Стоит в шапке TopBar на каждой поверхности и дублируется в настройках владельца.

Анатомия:

- Дорожка `.track`: `inline-flex`, `align-items: center`, `gap: 4px`, `padding: 3px`.
- Внутри подпись группы `.group` («Тема») и `div role="radiogroup"` с тремя кнопками `role="radio"`.
- Порядок кнопок всегда `dark`, `light`, `system` (`THEMES`).

Типографика:

- подпись группы: 12px, `--ink-3`, `padding: 0 4px 0 8px`;
- кнопка: 13px/1.3, `--ink-3`, `white-space: nowrap`.

Поверхность: дорожка с фоном `--surface`, кольцом `0 0 0 1px var(--line)` и радиусом `--r-control` (11px). Кнопка без фона, `padding: 6px 11px`, радиус `--r-inner` (8px).

Состояния:

- hover: цвет `--ink-2`;
- выбрано (`[data-on]`, `aria-checked="true"`): фон `--hover`, цвет `--ink`;
- переходы `background-color` и `color` за `var(--dur-fast)`;
- фокус: глобальное кольцо;
- на грубом указателе `[role="radio"]` получает `min-height: 44px`.

Движение: клик раскрывает новую тему кругом из точки клика (см. «Движение»); Enter или Space на кнопке дают клик с координатами 0,0, и круг идёт из центра кнопки. Клик по уже выбранной теме ничего не делает. Стрелки и Home/End меняют тему сразу, без круга. В «после»-снимке переключатель уже должен показывать новое значение, поэтому обновление идёт через `flushSync`.

Адаптивность: при `max-width: 640px` подпись группы и длинная подпись «Як у системі» визуально скрыты (остаются для скринридера), видна короткая «Авто» с `aria-hidden="true"`, кнопки получают `padding: 6px 9px`.

Доступность:

- у `radiogroup` есть `aria-labelledby` на подпись «Тема»;
- `aria-checked` у каждой кнопки;
- roving tabindex (0 у выбранной, −1 у остальных) включается только после гидратации, без JS доступны все кнопки;
- стрелки вправо и вниз идут к следующей (с переходом по кругу), влево и вверх к предыдущей, Home и End на края.

```html
<form class="track" action="/theme" method="post">
  <span class="group" id="theme-label">Тема</span>
  <div role="radiogroup" aria-labelledby="theme-label" class="options">
    <button type="submit" name="theme" value="dark" role="radio" aria-checked="true" tabindex="0" class="option" data-on>Темна</button>
    <button type="submit" name="theme" value="light" role="radio" aria-checked="false" tabindex="-1" class="option">Світла</button>
    <button type="submit" name="theme" value="system" role="radio" aria-checked="false" tabindex="-1" class="option">
      <span class="long">Як у системі</span><span class="short" aria-hidden="true">Авто</span>
    </button>
  </div>
</form>
```

```css
.track {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px;
  border-radius: var(--r-control); background: var(--surface); box-shadow: 0 0 0 1px var(--line);
}
.group { font-size: 12px; color: var(--ink-3); padding: 0 4px 0 8px; }
.options { display: flex; gap: 4px; }
.option {
  border: 0; background: none; padding: 6px 11px; border-radius: var(--r-inner);
  font-size: 13px; line-height: 1.3; color: var(--ink-3); white-space: nowrap;
  transition: background-color var(--dur-fast), color var(--dur-fast);
}
.option:hover { color: var(--ink-2); }
.option[data-on] { background: var(--hover); color: var(--ink); }
.short { display: none; }
@media (max-width: 640px) {
  .group, .long { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .short { display: inline; }
  .option { padding: 6px 9px; }
}
```

`action="/theme"` в примере условный. В проекте это серверное действие `setThemeAction`.

### LangSwitch

Источник: `src/components/lang/LangSwitch.tsx`, `src/lib/copy/lang.ts`, стили `src/components/theme/ThemeSwitch.module.css`.

Для чего: выбор языка «UA RU EN» рядом с переключателем темы. Только текст: без флагов и без разделителей. Стоит в шапке TopBar на каждой поверхности, в настройках владельца («Язык кабинета») и в служебной панели `/demo`.

Анатомия: та же дорожка `.track` и те же кнопки `.option`, что у ThemeSwitch (значения выше). Подпись группы («Мова» у коллеги, «Язык» у владельца) есть, но всегда визуально скрыта (`.vh`), видимой подписи «Тема» здесь нет. Порядок кнопок: `uk`, `ru`, `en`, подписи «UA», «RU», «EN».

Состояния: как у ThemeSwitch (hover `--ink-2`, выбрано `[data-on]` фон `--hover` и цвет `--ink`, на грубом указателе 44px). Круга раскрытия нет: с JS клик сразу отмечает новый язык (оптимистично) и вызывает серверное действие `setLangAction` в transition, страница перерисовывается на новом языке. Без JS кнопки `type="submit" name="lang"` отправляют `<form>` тому же действию.

Адаптивность: своих правил нет, ширина не меняется.

Доступность: `role="radiogroup"` с `aria-labelledby` на скрытую подпись; у каждой кнопки `role="radio"`, `aria-checked`, `aria-label` с самоназванием языка («Українська», «Русский», «English») и `lang` этого языка. Стрелки и Home/End выбирают сразу; roving tabindex только после гидратации.

Куки: `tf_lang` у коллеги и `tf_lang_o` у владельца (у кабинета своя кука, поэтому ссылка коллеги не переключает язык кабинета), срок один год. Язык по умолчанию: `uk` у коллеги, `ru` у владельца. Язык из профиля человека важнее куки.

```html
<form class="track">
  <input type="hidden" name="surface" value="colleague">
  <span class="vh" id="lang-label">Мова</span>
  <div role="radiogroup" aria-labelledby="lang-label" class="options">
    <button type="submit" name="lang" value="uk" role="radio" aria-checked="true" aria-label="Українська" lang="uk" class="option" data-on>UA</button>
    <button type="submit" name="lang" value="ru" role="radio" aria-checked="false" aria-label="Русский" lang="ru" class="option">RU</button>
    <button type="submit" name="lang" value="en" role="radio" aria-checked="false" aria-label="English" lang="en" class="option">EN</button>
  </div>
</form>
```

## Логотип и иконки

Источник: `src/components/shell/Logo.tsx`, `src/components/shell/Logo.module.css`, `src/components/shell/wordmark-path.ts`, `src/lib/brand.ts`, `public/brand/*.svg`, `src/app/_brand/home-icon.tsx`, `src/app/home-*.png/route.tsx`, `src/app/manifest.ts`, `src/components/ui/Icons.tsx`, `src/components/media/icons.tsx`, `docs/DECISIONS.md` §3f.

### Бренд

- `BRAND.name` («Actum») единственный источник названия. На сервере его можно переопределить через `APP_NAME` и `APP_NAME_LATIN`.
- Слоганы: «Завдання, з якими можна одразу братися до роботи» (uk), «Задачи, за которые можно браться сразу» (ru).

### Знак и словесный знак

Для чего: строчная «a», где круглая часть это кольцо прогресса, а справа прямая ножка. Словесный знак «actum»: эта «a» плюс «ctum» в Fixel Display Bold.

Анатомия:

- Всё в единицах шрифта Fixel Display Bold: upm 1000, высота строчных 520, штрих 149, базовая линия y = 760.
- Кольцо: путь-эллипс `M254.5 300.5A215 199.5 0 1 1 254.5 699.5A215 199.5 0 1 1 254.5 300.5` (центр 254.5, 500, радиусы 215 × 199.5). Он начинается в 12 часов, `pathLength="100"`, `fill: none`, `stroke-width: 143`, `stroke-dasharray: 100`.
- Ножка: `<rect x="392" y="240" width="149" height="520">` с прямыми концами.
- Знак отдельно: `viewBox="-62 199 633 602"`.
- Словесный знак одним SVG: `viewBox="-52 82 3139 709"`, те же две фигуры плюс `CTUM_PATH`. Это один длинный `path` (~2 КБ) с контурами «ctum», сгенерированный из шрифта (`docs/design-directions/wordmark-build.html`), `fill: currentColor`. Буква не может съехать с базовой линии.

Цвет: кольцо и ножка `--accent-solid` (`#C9B8FF` в тёмной, `#7E62E0` в светлой), «ctum» цвета `--ink`.

Размеры:

- ссылка `.logo`: `font: 700 var(--fs-logo)/1 var(--ff-display)` (21px), `letter-spacing: var(--tr-logo)`;
- словесный знак: `3.139em × .709em`: 1000 единиц шрифта равны 1em, поэтому буквы знака того же размера, что текст Fixel Display 21px;
- вариант «только знак»: `1.2em × 1.14em`;
- если имя бренда не «actum», рисуется знак `.633em × .602em`, а за ним имя текстом Fixel с `gap: .18em`.

Состояния:

- фокус: глобальное кольцо по радиусу `--r-inner`;
- hover проигрывает анимацию заново: атрибут `data-play` снимается, идёт принудительный reflow, атрибут ставится снова;
- `loading`: знак «дышит» (ниже).

Движение:

- Дорисовка при загрузке и при наведении: кольцо `logo-ring .95s .1s cubic-bezier(.2, .8, .2, 1) both` (`stroke-dashoffset` 100 → 0, по часовой от 12 часов), затем ножка `logo-stem .6s .75s cubic-bezier(.3, 1.45, .5, 1) both` (падает с `translateY(-35%)` и opacity 0, на пружине).
- Загрузчик «Дихання» (`MarkSpinner`, `[data-loading]`): `logo-breathe 2.2s ease-in-out infinite`, scale .9 → 1 → .9, на вдохе `drop-shadow(0 0 .28em var(--accent-glow, rgb(201 184 255 / .55)))`. Токена `--accent-glow` нет, поэтому всегда работает запасное значение, одинаковое в обеих темах. Загрузчик заменяет любые спиннеры. Размер по умолчанию 18px, в SendBar 17px (в `/kit` 22px). В SendBar он стоит внутри primary-кнопки, и обёртка `.spin` перекрашивает его в тёмный: `--accent-solid: var(--accent-ink)`.
- При reduced motion дорисовки нет. Загрузчик по коду стоит неподвижно: мягкая замена `logo-breathe-soft` перекрыта глобальным `animation: none !important` (см. «Движение»).

Доступность:

- у ссылки логотипа `aria-label` равен имени бренда;
- все SVG `aria-hidden="true" focusable="false"`;
- `MarkSpinner` с `label` получает `role="status"` и `aria-label`.

```html
<a class="logo" href="/" aria-label="Actum" data-play data-variant="wordmark">
  <svg class="svg word" viewBox="-52 82 3139 709" aria-hidden="true" focusable="false">
    <path class="ring" d="M254.5 300.5A215 199.5 0 1 1 254.5 699.5A215 199.5 0 1 1 254.5 300.5" pathLength="100"/>
    <rect class="stem" x="392" y="240" width="149" height="520"/>
    <path class="ctum" d="…CTUM_PATH…"/>
  </svg>
</a>
```

```css
.logo {
  display: inline-flex; align-items: center; gap: .18em; flex: none;
  font: 700 var(--fs-logo)/1 var(--ff-display); letter-spacing: var(--tr-logo);
  color: var(--ink); text-decoration: none; border-radius: var(--r-inner);
}
.svg { display: block; flex: none; overflow: visible; }
.word { width: 3.139em; height: .709em; }
.ctum { fill: currentColor; }
.ring { fill: none; stroke: var(--accent-solid); stroke-width: 143; stroke-dasharray: 100; }
.stem { fill: var(--accent-solid); transform-box: fill-box; }
.logo[data-play] .ring { animation: logo-ring .95s .1s cubic-bezier(.2, .8, .2, 1) both; }
.logo[data-play] .stem { animation: logo-stem .6s .75s cubic-bezier(.3, 1.45, .5, 1) both; }
@keyframes logo-ring { from { stroke-dashoffset: 100; } }
@keyframes logo-stem { from { transform: translateY(-35%); opacity: 0; } }
.svg[data-loading] { transform-origin: 50% 50%; animation: logo-breathe 2.2s ease-in-out infinite; }
@keyframes logo-breathe {
  0%, 100% { transform: scale(.9); filter: drop-shadow(0 0 0 transparent); }
  50% { transform: scale(1); filter: drop-shadow(0 0 .28em var(--accent-glow, rgb(201 184 255 / .55))); }
}
```

Числа из DECISIONS §3f про `viewBox 0 0 48 48`, `circle r=11` и `viewBox 8 15 31 24` устарели: знак пересобран по метрикам шрифта.

Контур «ctum» целиком (`CTUM_PATH` из `src/components/shell/wordmark-path.ts`, сгенерирован из Fixel Display Bold, OFL; `viewBox` словесного знака `-52 82 3139 709`). Без него словесный знак не повторить:

```text
M904 770L895 770Q836 770 787 750.5Q738 731 703 696.5Q668 662 648.5 614Q629 566 629 509L629 509L629 489Q629 433 649 385.5Q669 338 704.5 303.5Q740 269 788 249.5Q836 230 893 230L893 230L901 230Q975 230 1032 260Q1089 290 1127 344L1127 344L1021 420Q979 344 904 344L904 344L902 344Q846 344 814.5 383.5Q783 423 783 495L783 495L783 505Q783 575 817 614.5Q851 654 906 654L906 654L911 654Q951 654 979.5 633.5Q1008 613 1028 577L1028 577L1131 658Q1093 712 1036.5 741Q980 770 904 770L904 770ZM1407 767L1407 767Q1370 767 1338 757.5Q1306 748 1283.5 727Q1261 706 1248 673.5Q1235 641 1235 596L1235 596L1235 355L1167 355L1167 256Q1181 251 1199.5 247.5Q1218 244 1235 242L1235 242L1235 120L1383 102L1383 240L1539 240L1539 355L1382 355L1382 569Q1382 609 1400 625.5Q1418 642 1452 642L1452 642Q1462 642 1474.5 641Q1487 640 1499.5 638Q1512 636 1523.5 634Q1535 632 1542 631L1542 631L1542 744Q1529 750 1512 754Q1495 758 1476.5 761Q1458 764 1440 765.5Q1422 767 1407 767ZM1810 771L1807 771Q1719 771 1672.5 719.5Q1626 668 1626 574L1626 574L1626 240L1775 240L1775 541Q1775 646 1864 646L1864 646L1866 646Q1920 646 1952.5 609.5Q1985 573 1985 511L1985 511L1985 240L2134 240L2134 760L2016 760Q2010 745 2005.5 720.5Q2001 696 2000 679L2000 679Q1966 721 1917 746Q1868 771 1810 771L1810 771ZM2268 760L2268 240L2386 240Q2391 254 2395.5 276Q2400 298 2401 315L2401 315Q2432 276 2475 252.5Q2518 229 2569 229L2569 229L2570 229Q2626 229 2664 252.5Q2702 276 2722 320L2722 320Q2753 278 2797.5 253Q2842 228 2895 228L2895 228L2896 228Q2979 228 3023 279.5Q3067 331 3067 425L3067 425L3067 759L2918 759L2918 452Q2918 396 2899 375Q2880 354 2840 353L2840 353L2839 353Q2796 355 2769 384Q2742 413 2742 475L2742 475L2742 760L2593 760L2593 452Q2593 396 2574 375.5Q2555 355 2514 354L2514 354L2513 354Q2471 355 2444 384.5Q2417 414 2417 475L2417 475L2417 760L2268 760Z
```

### Иконки приложения и favicon

- `public/brand/favicon.svg`: знак с `viewBox="-62 199 633 602"` и встроенным `<style>`, который сам выбирает цвет: `#7E62E0` при светлой схеме браузера и `#C9B8FF` при тёмной. Файл целиком:

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-62 199 633 602" role="img" aria-label="Actum"><style>.ring{stroke:#7E62E0}.stem{fill:#7E62E0}@media (prefers-color-scheme:dark){.ring{stroke:#C9B8FF}.stem{fill:#C9B8FF}}</style><ellipse class="ring" cx="254.5" cy="500.0" rx="215.0" ry="199.5" fill="none" stroke="#9B85F5" stroke-width="143"/><rect class="stem" x="392.0" y="240.0" width="149.0" height="520.0" fill="#9B85F5"/></svg>
```

- `public/brand/actum-mark.svg` и `actum-wordmark.svg`: те же фигуры с заливкой по умолчанию `#9B85F5`, у «ctum» `currentColor`.
- PNG генерирует при сборке `homeIcon(size)` через `next/og`: квадрат с фоном `#0A0B0C`, знак `#C9B8FF` шириной около 56% стороны (высота `w * 602 / 633`), чтобы маски круга и сквиркла его не резали. Текста нет.
- Маршруты PNG: `/home-180.png` (apple-touch-icon), `/home-192.png`, `/home-512.png`.
- Иконки в metadata: `icons: { icon: "/brand/favicon.svg", apple: "/home-180.png" }` во всех корневых layout, кроме `/kit`.
- В PNG и в файлах `public/brand/*.svg` кольцо нарисовано `<ellipse cx="254.5" cy="500" rx="215" ry="199.5">` с `stroke-width="143"`, а не путём с `pathLength`, как в `Logo.tsx`.
- Manifest: `name` и `short_name` равны `BRAND.name`, `start_url: "/"`, `display: "standalone"`, `background_color` и `theme_color` `#0A0B0C`. Иконки: `favicon.svg` (`sizes: "any"`), 192 и 512 PNG.
- Фон иконок `#0A0B0C` равен значению `--accent-ink`, а не `--bg` (`#07080A`).

### Иконки интерфейса

Правило: никаких наборов иконок (SPEC §6.8, SPEC-DELTA §5.5). Немногие нужные иконки сделаны своими inline-SVG компонентами в одном стиле.

- Сетка `viewBox="0 0 16 16"`, `fill="none"`, `stroke="currentColor"`, `strokeWidth={1.5}`, `strokeLinecap="round"`, `strokeLinejoin="round"`.
- Цвет берётся из текста родителя.
- Размер задаёт проп `size`, по умолчанию 16. В коде встречаются 12, 14, 16, 18, 22.
- Иконки декоративные: `aria-hidden="true"`, `focusable="false"`. Смысл несёт подпись или `aria-label` кнопки.

```tsx
function Svg({ size = 16, ...rest }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest} />;
}
```

| Иконка | Файл | Где | Размер |
|---|---|---|---|
| `AttachIcon` (скрепка) | `ui/Icons.tsx` | FileDrop | 22 |
| `CheckIcon` (галочка) | `ui/Icons.tsx` | шаги входа по коду в настройках | 12, `strokeWidth` 2 |
| `CopyIcon` (два листа) | `ui/Icons.tsx` | CopyButton в админке | 16 |
| `ExternalIcon` (стрелка из квадрата) | `ui/Icons.tsx` | ссылки на Telegram, 2FA | 14 |
| `SearchIcon` (лупа) | `ui/Icons.tsx` | CommandBar | 16 |
| `CloseIcon` (крест) | `media/icons.tsx` | Lightbox; удаление файла в Composer | 16; 12 |
| `PlusIcon` / `MinusIcon` | `media/icons.tsx` | масштаб в Lightbox | 16 |
| `DownloadIcon` (стрелка вниз на черте) | `media/icons.tsx` | Lightbox; галерея вложений | 16; 14 |
| `ChevronIcon` (`direction: "left" \| "right"`) | `media/icons.tsx` | листание в Lightbox | 16 |
| `RetryIcon` (круговая стрелка) | `media/icons.tsx` | повтор загрузки файла | 14 |
| `DocIcon` (лист с загнутым углом) | `media/icons.tsx` | плитка документа; галерея | 16; 18 |

Ещё два inline-SVG в том же духе, но на своей сетке:

- галочка ответа в SpecRow и в туре: `viewBox="0 0 14 14"`, 14px, `stroke="currentColor"`, `strokeWidth="2"`, круглые концы, путь `M2 7.5l3.2 3L12 3.5`. В SpecRow она цвета `--accent-text` и рисуется штрихом (`stroke-dasharray: 20`, `tick-draw .45s var(--ease) .25s both`), в туре без анимации;
- кольцо прогресса `ProgressRing`: 18px, `viewBox="0 0 18 18"`, окружность `r="7"`, `strokeWidth="2"`, дорожка `--line-2`, значение `--accent-line` с круглым концом, `stroke-dasharray: 44`, повёрнуто на −90°; `stroke-dashoffset` меняется за `.9s var(--ease-spring)`. Рядом текст «3 / 5» в `.meta`.

# Часть 2. Базовые компоненты и формы

## Базовые компоненты

Все примитивы лежат в `src/components/ui/`. Каждый компонент: `.tsx` плюс свой `.module.css` (CSS Modules, без Tailwind). Значения берутся из токенов `src/styles/tokens.css`. Сырые числа в модулях есть, ниже они названы как есть.

Общие правила, которые действуют на все компоненты раздела:

- Цвета зависят от темы. Ниже цвет токена дан парой «тёмная / светлая». Тёмная тема основная.
- CSS Modules переименовывают `@keyframes`, поэтому глобальные анимации из `src/styles/motion.css` внутри модуля недоступны. Каждый модуль держит свою копию нужного `@keyframes`. При переносе в другой стек можно оставить одну глобальную копию.
- `@media (prefers-reduced-motion: reduce)` в `motion.css` выключает все анимации и переходы (`animation: none !important; transition: none !important`). Конечное состояние каждой анимации совпадает с обычным стилем элемента, поэтому без анимации сразу видно итог.
- Кольцо фокуса общее, из `base.css` (см. раздел «Фокус и доступность» → «Кольцо фокуса»). Компоненты свой фокус почти не задают.

Шпаргалка токенов, на которые ссылается этот раздел:

| Токен | Тёмная | Светлая |
|---|---|---|
| `--bg` | `#07080A` | `#F6F7F8` |
| `--surface` | `#0E0F12` | `#FFFFFF` |
| `--raised` | `#141519` | `#FBFBFC` |
| `--hover` | `#1A1C21` | `#F1F2F4` |
| `--line` | `rgb(255 255 255 / .07)` | `rgb(10 12 16 / .08)` |
| `--line-2` | `rgb(255 255 255 / .12)` | `rgb(10 12 16 / .14)` |
| `--ink` | `#F3F4F6` | `#0A0C10` |
| `--ink-2` | `#A3A9B3` | `#555C68` |
| `--ink-3` | `#7E848E` | `#676D77` |
| `--accent` | `#C9B8FF` | `#D9CCFF` |
| `--accent-ink` | `#0A0B0C` | `#0A0B0C` |
| `--accent-line` | `rgb(201 184 255 / .55)` | `#7E62E0` |
| `--accent-solid` | `#C9B8FF` | `#7E62E0` |
| `--accent-wash` | `rgb(201 184 255 / .11)` | `rgb(150 120 255 / .14)` |
| `--ask` | `#FFB45C` | `#B45309` |
| `--danger` | `#FF7A7A` | `#B42318` |
| `--shadow-drop` | `0 24px 48px -24px rgb(0 0 0 / .6)` | `0 24px 48px -28px rgb(10 12 16 / .25)` |
| `--shadow` | `0 0 0 1px var(--line), var(--shadow-drop)` | то же |
| `--shadow-accent` | `0 0 0 1px rgb(0 0 0 / .1), 0 8px 24px -10px var(--accent-line)` | то же |

| Токен | Значение | Токен | Значение |
|---|---|---|---|
| `--r-panel` | 20px | `--s-1` | 4px |
| `--r-block` | 14px | `--s-2` | 8px |
| `--r-control` | 11px | `--s-3` | 12px |
| `--r-chip` | 9px | `--s-4` | 16px |
| `--r-inner` | 8px | `--s-5` | 20px |
| `--r-tag` | 6px | `--s-6` | 24px |
| `--r-pill` | 999px | `--s-8` | 40px |
| `--fs-body` / `--lh-body` | 15px / 1.55 | `--dur-fast` | 150ms |
| `--fs-ui` | 14px | `--dur-base` | 220ms |
| `--fs-small` | 13.5px | `--ease` | `cubic-bezier(.2, .8, .2, 1)` |
| `--fs-meta` / `--lh-meta` | 13px / 1.4 | `--ease-spring` | `cubic-bezier(.34, 1.3, .5, 1)` |
| `--fs-chip` | 12.5px | `--ease-pop` | `cubic-bezier(.3, 1.25, .5, 1)` |
| `--fs-label` | 11px | `--z-dialog` / `--z-toast` | 40 / 50 |
| `--gutter` | 24px, 16px при `max-width: 640px` | `--z-top` | 10 |

Шрифтовые роли: `--ff-text` (Fixel Text), `--ff-display` (Fixel Display), `--ff-meta` (Martian Mono только для цифр и знаков `: / $ % .`, остальное Fixel Text; Martian уменьшен `size-adjust: 90%`), `--ff-mono` (вся строка в Martian Mono). Источник: `src/app/fonts.ts`.

### Button и ButtonLink

Источник: `src/components/ui/Button.tsx`, `src/components/ui/Button.module.css`; `kbd`, `:focus-visible` и `@media (pointer: coarse)` из `src/styles/base.css`; `useModKeyLabel`, `isSubmitShortcut` из `src/components/ui/hooks.ts`.

Одна кнопка на весь продукт: четыре варианта и два размера. `ButtonLink` даёт тот же вид ссылке (`next/link`). Функция `buttonClass(variant, size, extra)` возвращает те же классы для любого элемента: ссылок в админке, `<button type="submit">` выхода, `<a target="_blank">`.

Props: `variant` = `primary | ghost | quiet | pill` (по умолчанию `ghost`), `size` = `md | sm` (по умолчанию `md`), `kbd?: string | null`, `type` по умолчанию `"button"`. Остальные атрибуты уходят на `<button>` или `<a>`.

Анатомия: `display: inline-flex`, `align-items: center`, `justify-content: center`, `gap: 10px`. Внутри текст, затем необязательный `<kbd>`. Сброс: `margin: 0; border: 0; font: inherit; line-height: 1.25; text-decoration: none; white-space: nowrap; -webkit-tap-highlight-color: transparent`.

Варианты (размер `md`):

| Вариант | Имя в макете | Фон | Цвет текста | Шрифт | Радиус | Padding | Рамка и тень | Hover |
|---|---|---|---|---|---|---|---|---|
| `primary` | `.go` | `--accent` | `--accent-ink` | 600, `--fs-body` (15px) | `--r-control` (11px) | `11px 16px` | `--shadow-accent` | `box-shadow: 0 0 0 1px rgb(0 0 0 / .12), 0 10px 28px -10px var(--accent-line)` |
| `ghost` | `.ghost` | нет | `--ink` | 400, `--fs-ui` (14px) | `--r-control` (11px) | `10px 14px` | `0 0 0 1px var(--line-2)` | фон `--hover` |
| `quiet` | `.later` | нет | `--ink-3` | 400, `--fs-ui` (14px) | `--r-inner` (8px) | `8px 6px` | нет | цвет `--ink` |
| `pill` | `.pill` | `--raised` | `--ink-2` | 400, 13px | `--r-pill` (999px) | `5px 11px` | `0 0 0 1px var(--line)` | цвет `--ink`, рамка `0 0 0 1px var(--line-2)` |

Размер `sm`:

| Вариант | Padding | Шрифт | Gap |
|---|---|---|---|
| `primary` | `7px 12px` | `--fs-ui` (14px) | 8px |
| `ghost` | `7px 11px` | `--fs-small` (13.5px) | 10px |
| `quiet` | `6px 4px` | `--fs-small` (13.5px) | 10px |
| `pill` | правила `sm` нет, выглядит как `md` | | |

Состояния:

- hover: см. таблицу. Правила hover написаны с `:not(:disabled)`, у выключенной кнопки hover нет. У кнопки только с `aria-disabled="true"` hover не отключён (в коде `aria-disabled` сейчас нигде не ставится).
- active (нажатие): `transform: scale(.97)`, кроме `:disabled` и `[data-busy]`.
- focus-visible: глобальное кольцо `outline: 2px solid var(--accent-line); outline-offset: 2px`, оно повторяет радиус кнопки.
- disabled и `aria-disabled="true"`: `opacity: .45; box-shadow: none; cursor: not-allowed`.
- busy: атрибут `data-busy` оставляет вид как есть, ставит `cursor: progress` и отключает эффект нажатия. Клики игнорирует вызывающий код. Так сделано в `SendBar` (идёт финальная проверка) и в `TelegramConnectView`. Вместе с ним ставится `aria-busy`.
- ожидание в формах: обычно `disabled={pending}` плюс `aria-busy={pending}`.

Движение: `transition: background-color var(--dur-fast), box-shadow var(--dur-fast), color var(--dur-fast), transform var(--dur-fast)` (150ms, без своей кривой, то есть `ease` по умолчанию).

Адаптивность: при `@media (pointer: coarse)` у `button`, `[role="radio"]`, `.opt`, `.tab` `min-height: 44px` (`base.css`). У `ButtonLink` элемент `<a>`, под этот селектор он не попадает.

Подсказка клавиш `kbd`: рендерится как `<kbd aria-hidden="true">` после текста. Базовый вид `kbd` см. в разделе «Типографика» → «Глобальные помощники». Внутри `primary`: `box-shadow: 0 0 0 1px rgb(0 0 0 / .18); color: var(--accent-ink)`. Текст подсказки собирает вызывающий код, например «Ctrl ↵». `useModKeyLabel()` даёт «⌘» на устройствах Apple и «Ctrl» на остальных (и на сервере). `isSubmitShortcut(e)` ловит Ctrl+Enter и Cmd+Enter и пропускает Enter, который завершает IME-ввод.

Доступность: `kbd` скрыт от читалок. Сочетание клавиш объявляется на самой кнопке через `aria-keyshortcuts`, например в `SendBar`: `"Control+Enter Meta+Enter"`.

Примеры подписей из галереи (uk): `primary` «Надіслати» с kbd «Ctrl ↵», `ghost` «Змінити план», `quiet` «надіслати як є», `pill` «+ файл». В `sm`: «Так, скасувати», «Скопіювати», «Скасувати». Выключенные: `primary` «Надіслати» с kbd и `ghost` «Інший агент»; ссылка `ButtonLink ghost` «Мої завдання».

```css
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  margin: 0; border: 0; font: inherit; line-height: 1.25; text-decoration: none; white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
  transition: background-color var(--dur-fast), box-shadow var(--dur-fast), color var(--dur-fast), transform var(--dur-fast);
}
.btn:active:not(:disabled):not([data-busy]) { transform: scale(.97); }
.btn:disabled,
.btn[aria-disabled="true"] { opacity: .45; box-shadow: none; cursor: not-allowed; }
.btn[data-busy] { cursor: progress; }

.primary {
  background: var(--accent); color: var(--accent-ink); font-weight: 600; font-size: var(--fs-body);
  border-radius: var(--r-control); padding: 11px 16px; box-shadow: var(--shadow-accent);
}
.primary:hover:not(:disabled) { box-shadow: 0 0 0 1px rgb(0 0 0 / .12), 0 10px 28px -10px var(--accent-line); }
.primary kbd { box-shadow: 0 0 0 1px rgb(0 0 0 / .18); color: var(--accent-ink); }

.ghost {
  background: none; color: var(--ink); font-size: var(--fs-ui);
  border-radius: var(--r-control); padding: 10px 14px; box-shadow: 0 0 0 1px var(--line-2);
}
.ghost:hover:not(:disabled) { background: var(--hover); }

.quiet { background: none; color: var(--ink-3); font-size: var(--fs-ui); padding: 8px 6px; border-radius: var(--r-inner); }
.quiet:hover:not(:disabled) { color: var(--ink); }

.pill {
  background: var(--raised); color: var(--ink-2); font-size: 13px;
  border-radius: var(--r-pill); padding: 5px 11px; box-shadow: 0 0 0 1px var(--line);
}
.pill:hover:not(:disabled) { color: var(--ink); box-shadow: 0 0 0 1px var(--line-2); }

.sm.primary { padding: 7px 12px; font-size: var(--fs-ui); gap: 8px; }
.sm.ghost { padding: 7px 11px; font-size: var(--fs-small); }
.sm.quiet { padding: 6px 4px; font-size: var(--fs-small); }
```

```html
<button type="button" class="btn primary">Надіслати <kbd aria-hidden="true">Ctrl ↵</kbd></button>
```

### Panel и PanelHeader

Источник: `src/components/ui/Panel.tsx`, `src/components/ui/Panel.module.css`.

`Panel` это главная карточка экрана: композер, специфікація, входящие, правая колонка задачи, страница входа. `PanelHeader` это верхняя строка карточки с мета-текстом слева и необязательным содержимым справа.

Props `Panel`: `as` = `section | aside | div` (по умолчанию `section`), `label` уходит в `aria-label`, `className`, остальные атрибуты. Props `PanelHeader`: `meta`, `right?`, `className?`.

Анатомия `Panel`: `position: relative; min-width: 0; overflow: clip`. Перед `clip` стоит запасное `overflow: hidden`. `clip` обрезает как `hidden`, но не создаёт контейнер прокрутки, поэтому `position: sticky` у детей липнет к окну. Своего padding у панели нет, отступы задаёт содержимое (в галерее `16px 18px`, у формы входа `28px 28px 24px`).

Поверхность `Panel`: фон `--surface` (`#0E0F12` / `#FFFFFF`), радиус `--r-panel` (20px), тень `--shadow` (кольцо 1px `--line` плюс `--shadow-drop`). Сверху блик: `::before` высотой 1px по всей ширине, `linear-gradient(90deg, transparent, var(--line-2), transparent)`, `pointer-events: none`.

Движение `Panel`: `transition: box-shadow var(--dur-base)` (220ms). Сам компонент тень не меняет, переход нужен тем, кто её меняет снаружи. Пример: композер (`src/components/intake/Composer.module.css`) при фокусе внутри ставит `.panel:focus-within { box-shadow: 0 0 0 1px var(--accent-line), var(--shadow-drop); }`, кольцо панели плавно становится сиреневым.

Анатомия `PanelHeader`: `display: flex; align-items: center; justify-content: space-between; gap: var(--s-3)` (12px), `flex-wrap: wrap`, `padding: 14px 18px`, снизу `border-bottom: 1px solid var(--line)`. Левая часть `div.meta` с `min-width: 0`. Правая часть `div.meta` с `display: flex; align-items: center; gap: var(--s-2)` (8px).

Типографика `PanelHeader`: обе части получают глобальный класс `.meta` (`--ff-meta`, 400, `--fs-meta`/`--lh-meta` 13px/1.4, цвет `--ink-3`; `b` внутри 500 `--ink-2`).

Доступность: `label` становится `aria-label` региона, поэтому `section` и `aside` получают имя.

Пример из галереи: слева `MetaList plain` из «**чернетка**» и «збережено 14:31», справа «2 файли».

Расхождение со SPEC-DELTA §5.5: там `overflow: hidden`, в коде `overflow: clip` (важно, если внутри нужен sticky).

```css
.panel {
  position: relative; min-width: 0;
  background: var(--surface); border-radius: var(--r-panel); box-shadow: var(--shadow);
  overflow: hidden;
  overflow: clip;
  transition: box-shadow var(--dur-base);
}
.panel::before {
  content: ""; position: absolute; inset: 0 0 auto; height: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--line-2), transparent);
}
.header {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); flex-wrap: wrap;
  padding: 14px 18px; border-bottom: 1px solid var(--line);
}
.headerMeta { min-width: 0; }
.headerRight { display: flex; align-items: center; gap: var(--s-2); }
```

```html
<section class="panel" aria-label="Приклад панелі">
  <div class="header">
    <div class="meta headerMeta"><b>чернетка</b> збережено 14:31</div>
    <div class="meta headerRight">2 файли</div>
  </div>
  <p style="padding: 16px 18px">…</p>
</section>
```

### Block

Источник: `src/components/ui/Block.tsx`, `src/components/ui/Block.module.css`.

Приподнятая внутренняя карточка внутри `Panel`: план агента, лог запуска.

Props: `header`, `aside?`, `label?` (уходит в `aria-label` элемента `section`), `className?`, `children?`.

Анатомия: `section.block`, внутри `div.head` и потом дети. `.head`: `display: flex; justify-content: space-between; align-items: center; gap: var(--s-2) var(--s-3)` (8px 12px), `flex-wrap: wrap`, `margin-bottom: 10px`. В нём `.headMain` (`display: flex; align-items: center; gap: var(--s-2)`, `min-width: 0`) и `.aside` (`display: flex; align-items: center; gap: var(--s-2)`).

Поверхность: фон `--raised` (`#141519` / `#FBFBFC`), радиус `--r-block` (14px), кольцо `box-shadow: 0 0 0 1px var(--line)`, `padding: 14px`, `margin-top: var(--s-3)` (12px), `min-width: 0`.

Пример из галереи: в шапке `AgentChip` «Документы» в состоянии `done`, справа мета «уверенность высокая».

```css
.block {
  border-radius: var(--r-block); box-shadow: 0 0 0 1px var(--line);
  padding: 14px; margin-top: var(--s-3); background: var(--raised); min-width: 0;
}
.head { display: flex; justify-content: space-between; align-items: center; gap: var(--s-2) var(--s-3); flex-wrap: wrap; margin-bottom: 10px; }
.headMain { min-width: 0; display: flex; align-items: center; gap: var(--s-2); }
.aside { display: flex; align-items: center; gap: var(--s-2); }
```

### Disclosure

Источник: `src/components/ui/Disclosure.tsx`, `src/components/ui/Disclosure.module.css`.

Свёрнутый раздел на нативном `details`. Работает без JS, клавиатура и читалки из коробки. Используется для «Исходный текст» в задаче, «Заменить токен» в настройках, технических подробностей.

Props: `summary`, `meta?`, `defaultOpen?`, `className?`, `children`.

Анатомия: `details.details` с `border-top: 1px solid var(--line)`. `summary`: `display: flex; align-items: center; gap: 10px; padding: 12px 0; cursor: pointer; list-style: none`, радиус `--r-inner` (8px, его повторяет кольцо фокуса). Внутри по порядку: шеврон, подпись, необязательная мета. Тело `div.body` с `padding: 2px 0 14px`.

Шеврон: пустой `span` 7×7px, `flex: none; margin: 0 2px`, правая и нижняя граница `1.5px solid currentColor`. Закрыт: `rotate(-45deg)` (смотрит вправо). Открыт: `rotate(45deg)` (смотрит вниз).

Типографика: summary `--fs-ui` (14px), цвет `--ink-2` (`#A3A9B3` / `#555C68`); подпись 500; мета с классом `.meta`.

Состояния: hover на summary меняет цвет на `--ink`. Открыто: `details[open]` поворачивает шеврон. Стандартный маркер скрыт (`list-style: none` и `::-webkit-details-marker { display: none }`).

Движение: `transition: transform var(--dur-fast) var(--ease)` у шеврона. Тело появляется без анимации.

Доступность: шеврон `aria-hidden="true"`. Открытие по Enter и пробелу даёт браузер.

Пример из галереи: «Технічні подробиці», мета «2 розбори».

```css
.details { border-top: 1px solid var(--line); }
.summary {
  display: flex; align-items: center; gap: 10px; padding: 12px 0; cursor: pointer;
  list-style: none; font-size: var(--fs-ui); color: var(--ink-2); border-radius: var(--r-inner);
}
.summary::-webkit-details-marker { display: none; }
.summary:hover { color: var(--ink); }
.label { font-weight: 500; }
.chevron {
  width: 7px; height: 7px; flex: none; margin: 0 2px;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg); transition: transform var(--dur-fast) var(--ease);
}
.details[open] > .summary .chevron { transform: rotate(45deg); }
.body { padding: 2px 0 14px; }
```

```html
<details class="details">
  <summary class="summary">
    <span class="chevron" aria-hidden="true"></span>
    <span class="label">Технічні подробиці</span>
    <span class="meta">2 розбори</span>
  </summary>
  <div class="body">…</div>
</details>
```

### Empty

Источник: `src/components/ui/Empty.tsx`, `src/components/ui/Empty.module.css`.

Пустое состояние без иллюстраций: заголовок, одна строка текста, необязательное действие.

Props: `title: string`, `text?`, `action?`, `headingLevel` = `2 | 3` (по умолчанию 2, задаёт `h2` или `h3`).

Анатомия: обёртка `padding: var(--s-8) var(--s-6)` (40px 24px). Текст `margin-top: var(--s-2)` (8px), действие `margin-top: var(--s-4)` (16px).

Типографика: заголовок `--ff-display` 500, `--fs-h3`/`--lh-h3` (20px/1.2), `letter-spacing: var(--tr-h3)` (-0.02em). Текст наследует тело (`--ff-text` 15px/1.55), цвет `--ink-2`, `max-width: 44ch`.

Примеры: коллега (uk) «Завдань поки немає.» с кнопкой `ButtonLink primary sm` «Нове завдання»; владелец (ru) «Новых задач нет.» и «Когда коллеги отправят задачу, она появится здесь и придёт в Telegram.»

```css
.empty { padding: var(--s-8) var(--s-6); }
.title { font: 500 var(--fs-h3)/var(--lh-h3) var(--ff-display); letter-spacing: var(--tr-h3); }
.text { margin-top: var(--s-2); max-width: 44ch; color: var(--ink-2); }
.action { margin-top: var(--s-4); }
```

### Facts

Источник: `src/components/ui/Facts.tsx`, `src/components/ui/Facts.module.css`.

Список «термин: значение» (`dl`), термины в узкой мета-колонке. Используется в правой колонке задачи у владельца (`TaskSide`) и на странице задачи у коллеги (`src/app/(colleague)/tasks/[serial]/page.tsx`).

Props: `items: { term: string; value: ReactNode }[]`, `className?`.

Анатомия: `dl` с `display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: var(--s-2) 14px` (8px 14px), `margin: 0 0 18px`. Каждая пара обёрнута в `div` с `display: contents`, поэтому `dt` и `dd` встают прямо в сетку. `dt` получает класс `.meta` и `padding-top: 2px` (выравнивает 13px мету с 14px значением). `dd`: `margin: 0; min-width: 0; overflow-wrap: anywhere`.

Типографика: общий `font-size: var(--fs-ui)` (14px); термин в `.meta` (13px/1.4, `--ink-3`).

Адаптивность: при `max-width: 380px` колонка терминов 80px.

Пример из галереи (uk): «що», «термін», «терміновість».

```css
.facts { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: var(--s-2) 14px; margin: 0 0 18px; font-size: var(--fs-ui); }
.row { display: contents; }
.row dt { padding-top: 2px; }
.row dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 380px) { .facts { grid-template-columns: 80px minmax(0, 1fr); } }
```

### MetaList

Источник: `src/components/ui/MetaList.tsx`, `src/components/ui/MetaList.module.css`.

Строка мета-пунктов (кто, когда, срок). Пункты разделены пробелом, а не точкой «·». Это правило всего продукта.

Props: `items: ReactNode[]`, `className?`, `plain?`. Пустые значения (`null`, `undefined`, `false`, `""`) пропускаются. Без `plain` у списка класс `.meta`. `plain` нужен, когда родитель уже `.meta` (например в `PanelHeader`).

Анатомия: `span` с `display: inline-flex; flex-wrap: wrap; align-items: baseline; column-gap: 1.25em; row-gap: 2px; min-width: 0`. Каждый пункт `span` с `min-width: 0`.

Доступность: между пунктами вставлен скрытый `span.vh` с «, », поэтому читалка слышит запятую, а глазами видна только щель 1.25em.

```css
.list { display: inline-flex; flex-wrap: wrap; align-items: baseline; column-gap: 1.25em; row-gap: 2px; min-width: 0; }
.item { min-width: 0; }
```

```html
<span class="list meta">
  <span class="item"><b>чернетка</b></span><span class="vh">, </span><span class="item">збережено 14:31</span>
</span>
```

### PageIntro

Источник: `src/components/ui/PageIntro.tsx`, `src/components/ui/PageIntro.module.css`.

Вступление страницы коллеги: крупный `h1` и лид. Растягивается на обе колонки сетки коллеги.

Props: `title`, `lead?`, `id?`, `className?`. В `title` вторая фраза приглушается через `em`. Строка копирайта пишет её между звёздочками, `renderEm` превращает их в `em`. Пример (uk): «Опиши завдання. *Решту {brand} розбере сам.*».

Анатомия: `grid-column: 1 / -1; display: flex; align-items: end; justify-content: space-between; gap: var(--s-5)` (20px), `flex-wrap: wrap`.

Типографика: `h1` `--ff-display` 500, `--fs-h1`/`--lh-h1` (52px/1.02), `letter-spacing: var(--tr-h1)` (-0.045em), `max-width: 14ch`, `text-wrap: balance`. Для `:lang(en)` `max-width: 18ch`. `em` внутри: `font-style: normal; color: var(--ink-3)`. Лид: тело 15px/1.55, `--ink-2`, `max-width: 36ch`.

Адаптивность: при `max-width: 760px` токен `--fs-h1` становится 40px.

Доступность: у `h1` `tabIndex={-1}`, чтобы на него можно было перевести фокус программно. Кольцо при этом не рисуется (правило в `base.css`).

```css
.intro { grid-column: 1 / -1; display: flex; align-items: end; justify-content: space-between; gap: var(--s-5); flex-wrap: wrap; }
.h1 { font: 500 var(--fs-h1)/var(--lh-h1) var(--ff-display); letter-spacing: var(--tr-h1); max-width: 14ch; text-wrap: balance; }
.h1:lang(en) { max-width: 18ch; }
.h1 em { font-style: normal; color: var(--ink-3); }
.lead { max-width: 36ch; color: var(--ink-2); }
```

### InlineConfirm

Источник: `src/components/ui/InlineConfirm.tsx`, `src/components/ui/InlineConfirm.module.css`.

Подтверждение необратимого действия без модального окна. Под кнопкой раскрывается полоска с вопросом, основной кнопкой «Так, …» и тихой отменой.

Props: `trigger` (`label`, `variant` по умолчанию `ghost`, `size`, `kbd`, `disabled`), `question`, `confirmLabel`, `cancelLabel`, `onConfirm` (может быть async), `open` и `onOpenChange` для управляемого режима (например горячая клавиша), `defaultOpen` (только галерея и тесты), `placement` = `below | floating` (по умолчанию `below`), `className`.

Анатомия: обёртка `.wrap` с `display: inline-flex; flex-direction: column; align-items: flex-start; gap: var(--s-2)` (8px), `max-width: 100%`. Сверху кнопка-триггер, под ней полоска `.strip`: `display: flex; align-items: center; gap: var(--s-2) var(--s-4)` (8px 16px), `flex-wrap: wrap`, `padding: 10px 12px 10px 14px`. В полоске вопрос `p` и блок кнопок (`display: flex; align-items: center; gap: var(--s-2)`): `Button primary sm` с `confirmLabel` и `Button quiet sm` с `cancelLabel`.

Типографика: вопрос `--fs-ui` (14px), цвет `--ink`, `max-width: 52ch`.

Поверхность полоски: фон `--raised` (`#141519` / `#FBFBFC`), радиус `--r-block` (14px), кольцо `0 0 0 1px var(--line-2)`.

`placement="floating"` (верхняя панель): обёртка `position: relative`, полоска `position: absolute; top: calc(100% + 8px); right: 0; z-index: var(--z-dialog)` (40), `width: max-content`, `max-width: min(340px, calc(100vw - 2 * var(--gutter)))`, тень `0 0 0 1px var(--line-2), var(--shadow-drop)`. При `below` полоска сдвигает содержимое вниз.

Состояния и поведение:

- открытие: клик по триггеру переключает полоску; фокус сразу уходит на кнопку подтверждения. В управляемом режиме фокус тоже уходит на неё.
- отмена: кнопка отмены или Escape внутри полоски закрывают её и возвращают фокус на триггер. Escape не всплывает выше (`stopPropagation`).
- ожидание: пока `onConfirm` выполняется, обе кнопки `disabled`, у подтверждения `aria-busy`. После успеха полоска закрывается. Если `onConfirm` бросает ошибку, полоска остаётся открытой, кнопки снова доступны.

Движение: `animation: actum-fade var(--dur-base) var(--ease)` (opacity от 0, 220ms).

Адаптивность: ширина плавающей полоски ограничена окном минус два `--gutter`.

Доступность: у триггера `aria-expanded` и `aria-controls` (id полоски, пока она открыта). Полоска `role="group"`, `aria-label` равен вопросу, если вопрос строка.

Пример из галереи (uk): триггер «Скасувати завдання», вопрос «Виконавець побачить, що завдання скасовано. Скасувати?», «Так, скасувати», «Залишити».

```css
.wrap { display: inline-flex; flex-direction: column; align-items: flex-start; gap: var(--s-2); max-width: 100%; }
.strip {
  display: flex; align-items: center; gap: var(--s-2) var(--s-4); flex-wrap: wrap;
  padding: 10px 12px 10px 14px; border-radius: var(--r-block);
  background: var(--raised); box-shadow: 0 0 0 1px var(--line-2);
  animation: actum-fade var(--dur-base) var(--ease);
}
.question { font-size: var(--fs-ui); color: var(--ink); max-width: 52ch; }
.actions { display: flex; align-items: center; gap: var(--s-2); }
.floating { position: relative; }
.floating .strip {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: var(--z-dialog);
  width: max-content; max-width: min(340px, calc(100vw - 2 * var(--gutter)));
  box-shadow: 0 0 0 1px var(--line-2), var(--shadow-drop);
}
@keyframes actum-fade { from { opacity: 0; } }
```

```html
<div class="wrap">
  <button class="btn ghost" aria-expanded="true" aria-controls="c1">Скасувати завдання</button>
  <div id="c1" class="strip" role="group" aria-label="Виконавець побачить, що завдання скасовано. Скасувати?">
    <p class="question">Виконавець побачить, що завдання скасовано. Скасувати?</p>
    <div class="actions">
      <button class="btn primary sm">Так, скасувати</button>
      <button class="btn quiet sm">Залишити</button>
    </div>
  </div>
</div>
```

### ProgressRing

Источник: `src/components/ui/ProgressRing.tsx`, `src/components/ui/ProgressRing.module.css`.

Кольцо «сколько из пяти пунктов специфікації понятно» и подпись «3 / 5».

Props: `done`, `total` (по умолчанию 5), `label?` (фраза для читалки). `done` зажимается в `0..total`.

Анатомия: `span.meta` с `display: inline-flex; align-items: center; gap: var(--s-2)` (8px), `white-space: nowrap`. Внутри SVG 18×18 (`viewBox="0 0 18 18"`), повёрнутый `rotate(-90deg)`, чтобы дуга начиналась сверху, `flex: none`. Два круга `cx=9 cy=9 r=7`, `fill="none"`, `stroke-width=2`: дорожка цветом `--line-2`, значение цветом `--accent-line` с `stroke-linecap="round"`. `stroke-dasharray` равен 44 (≈ 2π·7), `stroke-dashoffset` = `44 × (1 − done / total)` через CSS-переменную `--offset`. Затем текст «{done} / {total}», где `done` уже зажат в `0..total`.

Типографика: класс `.meta` (13px/1.4, `--ink-3`, цифры в Martian Mono).

Движение: `transition: stroke-dashoffset .9s var(--ease-spring)`, дуга дорисовывается с пружиной.

Доступность: SVG `aria-hidden="true" focusable="false"`. Если есть `label`, видимое «3 / 5» скрыто от читалки (`aria-hidden`), а `label` лежит в `span.vh`. Пример из галереи: «зрозуміло 3 з 5».

```html
<span class="meta ring">
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false" class="svg">
    <circle cx="9" cy="9" r="7" fill="none" stroke="var(--line-2)" stroke-width="2"/>
    <circle class="value" cx="9" cy="9" r="7" fill="none" stroke="var(--accent-line)" stroke-width="2"
            stroke-linecap="round" stroke-dasharray="44" style="--offset: 17.6"/>
  </svg>
  <span aria-hidden="true">3 / 5</span><span class="vh">зрозуміло 3 з 5</span>
</span>
```

```css
.ring { display: inline-flex; align-items: center; gap: var(--s-2); white-space: nowrap; }
.svg { transform: rotate(-90deg); flex: none; }
.value { stroke-dashoffset: var(--offset); transition: stroke-dashoffset .9s var(--ease-spring); }
```

### Skeleton

Источник: `src/components/ui/Skeleton.tsx`, `src/components/ui/Skeleton.module.css`.

Полоски на месте текста, который ещё грузится. Используется, например, в строке специфікації в состоянии `pending`.

Props: `lines`, `widths?: string[]`, `className?`. Ширина полоски берётся из `widths[i]`. Если её нет, все полоски 100%, а последняя 62% (когда полосок больше одной).

Анатомия: обёртка `span` с `display: grid; gap: .55em; padding: .2em 0`. Полоска `span` с `display: block; height: .75em; width: var(--w, 100%); max-width: 100%`. Размеры в `em`, поэтому скелет подстраивается под кегль места, где стоит.

Поверхность: радиус `--r-tag` (6px). Фон из двух слоёв: блик `linear-gradient(90deg, var(--hover) 30%, var(--line-2) 50%, var(--hover) 70%)` размером `300% 100%` поверх сплошного `--hover` (`#1A1C21` / `#F1F2F4`).

Движение: `animation: shimmer 1.6s linear infinite`, блик едет от `background-position: 100% 0` к `0 0`. С `prefers-reduced-motion` остаётся стоящая полоска `--hover` (так задумано по комментарию в коде; по расчёту слой блика стоит в `0 0`, и у правого края, примерно последние 10% ширины, есть слабый переход к `--line-2`, не проверено в браузере).

Доступность: весь скелет `aria-hidden="true"`. `aria-busy="true"` ставит контейнер.

Расхождение со SPEC-DELTA §5.5: там «`actum-breathe`» (мигание прозрачности), в коде бегущий блик `shimmer`.

```css
.wrap { display: grid; gap: .55em; padding: .2em 0; }
.bar {
  display: block; height: .75em; width: var(--w, 100%); max-width: 100%;
  border-radius: var(--r-tag);
  background: linear-gradient(90deg, var(--hover) 30%, var(--line-2) 50%, var(--hover) 70%) 0 0 / 300% 100%, var(--hover);
  animation: shimmer 1.6s linear infinite;
}
@keyframes shimmer { from { background-position: 100% 0, 0 0; } to { background-position: 0 0, 0 0; } }
```

### StatusTrail

Источник: `src/components/ui/StatusTrail.tsx`, `src/components/ui/StatusTrail.module.css`.

Дорожка статуса задачи из трёх шагов: «прийнято» → «в роботі» → «готово». Для закрытых задач последний шаг заменяется на «відхилено» или «скасовано». На русском: «принято», «в работе», «готово», «отклонено», «отменено».

Props: `status` (`new | in_progress | done | rejected | cancelled`), `lang`, `animate?`, `className?`.

Какие шаги достигнуты:

| Статус | Шаг 1 | Шаг 2 | Шаг 3 | Текущий (`aria-current="step"`) |
|---|---|---|---|---|
| `new` | да | нет | нет («готово») | шаг 1 |
| `in_progress` | да | да | нет | шаг 2 |
| `done` | да | да | да | шаг 3 |
| `rejected` / `cancelled` | да | нет | да, закрыт («відхилено» / «скасовано») | шаг 3 |

Анатомия: `ol.meta` с `display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 0; padding: 0; list-style: none`. Шаг `li` с `display: flex; align-items: center; gap: var(--s-2)` (8px): точка `i`, затем текст. Между шагами черта: `.step + .step::before` шириной 36px, высотой 1px, фон `--line-2`, `margin-right: 2px`.

Точка: 7×7px, круг, `flex: none`, фон `--ink-3`. Достигнутый шаг: текст `--ink-2`, точка `--accent-solid` (`#C9B8FF` / `#7E62E0`) с кольцом `box-shadow: 0 0 0 3px var(--accent-wash)`. Закрытый шаг (`data-closed`): точка `--ink-2` без кольца.

Типографика: класс `.meta` (13px/1.4, `--ink-3` у недостигнутых шагов).

Движение (`animate`, карточка «прийнято»): достигнутые точки заливаются по очереди, `animation: fill .5s var(--ease) .9s both`, у второй задержка 1.1s, у третьей 1.3s. Кадр `fill` стартует с `background: var(--ink-3); box-shadow: 0 0 0 0 transparent`.

Доступность: `ol` с `aria-label` «Стан завдання» (ru «Состояние задачи»), текущий шаг `aria-current="step"`, точки `aria-hidden`.

Расхождение со SPEC-DELTA §5.5: там цвет точки `--accent`, в коде `--accent-solid` (в светлой теме бледный `--accent` почти не виден на белом).

```css
.trail { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; }
.step { display: flex; align-items: center; gap: var(--s-2); }
.step + .step::before { content: ""; width: 36px; height: 1px; background: var(--line-2); margin-right: 2px; }
.dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--ink-3); }
.step[data-reached] { color: var(--ink-2); }
.step[data-reached] .dot { background: var(--accent-solid); box-shadow: 0 0 0 3px var(--accent-wash); }
.step[data-closed] .dot { background: var(--ink-2); box-shadow: none; }
.trail[data-animate] .step[data-reached] .dot { animation: fill .5s var(--ease) .9s both; }
.trail[data-animate] .step[data-reached] + .step[data-reached] .dot { animation-delay: 1.1s; }
.trail[data-animate] .step[data-reached] + .step[data-reached] + .step[data-reached] .dot { animation-delay: 1.3s; }
@keyframes fill { from { background: var(--ink-3); box-shadow: 0 0 0 0 transparent; } }
```

```html
<ol class="meta trail" aria-label="Стан завдання">
  <li class="step" data-reached><i class="dot" aria-hidden="true"></i>прийнято</li>
  <li class="step" data-reached aria-current="step"><i class="dot" aria-hidden="true"></i>в роботі</li>
  <li class="step"><i class="dot" aria-hidden="true"></i>готово</li>
</ol>
```

### Toasts

Источник: `src/components/ui/Toasts.tsx`, `src/components/ui/Toasts.module.css`.

Короткие уведомления только для того, у чего нет места на странице: сохранено, скопировано, устарело, занято, сеть.

API: `ToastProvider` (prop `closeLabel`, uk «Закрити», ru «Закрыть») оборачивает приложение. `useToast()` даёт `show(text, { tone })` и `dismiss(id)`. `tone` = `info | error` (по умолчанию `info`). `ToastPreview` рисует один тост статично, для галереи.

Поведение:

- на экране не больше 2 тостов; новый вытесняет самый старый.
- тост живёт 5000ms.
- наведение мыши или фокус внутри тоста ставят таймер на паузу; после паузы тост доживает остаток, но не меньше 800ms.
- кнопка закрытия убирает тост сразу.

Анатомия: контейнер `.viewport` фиксирован в левом нижнем углу: `position: fixed; left: var(--gutter); bottom: var(--gutter); z-index: var(--z-toast)` (50), `display: flex; flex-direction: column; gap: var(--s-2)` (8px), `width: min(420px, calc(100vw - 2 * var(--gutter)))`, `pointer-events: none`. Тост: `display: flex; align-items: center; gap: var(--s-3)` (12px), `pointer-events: auto`, `padding: 10px 10px 10px 16px`. Текст `p` с `flex: 1; min-width: 0`. Справа текстовая кнопка закрытия.

Типографика: текст `--fs-ui` (14px), цвет `--ink`. Кнопка закрытия `--fs-small` (13.5px), цвет `--ink-3`.

Поверхность: фон `--raised` (`#141519` / `#FBFBFC`), радиус `--r-block` (14px), тень `--shadow`. Ошибка: слева красная полоса 3px, `box-shadow: inset 3px 0 0 var(--danger), var(--shadow)`.

Кнопка закрытия: `border: 0; background: none; padding: 6px 8px; border-radius: var(--r-inner)` (8px), `flex: none`. Hover: цвет `--ink`, фон `--hover`.

Движение: `animation: toast-in 420ms var(--ease-pop) both`, от `opacity: 0; transform: translateY(14px) scale(.98)`. Статичный превью (`data-static`) без анимации и с `max-width: 420px`.

Адаптивность: ширина и отступы завязаны на `--gutter` (24px, при `max-width: 640px` 16px). На сенсорном экране кнопка закрытия, как любая `button`, получает `min-height: 44px` из `base.css`.

Доступность: контейнер есть с первой отрисовки, `aria-live="polite" aria-relevant="additions"`, поэтому первый тост тоже озвучивается. Тост-ошибка дополнительно `role="alert"`.

Примеры: «Номер скопійовано: № 0148», ошибка «Не вдалося зберегти. Перевір з’єднання і спробуй ще раз.»; у владельца «Сохранено», ошибка «Не получилось сохранить. Проверьте соединение.»

```css
.viewport {
  position: fixed; left: var(--gutter); bottom: var(--gutter); z-index: var(--z-toast);
  display: flex; flex-direction: column; gap: var(--s-2); width: min(420px, calc(100vw - 2 * var(--gutter)));
  pointer-events: none;
}
.toast {
  display: flex; align-items: center; gap: var(--s-3); pointer-events: auto;
  padding: 10px 10px 10px 16px; border-radius: var(--r-block);
  background: var(--raised); box-shadow: var(--shadow); color: var(--ink); font-size: var(--fs-ui);
  animation: toast-in 420ms var(--ease-pop) both;
}
.toast[data-tone="error"] { box-shadow: inset 3px 0 0 var(--danger), var(--shadow); }
.text { flex: 1; min-width: 0; }
.close {
  flex: none; border: 0; background: none; color: var(--ink-3); font-size: var(--fs-small);
  padding: 6px 8px; border-radius: var(--r-inner);
}
.close:hover { color: var(--ink); background: var(--hover); }
@keyframes toast-in { from { opacity: 0; transform: translateY(14px) scale(.98); } }
```

```html
<div class="viewport" aria-live="polite" aria-relevant="additions">
  <div class="toast" data-tone="error" role="alert">
    <p class="text">Не вдалося зберегти. Перевір з’єднання і спробуй ще раз.</p>
    <button type="button" class="close">Закрити</button>
  </div>
</div>
```

### AgentChip

Источник: `src/components/ui/AgentChip.tsx`, `src/components/ui/AgentChip.module.css`.

Метка агента: цветная точка и имя. Стоит в строке входящих, в шапке плана агента, в панели агента задачи (`AgentPanel`) и в списке раннеров на странице «Агенты» (`src/app/admin/(panel)/agents/page.tsx`).

Props: `name: string | null`, `state` = `idle | live | done | attention`, `stateLabel?` (для читалки), `children?` (заменяет имя, например «Агент Документы»). Если нет ни имени, ни детей, вместо чипа выводится мета «—».

Анатомия: `span` с `display: inline-flex; align-items: center; gap: 7px; max-width: 100%`, `padding: 3px 9px 3px 7px`. Точка 7×7px, круг, `flex: none`. Имя `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`.

Типографика: `--fs-chip` (12.5px), `line-height: 1.4`, цвет `--ink-2`.

Поверхность: фона нет, кольцо `box-shadow: 0 0 0 1px var(--line-2)`, радиус 7px (число в модуле; комментарий в `tokens.css` относит чип к `--r-tag` 6px, но код ставит 7px).

Состояния точки:

| `state` | Цвет точки | Анимация |
|---|---|---|
| `idle` | `--ink-3` | нет |
| `live` | `--accent-solid` | `actum-pulse 1.6s infinite` |
| `done` | `--accent-solid` | нет |
| `attention` | `--ask` (`#FFB45C` / `#B45309`) | нет |

Движение: `actum-pulse` расходит от точки кольцо: `0% { box-shadow: 0 0 0 0 var(--accent-line) } 50%, 100% { box-shadow: 0 0 0 5px transparent }`.

Доступность: точка `aria-hidden`. `stateLabel` добавляется скрытым текстом «, {stateLabel}», чтобы цвет не был единственным сигналом. Примеры: «работает», «требует внимания».

```css
.chip {
  display: inline-flex; align-items: center; gap: 7px; max-width: 100%;
  font-size: var(--fs-chip); line-height: 1.4; color: var(--ink-2);
  padding: 3px 9px 3px 7px; border-radius: 7px; box-shadow: 0 0 0 1px var(--line-2);
}
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--ink-3); }
.chip[data-state="live"] .dot { background: var(--accent-solid); animation: actum-pulse 1.6s infinite; }
.chip[data-state="done"] .dot { background: var(--accent-solid); }
.chip[data-state="attention"] .dot { background: var(--ask); }
@keyframes actum-pulse { 0% { box-shadow: 0 0 0 0 var(--accent-line); } 50%, 100% { box-shadow: 0 0 0 5px transparent; } }
```

### Иконки

Источник: `src/components/ui/Icons.tsx`, `src/components/media/icons.tsx`.

Иконки продукта лежат в двух файлах: общие в `ui/Icons.tsx`, иконки просмотра и плиток файлов в `media/icons.tsx`. Наборов иконок нет. Линии 1.5px цветом `currentColor`, декоративные по умолчанию. Где и каким размером стоит каждая иконка, см. раздел «Логотип и иконки» → «Иконки интерфейса»; здесь фигуры для перерисовки.

Общая обёртка: `svg` размера `size` (по умолчанию 16), `viewBox="0 0 16 16"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, `aria-hidden="true"`, `focusable="false"`.

| Иконка | Где | Фигуры |
|---|---|---|
| `AttachIcon` | слой при перетаскивании файлов на страницу (`src/components/intake/FileDrop.tsx`, `size={22}`); у кнопки «+ файл» иконки нет | `path d="M10.5 4.5 5.4 9.6a1.6 1.6 0 0 0 2.3 2.3l5.3-5.3a3 3 0 0 0-4.2-4.2L3.5 7.7a4.3 4.3 0 0 0 6.1 6.1l4-4"` |
| `CheckIcon` | выполненный шаг в «Вход по коду» | `path d="m3.5 8.5 3 3 6-7"` |
| `CopyIcon` | кнопки копирования (`CopyButton`) | `rect x="5.5" y="5.5" width="8" height="8" rx="1.8"` и `path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.2"` |
| `ExternalIcon` | внешние ссылки (`Admin2fa`, `TelegramConnectView`) | `path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V5.5A1.5 1.5 0 0 1 4 4h2.5"` |
| `SearchIcon` | поиск в палитре команд (`CommandBar`) | `circle cx="7" cy="7" r="4.5"` и `path d="m10.4 10.4 3.1 3.1"` |
| `CloseIcon` (`media/icons.tsx`) | закрыть Lightbox, «Прибрати» файл | `path d="m4 4 8 8M12 4l-8 8"` |
| `PlusIcon` | масштаб «+» в Lightbox | `path d="M8 3.5v9M3.5 8h9"` |
| `MinusIcon` | масштаб «−» в Lightbox | `path d="M3.5 8h9"` |
| `DownloadIcon` | «Скачати» в Lightbox и в галерее вложений | `path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10"` |
| `ChevronIcon` | листание в Lightbox | влево `path d="M10 3.5 5.5 8l4.5 4.5"`, вправо `path d="m6 3.5 4.5 4.5L6 12.5"` |
| `RetryIcon` | «Повторити» загрузку файла | `path d="M12.8 6.2A5 5 0 1 0 13 9.5M13 3v3.4H9.6"` |
| `DocIcon` | плитка документа, строка документа в галерее | `path d="M9.5 1.8H4.6A1.6 1.6 0 0 0 3 3.4v9.2a1.6 1.6 0 0 0 1.6 1.6h6.8a1.6 1.6 0 0 0 1.6-1.6V5.3z"` и `path d="M9.5 1.8v3.5H13"` (тип «PDF» стоит рядом текстом) |

### LiveRegion

Описание: см. раздел «Фокус и доступность» → «Одна live-область на страницу».

### Мелкие элементы

Описание: см. разделы «Типографика» → «Глобальные помощники» (`.meta`, `.meta-prose`, `.num`, `kbd`), «Фокус и доступность» → «Кольцо фокуса», «Skip-ссылка», «Скрытый текст, выделение, плейсхолдер» и «Отступы, радиусы, раскладка, слои» → «Цели касания».

### Галерея `/kit`

Источник: `src/app/(dev)/kit/page.tsx`, `src/app/(dev)/kit/layout.tsx`, `src/app/(dev)/kit/_kit/Gallery.tsx`, `src/app/(dev)/kit/_kit/kit.module.css`, `src/app/(dev)/kit/_kit/MotionDemos.tsx`, `src/app/(dev)/kit/_kit/fixtures.ts`.

Для чего: страница разработчика, где каждый компонент показан в каждом состоянии с настоящими украинскими и русскими текстами. В production отдаёт 404. Повторять её не обязательно, но она удобна как эталон для сверки и снимков.

Корневая разметка своя: `<html lang="uk" data-theme={theme}>`, `CursorLight` в конце `body`, иконок в metadata нет, заголовок вкладки «{BRAND.name}: UI kit». Параметр `?theme=light|dark|system` ставит `data-theme` на `<html>` без записи куки (для снимков). Вся страница обёрнута в `CopyProvider`, `ToastProvider` и `AnnouncerProvider`.

Анатомия сверху вниз:

- Два живых макета экранов, каждый в обёртке `.screen` с нижней линией `1px solid var(--line)`:
  - экран коллеги: `TopBar view="colleague"`, затем `.colleague` с той же сеткой, что у «/»: `max-width: var(--page-colleague)` (1180px), `padding: 40px var(--gutter) 90px`, `grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr)`, `gap: var(--s-7)` (28px); при `max-width: 980px` одна колонка;
  - экран владельца: `TopBar view="owner"`, затем `.owner`: `max-width: var(--page-owner)` (1280px), `padding: 8px var(--gutter) 60px`, `grid-template-columns: minmax(0, 1fr) minmax(0, var(--side-w))` (460px), `gap: var(--s-5)` (20px); при `max-width: 1060px` одна колонка. Строка поиска `CommandBar` стоит в `.span` (`grid-column: 1 / -1`, `margin-top: 0`). У коллеги в такой же `.span` под редактором и спецификацией стоит `AcceptedCard` (`margin-top: var(--s-2)`).
- Каталог `main#main.catalogue`: `max-width: var(--page-owner)`, `padding: 56px var(--gutter) 120px`.
  - Шапка `.head` (`margin-bottom: var(--s-8)`, 40px): h1 «Набір компонентів» `500 40px/1.05 var(--ff-display)`, `letter-spacing: -0.04em`; лид `.lead` `--ink-2`, `max-width: 60ch`, `margin-top: var(--s-3)`.
  - Разделы `.section` (`margin-top: var(--s-9)`, 56px; это единственное место, где стоит `--s-9`): «Основи», «Кнопки», «Примітиви», «Прийом завдання», «Рух», «Кабінет власника». Шапка раздела `.sectionHead`: `display: flex; align-items: baseline; gap: var(--s-4); flex-wrap: wrap; margin-bottom: var(--s-5); padding-bottom: var(--s-3); border-bottom: 1px solid var(--line)`, h2 `500 var(--fs-h2)/var(--lh-h2) var(--ff-display)` (24px/1.15), `letter-spacing: var(--tr-h2)`, рядом пояснение в `.meta` (у «Рух» в `.meta-prose`).
  - Сетка демо `.grid`: `repeat(auto-fill, minmax(min(100%, 420px), 1fr))`, `gap: var(--s-6) var(--s-5)` (24px 20px), `align-items: start`. Демо `figure.demo` (`display: grid; gap: var(--s-2)`): подпись `figcaption.meta` (в «Рух» рядом кнопка `pill sm` «Повторити»), под ней `.stage`. `.wide` растягивает демо на всю ширину.
- Помощники раскладки: `.row` (`flex; flex-wrap: wrap; gap: var(--s-3); align-items: center`), `.stack` (`grid; gap: var(--s-3); justify-items: start`), `.rowEnd` (`flex; justify-content: flex-end; padding-bottom: 130px`: место под всплывающее подтверждение PersonMenu), `.pad` (`padding: 16px 18px`), `.small` (`--fs-ui`, `--ink-2`), `.gap` (`margin-left: 1.25em`).
- Образцы цвета `.swatches`: `repeat(auto-fill, minmax(130px, 1fr))`, `gap: var(--s-3)`. Плашка 44px высотой, радиус `--r-chip`, кольцо `0 0 0 1px var(--line-2)`, под ней имя токена `code.meta`. Показаны `--bg`, `--surface`, `--raised`, `--hover`, `--line-2`, `--ink`, `--ink-2`, `--ink-3`, `--accent`, `--accent-solid`, `--accent-text`, `--accent-wash`, `--ask`, `--danger`.
- Образцы шрифта `.type` (`grid; gap: var(--s-3)`): `.typeH1` / `.typeH2` / `.typeH3` повторяют шкалу `--fs-h1`…`--fs-h3`, затем строка текста, строка `.meta` с цифрами («№ 0148 сьогодні 14:32, перевірено за 6 с, ≈ $0.18, 75%») и четыре `kbd`.
- Поле плана в демо карточки задачи `.textarea`: `border: 0; border-radius: var(--r-chip); padding: 8px 11px; resize: vertical`, фон `--surface`, кольцо `0 0 0 1px var(--line-2)`, `--fs-ui`, `line-height: 1.5`.

```css
.catalogue { max-width: var(--page-owner); margin: 0 auto; padding: 56px var(--gutter) 120px; }
.section { margin-top: var(--s-9); }
.sectionHead {
  display: flex; align-items: baseline; gap: var(--s-4); flex-wrap: wrap;
  margin-bottom: var(--s-5); padding-bottom: var(--s-3); border-bottom: 1px solid var(--line);
}
.h2 { font: 500 var(--fs-h2)/var(--lh-h2) var(--ff-display); letter-spacing: var(--tr-h2); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: var(--s-6) var(--s-5); align-items: start; }
.demo { margin: 0; min-width: 0; display: grid; gap: var(--s-2); }
.wide { grid-column: 1 / -1; }
.swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: var(--s-3); }
.swatch { display: grid; gap: 6px; }
.swatch span { height: 44px; border-radius: var(--r-chip); box-shadow: 0 0 0 1px var(--line-2); }
```

Раздел «Рух» описан в «Движение» → «Замысел (галерея `/kit`, раздел «Рух»)».

## Формы и поля

Формы владельца берут стили из одного модуля `src/app/admin/_ui/forms.module.css` (в коде импортируется как `f`). Его используют: `src/app/admin/login/LoginForm.tsx`, `settings/page.tsx`, `settings/_components/SettingsControls.tsx` и `Admin2fa.tsx`, `people/_components/NewPersonForm.tsx`, `PersonFields.tsx`, `PersonControls.tsx`, `InviteSlip.tsx`, `LinkActions.tsx`, `standard/_components/StandardWorkspace.tsx`, `inbox/_components/ReplyBox.tsx`, `AgentPanel.tsx`, `RunPanel.tsx`, `agents/_components/AgentsControls.tsx` (все пути внутри `src/app/admin/(panel)/`, кроме входа).

У коллеги общего модуля форм нет. Страница `/enter` повторяет те же правила в своём `enter.module.css`. Поля внутри приёма задачи (редактор строки специфікації, варианты ответа, большой композер) имеют свои модули. Они собраны в конце раздела.

Своего переключателя-тумблера в продукте нет. Включить и выключить что-то можно нативным чекбоксом. Сегментные переключатели темы и языка сделаны как группа радиокнопок.

### Раскладка формы

Источник: `src/app/admin/_ui/forms.module.css`, `src/app/admin/(panel)/_components/shell.module.css`, `src/app/admin/(panel)/settings/_components/settings.module.css`.

| Класс | Правило | Для чего |
|---|---|---|
| `.form` | `display: grid; gap: var(--s-4)` (16px), `min-width: 0` | вся форма: поля, затем строка действий |
| `.grid2` | `grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4)` | два поля в ряд (в TSX сейчас не используется) |
| `.grid3` | `grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-3) var(--s-4)` (12px 16px) | три коротких поля: «Как обращаться», «Полное имя», «Отдел» у человека; падежи имени владельца «Кто?», «Кого?», «Кому?» в настройках |
| `.row` | `display: flex; gap: var(--s-3); flex-wrap: wrap; align-items: flex-end` | поле и кнопка в одну строку: «Название» токена раннера и `primary` «Создать токен» |
| `.grow` | `flex: 1 1 240px` | поле, которое тянется в `.row` |
| `.actions` | `display: flex; gap: var(--s-2) var(--s-3)` (8px 12px), `flex-wrap: wrap; align-items: center` | кнопки и строка ошибки после них |

Адаптивность: `.grid2` и `.grid3` становятся одной колонкой при `@media (max-width: 640px)` и при `@container (max-width: 30rem)`. Контейнер задаёт боковая колонка админки: `.sideCol { container-type: inline-size; }` в `shell.module.css`. Так форма в узкой колонке складывается как на телефоне.

Группа полей с подписью (настройки: «Лимит на человека», группы имени «По-украински», «По-русски», «По-английски»): `fieldset.group` с `border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: var(--s-3)`. `legend`: `padding: 0; margin-bottom: 8px; font-size: var(--fs-ui); font-weight: 500`. Внутри `.limits` с `display: flex; flex-wrap: wrap; gap: var(--s-4)` и два числовых поля «в час» и «в день».

### Поле: подпись, подсказка, ошибка

Источник: `src/app/admin/_ui/forms.module.css`; пример разметки `src/app/admin/(panel)/people/_components/PersonFields.tsx`.

Анатомия: `.field` с `display: grid; gap: 6px; min-width: 0; align-content: start`. Порядок сверху вниз: подпись, поле, подсказки, ошибка.

| Класс | Шрифт | Цвет |
|---|---|---|
| `.label` | `--fs-ui` (14px), 500, шрифт тела | `--ink` |
| `.label .opt` | 400, `margin-left: .5em` | `--ink-3` (пометка необязательного поля; в TSX использования не нашёл) |
| `.hint` | `400 var(--fs-meta)/var(--lh-meta) var(--ff-text)` (13px/1.4, Fixel целиком) | `--ink-3` |
| `.error` | то же | `--danger` (`#FF7A7A` / `#B42318`) |
| `.ok` | то же | `--ink-2` (положительное сообщение, например «Новый код отправлен, прежний больше не действует.») |

Доступность: у подписи `htmlFor` на id поля. Id подсказки и ошибки перечислены в `aria-describedby` поля. При ошибке у поля `aria-invalid="true"`, без ошибки атрибута нет. Строка ошибки чаще всего `role="alert"`. На входе абзац ошибки с `role="alert"` есть всегда (пустой, пока сообщения нет), поэтому текст объявляется, когда появляется.

Примеры (ru): подпись «Как обращаться», плейсхолдер «Аня»; «Полное имя» и «Анна Ковальова»; «Отдел» и «маркетинг». Ошибки: «Заполните это поле.», «Слишком длинно.», «Проверьте значения в форме.». Подсказка у языка: «Подставится при входе по ссылке. Потом коллега может сменить его сам.»

```html
<div class="field">
  <label for="p-name" class="label">Как обращаться</label>
  <input id="p-name" name="name" class="input" placeholder="Аня" maxlength="60" required
         aria-invalid="true" aria-describedby="p-name-err">
  <p id="p-name-err" class="error">Заполните это поле.</p>
</div>
```

### Текстовое поле, textarea и select

Источник: `src/app/admin/_ui/forms.module.css`.

У трёх контролов общая база: `width: 100%; min-width: 0; border: 0; margin: 0`, радиус `--r-chip` (9px), фон `--raised` (`#141519` / `#FBFBFC`), цвет `--ink`, вместо рамки кольцо `box-shadow: 0 0 0 1px var(--line-2)`, `padding: 9px 12px`, `font-size: var(--fs-ui)` (14px), `line-height: 1.45`. Плейсхолдер `--ink-3` (глобально).

Модификаторы:

- `.textarea`: `resize: vertical; min-height: 88px`.
- `.tall`: `min-height: 160px` (длинный текст в редакторе стандарта: «Вступление», «Хороший пример», «Текст задачи» в песочнице).
- `.select`: `appearance: none; padding-right: 32px; cursor: pointer`. Стрелка нарисована двумя градиентами цвета `--ink-3`, это треугольники 5×5px, вместе они дают галочку вниз. Позиции `calc(100% - 17px) 50%` и `calc(100% - 12px) 50%`.
- `.mono`: `font-family: var(--ff-mono); font-size: 13px; letter-spacing: -0.01em`. Для токенов, ссылок-приглашений, id чатов.
- `.num`: `width: 9rem`. Для `type="number"` (лимиты).

Состояния:

| Состояние | Селектор | Что меняется |
|---|---|---|
| обычное | | кольцо 1px `--line-2` |
| hover | `:hover` | кольцо `0 0 0 1px var(--ink-3)` |
| фокус | `:focus-visible` | `outline: 2px solid var(--accent-line); outline-offset: 1px` (на 1px ближе, чем у кнопок); кольцо остаётся; анимация `actum-focus` из глобального правила |
| ошибка | `[aria-invalid="true"]`, только `.input` и `.textarea` | кольцо `0 0 0 1px var(--danger)`. Правило стоит ниже hover при той же специфичности, поэтому красное кольцо остаётся и при наведении. У `.select` стиля ошибки нет |
| выключено | `:disabled` | `opacity: .55; cursor: not-allowed` (у кнопок .45) |
| только чтение | `[readonly]`, `.input` и `.textarea` | фон `--surface` (`#0E0F12` / `#FFFFFF`), поле выглядит «плоским» |
| сенсорный экран | `@media (pointer: coarse)` | `.input` и `.select` `min-height: 44px` (у `.textarea` нет) |

Движение: `transition: box-shadow var(--dur-fast), background-color var(--dur-fast)` (150ms).

```css
.input,
.textarea,
.select {
  width: 100%; min-width: 0; border: 0; margin: 0;
  border-radius: var(--r-chip); background: var(--raised); color: var(--ink);
  box-shadow: 0 0 0 1px var(--line-2);
  padding: 9px 12px; font-size: var(--fs-ui); line-height: 1.45;
  transition: box-shadow var(--dur-fast), background-color var(--dur-fast);
}
.input:hover, .textarea:hover, .select:hover { box-shadow: 0 0 0 1px var(--ink-3); }
.input:focus-visible, .textarea:focus-visible, .select:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 1px; }
.input[aria-invalid="true"], .textarea[aria-invalid="true"] { box-shadow: 0 0 0 1px var(--danger); }
.input:disabled, .textarea:disabled, .select:disabled { opacity: .55; cursor: not-allowed; }
.input[readonly], .textarea[readonly] { background: var(--surface); }
.textarea { resize: vertical; min-height: 88px; }
.tall { min-height: 160px; }
.select { appearance: none; padding-right: 32px; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--ink-3) 50%), linear-gradient(135deg, var(--ink-3) 50%, transparent 50%);
  background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%;
  background-size: 5px 5px; background-repeat: no-repeat;
}
.mono { font-family: var(--ff-mono); font-size: 13px; letter-spacing: -0.01em; }
.num { width: 9rem; }
@media (pointer: coarse) { .input, .select { min-height: 44px; } }
```

Select рядом с подписью в строку (`src/app/admin/(panel)/standard/_components/standard.module.css`, подпись «к полю»): `label.fieldSelect` с `display: inline-flex; align-items: center; gap: 8px`, подпись `span` с глобальным классом `meta`, у `select` `width: auto; min-width: 11rem` (`.fieldSelect select` сильнее `.select`). В модуле есть `.fieldSelect .meta { white-space: nowrap; }`, но CSS Modules делают этот `.meta` локальным, а в TSX стоит глобальный `meta`, поэтому правило, судя по коду, не срабатывает (не проверено в браузере). Задумано, что подпись не переносится.

### Чекбокс

Источник: `src/app/admin/_ui/forms.module.css`; разметка в `src/app/admin/(panel)/settings/page.tsx` (`Check`), `SettingsControls.tsx`, `AgentsControls.tsx` (`PauseToggle`), `PersonControls.tsx`, `AgentPanel.tsx`.

Нативный чекбокс внутри подписи, рядом текст и необязательная подсказка. Заменяет и галочку, и тумблер.

Анатомия: `label.check` с `display: flex; gap: 10px; align-items: flex-start`, `font-size: var(--fs-ui)` (14px), цвет `--ink`, `cursor: pointer`. Чекбокс: `flex: none; width: 16px; height: 16px; margin: 3px 0 0` (выровнен по первой строке текста), `accent-color: var(--accent-solid)` (`#C9B8FF` / `#7E62E0`), `cursor: pointer`. Текст в `span`. Подсказка `span.hint` внутри него становится блоком: `display: block; margin-top: 2px`.

Состояния: отмеченный и выключенный рисует браузер (цвет галочки задаёт `accent-color`). Отдельного стиля для выключенной подписи в CSS нет.

Два режима поведения:

- в форме: значение уходит вместе с кнопкой «Сохранить» (`Check` в настройках, «Удалить сохранённый токен»).
- сразу сохраняет (тумблеры Telegram в настройках, пауза раннера, автозапуск у человека): галочка меняется сразу, на время сохранения чекбокс `disabled`. При ошибке галочка возвращается назад и показывается тост-ошибка «Не получилось сохранить. Проверьте соединение.». При успехе тост «Сохранено» (у паузы раннера свой текст про паузу или возобновление).

Пример (ru): «Разбирать задачи с помощью Claude», подсказка «Если выключить, задачи будут приходить с пометкой «не проверено».»

```css
.check { display: flex; gap: 10px; align-items: flex-start; font-size: var(--fs-ui); color: var(--ink); cursor: pointer; }
.check input { flex: none; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--accent-solid); cursor: pointer; }
.check .hint { display: block; margin-top: 2px; }
```

```html
<label class="check">
  <input type="checkbox" name="intakeAiEnabled" checked>
  <span>Разбирать задачи с помощью Claude
    <span class="hint">Если выключить, задачи будут приходить с пометкой «не проверено».</span>
  </span>
</label>
```

### Радио-чипы

Источник: `src/app/admin/_ui/forms.module.css`; разметка в `src/app/admin/(panel)/settings/page.tsx` (обращение) и `src/app/admin/(panel)/standard/_components/StandardWorkspace.tsx` (строгость, «обязательно / желательно»).

Выбор одного из нескольких вариантов. Выглядит как чипы вариантов ответа у коллеги, но работает на нативных `input type="radio"`.

Анатомия: `fieldset.choices` с `display: flex; flex-wrap: wrap; gap: 6px; border: 0; padding: 0; margin: 0; min-width: 0`. `legend`: `padding: 0; margin-bottom: 6px; font-size: var(--fs-ui); font-weight: 500` (во всех текущих местах легенда скрыта классом `.vh`: у «Обращение к коллегам» и «Строгость» имя уже стоит в заголовке раздела, у «обязательно / желательно» легенда «Пункт {n}»). Вариант `label.choice` (`position: relative; display: inline-flex`). Радиокнопка лежит поверх всего чипа невидимой: `position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer`. Видимая часть `span`: `display: inline-flex; align-items: center; gap: 8px; padding: 6px 11px`. Внутри `small` для пояснения.

Типографика: текст `--fs-small` (13.5px), цвет `--ink-2`. `small` `--fs-meta` (13px), цвет `--ink-3`.

Поверхность: фон `--raised`, радиус `--r-chip` (9px), кольцо `0 0 0 1px var(--line-2)`.

Состояния:

- выбран (`input:checked + span`): кольцо `0 0 0 1.5px var(--ink)`, цвет текста `--ink`. Фон не меняется.
- фокус (`input:focus-visible + span`): `outline: 2px solid var(--accent-line); outline-offset: 2px` на видимом чипе.
- hover и disabled: отдельных правил нет.

Движение: `transition: box-shadow var(--dur-fast), color var(--dur-fast)`.

Доступность: нативная группа радиокнопок. Tab заходит в группу, стрелки переключают вариант.

Примеры (ru): «на «ти»» с пояснением «Опиши завдання своїми словами» (`small lang="uk"`); строгость «мягкая», «обычная», «строгая» с пояснениями «только явные пропуски», «все обязательные пункты», «каждый пункт».

```css
.choices { display: flex; flex-wrap: wrap; gap: 6px; border: 0; padding: 0; margin: 0; min-width: 0; }
.choices legend { padding: 0; margin-bottom: 6px; font-size: var(--fs-ui); font-weight: 500; }
.choice { position: relative; display: inline-flex; }
.choice input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.choice span {
  display: inline-flex; align-items: center; gap: 8px; padding: 6px 11px; border-radius: var(--r-chip);
  background: var(--raised); box-shadow: 0 0 0 1px var(--line-2); color: var(--ink-2); font-size: var(--fs-small);
  transition: box-shadow var(--dur-fast), color var(--dur-fast);
}
.choice input:checked + span { box-shadow: 0 0 0 1.5px var(--ink); color: var(--ink); }
.choice input:focus-visible + span { outline: 2px solid var(--accent-line); outline-offset: 2px; }
.choice small { color: var(--ink-3); font-size: var(--fs-meta); }
```

```html
<fieldset class="choices">
  <legend class="vh">Строгость</legend>
  <label class="choice">
    <input type="radio" name="strictness" checked>
    <span>обычная <small>все обязательные пункты</small></span>
  </label>
  <label class="choice">
    <input type="radio" name="strictness">
    <span>строгая <small>каждый пункт</small></span>
  </label>
</fieldset>
```

### Поле с кнопкой копирования

Источник: `src/app/admin/_ui/forms.module.css` (`.copyRow`); `src/app/admin/(panel)/people/_components/InviteSlip.tsx`, `src/app/admin/(panel)/agents/_components/AgentsControls.tsx`, `src/app/admin/(panel)/_components/CopyButton.tsx`.

Значение, которое владелец копирует и отправляет: ссылка-приглашение, текст сообщения, токен раннера.

Анатомия: `.copyRow` с `display: flex; gap: var(--s-2)` (8px), `align-items: flex-start; flex-wrap: wrap`. Поле внутри тянется: `flex: 1 1 260px`. Поле `readOnly` (фон `--surface`), для ссылок и токенов ещё `.mono`. При фокусе текст выделяется целиком.

Кнопка `CopyButton`. Описание: см. раздел «Компоненты владельца» → «CopyButton и LogoutButton».

```css
.copyRow { display: flex; gap: var(--s-2); align-items: flex-start; flex-wrap: wrap; }
.copyRow .input, .copyRow .textarea { flex: 1 1 260px; }
```

### Поле кода из Telegram

Источник: `src/app/admin/login/login.module.css` и `LoginForm.tsx`, `src/app/admin/(panel)/settings/_components/settings.module.css` и `Admin2fa.tsx`, `src/app/enter/enter.module.css` и `EnterForm.tsx`.

Шесть цифр, которые должны читаться как одно число. Это `.input` с добавкой `.code`: `max-width: 14rem; font-family: var(--ff-mono); font-size: var(--fs-body)` (15px), `letter-spacing: .16em`. Оба класса одной специфичности, 15px побеждает за счёт порядка подключения модулей (не проверено в браузере). В настройках («Вход по коду», `Admin2fa.tsx`) `.code` такой же, но без `font-size` (остаётся 14px от `.input`). На `/enter` у коллеги `.code` написан целиком в `enter.module.css`: база `.input` с теми же значениями плюс `max-width: 14rem`, `--ff-mono`, `--fs-body` (15px), `letter-spacing: .16em`; повторены hover, фокус, ошибка и 44px на сенсорном экране. Правил disabled и readonly там нет.

Атрибуты: `inputMode="numeric"`, `autoComplete="one-time-code"`, `pattern="\d{6}"`, `maxLength={16}` (влезает вставка «123 456» или «123-456», сервер убирает пробелы и дефисы), `spellCheck={false}`.

Поведение входа: под полем подсказка «Код отправлен в Telegram. Он действует 5 минут.», абзац ошибки `role="alert"`. После неудачной попытки фокус возвращается в поле. Кнопки: `primary` «Войти», `quiet` «Отправить ещё раз», `quiet` «Назад к паролю». Пустую отправку форма не пускает и ставит фокус в поле.

### Отправка, ожидание и сохранение

Источник: `src/app/admin/(panel)/settings/_components/SettingsControls.tsx` (`SettingsForm`), `src/app/admin/(panel)/standard/_components/standard.module.css` (`.saveBar`), `src/app/admin/login/LoginForm.tsx`.

Типовая форма раздела настроек:

- `form.form` с `noValidate` (проверяет сервер) и `aria-busy` на время отправки.
- поля, затем `.actions`: `Button primary sm` «Сохранить», `disabled` пока идёт отправка.
- ошибка всей формы справа от кнопки: `p.error role="alert"` «Проверьте значения в форме.».
- успех: тост «Сохранено» и объявление в `LiveRegion` «Сохранено.». Введённые значения не сбрасываются.

Липкая строка сохранения редактора стандарта (`.saveBar`). Описание: см. раздел «Компоненты владельца» → «Полоса сохранения стандарта».

Форма и карточка входа в кабинет. Описание: см. раздел «Экраны владельца» → «Вход».

### Поля вне форм владельца

Эти поля живут в своих модулях. Их полное описание в разделах про приём задачи и про шапку; здесь только отличия от базового поля.

| Поле | Источник | Вид и отличия |
|---|---|---|
| «Доповнити» у коллеги (textarea) | `src/app/(colleague)/_components/mine.module.css` (`.addInput`), `src/app/(colleague)/tasks/[serial]/TaskActions.tsx` | радиус `--r-chip`, фон `--raised`, кольцо 1px `--line-2`, `padding: 10px 12px`, `resize: vertical; min-height: 76px`, `--fs-ui`, `line-height: 1.5`. Фокус `outline: 2px solid var(--accent-line); outline-offset: 1px`. Hover и красного кольца ошибки нет. Подпись это `.meta` с `b` «Доповнити», подсказка `.meta-prose`. Ошибка `--fs-small` (13.5px) цветом `--ask`, а не `--danger`. Ctrl/⌘+Enter отправляет, кнопка `primary sm` «Надіслати» |
| Редактор строки специфікації | `src/components/intake/SpecRow.module.css` | `.input`: радиус `--r-chip`, фон `--raised`, кольцо 1px `--line-2`, `padding: 8px 11px`, `--fs-body` (15px), `line-height: 1.45`. Textarea: `resize: none; min-height: 2.6lh; max-height: 40vh; field-sizing: content`. Поля срока (`.field .input`) шрифтом `--ff-meta`. На сенсорном экране `font-size: 16px; min-height: 44px`. Чипы срочности `.chip`: `padding: 7px 11px`, `--fs-small`, `line-height: 1.3`, `--ink-2`, hover `--ink`, выбран `[data-on]` кольцо 1.5px `--ink` |
| Варианты ответа и «свій варіант…» | `src/components/intake/OptionChips.module.css`, `OptionChips.tsx` | чипы это `button role="radio"` в `role="radiogroup"` с `aria-label` = вопрос; `padding: 6px 11px`, радиус `--r-chip`, фон `--raised`, кольцо 1px `--line-2`, `--fs-small`, `line-height: 1.3`, `--ink-2`; hover `--ink`; нажатие `scale(.97)` за 120ms `--ease`; выбран `[data-on]` кольцо 1.5px `--ink`; disabled `opacity: .45`. Стрелки, Home, End двигают выбор (roving tabindex после гидрации). Поле `.free`: тот же вид, `flex: 1 1 180px`, цвет `--ink`, `outline-offset: 2px`, выбрано `[data-on]` кольцо 1.5px `--ink`; Enter или уход фокуса отправляют, максимум 300 символов; на сенсорном экране `min-height: 44px; font-size: 16px` |
| Поиск в палитре команд | `src/components/owner/CommandBar.module.css` | поле без рамки и фона: `flex: 1; border: 0; background: none; outline: none; font-size: 16px; color: var(--ink)`. Строка `.inputRow`: `display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line)` |
| Композер задачи | `src/components/intake/HighlightTextarea.module.css` | прозрачная textarea поверх слоя подсветки: `--ff-text` 400 `--fs-write`/`--lh-write` (19px/2.35, 17px при `max-width: 640px`), `letter-spacing: var(--tr-write)` (-0.005em), `padding: 22px 22px 18px`, `caret-color: var(--accent-solid)`, `resize: none`, `min-height: 220px; max-height: 70vh`, `field-sizing: content`, `outline: none`, рамки нет. Фокус показывает кольцо панели вокруг (`.panel:focus-within`, см. `Panel`). Выключено: цвет `--ink-2`, `cursor: default` |
| «+ файл» | `src/components/intake/Composer.module.css` (`.attach`) | `label` с видом `pill` вокруг скрытого `input type="file"`: фон `--raised`, `--ink-2`, 13px, `line-height: 1.25`, радиус `--r-pill`, `padding: 5px 11px`, кольцо 1px `--line`, `gap: 6px`. Hover цвет `--ink` и кольцо `--line-2`. Фокус через `:focus-within`, `outline: 2px solid var(--accent-line); outline-offset: 2px`. `[data-disabled]` `opacity: .45; cursor: not-allowed` |
| Переключатели темы и языка | `src/components/theme/ThemeSwitch.module.css` (его же использует `src/components/lang/LangSwitch.tsx`) | сегментная группа радиокнопок вместо `select`. Описание: см. раздел «Тема и переключатель» → «ThemeSwitch» и «LangSwitch» |

### Доступность форм: сводка

- У каждого поля есть `label` с `htmlFor`. Где подписи нет на экране, стоит `aria-label` (например большое поле примера в стандарте).
- Подсказка и ошибка связаны с полем через `aria-describedby`. `aria-invalid="true"` ставится только при ошибке.
- Ошибки объявляются: `role="alert"` у строки ошибки, у тоста-ошибки, у ошибки формы.
- `noValidate` стоит у форм настроек (`SettingsForm`, токен и чат Telegram, «Вход по коду») и у формы входа: там проверяет сервер, браузерные пузыри не показываются. Остальные формы владельца (новый человек, токен раннера, ответ коллеге, стандарт, песочница) без `noValidate`, у полей с `required` браузер может показать свою подсказку.
- Пока форма отправляется, у неё `aria-busy`, а кнопка отправки `disabled`.
- Группы радиокнопок оформлены `fieldset` и `legend`. Во всех текущих группах легенда скрыта `.vh` (видимое имя даёт заголовок раздела или номер пункта).
- Поля, где владелец пишет текст для коллег по-украински, помечены `lang="uk"` (стандарт, текст приглашения).
- На сенсорных экранах поля ввода и select не ниже 44px.

# Часть 3. Шапка и кабинет владельца

## Шапка и навигация

Шапка одна на оба интерфейса: компонент `TopBar` с параметром `view="colleague" | "owner"`. Под ней у владельца идёт общая оболочка кабинета: строка поиска `CommandBar` и `<main id="main">`. Шапка не липкая и не имеет своего фона: под ней видна сетка страницы (`body` с линиями `--grid` через 48px). Нижней линии у шапки тоже нет.

Отличия от `docs/SPEC-DELTA.md` §5.5, которые важны для повторения: порядок разделов владельца в коде «Входящие, Люди, Агенты, Стандарт, Настройки» (в спеке Агенты стоят вторыми); в шапке владельца стоит не один `RunnerStatus`, а группа `ServiceHealth` (две точки и статус раннера); навигация владельца уходит во второй ряд уже на 1100px, а не только на 640px.

### TopBar

Источник: `src/components/shell/TopBar.tsx`, `src/components/shell/TopBar.module.css`, `src/styles/base.css` (`.skip`), `src/styles/tokens.css`

Верхняя полоса страницы: ссылка «перейти к содержимому», логотип, разделы, служебная группа справа.

Анатомия:
- `header.top` (`position: relative; z-index: var(--z-top)`, `--z-top` = 10). Атрибут `data-view` хранит вариант.
- `.inner`: `max-width: var(--page-owner)` (1280px) у обоих вариантов, `margin: 0 auto`, `padding: 18px var(--gutter)` (`--gutter` 24px, на ширине до 640px 16px). `display: flex; align-items: center; gap: 14px`.
- Порядок внутри: `Logo`, затем `nav` (компонент `ScrollRow` как `<nav>`), затем `.end` с `margin-left: auto`.
- `.nav`: `display: flex; gap: 2px; margin-left: 14px; min-width: 0`.
- `.end`: `display: flex; align-items: center; gap: 10px; min-width: 0`. Внутри по порядку: `status` (только владелец), `LangSwitch` (UA RU EN), `ThemeSwitch`, `account`.
- Высота явно не задана: это 18px сверху и снизу плюс самый высокий элемент ряда (переключатели). Точное значение в px (не проверено). На сенсорном экране кнопки и `[role="radio"]` получают `min-height: 44px` из `base.css`, поэтому ряд там выше.

Варианты:

| | Коллега (`view="colleague"`) | Владелец (`view="owner"`) |
|---|---|---|
| Логотип ведёт на | `/` | `/admin/inbox` |
| Разделы | «Нове завдання», «Мої завдання» + число открытых задач | «Входящие» + число новых задач, «Люди», «Агенты», «Стандарт», «Настройки» |
| `status` | нет | `ServiceHealth` (см. ниже) |
| `account` | `PersonMenu` (имя и «Вийти») | `LogoutButton` («Выйти», кнопка `quiet sm` в обычной `<form>`) |
| `nav={false}` | `/no-access`, `/enter`: только логотип и переключатели | `/admin/login`: только логотип и переключатели |

Пункт навигации `.link`:
- Типографика: `font-size: var(--fs-small)` (13.5px), `line-height: 1.3`, шрифт текста `--ff-text`, цвет `--ink-3`.
- Форма: `display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; padding: 6px 10px; border-radius: var(--r-inner)` (8px), без подчёркивания.
- Число `.count` (класс `meta`, значит шрифт `--ff-meta`, цифры Martian Mono): `font-size: 12px`, цвет `--ink-3`. Ноль не показывается (число рендерится только если оно больше нуля).

Состояния пункта:
- hover: цвет `--ink-2`.
- текущий раздел (`aria-current="page"`): `color: var(--nav-on-ink); background: var(--nav-on)`; число `color: var(--nav-on-meta)`. В тёмной теме это `--hover` #1A1C21 / `--ink` #F3F4F6 / `--ink-3` #7E848E (серая плашка). В светлой #E4DAFF / #5537C2 / #5537C2 (сиреневая плашка).
- focus-visible: общее правило `base.css`: `outline: 2px solid var(--accent-line); outline-offset: 2px`, появление `actum-focus` за `--dur-fast`; у ссылок `border-radius: 4px`.
- грубый указатель (`pointer: coarse`): `min-height: 44px`.

Движение: `transition: color var(--dur-fast), background-color var(--dur-fast)` (150ms).

Адаптив:
- До 640px (оба варианта): `.inner` переносится (`flex-wrap: wrap; row-gap: 10px; padding-top: 14px; padding-bottom: 10px`). `.nav` уходит во второй ряд: `order: 3; flex: 1 0 100%; margin: -2px calc(-1 * var(--gutter)); padding: 4px var(--gutter); overflow-x: auto`. Ряд тянется от края до края экрана и прокручивается вбок внутри себя, страница вбок не едет. Пункты `padding-inline: 8px`. `.end`: `gap: 6px; flex-wrap: wrap; justify-content: flex-end; row-gap: 8px`.
- До 1100px (только владелец): тот же второй ряд навигации (`flex-wrap: wrap; row-gap: 10px` у `.inner`, те же правила у `.nav`), отступы `.inner` не меняются.

Доступность: первая фокусируемая ссылка `a.skip` ведёт на `#main` («Перейти к содержимому» у владельца, «Перейти до основного вмісту» у коллеги). `nav` с `aria-label` «Основная навигация» (у коллеги «Основна навігація»). Текущий раздел помечен `aria-current="page"`.

Ссылка пропуска `.skip`. Описание: см. раздел «Фокус и доступность» → «Skip-ссылка».

Элементы ряда, описанные в других разделах:
- `LangSwitch` («UA RU EN») и `ThemeSwitch` («Тема: Тёмная / Светлая / Как в системе»). Описание: см. раздел «Тема и переключатель».
- `Logo` (словесный знак, ведёт на `/admin/inbox` или `/`). Описание: см. раздел «Логотип и иконки» → «Знак и словесный знак».

```html
<header class="top" data-view="owner">
  <a class="skip" href="#main">Перейти к содержимому</a>
  <div class="inner">
    <a class="logo" href="/admin/inbox">…svg…</a>
    <nav class="row nav" aria-label="Основная навигация">
      <a class="link" href="/admin/inbox" aria-current="page">Входящие <span class="meta count">3</span></a>
      <a class="link" href="/admin/people">Люди</a>
      <a class="link" href="/admin/agents">Агенты</a>
      <a class="link" href="/admin/standard">Стандарт</a>
      <a class="link" href="/admin/settings">Настройки</a>
    </nav>
    <div class="end">
      <div class="healthRow" role="group" aria-label="Состояние служб">…</div>
      <form class="track">…UA RU EN…</form>
      <form class="track"><span class="group">Тема</span><div role="radiogroup">…</div></form>
      <form><button type="submit" class="btn quiet sm">Выйти</button></form>
    </div>
  </div>
</header>
```

```css
.top { position: relative; z-index: var(--z-top); }
.inner {
  max-width: var(--page-owner); margin: 0 auto; padding: 18px var(--gutter);
  display: flex; align-items: center; gap: 14px;
}
.nav { display: flex; gap: 2px; margin-left: 14px; min-width: 0; }
.link {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  color: var(--ink-3); font-size: var(--fs-small); line-height: 1.3; padding: 6px 10px;
  border-radius: var(--r-inner); text-decoration: none;
  transition: color var(--dur-fast), background-color var(--dur-fast);
}
.link:hover { color: var(--ink-2); }
.link[aria-current="page"] { color: var(--nav-on-ink); background: var(--nav-on); }
.count { font-size: 12px; }
.link[aria-current="page"] .count { color: var(--nav-on-meta); }
.end { margin-left: auto; display: flex; align-items: center; gap: 10px; min-width: 0; }

@media (max-width: 640px) {
  .inner { flex-wrap: wrap; row-gap: 10px; padding-top: 14px; padding-bottom: 10px; }
  .nav { order: 3; flex: 1 0 100%; margin: -2px calc(-1 * var(--gutter)); padding: 4px var(--gutter); overflow-x: auto; }
  .link { padding-inline: 8px; }
  .end { gap: 6px; flex-wrap: wrap; justify-content: flex-end; row-gap: 8px; }
}
@media (max-width: 1100px) {
  .top[data-view="owner"] .inner { flex-wrap: wrap; row-gap: 10px; }
  .top[data-view="owner"] .nav {
    order: 3; flex: 1 0 100%; margin: -2px calc(-1 * var(--gutter)); padding: 4px var(--gutter); overflow-x: auto;
  }
}
@media (pointer: coarse) { .link { min-height: 44px; } }
```

### ScrollRow

Источник: `src/components/shell/ScrollRow.tsx`, `src/components/shell/ScrollRow.module.css`

Ряд ссылок, который прокручивается вбок внутри себя: навигация шапки во втором ряду и вкладки «Входящих».

Анатомия: обёртка `.row` (тег `div` или `nav`), дети — ссылки. Включается ли прокрутка, решает вызывающий CSS (`overflow-x: auto`).

Поведение:
- Полосы прокрутки нет (`scrollbar-width: none`, `::-webkit-scrollbar { display: none }`), `overscroll-behavior-x: contain`.
- Мягкая привязка: `scroll-snap-type: x proximity`, у ссылок `scroll-snap-align: start`, `scroll-padding-inline: var(--fade)`.
- Край, за которым есть ещё пункты, гаснет маской шириной `--fade` = 32px. Скрипт ставит `data-more="start" | "end" | "both"` по положению прокрутки; если ряд помещается, маски нет.
- Текущая ссылка (`aria-current="page"`) при загрузке сразу ставится в центр ряда, если её закрывает край; при смене раздела прокручивается плавно (`behavior: "smooth"`), при `prefers-reduced-motion: reduce` без анимации.

```css
.row {
  --fade: 32px;
  scrollbar-width: none; overscroll-behavior-x: contain;
  scroll-snap-type: x proximity; scroll-padding-inline: var(--fade);
}
.row::-webkit-scrollbar { display: none; }
.row > a { scroll-snap-align: start; }
.row[data-more="end"] { mask-image: linear-gradient(to right, #000 calc(100% - var(--fade)), transparent); }
.row[data-more="start"] { mask-image: linear-gradient(to left, #000 calc(100% - var(--fade)), transparent); }
.row[data-more="both"] {
  mask-image: linear-gradient(to right, transparent, #000 var(--fade), #000 calc(100% - var(--fade)), transparent);
}
```

### PersonMenu

Источник: `src/components/shell/PersonMenu.tsx`, `src/components/shell/PersonMenu.module.css`, `src/components/ui/InlineConfirm.tsx`, `src/components/ui/InlineConfirm.module.css`, `src/lib/copy/colleague/uk.ts`

Правый край шапки коллеги: имя и выход с подтверждением на месте.

Анатомия: `.person` `display: flex; align-items: center; gap: 6px; min-width: 0`. Внутри имя `.name` (класс `meta`) и `InlineConfirm` с `placement="floating"`; триггер — кнопка `quiet sm` «Вийти».

Типографика: имя шрифтом `--ff-meta`, `--fs-meta` (13px), цвет `--ink-2`, `max-width: 16ch`, одна строка с многоточием.

Состояния: по нажатию открывается всплывающее подтверждение `InlineConfirm` с `placement="floating"`: полоса `position: absolute; top: calc(100% + 8px); right: 0; z-index: var(--z-dialog)` (40), `width: max-content; max-width: min(340px, calc(100vw - 2 * var(--gutter)))`, `padding: 10px 12px 10px 14px; border-radius: var(--r-block)`, фон `--raised`, тень `0 0 0 1px var(--line-2), var(--shadow-drop)`, появление `actum-fade var(--dur-base) var(--ease)`. Вопрос «Щоб увійти знову, знадобиться твоє посилання. Вийти?» (на «ви»: «…ваше посилання…»), кнопки `primary sm` «Вийти» и `quiet sm` «Залишитися». Фокус переходит на кнопку подтверждения; отмена и Esc возвращают его на триггер.

Адаптив: до 640px имя скрыто (`display: none`), остаётся только «Вийти».

### Состояние служб и раннера (ServiceHealth, RunnerStatus)

Источник: `src/app/admin/(panel)/_components/ServiceHealth.tsx`, `src/app/admin/(panel)/_components/shell.module.css`, `src/components/shell/RunnerStatus.tsx`, `src/components/shell/RunnerStatus.module.css`, `src/lib/copy/owner/ru.ts`

Группа в шапке владельца: работает ли проверка задач, подключён ли Telegram, на связи ли раннер на ПК.

Анатомия:
- `.healthRow` (`role="group"`, `aria-label` «Состояние служб»): `display: flex; align-items: center; gap: 10px; min-width: 0`.
- Два пункта `.health` (проверка задач, Telegram): `display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-chip)` (12.5px), `color: var(--ink-3)`, без переноса. Видимый текст пункта `.healthText` скрыт на всех ширинах (`display: none`): остаётся только точка с `title`, полный текст читает скринридер (`.vh`). Причина в коде: в 1280px не хватает места.
- Третий пункт — `RunnerStatus`, он свой текст показывает всегда.

Точка `.dot` (общая для `.health` и `RunnerStatus`): `width: 7px; height: 7px; border-radius: 50%`, по умолчанию `background: var(--ink-3)`.

Тона пунктов проверки и Telegram (`data-tone`):

| Тон | Точка | Текст | Когда |
|---|---|---|---|
| `ok` | `--accent-solid` + кольцо `0 0 0 3px var(--accent-wash)` | `--ink-2` | проверка через Claude; Telegram подключён |
| `muted` | `--ink-3` | `--ink-3` | мок; проверка выключена; Telegram не настроен |
| `warn` | `--ask` | `--ask` | «Claude не отвечает»; «нет ключа API» |

`RunnerStatus` (`span.status`, `role="status"`, `title` с тем же текстом):
- `display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-chip); color: var(--ink-3); white-space: nowrap; flex: none`. Текст `.text` с многоточием.

| `data-state` | Текст | Точка | Цвет текста |
|---|---|---|---|
| `online` | «Раннер онлайн» | `--accent-solid` + кольцо 3px `--accent-wash` | `--ink-2` |
| `offline` | «Раннер офлайн с {time}», например «Раннер офлайн с 14:20» | `--ink-3` | `--ink-3` |
| `unauthorized` | «Claude Code на ПК не авторизован» | `--ask` | `--ask` |
| `paused` | «Раннер на паузе» | `--ink-3` | `--ink-3` |
| `missing` | «Раннер офлайн» | `--ink-3` | `--ink-3` |

В `SPEC-DELTA.md` §6.2 для `missing` указан текст «Раннер не подключён», в коде сейчас «Раннер офлайн».

Адаптив: до 640px `.health` и `.status` получают `padding: 6px 2px`; `RunnerStatus` становится `flex: 0 1 auto; min-width: 0`, текст `max-width: 46vw` с многоточием.

```css
.status { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-chip); color: var(--ink-3); white-space: nowrap; flex: none; }
.text { overflow: hidden; text-overflow: ellipsis; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ink-3); }
.status[data-state="online"] .dot { background: var(--accent-solid); box-shadow: 0 0 0 3px var(--accent-wash); }
.status[data-state="online"] { color: var(--ink-2); }
.status[data-state="unauthorized"] .dot { background: var(--ask); }
.status[data-state="unauthorized"] { color: var(--ask); }
@media (max-width: 640px) {
  .status { padding: 6px 2px; flex: 0 1 auto; min-width: 0; }
  .text { max-width: 46vw; }
}
```

### Оболочка кабинета владельца

Источник: `src/app/admin/(panel)/layout.tsx`, `src/app/admin/(panel)/_components/shell.module.css`, `src/app/admin/(panel)/_components/OwnerTopBar.tsx`, `src/app/admin/layout.tsx`, `src/app/admin/(panel)/page.tsx`

Общая рамка всех страниц `/admin/*` после входа: шапка, строка поиска, содержимое. Своей страницы у `/admin` нет: она сразу перенаправляет на `/admin/inbox`.

Анатомия:
- `OwnerTopBar` берёт текущий раздел из второго сегмента URL (`/admin/<раздел>`), по умолчанию «Входящие». Число у «Входящих» — новые задачи.
- `.page`: `max-width: var(--page-owner)` (1280px), `margin: 0 auto`, `padding: 8px var(--gutter) 60px`.
- `.cmdk` (обёртка `CommandBar`): `margin-bottom: var(--s-5)` (20px). Строка поиска занимает всю ширину контейнера на каждой странице кабинета.
- `<main id="main" class="main" tabindex="-1">`: `min-width: 0`, при фокусе без обводки.
- Корневой `<html>` кабинета (`src/app/admin/layout.tsx`, общий для входа и панели): `lang` = язык владельца (ru по умолчанию), `data-theme` из cookie, мета `theme-color` по `prefers-color-scheme`: #07080A (dark) и #F6F7F8 (light). В `<body>` после страницы подключён `CursorLight` (см. раздел «Фон страницы» → «CursorLight»).
- Панель также оборачивает всё в провайдеры тостов и одной live-области (`ToastProvider`, `AnnouncerProvider`).

```css
.page { max-width: var(--page-owner); margin: 0 auto; padding: 8px var(--gutter) 60px; }
.cmdk { margin-bottom: var(--s-5); }
.main { min-width: 0; }
.main:focus { outline: none; }
```

## Экраны владельца

Скриншоты лежат в `docs/screenshots/`. Сняты 27.10.2026 на 1366 и 390px. Изменения после этой даты (например, шаг входа с кодом из Telegram) на снимках могут отсутствовать (не проверено).

Общая сетка для всех страниц кроме «Входящих», страницы задачи и входа (`shell.module.css`):
- `.column`: `display: grid; gap: var(--s-5)` (20px). В ней шапка страницы `PageHead` и содержимое.
- `.split`: до 1024px одна колонка с тем же `gap: var(--s-5)`. С 1024px `grid-template-columns: minmax(0, 1fr) minmax(0, var(--side-page))`, `grid-template-rows: auto 1fr`, `grid-template-areas: "main side" "more side"`. `--side-page` = `clamp(340px, 34vw, var(--side-w))`, то есть от 340 до 460px.
- `.mainCol`, `.sideCol`, `.moreCol`: `display: grid; gap: var(--s-5); align-content: start`. `.moreCol` стоит под `.mainCol`, а `.sideCol` тянется на обе строки справа. Гибкая вторая строка (`1fr`) забирает лишнюю высоту правой колонки, поэтому `.moreCol` идёт сразу под `.mainCol`.
- `.even` (только «Настройки»): с 1024px `grid-template-columns: repeat(2, minmax(0, 1fr))`, области те же.
- `.sideCol` — контейнер (`container-type: inline-size`): формы в нём при ширине до 30rem складываются в одну колонку, как на телефоне.
- До 1024px блоки идут в порядке DOM: обычно main, side, more; на «Людях» `.sideCol` с формой стоит в DOM первым, поэтому на телефоне форма выше списка.

В `SPEC-DELTA.md` §5.7 сказано, что формы админки идут одной колонкой шириной до 760px. В коде страницы растянуты на ширину контейнера 1280px и делятся на две колонки с 1024px.

```css
.column { display: grid; gap: var(--s-5); min-width: 0; }
.split { display: grid; gap: var(--s-5); align-items: start; min-width: 0; }
.mainCol, .sideCol, .moreCol { display: grid; gap: var(--s-5); align-content: start; min-width: 0; }
.sideCol { container-type: inline-size; }
@media (min-width: 1024px) {
  .split {
    grid-template-columns: minmax(0, 1fr) minmax(0, var(--side-page));
    grid-template-rows: auto 1fr;
    grid-template-areas: "main side" "more side";
  }
  .even { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mainCol { grid-area: main; }
  .sideCol { grid-area: side; }
  .moreCol { grid-area: more; }
}
```

### Входящие

Источник: `src/app/admin/(panel)/inbox/page.tsx`, `src/app/admin/(panel)/inbox/_components/inbox.module.css`, `src/app/admin/(panel)/inbox/_components/InboxLive.tsx`

Скриншоты: `admin-inbox-1366-dark.png`, `admin-inbox-1366-light.png`, `admin-inbox-390-dark.png`, `admin-inbox-390-light.png`; с живым запуском `admin-inbox-run-1366-dark.png`, `admin-inbox-run-1366-light.png`; с отчётом агента `admin-inbox-report-1366-dark.png`, `admin-inbox-report-1366-light.png`; другие языки `admin-inbox-1366-dark-en.png`, `admin-inbox-1366-dark-uk.png`.

Раскладка:
- Видимого заголовка нет: `<h1 class="vh">Входящие</h1>`.
- `.grid`: `grid-template-columns: minmax(0, 1fr) minmax(0, var(--side-w))` (`--side-w` 460px), `gap: var(--s-5)` (20px), `align-items: start`.
- Слева `.listCol`: один `Panel` со всем списком. Сверху вниз: `InboxTabs`; полоса фильтров (только если фильтр включён); список `InboxItem`; пагинация (если задач больше страницы).
- Справа `.sideCol`: карточка выбранной задачи (`TaskSide`). `position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow-y: auto; border-radius: var(--r-panel)` (20px), `scrollbar-width: thin`. Карточка прокручивается внутри себя и остаётся на экране, пока листается список.
- По умолчанию выбрана первая непросмотренная задача, иначе первая в списке.
- Пустая правая колонка: `Panel` `.sideEmpty` (`padding: 32px 22px`) с `Empty`: «Выберите задачу» / «Карточка задачи откроется здесь.».

Полоса фильтров `.filters` (`role="group"`, `aria-label` «Фильтры»): `display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 18px; border-bottom: 1px solid var(--line)`.
- Чип `.filterChip` (ссылка, которая убирает этот фильтр): `inline-flex; align-items: center; gap: 6px; padding: 3px 6px 3px 10px; border-radius: var(--r-tag)` (6px), кольцо `0 0 0 1px var(--line-2)`, `font-size: var(--fs-chip)` (12.5px), цвет `--ink-2`, без подчёркивания. Крестик «×» (`aria-hidden`) `--ink-3`, 15px, `line-height: 1`. hover: текст `--ink`, кольцо `--ink-3`. `aria-label` «Убрать фильтр «{name}»». Тексты чипов строчные: «срочность: высокая», «просроченные», «как есть», «без проверки», «проверенные», «агент: {name}», «поиск: «{q}»»; фильтр по человеку показывает его имя.
- В конце ссылка в виде кнопки `quiet sm` «Сбросить» с `font-size: var(--fs-chip)`, цвет `--ink-3`, `margin-left: 4px`.

Пагинация `nav.pager` (`aria-label` «Список задач»): `display: flex; justify-content: space-between; align-items: center; gap: var(--s-3); padding: 12px 18px; border-top: 1px solid var(--line); flex-wrap: wrap`. Слева meta «Показаны {from}–{to} из {total}», справа ссылки-кнопки `ghost sm` (`gap: var(--s-2)`): «Назад» только со второй страницы, «Дальше» только если есть следующая.

Пустые состояния списка (`Empty`):
- пусто на вкладке «Открытые» без фильтров: «Новых задач нет.» / «Когда коллеги отправят задачу, она появится здесь и придёт в Telegram.»;
- пусто при фильтре или на любой другой вкладке: «По этому фильтру задач нет.» и ссылка-кнопка `ghost sm` «Показать все» (ведёт на `?view=all`).

Живое обновление (`InboxLive`): список перезапрашивается каждые 30 с, пока вкладка видна, и сразу при возврате на вкладку. Новая строка въезжает сверху с сиреневой вспышкой: класс `.fresh` на 1300 мс, анимация `fresh 1.2s var(--ease) both`.

Смена задачи в правой колонке: содержимое `.swap` появляется анимацией `swap var(--dur-base) var(--ease) both` (220ms; из `opacity: 0; transform: translateY(6px); filter: blur(2px)`).

Телефон и узкий экран (до 1060px): одна колонка (`grid-template-columns: minmax(0, 1fr)`), правая колонка скрыта (`display: none`). Нажатие на строку открывает отдельную страницу `/admin/inbox/[serial]` (это делает скрипт `InboxLive` и поиск `OwnerCommandBar`, оба по `(max-width: 1060px)`). На 390px вкладки прокручиваются вбок внутри панели, строка списка перестраивается (см. `InboxItem`).

```css
.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, var(--side-w)); gap: var(--s-5); align-items: start; }
.listCol { min-width: 0; }
.sideCol { min-width: 0; position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow-y: auto; border-radius: var(--r-panel); scrollbar-width: thin; }
@media (max-width: 1060px) {
  .grid { grid-template-columns: minmax(0, 1fr); }
  .sideCol { display: none; }
}
.fresh { animation: fresh 1.2s var(--ease) both; }
@keyframes fresh {
  from { opacity: 0; transform: translateY(-8px); background: var(--accent-wash); }
  35% { opacity: 1; transform: none; background: var(--accent-wash); }
  to { background: transparent; }
}
.swap { animation: swap var(--dur-base) var(--ease) both; }
@keyframes swap { from { opacity: 0; transform: translateY(6px); filter: blur(2px); } }
```

### Страница задачи

Источник: `src/app/admin/(panel)/inbox/[serial]/page.tsx`, `src/app/admin/(panel)/inbox/_components/TaskDetail.tsx`, `src/app/admin/(panel)/inbox/_components/inbox.module.css`

Скриншоты: `admin-task-1366-dark.png`, `admin-task-1366-light.png`, `admin-task-390-dark.png`, `admin-task-390-light.png`; на телефоне с живым логом `admin-inbox-run-390-dark.png`, `admin-inbox-run-390-light.png`, `admin-inbox-run-390-light-en.png`; с отчётом `admin-inbox-report-390-dark.png`, `admin-inbox-report-390-light.png`.

Та же карточка `TaskSide`, что в правой колонке «Входящих», но на всю ширину контейнера. Нужна на узких экранах и для прямых ссылок из Telegram.

Раскладка:
- `.full`: `display: grid; gap: var(--s-3)` (12px).
- Сверху ссылка `.backLink` «← Входящие»: `font-size: var(--fs-ui)` (14px), цвет `--ink-3`, без подчёркивания, hover `--ink`.
- Скрытый `h1` «№ 0008 {название}».
- Карточка без блока агента: одна колонка `max-width: 880px`, по центру.
- С 1024px, если в карточке есть блок агента (`.agentCol`): сама карточка (`[data-taskside]`) становится сеткой `grid-template-columns: minmax(0, 1fr) minmax(0, clamp(320px, 32vw, 440px))`, `column-gap: 28px`, `align-items: start`, `grid-template-rows: repeat(15, auto) 1fr`. Все блоки карточки идут в первой колонке по строке на блок, `.agentCol` (план агента и запуск) стоит во второй колонке на всю высоту (`grid-row: 1 / -1`). Последняя гибкая строка забирает лишнюю высоту колонки агента. Первый блок в колонке агента без верхнего отступа.
- До 1024px всё идёт одной колонкой сверху вниз, как в правой колонке «Входящих».

Содержимое карточки сверху вниз (`TaskDetail`): мета-строка (№, время получения, человек), заголовок `h2`, флаги, предупреждения, `Facts` (что, зачем, готово, срок, материалы), раскрывашка «Исходный текст», «Ответы на уточнения», «Файлы», блок агента (`AgentPanel`, `RunPanel`), ответ коллеге (`ReplyBox`), «Ход задачи», раскрывашка «Разбор и проверка».

```css
.full { display: grid; gap: var(--s-3); min-width: 0; }
.full:not(:has(.agentCol)) { max-width: 880px; margin-inline: auto; }
@media (min-width: 1024px) {
  .full > [data-taskside]:has(> .agentCol) {
    display: grid; column-gap: 28px; align-items: start;
    grid-template-columns: minmax(0, 1fr) minmax(0, clamp(320px, 32vw, 440px));
    grid-template-rows: repeat(15, auto) 1fr;
  }
  .full > [data-taskside]:has(> .agentCol) > * { grid-column: 1; }
  .full > [data-taskside] > .agentCol { grid-column: 2; grid-row: 1 / -1; }
  .full .agentCol > .block:first-child { margin-top: 0; }
}
```

### Агенты

Источник: `src/app/admin/(panel)/agents/page.tsx`, `src/app/admin/(panel)/agents/_components/agents.module.css`, `src/app/admin/(panel)/agents/_components/AgentsControls.tsx`

Скриншоты: `admin-agents-1366-dark.png`, `admin-agents-1366-light.png`, `admin-agents-390-dark.png`, `admin-agents-390-light.png`; на украинском `admin-agents-1366-light-uk.png`.

Раскладка: `.column`, затем `PageHead` «Агенты» с вводным абзацем, затем `.split`.
- Левая колонка (`.mainCol`): секция «Раннер» (строки без внутреннего отступа, `flush`), секция «Профили» (`flush`, справа число профилей).
- Правая колонка (`.sideCol`, 340–460px): секция «Токены» (`flush`), секция «Подключить ПК» (форма токена и инструкция).
- Телефон: одна колонка в порядке Раннер, Профили, Токены, Подключить ПК.

Строка раннера (`.rowItem`):
- `.runnerHead`: `display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap`. Слева `AgentChip` с именем ПК (онлайн: состояние `done`; онлайн с ошибкой входа: `attention`; офлайн: `idle`). Рядом `.runnerState`: `font-size: var(--fs-ui)`, цвет `--ink-3`, онлайн `--ink-2`. Тексты «онлайн», «офлайн с {time}», «ещё не выходил на связь».
- `MetaList`: «последний сигнал {when}», «компьютер {host}», «раннер {v}», «Claude Code {v}», «параллельно: {n}», «сегодня ≈ ${cost}».
- Строка состояния: при `ok` обычная `meta-prose` («в порядке»), иначе `.warn` (`font-size: var(--fs-ui)`, цвет `--ask`), например «Claude Code не авторизован, на ПК выполните claude /login».
- «Сейчас выполняются»: `.activeRuns` `display: grid; gap: 4px; font-size: var(--fs-ui)`, подпись в meta, затем список (`gap: 2px`): номер жирным в meta и ссылка на задачу.
- Флажок «Пауза» (`.check` из форм) с подсказкой «На паузе раннер не берёт новые задачи, текущие доработают.».
- Без раннера в секции одна строка `meta-prose` в `.empty`: «ПК ещё не подключён. Создайте токен ниже и вставьте его в runner\.env.».

Строка токена (секция «Токены»): название вес 500 и префикс токена в `.key` («{prefix}…»), `MetaList` («создан {date}», «использовался {when}» или «ещё не использовался», «IP {ip}»), кнопки с подтверждением на месте: `ghost sm` «Заменить» и `quiet sm` «Отозвать». Без токенов: «Токенов пока нет.».

Строка профиля:
- `.profileHead`: `display: flex; align-items: baseline; gap: var(--s-3); flex-wrap: wrap`. Имя `.profileName` вес 500, рядом ключ `.key`: `font: 400 12px/1.4 var(--ff-mono)`, цвет `--ink-3`, `padding: 1px 6px; border-radius: var(--r-tag)`, кольцо `0 0 0 1px var(--line)`.
- Описание `.desc`: `font-size: var(--fs-ui)`, цвет `--ink-2`.
- Таблица фактов `.facts` (`dl`): `grid-template-columns: 140px minmax(0, 1fr); gap: 4px 14px; margin: 4px 0 0; font-size: var(--fs-ui)`. Термины в meta. До 640px одна колонка, у `dd` `margin-bottom: 6px`.
- Пояснение над списком `.note`: `padding: 12px 18px 0`.
- Удалённые профили и отозванные токены: `details.more` `padding: 12px 18px 16px; border-top: 1px solid var(--line)`, список внутри `font-size: var(--fs-ui)`, цвет `--ink-2`.

Секция «Подключить ПК»: форма в строку (поле «Название» растягивается, кнопка `primary` «Создать токен»), затем `.setup`: `display: grid; gap: var(--s-2); padding-top: var(--s-4); border-top: 1px solid var(--line)`. Заголовок «Как подключить» (`font-size: var(--fs-ui)`, вес 500), абзац, блок команд `pre.code`. Новый токен показывается блоком `.secret` (см. «Компоненты владельца»).

### Люди и карточка человека

Источник: `src/app/admin/(panel)/people/page.tsx`, `src/app/admin/(panel)/people/[id]/page.tsx`, `src/app/admin/(panel)/people/_components/people.module.css`, `src/app/admin/(panel)/people/_components/*.tsx`

Скриншоты: `admin-people-1366-dark.png`, `admin-people-1366-light.png`, `admin-people-390-dark.png`, `admin-people-390-light.png`. Для страницы одного человека снимков нет.

Список людей (`/admin/people`):
- `PageHead` «Люди», вводная строка «{n} {человек/человека}, действующих ссылок: {m}.» и, если есть архивные, « В архиве: {n}.» (без людей: «Добавьте коллегу, и {brand} выдаст личную ссылку для входа.»).
- `.split`: в DOM сначала `.sideCol` с секцией «Новый коллега», потом `.mainCol` с секцией «Все люди» (`flush`). С 1024px список слева, форма справа. На телефоне форма идёт первой.
- Форма: поля «Как обращаться», «Полное имя», «Отдел» в `grid3`, затем «Заметка для себя, видна только вам», «Язык интерфейса» (`select`), кнопка `primary` «Создать и получить ссылку». Правая колонка (340–460px) не шире 30rem (480px при корневом шрифте 16px), поэтому с 1024px три поля стоят одной колонкой; в ряд по три они встают только между 641 и 1023px, когда форма идёт на всю ширину. После создания под формой появляется `InviteSlip`.
- Строка человека `.person`: `display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; align-items: start`.
  - `.personMain` (`display: grid; gap: 2px`): имя-ссылка `.personName` (вес 500, без подчёркивания; hover подчёркивание цвета `--line-2`), внутри той же ссылки полное имя в meta; `MetaList` (отдел, состояние ссылки или «в архиве», «заходил(а) {when}» или «входов не было», «задач: {n}, открытых: {m}», «Telegram»); заметка `meta-prose`.
  - Состояние ссылки `.state` по `data-state`: `active` («ссылка действует») `--ink-2`, `revoked` («ссылка отозвана») `--ask`, `none` («ссылка не выдана») без своего цвета, то есть `--ink-3` от meta.
  - Метка `.tg`: `inline-flex; gap: 6px`, цвет `--ink-2`, перед текстом точка 6px цвета `--accent-solid`.
  - Кнопки `.personActions` на всю ширину строки (`grid-column: 1 / -1`).
  - Архивный человек: вся строка `opacity: .62`.
  - До 640px одна колонка.
- Пусто: `Empty` «Пока никого нет.» с тем же текстом, что во вводной строке, внутри `.empty` (`padding: 28px 18px`).

Карточка человека (`/admin/people/[id]`):
- `PageHead` со ссылкой «← Люди», `h1` = имя, вводная строка — `MetaList` (полное имя, отдел, «в списке с {date}», последний вход, «Telegram»).
- Если человек в архиве: полоса `.notice` «{name} в архиве с {date}.».
- `.split`: `.mainCol` — «Данные» (форма); `.sideCol` — «Ссылка для входа» (справа состояние ссылки; у архивного человека секции нет), «Агенты» (разрешение автозапуска), «Входы» (сессии); `.moreCol` — «Задачи» (справа «задач: {n}, открытых: {m}», до 10 строк и ссылка-кнопка `ghost sm` «Все задачи во «Входящих»»; пусто — «Задач пока нет.»), «Архивировать» или «Вернуть из архива».
- Строка задачи `.taskRow`: `grid-template-columns: 62px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line)`. Номер жирным в meta, название `.taskTitle` (500, одна строка с многоточием, hover подчёркивание `--line-2`), статус в meta.
- Сессии `.session`: `display: flex; justify-content: space-between; align-items: center; gap: var(--s-3); flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid var(--line)`, текст `.sessionMain` `font-size: var(--fs-ui)`.
- Телефон: Данные, затем Ссылка, Агенты, Входы, затем Задачи, Архив.

### Стандарт

Источник: `src/app/admin/(panel)/standard/page.tsx`, `src/app/admin/(panel)/standard/_components/StandardWorkspace.tsx`, `src/app/admin/(panel)/standard/_components/standard.module.css`

Скриншоты: `admin-standard-1366-dark.png`, `admin-standard-1366-light.png`, `admin-standard-390-dark.png`, `admin-standard-390-light.png`.

Раскладка:
- `PageHead` «Стандарт», вводная строка «Действует редакция {n} от {date}.» (или «Действует стандарт по умолчанию.») плюс пояснение «Коллеги видят пункты рядом с полем, а проверка сверяет по ним каждую задачу. …».
- Если редакций больше одной: раскрывашка `Disclosure` «Все редакции» (справа число редакций). Внутри список `.versions` (`list-style: none; display: grid; gap: 6px; font-size: var(--fs-ui)`), строка `li` `display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap`: «Редакция {n}», рядом дата в meta, затем у действующей meta «действует», у остальных кнопка `VersionActivate`.
- `VersionActivate` (`src/app/admin/(panel)/standard/_components/VersionActivate.tsx`): `Button quiet sm` «Сделать действующей», без подтверждения. Пока идёт запрос, кнопка `disabled`. Итог тостом: «Редакция {n} снова действует.» (`info`) или «Не получилось. Обновите страницу и попробуйте ещё раз.» (`error`). Новой редакции не создаётся, редактор перезагружается с выбранной.
- `.workspace`: `display: grid; gap: var(--s-5); align-items: start`. С 1024px `grid-template-columns: minmax(0, 1fr) minmax(0, var(--side-page))`. Слева редактор, справа секция `#playground` «Проверить на примере»: `position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow-y: auto; scrollbar-width: thin`.
- Редактор `.editor` (`display: grid; gap: var(--s-5)`): секции «Вступление» (высокое поле), «Пункты» (справа «{n} / {max}»), «Строгость» (чипы-радио), «Хороший пример» (справа «необязательно»), внизу липкая полоса сохранения `.saveBar`.
- Телефон: одна колонка, редактор, потом проверка (не липкая).

Пункт стандарта `.criterion`: `display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; padding: 16px 0; border-top: 1px solid var(--line)`; у первого нет линии и `padding-top: 4px`. Номер «01» в meta с `padding-top: 30px` (на уровне поля). Тело `display: grid; gap: var(--s-3)`. Поля пункта: «Название» и «Описание». Под ними ряд `.criterionControls` (`flex; flex-wrap: wrap; gap: var(--s-3); align-items: center`): чипы «обязательно / желательно», выбор поля «к полю» (`.fieldSelect` `inline-flex; gap: 8px`, `select` `width: auto; min-width: 11rem`) и кнопка `quiet sm` «Убрать» (выключена, когда пункт один). Под списком кнопка `ghost sm` «Добавить пункт» (выключена на 15 пунктах). До 640px одна колонка, номер без отступа сверху.

Проверка на примере: `meta-prose` «Проверяет по черновику стандарта. Задача никуда не уходит.», поле «Текст задачи» (`.tall`), кнопки `primary sm` «Разобрать», `ghost sm` «Финальная проверка», `quiet sm` «Подставить слабую задачу».

Результат проверки `.result` (`aria-live="polite"`): `display: grid; gap: var(--s-4); padding-top: var(--s-4); border-top: 1px solid var(--line)`, появляется анимацией `rise var(--dur-rise) var(--ease) both` (600ms; из `opacity: 0; translateY(6px); blur(3px)`).
- Вердикт `.verdict` (`flex; align-items: baseline; gap: var(--s-4); flex-wrap: wrap`): слово `.verdictWord` `font: 500 var(--fs-h3)/var(--lh-h3) var(--ff-display)` (20px/1.2), `letter-spacing: var(--tr-h3)` («Принята», «Можно отправлять», «На доработку», «Есть вопросы»); для `needs_revision` и `needs_answers` цвет `--ask`. Рядом meta «{s} с, {tokens} токенов» и модель (или «мок»).
- Пункты `.criteriaResult li`: `grid-template-columns: 64px minmax(0, 1fr); gap: 10px`. Статус `.status` («есть», «неясно», «нет») `font: 400 var(--fs-meta)/1.5 var(--ff-text)`, цвет `--ink-3`; `ok` — `--accent-text`; `unclear`, `missing` — `--ask`.
- Сервис не ответил: строка `.unchecked` (`--fs-ui`, `--ask`).
- Сырой ответ `.json`: `padding: 12px 14px; border-radius: var(--r-chip)`, фон `--raised`, кольцо `--line`, `font: 400 12px/1.6 var(--ff-mono)`, цвет `--ink-2`, `max-height: 420px`, прокрутка.
- Пока идёт проверка: meta «Проверяем…» мигает `breathe 1.6s ease-in-out infinite` (до `opacity: .5`).

### Настройки

Источник: `src/app/admin/(panel)/settings/page.tsx`, `src/app/admin/(panel)/settings/_components/settings.module.css`, `src/app/admin/(panel)/settings/_components/SettingsControls.tsx`, `src/app/admin/(panel)/settings/_components/Admin2fa.tsx`

Скриншоты: `admin-settings-1366-dark.png`, `admin-settings-1366-light.png`, `admin-settings-390-dark.png`, `admin-settings-390-light.png`; на английском `admin-settings-1366-dark-en.png`.

Раскладка: `PageHead` «Настройки» без вводной строки, затем `.split.even`: с 1024px две равные колонки.
- Левая колонка сверху (`.mainCol`): «Как вас называть» (имя в семи формах: по три падежа на украинском и русском, одна форма на английском), «Обращение к коллегам» (чипы «на «ти»» / «на «ви»» с украинским примером).
- Левая колонка ниже (`.moreCol`): «Тема» (`ThemeSwitch`), «Язык кабинета» (`LangSwitch`), «Вход в кабинет» (кнопки «Выйти на этом устройстве» и «Выйти на всех устройствах»).
- Правая колонка (`.sideCol`): «Автоматический разбор», «Telegram», «Агенты».
- Телефон: Как вас называть, Обращение, Автоматический разбор, Telegram, Агенты, Тема, Язык кабинета, Вход в кабинет.

Детали:
- Имена `.names` (`display: grid; gap: var(--s-4)`) из трёх групп «По-украински», «По-русски», «По-английски». Группа `.group` (`fieldset` без рамки): `display: grid; gap: var(--s-3)`; легенда `font-size: var(--fs-ui)`, вес 500, `margin-bottom: 8px`. Поля в `grid3` (одна колонка до 640px), под каждым подсказка-пример.
- Строка режима `.mode`: `font-size: var(--fs-ui)`, цвет `--ink-2` («Сейчас работает Claude, модель {model}.» или мок); если ключа API нет (`data-warn`) — `--ask` («Ключ Anthropic API не задан: задачи приходят без проверки.»).
- Сводка за сегодня `.usage`: `display: grid; gap: 4px; padding: 12px 14px; border-radius: var(--r-chip)`, фон `--raised`, кольцо `0 0 0 1px var(--line)`. Первая строка `.usageMain` `font: 400 var(--fs-ui)/1.5 var(--ff-meta)`, цвет `--ink`; вторая `meta-prose`.
- Под сводкой таблица `AiUsage` (см. компоненты).
- Числовые лимиты `.limits`: `display: flex; flex-wrap: wrap; gap: var(--s-4)`, поле числа `width: 9rem`.
- Telegram делится на части `.part`: `display: grid; gap: var(--s-3); padding-top: var(--s-4); border-top: 1px solid var(--line)`, заголовок части `h3.partTitle` `font: 600 var(--fs-body)/var(--lh-h3) var(--ff-text)` (15px), цвет `--ink`. Строки состояния с точкой и шаги кода входа описаны в «Компонентах владельца».
- Кнопки выхода `.session`: `display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: flex-start`. Обе `ghost sm`: «Выйти на этом устройстве» (обычная `<form>`) и «Выйти на всех устройствах» (с подтверждением на месте).
- В шапке секции «Telegram» справа meta «Не настроен.», пока нет токена бота.

### Вход

Источник: `src/app/admin/login/page.tsx`, `src/app/admin/login/LoginForm.tsx`, `src/app/admin/login/login.module.css`

Скриншоты: `admin-login-1366-dark.png`, `admin-login-1366-light.png`, `admin-login-390-dark.png`, `admin-login-390-light.png`; на украинском `admin-login-1366-dark-uk.png`.

Раскладка:
- Шапка `TopBar view="owner" nav={false}`: только логотип, «UA RU EN» и тема. Ни разделов, ни состояния служб, ни «Выйти».
- `main.main`: `max-width: var(--page-owner); margin: 0 auto; padding: 8vh var(--gutter) 90px; display: grid; justify-items: center`.
- Одна панель `Panel` (`aria-label` «Вход»; фон `--surface`, радиус `--r-panel`, `--shadow`) с классом `.panel`: `width: 100%; max-width: 28rem; padding: 28px 28px 24px; display: grid; gap: var(--s-5)`, появляется анимацией `rise var(--dur-rise) var(--ease) both` (600ms).
- Внутри: `h1` «Вход» (`font: 500 40px/1.05 var(--ff-display); letter-spacing: -0.04em`), форма `.form` из форм владельца с `gap: var(--s-4)`: поле «Пароль» (`autocomplete="current-password"`), кнопка `primary` «Войти» (`justify-self: start`). Ниже под линией `.note` (`border-top: 1px solid var(--line); padding-top: var(--s-4)`) серая строка «Коллегам пароль не нужен: они входят по личной ссылке.».
- Второй шаг (код из Telegram): `h1` «Код из Telegram», поле кода `.code` (`max-width: 14rem; font-family: var(--ff-mono); font-size: var(--fs-body); letter-spacing: .16em`, `inputmode="numeric"`, `autocomplete="one-time-code"`), подсказка «Код отправлен в Telegram. Он действует 5 минут.», кнопки `primary` «Войти», `quiet` «Отправить ещё раз», `quiet` «Назад к паролю».
- Ошибки под полем в тоне `--danger` (`.error`) с `role="alert"`; при ошибке во введённом («Пароль не подошёл.», «Код не подошёл. Осталось попыток: {n}.», блокировка) поле получает `aria-invalid` и красное кольцо; сообщение «Новый код отправлен, прежний больше не действует.» идёт тем же абзацем с `role="alert"`, но в тоне `ok` (`.ok`, `--ink-2`). Когда отправок не осталось, «Отправить ещё раз» выключена и под полем подсказка «Больше отправок для этого входа нет. Введите последний код или вернитесь к паролю.».
- Во время отправки кнопки выключены, у «Войти» `aria-busy`.
- Телефон (до 640px): панель `padding: 22px 18px 20px`, `h1` 34px.

В `SPEC-DELTA.md` §5.8 логотип стоит внутри панели; в коде он только в шапке.

```css
.main { max-width: var(--page-owner); margin: 0 auto; padding: 8vh var(--gutter) 90px; display: grid; justify-items: center; }
.panel { width: 100%; max-width: 28rem; padding: 28px 28px 24px; display: grid; gap: var(--s-5); animation: rise var(--dur-rise) var(--ease) both; }
.h1 { font: 500 40px/1.05 var(--ff-display); letter-spacing: -0.04em; }
.form { gap: var(--s-4); }
.submit { justify-self: start; }
.code { max-width: 14rem; font-family: var(--ff-mono); font-size: var(--fs-body); letter-spacing: .16em; }
.note { border-top: 1px solid var(--line); padding-top: var(--s-4); }
@media (max-width: 640px) { .panel { padding: 22px 18px 20px; } .h1 { font-size: 34px; } }
@keyframes rise { from { opacity: 0; transform: translateY(6px); filter: blur(3px); } }
```

### Ошибка и «не найдено»

Источник: `src/app/admin/(panel)/error.tsx`, `src/app/admin/(panel)/not-found.tsx`

Обе страницы — `Panel` (`aria-label` = заголовок) с `Empty` внутри, внутри общей оболочки кабинета. «Такой страницы или задачи нет.» / «Возможно, номер набран с ошибкой. Найти задачу можно через поиск: Ctrl K.» и ссылка-кнопка `ghost sm` «Во «Входящие»». Ошибка: «Страница не открылась.» / «Попробуйте ещё раз. Если повторится, ищите в логе сервера код {digest}.» (без кода — «без кода») и кнопка `ghost sm` «Повторить». `Empty`: `padding: var(--s-8) var(--s-6)` (40px 24px), заголовок `500 var(--fs-h3)/var(--lh-h3) var(--ff-display)`, текст `--ink-2` до 44ch, действие с `margin-top: var(--s-4)`. Снимков нет.

## Компоненты владельца

Общие примитивы (`Panel`, `Block`, `Button`, `AgentChip`, `MetaList`, `Facts`, `Empty`, `Disclosure`, `InlineConfirm`, `Toasts`) описаны в разделе «Базовые компоненты». Здесь коротко их значения, на которые опираются компоненты владельца:
- `Panel`: фон `--surface`, `border-radius: var(--r-panel)` (20px), `box-shadow: var(--shadow)` (кольцо `--line` плюс `--shadow-drop`), сверху блик `::before` высотой 1px `linear-gradient(90deg, transparent, var(--line-2), transparent)`, `overflow: clip`.
- `Block`: `border-radius: var(--r-block)` (14px), кольцо `0 0 0 1px var(--line)`, `padding: 14px; margin-top: var(--s-3)`, фон `--raised`. Шапка блока `display: flex; justify-content: space-between; gap: var(--s-2) var(--s-3); flex-wrap: wrap; margin-bottom: 10px`.
- `AgentChip`: `inline-flex; gap: 7px; font-size: var(--fs-chip); line-height: 1.4; color: var(--ink-2); padding: 3px 9px 3px 7px; border-radius: 7px`, кольцо `--line-2`; точка 7px: `idle` `--ink-3`, `live` `--accent-solid` с `actum-pulse 1.6s infinite`, `done` `--accent-solid`, `attention` `--ask`.
- `MetaList`: `display: inline-flex; flex-wrap: wrap; align-items: baseline; column-gap: 1.25em; row-gap: 2px`. Разделителя «·» нет, только промежуток.
- `.meta` (глобально): `font: 400 var(--fs-meta)/var(--lh-meta) var(--ff-meta)` (13px/1.4), цвет `--ink-3`; `.meta b` вес 500, цвет `--ink-2`.

### CommandBar

Источник: `src/components/owner/CommandBar.tsx`, `src/components/owner/CommandBar.module.css`, `src/app/admin/(panel)/_components/OwnerCommandBar.tsx`

Поиск задач и людей и список команд кабинета. Открывается кликом по строке или сочетанием Ctrl K / ⌘ K.

Анатомия:
- Триггер `button.trigger` во всю ширину: `display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: var(--r-block)` (14px), фон `--surface`, `box-shadow: var(--shadow)`, цвет `--ink-3`, текст слева. Внутри иконка лупы (16px, линия 1.5px, `--ink-3`), текст «Поиск задачи, человека или команда…» (одна строка с многоточием) и справа подсказка `meta` «Ctrl K» (на Apple «⌘ K»), `margin-left: auto`.
- Диалог: нативный `<dialog>` через `showModal()`. `width: min(640px, calc(100vw - 2 * var(--gutter))); max-height: 76vh; margin: 12vh auto auto; padding: 0; border-radius: var(--r-panel)` (20px), фон `--surface`, `box-shadow: 0 0 0 1px var(--line-2), 0 40px 80px -30px rgb(0 0 0 / .55)`. Подложка `rgb(0 0 0 / .45)` с `backdrop-filter: blur(4px)`.
- Палитра `.palette`: колонка `max-height: 76vh`. Строка ввода `.inputRow` `display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line)`: лупа, поле `.input` (без рамки и фона, `font-size: 16px`, цвет `--ink`, до 200 символов), справа `<kbd>Esc</kbd>`.
- Список `.list`: `overflow-y: auto; padding: 6px; overscroll-behavior: contain`. Группы «Задачи» (до 8), «Люди» (до 5), «Команды»; пустые группы не показываются. Пока поле пустое, виден только список команд; при вводе команды отбираются по подстроке в названии, задачи и люди приходят из поиска. Между группами линия `--line` с отступами 4px. Подпись группы `meta` с `padding: 8px 10px 4px`.
- Пункт `.option`: `display: flex; align-items: baseline; gap: 12px; padding: 9px 10px; border-radius: var(--r-inner)` (8px), `font-size: var(--fs-ui)`. Для задачи: номер жирным в meta шириной 44px («0148»), название (`--ink`, одна строка с многоточием), справа человек в meta. Для человека: имя и отдел. Для команды: название и подсказка «раздел», «фильтр», «тема», «действие».
- Строки состояния `.status` (`padding: 14px 10px; font-size: var(--fs-ui); color: var(--ink-2)`): «Ищем…» и «Ничего не нашлось по «{q}».».

Состояния:
- hover триггера: цвет `--ink-2`, тень `0 0 0 1px var(--line-2), var(--shadow-drop)`.
- активный пункт (`aria-selected="true"`, меняется стрелками или наведением мыши): фон `--hover`, слева полоса `inset 2px 0 0 var(--accent-solid)`.

Движение: открытие `palette-in 160ms var(--ease) both` (из `opacity: 0; transform: scale(.96)`), подложка `backdrop-in 160ms linear both` (из `opacity: 0`). Тени триггера меняются за `--dur-fast`. Поиск с задержкой 150 мс после ввода.

Адаптив: до 640px или на сенсорном экране подсказка «Ctrl K» скрыта. Ширина диалога ограничена экраном минус два поля.

Доступность: триггер `aria-haspopup="dialog"`, `aria-keyshortcuts="Control+K Meta+K"`. Диалог `aria-label` «Поиск и команды». Поле `role="combobox"`, `aria-controls`, `aria-autocomplete="list"`, `aria-activedescendant`. Список `role="listbox"`, группы `role="group"` с подписью, пункты `role="option"`. Клавиши ↑ ↓ (по кругу), Enter, Esc; повторное Ctrl K закрывает диалог. Клик по подложке закрывает. После закрытия фокус возвращается на триггер.

Команды (`OwnerCommandBar`): «Входящие: открытые / новые / у агентов / готово / все», фильтры «Только срочные», «Высокая срочность», «Просроченные», «Отправленные как есть», «Без проверки», «Сбросить фильтры», разделы, «Добавить человека», «Подключить ПК», «Тема: Тёмная / Светлая / Как в системе», «Выйти». На ширине до 1060px найденная задача открывается отдельной страницей.

```css
.trigger {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 11px 14px; border: 0; border-radius: var(--r-block);
  background: var(--surface); box-shadow: var(--shadow); color: var(--ink-3); text-align: left;
  transition: box-shadow var(--dur-fast), color var(--dur-fast);
}
.trigger:hover { color: var(--ink-2); box-shadow: 0 0 0 1px var(--line-2), var(--shadow-drop); }
.shortcut { margin-left: auto; flex: none; white-space: nowrap; }
@media (max-width: 640px), (pointer: coarse) { .shortcut { display: none; } }

.dialog {
  width: min(640px, calc(100vw - 2 * var(--gutter))); max-height: 76vh; margin: 12vh auto auto; padding: 0;
  border: 0; border-radius: var(--r-panel); background: var(--surface); color: var(--ink);
  box-shadow: 0 0 0 1px var(--line-2), 0 40px 80px -30px rgb(0 0 0 / .55);
  overflow: hidden;
}
.dialog[open] { animation: palette-in 160ms var(--ease) both; }
.dialog::backdrop { background: rgb(0 0 0 / .45); backdrop-filter: blur(4px); }
.dialog[open]::backdrop { animation: backdrop-in 160ms linear both; }

.inputRow { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font-size: 16px; color: var(--ink); }
.list { overflow-y: auto; padding: 6px; overscroll-behavior: contain; }
.group + .group { margin-top: 4px; border-top: 1px solid var(--line); padding-top: 4px; }
.groupLabel { padding: 8px 10px 4px; }
.option {
  display: flex; align-items: baseline; gap: 12px; padding: 9px 10px; border-radius: var(--r-inner);
  cursor: pointer; font-size: var(--fs-ui); min-width: 0;
}
.option[aria-selected="true"] { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent-solid); }
.serial { flex: none; width: 44px; }
.hint { margin-left: auto; flex: none; white-space: nowrap; }

@keyframes palette-in { from { opacity: 0; transform: scale(.96); } }
@keyframes backdrop-in { from { opacity: 0; } }
```

### InboxTabs и TabIndicator

Источник: `src/components/owner/InboxTabs.tsx`, `src/components/owner/InboxTabs.module.css`, `src/components/owner/TabIndicator.tsx`

Вкладки над списком «Входящих»: «Открытые», «Новые», «У агентов», «Готово», «Все», у каждой число.

Анатомия:
- `nav.tabs` (`aria-label` «Какие задачи показать»): `border-bottom: 1px solid var(--line)`.
- Внутри `ScrollRow` `.scroller`: `position: relative; display: flex; gap: 2px; padding: 10px 12px; overflow-x: auto`. Отступ внутри прокрутки, чтобы обводка фокуса не обрезалась.
- Вкладка `.tab` — ссылка с `?view=` (у «Открытых» без параметра; текущие фильтры сохраняются): `position: relative; z-index: 1; display: inline-flex; align-items: center; white-space: nowrap`, цвет `--ink-3`, `font-size: var(--fs-small)` (13.5px), `line-height: 1.3; padding: 6px 10px; border-radius: var(--r-inner)`. Число `.count` в meta, `margin-left: 4px; font-size: 12px`; в отличие от шапки ноль тоже показывается. У ссылки есть ещё глобальный класс `tab`.

Состояния:
- hover: `--ink-2`.
- текущая (`aria-current="page"`): `color: var(--nav-on-ink); background: var(--nav-on)`, число `--nav-on-meta`. Та же плашка, что у пункта шапки.
- Скользящая плашка: `TabIndicator` — `span.indicator` под вкладками (`position: absolute; z-index: 0; border-radius: var(--r-inner); background: var(--nav-on); pointer-events: none`). Скрипт ставит ей ширину, высоту и `transform: translate(...)` по текущей вкладке и ставит ряду `data-indicator`; тогда у самой вкладки фон становится прозрачным. По клику плашка сразу едет к нажатой вкладке, пока грузится страница. Без JS видна собственная плашка вкладки.

Движение: плашка `transition: transform .32s var(--ease), width .32s var(--ease)`. При первом показе и при смене ширины ряда — без анимации. Цвет вкладок за `--dur-fast`.

Адаптив: до 640px `.scroller` `padding-inline: 8px`, вкладки `padding-inline: 8px`. Ряд прокручивается вбок с гаснущим краем (`ScrollRow`). На сенсорном экране `.tab` получает `min-height: 44px` из `base.css`.

Доступность: текущая вкладка `aria-current="page"`, плашка `aria-hidden="true"`.

```css
.tabs { border-bottom: 1px solid var(--line); }
.scroller { position: relative; display: flex; gap: 2px; padding: 10px 12px; overflow-x: auto; }
.tab {
  position: relative; z-index: 1; display: inline-flex; align-items: center; white-space: nowrap; text-decoration: none;
  color: var(--ink-3); font-size: var(--fs-small); line-height: 1.3; padding: 6px 10px; border-radius: var(--r-inner);
  transition: color var(--dur-fast), background-color var(--dur-fast);
}
.tab:hover { color: var(--ink-2); }
.tab[aria-current="page"] { color: var(--nav-on-ink); background: var(--nav-on); }
.indicator {
  position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 0; pointer-events: none;
  border-radius: var(--r-inner); background: var(--nav-on);
  transition: transform .32s var(--ease), width .32s var(--ease);
}
.scroller:not([data-indicator]) .indicator { display: none; }
.scroller[data-indicator] .tab[aria-current="page"] { background: transparent; }
.count { margin-left: 4px; font-size: 12px; }
.tab[aria-current="page"] .count { color: var(--nav-on-meta); }
@media (max-width: 640px) {
  .scroller { padding-inline: 8px; }
  .tab { padding-inline: 8px; }
}
```

### InboxItem

Источник: `src/components/owner/InboxItem.tsx`, `src/components/owner/InboxItem.module.css`, `src/app/admin/(panel)/inbox/_components/inbox-rows.tsx`

Строка списка «Входящих»: номер, название, мета-строка, агент справа.

Анатомия:
- `ul.list` без маркеров; `li` с нижней линией `1px solid var(--line)`, у последнего линии нет.
- Ссылка `a.item`: `display: grid; grid-template-columns: 62px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 14px 18px`.
- Колонка 1: номер жирным в meta, только цифры: «0148».
- Колонка 2 `.main` (`display: grid; gap: 1px`): название `.title` (вес 500, одна строка с многоточием) и `MetaList` (человек; срок «до {дата}», «не горит», «срок не указан»; время или состояние запуска: «в очереди», «выполняется {n} мин», «готово, ждёт проверки», «требует внимания», «ждёт запуска»; флаги). Просроченный срок цветом `--ask`. Флаги `.flag` цветом `--ask` («как есть», «не проверено», «несколько задач», «срок под вопросом»…).
- Колонка 3 `.who`: `display: flex; gap: var(--s-2); align-items: center; justify-content: flex-end; max-width: 160px`. `AgentChip` агента (`live` — запуск идёт, `done` — запуск выполнен, `attention` — ошибка, требует внимания или нужны данные владельца, иначе `idle`; состояние словами для скринридера: «работает», «закончил», «требует внимания») или meta-текст, без агента «—».
- Закрытая задача (готово, отклонена, отменена): в мете нет срока и флагов, вместо состояния «закрыто {дата}», справа meta «готово», «отклонена» или «отменена» вместо чипа.

Состояния:
- hover: фон `--hover`.
- выбранная (`aria-current="true"`): фон `--hover` и слева полоса `inset 2px 0 0 var(--accent-solid)`. В спеке указан `--accent`; в коде `--accent-solid`, это важно для светлой темы, где бледный `--accent` (#D9CCFF) почти не виден на белом.
- непросмотренная (`data-unseen`): название вес 600.
- focus-visible: обводка внутрь (`outline-offset: -2px`), углы прямые.
- новая строка при обновлении: класс `.fresh` (см. «Входящие»).

Движение: фон за `--dur-fast`.

Адаптив: до 640px `grid-template-columns: 44px minmax(0, 1fr); row-gap: 6px; padding: 12px 16px`; `.who` переходит во вторую колонку под название (`grid-column: 2; justify-content: flex-start`).

```css
.li { border-bottom: 1px solid var(--line); }
.li:last-child { border-bottom: 0; }
.item {
  display: grid; grid-template-columns: 62px minmax(0, 1fr) auto; gap: 14px; align-items: center;
  padding: 14px 18px; color: inherit; text-decoration: none; transition: background-color var(--dur-fast);
}
.item:hover { background: var(--hover); }
.item:focus-visible { outline-offset: -2px; border-radius: 0; }
.item[aria-current] { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent-solid); }
.main { min-width: 0; display: grid; gap: 1px; }
.title { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item[data-unseen] .title { font-weight: 600; }
.flag { color: var(--ask); }
.who { display: flex; gap: var(--s-2); align-items: center; justify-content: flex-end; min-width: 0; max-width: 160px; }
@media (max-width: 640px) {
  .item { grid-template-columns: 44px minmax(0, 1fr); row-gap: 6px; padding: 12px 16px; }
  .who { grid-column: 2; justify-content: flex-start; }
}
```

```html
<ul class="list" aria-label="Список задач">
  <li class="li">
    <a class="item" href="/admin/inbox?task=148" aria-current="true" data-unseen>
      <span class="meta"><b>0148</b></span>
      <span class="main">
        <span class="title">Вивантажити з CRM оптових клієнтів</span>
        <span class="metaList meta">
          <span class="metaItem">Анна Ковальова</span><span class="vh">, </span>
          <span class="metaItem">до 27.10</span><span class="vh">, </span>
          <span class="metaItem">ждёт запуска</span><span class="vh">, </span>
          <span class="metaItem"><span class="flag">как есть</span></span>
        </span>
      </span>
      <span class="who">
        <span class="chip" data-state="done"><i class="dot" aria-hidden="true"></i><span class="name">CRM через браузер</span><span class="vh">, закончил</span></span>
      </span>
    </a>
  </li>
</ul>
```

`MetaList` разделяет пункты только промежутком 1.25em; между пунктами стоит скрытая запятая для скринридера (`.vh`). В коде классы пунктов меты и ссылки строки разные (CSS Modules); при переносе не давайте им одно имя, иначе пункты меты получат сетку строки.

### TaskSide

Источник: `src/components/owner/TaskSide.tsx`, `src/components/owner/TaskSide.module.css`, `src/components/ui/Facts.module.css`, `src/app/admin/(panel)/inbox/_components/TaskDetail.tsx`, `src/app/admin/(panel)/inbox/_components/inbox.module.css`, `src/app/admin/(panel)/inbox/_components/MarkSeen.tsx`

Карточка выбранной задачи: в правой колонке «Входящих» и на отдельной странице задачи.

Анатомия:
- `Panel as="aside"` (`aria-label` «Карточка задачи», `data-taskside`), `.side { padding: 20px }`.
- Мета-строка `MetaList`: «№ 0148» жирным, время получения («сегодня 14:32», «вчера 14:32», «{дата}, {время}»), человек «{имя}, {отдел}».
- Заголовок `h2.title`: `font: 500 var(--fs-h2)/var(--lh-h2) var(--ff-display)` (24px/1.15), `letter-spacing: var(--tr-h2)` (-0.025em), `margin: 10px 0 16px`, `text-wrap: balance`. Получает фокус программно (`tabindex="-1"`), без обводки.
- Флаги `.flags` (`margin: -6px 0 14px`), слова цветом `--ask`.
- Предупреждения `.notices` (`display: grid; gap: 6px; margin: 0 0 16px`), каждое `.notice`: `font-size: var(--fs-ui); color: var(--ink); padding: 10px 12px; border-radius: var(--r-chip)` (9px), фон `--ask-wash`, слева полоса `inset 2px 0 0 var(--ask)`. Тексты: «Отправлено как есть: «{note}»», «Не проверено: сервис проверки не ответил ({reason}). Задача принята без проверки.», «В тексте похоже на попытку повлиять на проверку.».
- Факты `Facts` (`dl`): `grid-template-columns: 96px minmax(0, 1fr); gap: var(--s-2) 14px; margin: 0 0 18px; font-size: var(--fs-ui)`; термины строчными в meta: «что», «зачем», «готово», «срок», «материалы». Пустое значение — meta «не указано». В сроке: дата жирным в meta (просрочено — `--ask` и слово «просрочено»), затем срочность через отступ `margin-left: 1.25em`. Места `[уточнити …]` / `[уточнить …]` / `[clarify …]` — цветом `--ask` с пунктирной нижней линией `border-bottom: 1px dashed var(--ask-line)` (`.unknown`). Ссылки в материалах цветом `--accent-text`.
- Раскрывашка «Исходный текст» (`Disclosure`, линия сверху `--line`); открыта сразу, если из текста ничего не разобрано.
- Разделы карточки `.section`: `margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); display: grid; gap: 10px`. Заголовок `h3.sectionTitle` `font: 500 var(--fs-ui)/1.3 var(--ff-text)`, цвет `--ink`. Разделы: «Ответы на уточнения» (вопрос `--ink-3` `--fs-meta`, ответ обычным текстом), «Файлы», ответ коллеге, «Ход задачи», «Разбор и проверка».
- Блок агента `.agentCol`: две обёртки `.block` (`margin-top: 12px`), в первой `AgentPanel` (план `AgentPlanBlock` или выбор агента), во второй `RunPanel` (запуск `RunLogBlock`), если запуск был. Внутри каждой свой `Block`. У закрытой задачи без запуска и без маршрута блока агента нет.
- «Ход задачи» `.timeline` (`display: grid; gap: 10px`): событие `.event` `grid-template-columns: 76px minmax(0, 1fr); gap: 10px; font-size: var(--fs-ui)`. Время в meta, затем кто (`--ink-2`, вес 500, `margin-right: 6px`: «Вы», имя коллеги, «Агент», «Система») и текст (`white-space: pre-wrap`). Текст коллеги (`data-actor="colleague"`) `--ink`, события агента и смены статуса (`data-type="agent"`, `"status_changed"`, например «Статус: {from} → {to}») `--ink-2`, остальное цветом текста карточки. До 640px одна колонка с `gap: 2px`.
- «Разбор и проверка»: раскрывашка с meta справа («разборов: {n}», «финальная проверка: принята с {k}-й попытки»); внутри список попыток и вложенная раскрывашка «Технические подробности» (`pre.tech`: `font: 400 12px/1.6 var(--ff-meta)`, цвет `--ink-3`).

Адаптив: до 640px `.side { padding: 18px 16px }`; факты до 380px `grid-template-columns: 80px minmax(0, 1fr)`.

Доступность: клавиша R внутри карточки открывает подтверждение запуска (см. `AgentPlanBlock`), область ограничена атрибутом `data-taskside`. Когда карточка показана, задача помечается просмотренной: если владелец её ещё не видел, `TaskDetail` рендерит `MarkSeen`, который ничего не рисует и шлёт отметку из эффекта (не во время рендера). Страницу он не обновляет: вес 600 у строки списка (`data-unseen`) уходит, когда список перерисуется с сервера (когда именно, не проверено).

```css
.side { padding: 20px; }
.title { font: 500 var(--fs-h2)/var(--lh-h2) var(--ff-display); letter-spacing: var(--tr-h2); margin: 10px 0 16px; text-wrap: balance; overflow-wrap: anywhere; }
.flags { margin: -6px 0 14px; }
.flag { color: var(--ask); }
.notices { display: grid; gap: 6px; margin: 0 0 16px; }
.notice {
  font-size: var(--fs-ui); color: var(--ink); padding: 10px 12px; border-radius: var(--r-chip);
  background: var(--ask-wash); box-shadow: inset 2px 0 0 var(--ask);
}
@media (max-width: 640px) { .side { padding: 18px 16px; } }

/* разделы карточки (inbox.module.css) */
.section { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); display: grid; gap: 10px; }
.sectionTitle { font: 500 var(--fs-ui)/1.3 var(--ff-text); color: var(--ink); }
.event { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; font-size: var(--fs-ui); }
.unknown { color: var(--ask); border-bottom: 1px dashed var(--ask-line); }
```

### AgentPlanBlock

Источник: `src/components/owner/AgentPlanBlock.tsx`, `src/components/owner/AgentPlanBlock.module.css`

План агента в карточке задачи: какой агент, насколько Claude уверен, шаги плана и кнопки запуска.

Анатомия (внутри `Block`, `aria-label` «План агента»):
- Шапка: слева `AgentChip` в состоянии `done` с текстом «Агент {name}», справа meta «уверенность высокая / средняя / низкая» или «выбран вручную».
- Шаги `ol.steps` (без маркеров, свой счётчик): каждый шаг `display: grid; grid-template-columns: 28px minmax(0, 1fr); font-size: var(--fs-ui); padding: 4px 0`. Номер «01», «02» (`decimal-leading-zero`) шрифтом `--ff-meta` 12px/1.9, цвет `--ink-3`.
- Редактор плана (если раскрыт «Изменить план»): `margin-top: 12px`. Поля «План», «Указания агенту», список «Риски».
- Последний запуск `.outcome` (`margin-top: 12px`): `MetaList` «Последний запуск», статус жирным, время. Статус `done` — `--ink`; `attention` — `--ask`; `off` (отменён) — вес 400, `--ink-3`.
- Кнопки `.acts`: `display: flex; gap: var(--s-2); margin-top: 14px; flex-wrap: wrap; align-items: flex-start`. `primary` «Запустить на ПК» с `<kbd>R</kbd>` (после первого запуска `ghost` «Запустить снова»), `ghost` «Изменить план» (`aria-expanded`), `ghost` «Другой агент», `quiet` «Спросить Claude ещё раз».
- Заметка `.note` (`meta-prose`, `margin-top: 10px`): например «Раннер офлайн: задача подождёт в очереди.».

Состояния:
- подтверждение запуска (`InlineConfirm`, `placement="below"`: полоса под кнопкой сдвигает содержимое вниз; `padding: 10px 12px 10px 14px; border-radius: var(--r-block)`, фон `--raised`, кольцо `0 0 0 1px var(--line-2)`, вопрос `--fs-ui` `--ink` до 52ch, появление `actum-fade var(--dur-base)`): «Запустить агента «{name}» на вашем ПК? Агент сможет: {capabilities}.», кнопки `primary sm` «Да, запустить» и `quiet sm` «Отмена». Фокус уходит на «Да, запустить», Esc закрывает.
- идёт активный запуск: кнопки скрыты, клавиша R не работает.

Доступность: R без модификаторов открывает подтверждение, только когда фокус внутри карточки задачи и не в текстовом поле. Шаги — список `ol` с `aria-label`.

```css
.steps { list-style: none; margin: 0; padding: 0; counter-reset: s; }
.steps li { counter-increment: s; display: grid; grid-template-columns: 28px minmax(0, 1fr); font-size: var(--fs-ui); padding: 4px 0; }
.steps li::before { content: counter(s, decimal-leading-zero); font: 400 12px/1.9 var(--ff-meta); color: var(--ink-3); }
.acts { display: flex; gap: var(--s-2); margin-top: 14px; flex-wrap: wrap; align-items: flex-start; }
.outcome { margin-top: 12px; }
.outcome b[data-tone="done"] { color: var(--ink); }
.outcome b[data-tone="attention"] { color: var(--ask); }
.outcome b[data-tone="off"] { font-weight: 400; color: var(--ink-3); }
```

### RunLog и RunLogBlock

Источник: `src/components/owner/RunLog.tsx`, `src/components/owner/RunLog.module.css`, `src/app/admin/(panel)/inbox/_components/RunPanel.tsx`

Лог выполнения агента на ПК: строки «14:20  прочитал договор…», мигающий курсор на последней строке, пока агент работает.

Анатомия `RunLogBlock` (внутри `Block`, `aria-label` «Лог выполнения»):
- Шапка: слева `MetaList` «№ 0147» жирным и статус («агент работает», «в очереди», «выполнено», «ошибка: {reason}»…); справа `MetaList` со стоимостью «≈ $0.18» (`title` «оценка Claude Code») и длительностью «5:12».
- Тело: `RunLog`, под ним при обрезке строка `meta-prose` (`margin-top: 8px`) «Лог обрезан на 5000 строк…».
- Кнопки `.actions`: `display: flex; gap: var(--s-2); flex-wrap: wrap; margin-top: 14px`. Набор зависит от запуска (`RunPanel`): пока запуск активен, одна `ghost sm` с подтверждением на месте «Отменить выполнение» (при отложенном автозапуске «Отменить автозапуск»); после выполнения одна `primary sm` «Отметить выполненной и написать коллеге» (`aria-expanded`), которая раскрывает форму сообщения коллеге; у отменённого, упавшего или уже закрытого запуска кнопок нет.

Анатомия `RunLog`:
- `.frame` задаёт шаг строки `--log-line` = `--fs-small` × `--lh-log` (13.5 × 1.9), округлённый до целых px через `round()`, где он поддерживается.
- `.box` (прокрутка): `max-height: calc(var(--log-line) * 10)` — ровно десять строк, срез всегда между строками; `overflow-y: auto; overscroll-behavior: contain; border-radius: var(--r-tag)`.
- `ul.log`: `font: 400 var(--fs-small)/var(--log-line) var(--ff-meta)`, цвет `--ink-2`, `overflow: clip`. Время `.at` цветом `--ink-3`, `margin-right: 10px`.
- Края: `::before` и `::after` высотой в одну строку, градиент из `--raised` в прозрачный. Показываются, когда выше или ниже есть скрытые строки (`data-above`, `data-below`).

Виды строк (`data-kind`): `tool` — `--ink-2` (по умолчанию); `text` — `--ink-3`; `denied` — `--ask`; `error` — `--danger`; `retry` и `system` — 12px, `--ink-3`. Последняя строка во время работы (`data-now`) — `--ink` и курсор «▍» цветом `--accent-solid` с `margin-left: 4px`.

Движение: каждая строка въезжает `line-in .4s var(--ease) both` (из `opacity: 0; translateY(3px)`). Курсор мигает `actum-blink 1s steps(1) infinite`. Края проявляются за `--dur-fast`. Живой лог сам прокручивается к последней строке, пока владелец не прокрутил вверх; законченный лог открывается с первой строки.

Доступность: коробка `role="region"`, `aria-label` «Лог выполнения», `tabindex="0"` (прокручивается с клавиатуры, при `focus-visible` `outline-offset: 2px`). Лог не объявляется скринридером; объявляется только смена текста статуса запуска (`RunPanel` через общую live-область).

Пустой активный запуск: под блоком `meta-prose` «Агент ещё ничего не написал.».

Под блоком (`RunPanel`, `agent.module.css`, всё в `.stack` `display: grid; gap: var(--s-3)`): строка `MetaList` `.runMeta` (`margin-top: 10px`) с профилем, «запуск вручную» / «запуск автоматически», «шагов: {n}», «отказов в разрешениях: {n}», «≈ ${cost}, оценка Claude Code», «Коллеге написали {when}.»; «Продолжить вручную» с командой `pre.cmd` и кнопкой `ghost sm` «Скопировать»; отчёт агента `.report` (см. ниже).

```css
.frame { --log-line: calc(var(--fs-small) * var(--lh-log)); position: relative; isolation: isolate; }
@supports (width: round(1px, 1px)) { .frame { --log-line: round(var(--fs-small) * var(--lh-log), 1px); } }
.box { max-height: calc(var(--log-line) * 10); overflow-y: auto; overscroll-behavior: contain; border-radius: var(--r-tag); }
.frame::before,
.frame::after {
  content: ""; position: absolute; z-index: 1; height: var(--log-line); pointer-events: none;
  opacity: 0; transition: opacity var(--dur-fast) var(--ease);
}
.frame::before { inset: 0 0 auto; background: linear-gradient(var(--raised), transparent); }
.frame::after { inset: auto 0 0; background: linear-gradient(transparent, var(--raised)); }
.frame[data-above]::before,
.frame[data-below]::after { opacity: 1; }
.log { font: 400 var(--fs-small)/var(--log-line) var(--ff-meta); color: var(--ink-2); margin: 0; padding: 0; list-style: none; overflow: clip; }
.log li { overflow-wrap: anywhere; animation: line-in .4s var(--ease) both; }
.at { color: var(--ink-3); margin-right: 10px; }
.log li[data-kind="text"] { color: var(--ink-3); }
.log li[data-kind="denied"] { color: var(--ask); }
.log li[data-kind="error"] { color: var(--danger); }
.log li[data-kind="retry"],
.log li[data-kind="system"] { font-size: 12px; color: var(--ink-3); }
.log li[data-now] { color: var(--ink); }
.log li[data-now]::after { content: "▍"; margin-left: 4px; color: var(--accent-solid); animation: actum-blink 1s steps(1) infinite; }
@keyframes actum-blink { 50% { opacity: 0; } }
@keyframes line-in { from { opacity: 0; transform: translateY(3px); } }
```

### Блок агента до плана и отчёт (AgentPanel, RunPanel)

Источник: `src/app/admin/(panel)/inbox/_components/AgentPanel.tsx`, `src/app/admin/(panel)/inbox/_components/RunPanel.tsx`, `src/app/admin/(panel)/inbox/_components/agent.module.css`

Обёртки вокруг `AgentPlanBlock` и `RunLogBlock`: агент ещё не выбран, выбор вручную, отчёт после запуска.

- Агент не назначен: `Block` с `AgentChip` в состоянии `idle` и текстом «Агент», под ним строка `.line` (`font-size: var(--fs-ui); color: var(--ink-2); margin-bottom: 10px`): «Claude подбирает агента…» (мигает `breathe 1.6s ease-in-out infinite`), «Агент не определён: выберите вручную.», «Подходящего агента нет. Можно выбрать вручную.», «Агент не назначен.», без раннера «ПК не подключён: задача подождёт в очереди, пока вы не подключите его в разделе «Агенты».». Кнопки `ghost sm` «Другой агент» (выключена без профилей), `quiet sm` «Спросить Claude ещё раз» (выключена, когда попытки исчерпаны).
- Формы выбора агента и подсказки для Claude: `.panel` `display: grid; gap: var(--s-3); margin-top: 4px; padding-top: 12px; border-top: 1px solid var(--line)`, поля из форм владельца, кнопки `primary sm` («Назначить», «Перенаправить», «Спросить») и `quiet sm` «Отмена».
- «Что нужно от вас»: `.notice` в тоне `--ask-wash` с полосой `inset 2px 0 0 var(--ask)`, `padding: 10px 12px; border-radius: var(--r-chip)`, заголовок списка `.listTitle` (`--fs-meta`, 500, `--ink-2`).
- История маршрутизации: `details.history` (`margin-top: 10px`), `summary` в meta «История маршрутизации (попыток: {n})» без стандартного маркера; свой маркер «›» (`margin-right: 6px`) поворачивается на 90° за `--dur-fast` при открытии. Строки внутри в meta, `gap: 4px`.
- Команда «Продолжить вручную»: `pre.cmd` (`flex: 1 1 260px; padding: 9px 12px; border-radius: var(--r-chip)`, фон `--surface`, кольцо `--line-2`, `font: 400 12.5px/1.6 var(--ff-mono)`, цвет `--ink-2`) и рядом кнопка копирования.
- Отчёт агента `.report`: `display: grid; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line)`. Заголовок «Отчёт агента» (`500 var(--fs-ui)/1.3 var(--ff-text)`), сводка `--fs-ui`, списки «Сделано», «Осталось», «Ссылки» (ссылки `--accent-text`), «Изменённые файлы» (`.files`, моно 12.5px/1.6, `--ink-2`). Без отчёта — `pre.pre` с последним ответом (моно 12.5px/1.6, фон `--surface`, кольцо `--line`, `max-height: 280px`).
- Ошибка запуска `.fail`: `--ask`, `--fs-ui`. Нет связи: «Нет связи с сервером, повторяем…» (`meta-prose`, `margin-top: 8px`).

### ReplyBox

Источник: `src/app/admin/(panel)/inbox/_components/ReplyBox.tsx`, `src/app/admin/(panel)/inbox/_components/inbox.module.css`

Ответ коллеге и смена статуса задачи одной формой.

Анатомия: `form.reply` `display: grid; gap: var(--s-3)`. Поле «Ответ коллеге» (3 строки, до 2000 символов, плейсхолдер «Например: беру, пришлю файл до вечера»), подсказка «{name} увидит его в «Моих задачах». Статус: {status}.». Ряд кнопок `.replyActions` (`display: flex; flex-wrap: wrap; gap: var(--s-2); align-items: center`): кнопки статуса размера `sm`, только разрешённые из текущего статуса, первая `primary`, остальные `ghost` (по порядку «Взять в работу», «Готово», «Отклонить», «Вернуть в новые»; для готовой — одна «Вернуть в работу», для отклонённой — одна «Вернуть в новые»); справа `ghost sm` «Отправить» с `margin-left: auto`.

Состояния: во время отправки форма `aria-busy`, кнопки выключены. Пустой ответ без статуса: поле `aria-invalid` (красное кольцо), ошибка `role="alert"` «Напишите ответ или выберите статус.». Статус уже сменился: «Статус уже изменился. Обновите страницу.». Успех: форма очищается, тост и объявление «Сохранено. {name} увидит это в «Моих задачах».» или «Статус: {status}. {name} увидит это в «Моих задачах».» (с подключённым Telegram добавляется «…и получит сообщение в Telegram.»). Отменённая задача: вместо формы строка `meta-prose` «Коллега отменил задачу, отвечать уже не нужно.».

### Section и PageHead

Источник: `src/app/admin/(panel)/_components/Section.tsx`, `src/app/admin/(panel)/_components/shell.module.css`

Каркас всех страниц кабинета кроме «Входящих»: шапка страницы и секции-панели с настоящим `h2`.

`PageHead`:
- `.head`: `display: grid; gap: var(--s-2); margin: var(--s-3) 0 var(--s-2)`.
- Ссылка назад `.back` («← Люди»): `font-size: var(--fs-ui)`, цвет `--ink-3`, без подчёркивания, `justify-self: start`; hover `--ink`.
- `h1.h1`: `font: 500 40px/1.05 var(--ff-display); letter-spacing: -0.04em`, `tabindex="-1"`. До 760px 32px. Это не `--fs-h1` (52px), а своё значение кабинета.
- Вводная строка `.lead`: цвет `--ink-2`, `max-width: 62ch`.

`Section` (`Panel as="section"`; если задан `id`, то `aria-labelledby` указывает на свой `h2` с id `{id}-title`, на всех страницах кабинета `id` задан):
- Шапка `.sectionHead`: `display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); flex-wrap: wrap; padding: 14px 18px; border-bottom: 1px solid var(--line)`. Заголовок `h2.h2` `font: 500 17px/1.25 var(--ff-display); letter-spacing: -0.015em`. Справа необязательная meta (число, «Не настроен.», состояние ссылки).
- Тело `.sectionBody`: `padding: 18px; display: grid; gap: var(--s-4)`. Вариант `flush`: `padding: 0; gap: 0`, строки рисуют свои отступы.
- Строки `.rows` / `.rowItem`: `padding: 14px 18px; border-bottom: 1px solid var(--line); display: grid; gap: 6px`, у последней линии нет.
- Пустое место `.empty`: `padding: 28px 18px`.
- До 640px: тело `padding: 16px`, шапка `padding: 12px 16px`, строки `padding: 12px 16px`.

Служебные блоки там же:
- `.secret` (новый токен раннера): `display: grid; gap: var(--s-3); padding: 14px; border-radius: var(--r-block)`, фон `--accent-wash`, кольцо `inset 0 0 0 1px var(--accent-line)`, появление `lift var(--dur-base) var(--ease)` (из `opacity: 0; translateY(8px)`). Заголовок `.secretTitle` `500 var(--fs-h3)/var(--lh-h3) var(--ff-display)`.
- `.code` (команды, токен): `padding: 12px 14px; border-radius: var(--r-chip)`, фон `--raised`, кольцо `0 0 0 1px var(--line)`, `font: 400 13px/1.7 var(--ff-mono)`, цвет `--ink-2`, `white-space: pre-wrap`.
- `.notice` (человек в архиве): как предупреждение карточки задачи: `--ask-wash`, полоса 2px `--ask`, `padding: 10px 12px; border-radius: var(--r-chip)`.

```css
.head { display: grid; gap: var(--s-2); margin: var(--s-3) 0 var(--s-2); }
.back { font-size: var(--fs-ui); color: var(--ink-3); text-decoration: none; justify-self: start; }
.back:hover { color: var(--ink); }
.h1 { font: 500 40px/1.05 var(--ff-display); letter-spacing: -0.04em; overflow-wrap: anywhere; }
.lead { color: var(--ink-2); max-width: 62ch; }
@media (max-width: 760px) { .h1 { font-size: 32px; } }

.sectionHead {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); flex-wrap: wrap;
  padding: 14px 18px; border-bottom: 1px solid var(--line);
}
.h2 { font: 500 17px/1.25 var(--ff-display); letter-spacing: -0.015em; }
.sectionBody { padding: 18px; display: grid; gap: var(--s-4); min-width: 0; }
.flush { padding: 0; gap: 0; }
@media (max-width: 640px) { .sectionBody { padding: 16px; } .sectionHead { padding: 12px 16px; } }
.rowItem { padding: 14px 18px; border-bottom: 1px solid var(--line); display: grid; gap: 6px; min-width: 0; }
.rowItem:last-child { border-bottom: 0; }
```

```html
<section class="panel section" id="runner" aria-labelledby="runner-title">
  <div class="sectionHead">
    <h2 class="h2" id="runner-title">Раннер</h2>
    <div class="meta">1</div>
  </div>
  <div class="sectionBody flush">
    <ul class="rows"><li class="rowItem">…</li></ul>
  </div>
</section>
```

### Формы владельца

Описание: см. раздел «Формы и поля» (поля, подписи, флажки, чипы-радио, сетки `.grid2`/`.grid3`, `.copyRow`, поле кода).

### InviteSlip

Источник: `src/app/admin/(panel)/people/_components/InviteSlip.tsx`, `src/app/admin/(panel)/people/_components/people.module.css`

Карточка «Ссылка готова: {name}» после создания человека или перевыпуска ссылки: личная ссылка и готовое украинское сообщение, оба копируются.

Анатомия: `.slip` `display: grid; gap: var(--s-3); padding: 16px; border-radius: var(--r-block)` (14px), фон `--raised`, двойное кольцо `0 0 0 1px var(--accent-line), 0 0 0 4px var(--accent-wash)`. Заголовок `h3.slipTitle` `500 var(--fs-h3)/var(--lh-h3) var(--ff-display)` (20px), `letter-spacing: var(--tr-h3)`. Текст `.slipText` («Отправьте её лично. По ссылке входят без пароля, она работает, пока вы её не отзовёте.») `--fs-ui`, `--ink-2`, `max-width: 60ch`. Поле «Ссылка для входа» (`input` только чтение, `.mono`, фон `--surface`, выделяется целиком при фокусе) и кнопка `primary sm` «Скопировать ссылку» (тост «Ссылка скопирована»). Поле «Готовое сообщение» (`textarea` только чтение, 3 строки, `lang="uk"`) и кнопка `ghost sm` «Скопировать сообщение». Обе пары стоят в `.copyRow`.

Движение: появление `lift var(--dur-base) var(--ease) both` (из `opacity: 0; translateY(8px)`).

Доступность: `role="region"` с `aria-labelledby` на заголовок; фокус переходит на заголовок (`tabindex="-1"`, без обводки).

### Ссылка, входы и архив (LinkActions, PersonControls)

Источник: `src/app/admin/(panel)/people/_components/LinkActions.tsx`, `src/app/admin/(panel)/people/_components/PersonControls.tsx`, `src/app/admin/(panel)/people/_components/people.module.css`, `src/app/admin/_ui/forms.module.css`

Кнопки управления личной ссылкой и входами человека: в строке списка «Все люди» (`.personActions`) и в секциях карточки человека.

`LinkActions` (ряд под строкой человека и секция «Ссылка для входа»):
- Обёртка `.linkBox`: `display: grid; gap: var(--s-3); min-width: 0`. Внутри ряд `.actions` из форм владельца (`flex; gap: var(--s-2) var(--s-3); flex-wrap: wrap; align-items: center`), под ним строка ошибки и, если ссылку показали или выпустили, `InviteSlip`.
- Ссылка действует: `ghost sm` «Показать ссылку» (`aria-expanded`, раскрывает `InviteSlip`), `quiet sm` «Новая ссылка» с подтверждением на месте «Выпустить новую ссылку? Старая перестанет работать сразу, входы по ней завершатся.» / «Да, выпустить» / «Отмена», `quiet sm` «Отозвать» с подтверждением «Ссылка перестанет работать, войти по ней будет нельзя. Отозвать?» / «Да, отозвать». Если у человека включён автозапуск или подключён Telegram, к вопросу добавляется предложение о том, что автозапуск выключится или Telegram отключится.
- Ссылки нет или она отозвана: одна `ghost sm` «Выпустить ссылку».
- У архивного человека блока нет.
- Пока идёт запрос, «Показать ссылку» и «Выпустить ссылку» выключены (`disabled`); у подтверждений свои состояния ожидания (см. `InlineConfirm`). Ошибка: `p.error role="alert"` (`--danger`), например «Ссылку нельзя показать: секрет сервера сменился. Выпустите новую.». Успешный отзыв: тост «Ссылка отозвана.».

`PersonControls`:
- «Данные» (`PersonEditForm`): `form.form` с `aria-busy`, поля человека, ряд `.actions` с `primary sm` «Сохранить»; ошибка `p.error role="alert"`, успех тостом «Данные сохранены.».
- «Агенты» (`AutoRunToggle`): флажок `.check` «Разрешить автозапуск агентов по задачам этого человека» с подсказкой. Сохраняет сразу: на время запроса `disabled`, тост «Сохранено»; при ошибке галочка возвращается и тост-ошибка «Не получилось сохранить. Проверьте соединение.».
- «Входы» (`SessionsList`): сверху строка `meta-prose` об использовании ссылки (если есть), без сессий `meta-prose` «Активных входов нет.». Список `.sessions` (`list-style: none; display: grid; gap: 0`), строка `.session` (`display: flex; justify-content: space-between; align-items: center; gap: var(--s-3); flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid var(--line)`, у последней линии нет): слева `.sessionMain` (`display: grid; gap: 2px; font-size: var(--fs-ui)`) с браузером и системой и `MetaList` (IP, «вход {when}», «активность {when}»), справа `quiet sm` «Завершить». Под списком `meta-prose` «Чужой вход? «Завершить» не поможет, пока ссылка действует — выпустите новую.» и ряд `.actions`: `ghost sm` «Завершить все» (если входов больше одного) и `quiet sm` «Выпустить новую ссылку» с тем же подтверждением, что у «Новая ссылка»; после выпуска под рядом появляется `InviteSlip`.
- «Архивировать» / «Вернуть из архива» (`ArchiveControls`): `ghost sm` «Архивировать» с подтверждением «Архивировать {name}? Ссылка перестанет работать, входы завершатся. Задачи останутся.» / «Да, архивировать». У архивного: `meta-prose` «Вместе с возвратом будет выпущена новая ссылка.» и `ghost sm` «Вернуть из архива» (`disabled`, пока идёт запрос). После возврата страница перерисовывается уже не архивной, и в этой же секции под «Архивировать» появляется `InviteSlip` с новой ссылкой (по коду; в браузере не проверено). Обе части стоят в `.form` (`display: grid; gap: var(--s-4)`).

```css
.linkBox { display: grid; gap: var(--s-3); min-width: 0; }
.sessions { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
.session {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); flex-wrap: wrap;
  padding: 10px 0; border-bottom: 1px solid var(--line);
}
.session:last-child { border-bottom: 0; }
.sessionMain { display: grid; gap: 2px; min-width: 0; font-size: var(--fs-ui); }
```

### CopyButton и LogoutButton

Источник: `src/app/admin/(panel)/_components/CopyButton.tsx`, `src/app/admin/(panel)/_components/LogoutButton.tsx`

- `CopyButton`: `Button` (по умолчанию `ghost sm`; у главного значения, например ссылки в `InviteSlip`, `primary sm`) с `CopyIcon` 16px перед текстом. После нажатия текст на 2 секунды меняется на «Скопировано», и показывается тост («Скопировано», «Ссылка скопирована», «Команда скопирована»). Если буфер недоступен, ничего не меняется: значение остаётся в поле для ручного выделения. Обычно стоит в `.copyRow` рядом с полем (см. «Формы и поля» → «Поле с кнопкой копирования»).
- `LogoutButton`: `<form>` с одной кнопкой `quiet sm` «Выйти» (в шапке) или `ghost sm` «Выйти на этом устройстве» (в настройках). Работает без JS.

### Строки состояния и шаги в настройках Telegram

Источник: `src/app/admin/(panel)/settings/_components/settings.module.css`, `src/app/admin/(panel)/settings/_components/SettingsControls.tsx`, `src/app/admin/(panel)/settings/_components/Admin2fa.tsx`

Секция делится на части `.part` с `role="group"` и `aria-labelledby` на `h3.partTitle`: «Куда бот пишет мне», «Коллеги», «Вход по коду»; над ними строка бота (`.bot`, `display: grid; gap: var(--s-3)`).

Строка состояния `.line` (бот, чат владельца, «Включено»): `display: flex; align-items: baseline; gap: 9px; font-size: var(--fs-ui); color: var(--ink)`, получает фокус программно (`tabindex="-1"`, без обводки). Точка `.dot` 7px, `translate: 0 -1px`:
- серая `--ink-3` — бота нет или его сообщения никто не читает;
- `data-wait` — `--accent-solid`, дышит `actum-breathe 1.4s var(--ease) infinite` (до `opacity: .5`): токен ещё не подтверждён;
- `data-on` — `--accent-solid` с кольцом `0 0 0 3px var(--accent-wash)`: всё работает.

Шаги кода входа `ol.steps` (`display: grid; gap: var(--s-3)`), шаг `li` `display: flex; align-items: flex-start; gap: 10px; font-size: var(--fs-ui); color: var(--ink-2)`. Круг `.mark`: `20px × 20px; border-radius: 50%; display: grid; place-items: center; font: 500 var(--fs-label)/1 var(--ff-meta)` (11px).
- впереди (`todo`): кольцо `inset 0 0 0 1.5px var(--line-2)`, цифра `--ink-3`;
- сейчас (`now`): кольцо `--accent-solid`, цифра `--accent-text`, название шага вес 500, `--ink`;
- сделано (`done`): заливка `--accent-solid` без кольца, галочка 12px (линия 2px) цветом `--accent-ink`.
Название шага `line-height: 20px`, чтобы стоять на середине круга; под ним подсказка `.hint` (`.stepText` `display: grid; gap: 2px`). Шагов два: «Подключить личный чат» и «Включить»; список `aria-label` «Как включить», после включения он скрыт и остаётся строка с точкой `data-on` «Включено: после пароля нужен код из Telegram.». Состояние словами («готово», «сейчас») только для скринридера.

Другие части: список чатов `.chats li` (`display: flex; justify-content: space-between; gap: var(--s-3); padding: 6px 10px; border-radius: var(--r-chip)`, фон `--raised`, кольцо `--line`); инструкция для коллег `ol.how` (номер «1.» в колонке 20px, `--ink-3`; текст `--fs-meta`, `--ink-2`); итоговое состояние `.state` (`--fs-ui`, 500, `--ink`, без точки); поле кода `.code` (`max-width: 14rem`, моно, `letter-spacing: .16em`).

```css
.line { display: flex; align-items: baseline; gap: 9px; font-size: var(--fs-ui); color: var(--ink); }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); translate: 0 -1px; }
.dot[data-wait] { background: var(--accent-solid, var(--accent)); animation: actum-breathe 1.4s var(--ease) infinite; }
.dot[data-on] { background: var(--accent-solid, var(--accent)); box-shadow: 0 0 0 3px var(--accent-wash); }
.mark {
  flex: none; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--line-2); color: var(--ink-3);
  font: 500 var(--fs-label)/1 var(--ff-meta);
}
.steps [data-state="now"] > .mark { box-shadow: inset 0 0 0 1.5px var(--accent-solid, var(--accent)); color: var(--accent-text); }
.steps [data-state="done"] > .mark { background: var(--accent-solid, var(--accent)); box-shadow: none; color: var(--accent-ink); }
@keyframes actum-breathe { 50% { opacity: .5; } }
```

### AiUsage

Источник: `src/components/admin/AiUsage.tsx`, `src/components/admin/AiUsage.module.css`

Таблица расхода Claude (в коде блок называется «Кэш и стоимость») в «Настройки → Автоматический разбор»: запросы, доля кэша, стоимость сегодня и с начала месяца.

Анатомия:
- `figure.usage`: `margin: 0; display: grid; gap: 10px`.
- `table.table`: `width: 100%; max-width: 560px; border-collapse: collapse; font-size: var(--fs-ui)`. Три узкие колонки: подпись метрики, «Сегодня», «С начала месяца» (метрики идут вниз, периоды поперёк, чтобы таблица помещалась в 390px без прокрутки). Строки сверху вниз: «Запросы», «Из кэша», «Стоимость», «Без кэша было бы», «Картинки».
- `caption` «Расход Claude на проверку задач»: слева, `padding: 0 0 8px`, вес 500, `--ink`.
- Все ячейки: `padding: 8px 0; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap`; между колонками `padding-left: var(--s-4)` (16px). У последней строки линии нет, у строки заголовков нет верхнего отступа.
- Заголовки колонок: `font: 400 var(--fs-meta)/var(--lh-meta) var(--ff-text)`, `--ink-3`.
- Подписи строк: слева, вес 400, `--ink-2`, могут переноситься.
- Значения: шрифт `--ff-meta`, `font-variant-numeric: tabular-nums`, цвет `--ink`. Вторичные строки («Без кэша было бы», «Картинки», класс `.muted`) — значения `--ink-2`.
- Под таблицей `figcaption` `meta-prose`: «Оценка по ценам Anthropic, точная сумма в счёте. Кэш живёт {5 минут / 1 час}, …» или, если в месяце работал только мок, «В этом месяце задачи проверял только мок, поэтому расходов нет.».

Числа: деньги «$0.42», крошки «< $0.01», проценты по локали без дробей; пустое значение «—» (доля кэша без данных, стоимость при нуле запросов).

Доступность: настоящая таблица с `caption`, `th scope="col"` и `th scope="row"`.

```css
.usage { margin: 0; min-width: 0; display: grid; gap: 10px; }
.table { width: 100%; max-width: 560px; border-collapse: collapse; font-size: var(--fs-ui); }
.caption { text-align: left; padding: 0 0 8px; font-weight: 500; color: var(--ink); }
.table th, .table td { padding: 8px 0; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; vertical-align: baseline; }
.table tr > * + * { padding-left: var(--s-4); }
.table thead > tr > * { padding-top: 0; }
.table thead th { font: 400 var(--fs-meta)/var(--lh-meta) var(--ff-text); color: var(--ink-3); }
.table tbody th { text-align: left; font-weight: 400; color: var(--ink-2); white-space: normal; }
.table td { font-family: var(--ff-meta); font-variant-numeric: tabular-nums; color: var(--ink); }
.table tbody tr:last-child > * { border-bottom: 0; }
.muted td { color: var(--ink-2); }
```

### Полоса сохранения стандарта

Источник: `src/app/admin/(panel)/standard/_components/standard.module.css`, `src/app/admin/(panel)/standard/_components/StandardWorkspace.tsx`

Липкая полоса внизу редактора стандарта: кнопка «Сохранить как редакцию {n}», состояние, «Вернуть стандарт по умолчанию».

`.saveBar`: `position: sticky; bottom: 12px; z-index: var(--z-top)` (10), `display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-4); padding: 12px 14px; border-radius: var(--r-block)`, фон `--surface`, `box-shadow: var(--shadow)`.

Внутри по порядку: кнопка `primary` (размер `md`, `type="submit"`) «Сохранить как редакцию {n}» (выключена, пока идёт сохранение, нет изменений или есть ошибка), meta с `aria-live="polite"` «не сохранено» / «сохранено», справа `.reset` (`margin-left: auto`) с `quiet sm` «Вернуть стандарт по умолчанию» и подтверждением на месте «Вернуть стандарт по умолчанию? Он сохранится как новая редакция.» / «Да, вернуть» / «Отмена»; обёртка подтверждения прижата вправо (`.saveBar .reset > div { align-items: flex-end }`). Ошибка внутри полосы (`.error`, `--danger`): «Проверьте пункты: у каждого нужно название, пунктов от 1 до 15.». Успех: тост «Сохранено как редакция {n}.».

```css
.saveBar {
  position: sticky; bottom: 12px; z-index: var(--z-top);
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-4);
  padding: 12px 14px; border-radius: var(--r-block); background: var(--surface); box-shadow: var(--shadow);
}
.reset { margin-left: auto; }
.saveBar .reset > div { align-items: flex-end; }
```

## Тон текстов владельца

Источник: `src/lib/copy/owner/ru.ts`, `docs/SPEC-DELTA.md` §6.2

- Обращение к владельцу на «вы», спокойно и по делу: «Заметка для себя, видна только вам», «Отправьте её лично. По ссылке входят без пароля, она работает, пока вы её не отзовёте.», «Запустить агента «{name}» на вашем ПК?».
- Заглавная буква только в начале у заголовков, кнопок и пунктов меню: «Входящие», «Запустить на ПК», «Создать и получить ссылку», «Выйти на всех устройствах». Статусы, флаги, факты и мета пишутся строчными: «новая», «в работе», «как есть», «не горит», «уверенность высокая», «что», «зачем».
- Номер задачи: знак «№», пробел и четыре цифры с нулями: «№ 0148» (в `src/lib/format.ts` пробел неразрывный). В строках списка и в поиске только цифры жирным: «0148».
- Кнопки — короткий глагол или глагол с объектом: «Войти», «Выйти», «Отправить», «Назначить», «Спросить», «Разобрать», «Сбросить», «Дальше», «Назад», «Изменить план», «Другой агент».
- Подтверждение — вопрос с последствием, ответ «Да, {глагол}» и «Отмена»: «Остановить агента? Процесс на ПК будет завершён, сделанные изменения останутся.» / «Да, остановить».
- Восклицательных знаков в текстах для владельца нет. Два «!» в словаре — украинские тексты для коллеги: «Привіт! Завдання «{title}» виконано.» и пример слабой задачи «…Дякую!».
- Разделителя «·» нет нигде (правило записано в шапке `ru.ts`): пункты меты разделяет промежуток. Счётчики пишутся как «подпись: число»: «разборов: {n}», «попыток: {n}», «задач: {n}, открытых: {m}», «срочность: высокая».
- Кавычки только «ёлочки», ими выделяются названия разделов и вставки: «в «Моих задачах»», «Во «Входящие»», «Ничего не нашлось по «{q}».». Многоточие — один символ «…» в процессах и плейсхолдерах: «Ищем…», «Claude подбирает агента…», «Поиск задачи, человека или команда…».
- Ошибки говорят, что делать дальше, полным предложением с точкой: «Пароль не подошёл.», «Слишком много попыток. Попробуйте через {n} мин.», «Статус уже изменился. Обновите страницу.», «Не получилось. Обновите страницу и попробуйте ещё раз.». Пустые состояния — короткое утверждение с точкой и пояснение: «Новых задач нет.» / «Когда коллеги отправят задачу, она появится здесь и придёт в Telegram.».
- Время, деньги, единицы коротко: «сегодня 14:32», «вчера {time}», «выполняется {n} мин», «{s} с», «≈ $0.18», «Раннер офлайн с 14:20». Тосты из одного-двух слов без точки: «Сохранено», «Скопировано», «Ссылка скопирована», «Команда скопирована»; тосты-предложения с точкой: «Агент назначен.», «Данные сохранены.», «Сохранено как редакция {n}.».

# Часть 4. Сторона коллеги

## Экраны коллеги

Все значения ниже взяты из кода. Токены (`--surface`, `--r-block` и т. д.) определены в `src/styles/tokens.css`; при первом упоминании в компоненте рядом стоит значение тёмной темы (она по умолчанию), светлое значение — только где это важно. Брейкпоинты экранов коллеги: 980, 760, 640, 560 и 380 px, плюс `(pointer: coarse)` и `(hover: none)`. На ширине до 640 px `--gutter` = 16px (иначе 24px), `--fs-write` = 17px (иначе 19px). До 760 px `--fs-h1` = 40px (иначе 52px), `--fs-num-xl` = 48px (иначе 64px).

### Общая оболочка

Источник: `src/app/(colleague)/layout.tsx`, `src/app/(colleague)/_components/ColleagueProviders.tsx`, `src/app/(colleague)/_components/ColleagueTop.tsx`, `src/styles/base.css`, `src/components/shell/TopBar.module.css`

- Своя корневая разметка `<html lang={lang} data-theme={theme}>`. В `<body>` сначала `ColleagueProviders` со страницей внутри, затем `CursorLight` (световое пятно за курсором, см. раздел «Фон страницы» → «CursorLight»).
- `ColleagueProviders` ничего не рисует сам. Он оборачивает каждый экран коллеги в три провайдера: тексты и обращение (`CopyProvider`), тосты (`ToastProvider`, подпись кнопки закрытия «Закрити» берётся из словаря языка коллеги) и одну live-область страницы (`AnnouncerProvider`). Поэтому контейнер тостов и live-область есть на каждом экране коллеги с первой отрисовки.
- Фон страницы: `html` залит `--bg` (`#07080A`). На `body` сетка 48×48px из линий `--grid` (`rgb(255 255 255 / .035)`), `background-attachment: fixed`. Сверху `body::before` — мягкое сиреневое свечение `radial-gradient(closest-side, var(--glow), transparent)`, высота 70vh, анимация `actum-glow 48s ease-in-out infinite`.
- Шапка `TopBar view="colleague"`: логотип, навигация «Нове завдання» / «Мої завдання» (со счётчиком открытых задач), переключатели темы и языка, `PersonMenu` с именем и «Вийти». Внутренняя ширина шапки `--page-owner` (1280px), padding `18px var(--gutter)`. Текущий пункт: `color: var(--nav-on-ink); background: var(--nav-on)` (в тёмной теме серая плашка `--hover`, в светлой сиреневая `#E4DAFF` с текстом `#5537C2`).
- До 640 px навигация уходит во вторую строку шапки и прокручивается вбок внутри себя (`order: 3; flex: 1 0 100%; overflow-x: auto`), страница вбок не скроллится.
- Каждый `main` имеет `id="main"` для ссылки «Перейти до основного вмісту».
- Фокус везде одинаковый: `outline: 2px solid var(--accent-line); outline-offset: 2px` с короткой анимацией `actum-focus var(--dur-fast)`. Заголовки, которые получают фокус программно (`tabindex="-1"`), рамку не показывают.
- На сенсорных экранах `button`, `[role="radio"]`, `.opt`, `.tab` получают `min-height: 44px`.

### «Нове завдання» (`/`)

Источник: `src/app/(colleague)/page.tsx`, `src/app/(colleague)/_components/IntakeScreen.tsx`, `src/app/(colleague)/_components/intake.module.css`, `src/app/(colleague)/_components/GuideLink.tsx`, `src/components/ui/PageIntro.module.css`

Скриншоты: `colleague-intake-1366-dark.png`, `colleague-intake-1366-light.png`, `colleague-intake-390-dark.png`, `colleague-intake-390-light.png`, `colleague-intake-1366-dark-en.png`, `colleague-intake-1366-dark-ru.png`, `colleague-intake-390-light-en.png`.

Назначение: коллега пишет задачу свободным текстом, справа собирается спецификация, внизу спецификации кнопка отправки.

Сетка `main`:
- `max-width: var(--page-colleague)` (1180px), по центру, padding `40px var(--gutter) 90px`.
- Две колонки `minmax(0, 1.05fr) minmax(0, .95fr)`, gap `--s-7` (28px), `align-items: start`. Левая колонка чуть шире.
- Строки сверху вниз: полоса приветствия (только первый раз, на обе колонки), строка вступления (на обе колонки), затем слева `Composer`, справа `SpecList` с `SendBar` в подвале.
- До 980 px одна колонка: сначала Composer, под ним спецификация.
- До 640 px `padding-top: 24px`, gap `--s-5` (20px).

Строка вступления `.introRow`: `display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: var(--s-4) var(--s-5)`. Слева `PageIntro` (`.introText`: `flex: 1 1 560px; min-width: 0`), справа `GuideLink`: ссылка-кнопка `ButtonLink ghost sm` «Як це працює?», ведёт на `/guide` и запускает гайд заново. На узком экране кнопка переносится под текст.

`PageIntro` (h1 52px/1.02 с приглушённой второй фразой «Опиши завдання. *Решту {brand} розбере сам.*» и лид). Описание: см. раздел «Базовые компоненты» → «PageIntro».

Фокус при возврате из гайда (`GuideLink`): гайд перед переходом на `/` запоминает, куда вернуть фокус. Если на экране есть полоса приветствия, фокус встаёт на её текст (`#welcome-text`), чтобы строка про личную ссылку не была пропущена. Иначе на «Як це працює?» (если фокус был на карточке гайда) или на h1 `#intro-h1` (если фокус был в поле практики). Обычная загрузка `/` фокус не трогает. Фокус ставится с `preventScroll`.

Колонка спецификации `.specCol` несёт `view-transition-name: actum-handoff`. При отправке она «перетекает» в карточку «Прийнято» (см. ниже).

Пока идёт разбор текста, на колонке редактора висит `data-scanning`, и по тексту слева направо проходит мягкая сиреневая полоса сканирования (один проход 1,2 с):

```css
.composerCol[data-scanning] div:has(> textarea)::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 300%; pointer-events: none;
  background:
    linear-gradient(90deg, transparent 0 40%, var(--accent-wash) 50%, transparent 60% 100%),
    linear-gradient(90deg, transparent 0 35%, color-mix(in srgb, var(--surface) 45%, transparent) 50%, transparent 65% 100%);
  clip-path: inset(0 66.6667% 0 0);
  animation: scan-band 1.2s linear infinite;
}
@keyframes scan-band {
  from { transform: translateX(-66.6667%); clip-path: inset(0 0 0 66.6667%); }
  to   { transform: translateX(0);         clip-path: inset(0 66.6667% 0 0); }
}
@media (prefers-reduced-motion: reduce) { .composerCol[data-scanning] div:has(> textarea)::after { content: none; } }
```

Слой в три ширины текста, полоса в средней трети. Двигаются только `transform` и `clip-path`.

Структура:

```html
<main id="main" class="main">
  <div class="span"><div class="welcome">…</div></div>            <!-- только после входа по ссылке -->
  <div class="introRow">
    <div class="intro introText">
      <h1 id="intro-h1" tabindex="-1">Опиши завдання. <em>Решту {brand} розбере сам.</em></h1>
      <p class="lead">Пиши як у месенджері. …</p>
    </div>
    <a class="btn ghost sm" href="/guide">Як це працює?</a>
  </div>
  <div class="composerCol">  <!-- Composer --> </div>
  <div class="specCol">      <!-- SpecList, в подвале SendBar --> </div>
</main>
```

Телефон 390 px: одна колонка, боковые поля 16px. Заголовок 40px. Текст в редакторе 17px. Подсказка в панели инструментов редактора встаёт на всю ширину отдельной строкой. Плитки вложений 68px. Подвал с кнопкой «Надіслати» прилипает к низу экрана (см. `SendBar`).

Пока идёт финальная проверка или отправка «як є», `inert` получают обёртка `Composer` (внутри `.composerCol`) и сама `.specCol`: редактор и спецификация не реагируют.

### Полоса приветствия

Источник: `src/app/(colleague)/_components/WelcomeStrip.tsx`, `intake.module.css` (`.welcome`)

Назначение: один раз после входа по личной ссылке напоминает сохранить ссылку.

- `display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); flex-wrap: wrap`.
- padding `12px 14px 12px 18px`, радиус `--r-block` (14px), фон `--surface` (`#0E0F12`).
- Тень: кольцо `0 0 0 1px var(--line)` и акцентная кромка слева `inset 2px 0 0 var(--accent-solid, var(--accent))`.
- Текст `--fs-small` (13.5px), `--ink-2`, `max-width: 78ch`. Справа кнопка ghost sm «Зрозуміло».
- Текст фокусируемый (`tabindex="-1"`, `id="welcome-text"`): после гайда фокус встаёт на него, чтобы скринридер прочитал строку.
- «Зрозуміло» прячет полосу и ставит фокус на h1 (`#intro-h1`).

```css
.welcome {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); flex-wrap: wrap;
  padding: 12px 14px 12px 18px; border-radius: var(--r-block);
  background: var(--surface); box-shadow: 0 0 0 1px var(--line), inset 2px 0 0 var(--accent-solid, var(--accent));
}
```

### Окно «Як писати завдання»

Источник: `src/app/(colleague)/_components/StandardDialog.tsx`, `intake.module.css` (`.dialog` и далее)

Назначение: показывает стандарт владельца, если он разрешил его показывать коллегам. Открывается кнопкой quiet sm «Як писати завдання» в панели инструментов редактора.

- Нативный `<dialog>` через `showModal()`: ловушка фокуса и Esc из коробки. `aria-labelledby="standard-title"`.
- Положение: `margin: 12vh auto auto`, ширина `min(640px, calc(100% - 2 * var(--gutter)))`, `max-height: 76vh`.
- Подложка: `::backdrop { background: rgb(0 0 0 / .45); backdrop-filter: blur(3px); }`.
- Появление: `dialogIn var(--dur-base) var(--ease)` (220ms) из `opacity: 0; transform: scale(.96)`.
- Панель: фон `--surface`, радиус `--r-panel` (20px), тень `--shadow`, padding `var(--s-5) var(--s-6) var(--s-6)` (20/24/24), `display: grid; gap: var(--s-4)`, прокрутка внутри.
- Шапка: заголовок `500 var(--fs-h3)/var(--lh-h3) var(--ff-display)` (20px/1.2), справа quiet sm «Закрити». Под ней вступление стандарта (если есть) цветом `--ink-2`.
- Пункты стандарта: нумерованный список без маркеров, номер «01», «02» (`counter(c, decimal-leading-zero)`) слева в шрифте `--ff-meta` 13px, цвет `--ink-3`, отступ текста 32px. Название пункта 500, описание `--fs-small` `--ink-2`. Необязательный пункт помечен meta «бажано».
- Пример: блок `--raised` (`#141519`), кольцо `--line`, радиус `--r-block`, padding 14px, подпись meta «Приклад», текст `--fs-small` `--ink-2`.

### Экран «Прийнято» (`/?sent=N`)

Источник: `src/app/(colleague)/_components/SentView.tsx`, `intake.module.css` (`.sent`, `.accepted`, `.copy`, `.answers`), `src/components/intake/AcceptedCard.*`

Скриншоты: `colleague-accepted-1366-dark.png`, `colleague-accepted-1366-light.png`, `colleague-accepted-390-dark.png`, `colleague-accepted-390-light.png`, `colleague-accepted-1366-dark-en.png`.

Назначение: подтверждение отправки с номером задачи и копия спецификации «Так завдання побачить {ownerNom}».

- Тот же `main`, но внутри один блок `.sent` на обе колонки: `grid-column: 1 / -1; display: grid; gap: var(--s-6)` (24px), `overflow-x: clip; overflow-clip-margin: var(--gutter)` (чтобы пульс не расширял страницу на телефоне).
- Сверху визуально скрытый h1 «Прийнято». Затем `AcceptedCard` во всю ширину `main`. Под ним колонка `.copy` (`display: grid; gap: var(--s-4); max-width: 760px`) с read-only `SpecList` (заголовок «Так завдання побачить {ownerNom}») и панелью «Відповіді на уточнення», если ответы были.
- Пока копия грузится: строка meta-prose «Ще мить: показуємо, як завдання побачить {ownerNom}…» (padding `0 6px`).
- Панель ответов: padding `14px 18px 16px`; заголовок meta `<b>`; список `dl` gap `--s-3`; вопрос `--fs-small` `--ink-2`, ответ `--fs-body`.
- В карточку перед кнопками встраивается строка «Підключити Telegram» (вариант `card`, см. ниже).

Движение при свежей отправке:
- Если браузер умеет `document.startViewTransition` и нет reduced motion, переход идёт через View Transition: у колонки спецификации и у `.accepted` одно имя `actum-handoff`, поэтому панель спецификации морфится в карточку. Своих правил `::view-transition-*` для этого имени нет, работает стандартный морф браузера.
- За карточкой один мягкий сиреневый пульс:

```css
.accepted { position: relative; isolation: isolate; view-transition-name: actum-handoff; min-width: 0; }
.accepted::before {
  content: ""; position: absolute; inset: -48px -24px; z-index: -1; pointer-events: none; border-radius: 50%;
  background: radial-gradient(closest-side, var(--accent-wash), transparent);
  opacity: 0;
}
.sent[data-fresh] .accepted::before { animation: pulse 1.1s var(--ease) .25s both; }
@keyframes pulse { 0% { opacity: 0; transform: scale(.7); } 40% { opacity: 1; } 100% { opacity: 0; transform: scale(1.12); } }
```

- При перезагрузке `/?sent=N` (не свежая отправка) пульса и расшифровки номера нет.
- Фокус после отправки переходит на заголовок карточки.

Телефон 390 px: карточка в одну колонку (номер над заголовком), копия спецификации под ней на всю ширину.

### «Мої завдання» (`/tasks`)

Источник: `src/app/(colleague)/tasks/page.tsx`, `src/app/(colleague)/_components/mine.module.css`, `src/components/ui/Empty.module.css`

Скриншоты: `colleague-mine-1366-dark.png`, `colleague-mine-1366-light.png`, `colleague-mine-390-dark.png`, `colleague-mine-390-light.png`, `colleague-mine-1366-light-ru.png`.

Назначение: список своих черновиков и отправленных задач со статусом.

Сетка `main`: одна колонка, `max-width: 880px`, padding `40px var(--gutter) 90px`, `display: grid; gap: var(--s-5); align-content: start`. До 640 px `padding-top: 24px`, gap `--s-4` (16px).

Сверху вниз:
1. h1 «Мої завдання»: `500 40px/1.05 var(--ff-display)`, `letter-spacing: -0.04em`, `margin-bottom: var(--s-2)`. До 760 px 32px.
2. Полоса Telegram (вариант `strip`).
3. Панель «Чернетки» (только если есть).
4. Панель «Надіслані» с вкладками и списком.

Панель «Чернетки»:
- Шапка `PanelHeader`: meta «**Чернетки**» и «зберігаються 30 днів».
- Строка `.draft`: `display: flex; align-items: center; justify-content: space-between; gap: var(--s-4)`, padding `14px 18px`, линия снизу `1px var(--line)`, слева кромка цвета вопроса `box-shadow: inset 2px 0 0 var(--ask)` (`#FFB45C`).
- Внутри: заголовок (500, одна строка с многоточием, пусто — «Чернетка без тексту»), под ним MetaList «змінено {relative}» и число файлов; справа ghost sm «Продовжити».

Вкладки `.tabs` (внутри панели «Надіслані», это `nav`):
- `display: flex; gap: 2px; padding: 10px 12px; border-bottom: 1px solid var(--line); overflow-x: auto`, полоса прокрутки скрыта.
- Вкладка: `--ink-3`, `--fs-small`, line-height 1.3, padding `6px 10px`, радиус `--r-inner` (8px), переход цвета и фона `--dur-fast` (150ms).
- Hover: `--ink-2`. Текущая (`aria-current="page"`): `color: var(--ink); background: var(--hover)`. Здесь используется `--hover`, а не `--nav-on`: в светлой теме плашка серая `#F1F2F4`.
- Счётчик после названия: meta, `margin-left: 6px`, 12px.
- Вкладки «Активні» (новые и в работе) и «Усі» — это ссылки `/tasks` и `/tasks?view=all`.

Строка задачи (вся строка — ссылка на `/tasks/N`):

```css
.item {
  display: grid; grid-template-columns: 62px minmax(0, 1fr) auto; gap: 14px; align-items: center;
  padding: 14px 18px; color: inherit; text-decoration: none; transition: background-color var(--dur-fast);
}
.item:hover { background: var(--hover); }
.item:focus-visible { outline-offset: -2px; border-radius: 0; }
.title { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reply { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink-2); }

.status {
  display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink-2);
  padding: 3px 9px 3px 7px; border-radius: 7px; box-shadow: 0 0 0 1px var(--line-2); white-space: nowrap;
}
.dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--ink-3); }
.status[data-status="new"] .dot { background: var(--accent-solid, var(--accent)); }
.status[data-status="in_progress"] .dot { background: var(--accent-solid, var(--accent)); animation: actum-pulse 1.6s infinite; }
.status[data-status="done"] .dot { background: var(--accent-solid, var(--accent)); box-shadow: 0 0 0 3px var(--accent-wash); }
.status[data-status="rejected"], .status[data-status="cancelled"] { color: var(--ink-3); }
```

- Колонка 1: номер «0003» в meta `<b>` (`--ff-meta`, цифры Martian Mono).
- Колонка 2: заголовок; MetaList «надіслано {when}», термин (только у активных), флаг «надіслано як є» / «без перевірки» цветом `--ask`; последняя реплика владельца meta-prose «{ownerNom}: {text}» (обрезана до 140 символов, одна строка).
- Колонка 3: плашка статуса. Точка «в роботі» пульсирует (`actum-pulse`: кольцо `--accent-line` расходится до 5px и гаснет). «Готово» — залитая точка с кольцом `--accent-wash` 3px.
- Строки разделены `1px var(--line)`, у последней линии нет.

Пустые состояния (`Empty`, padding `var(--s-8) var(--s-6)`, без иллюстраций): заголовок `500 var(--fs-h3) var(--ff-display)`, текст `--ink-2` `max-width: 44ch`, кнопка через `margin-top: var(--s-4)`.
- Задач нет: «Завдань поки немає.», текст, primary «Нове завдання».
- Во вкладке «Активні» пусто: «Активних завдань немає. Усі вже закриті або скасовані.», ghost «Показати всі».

Телефон 390 px (до 640 px):
- Строка задачи: `grid-template-columns: 44px minmax(0, 1fr); row-gap: 6px; padding: 12px 16px`. Плашка статуса уходит во вторую колонку под текст (`grid-column: 2; justify-self: start`).
- Черновик: `flex-wrap: wrap; padding: 12px 16px`, кнопка «Продовжити» переносится.
- Вкладки прокручиваются вбок внутри панели.

### Страница задачи (`/tasks/[serial]`)

Источник: `src/app/(colleague)/tasks/[serial]/page.tsx`, `TaskActions.tsx`, `mine.module.css`, `src/components/ui/Facts.module.css`, `src/components/ui/InlineConfirm.module.css`

Скриншоты: `colleague-task-1366-dark.png`, `colleague-task-1366-light.png`, `colleague-task-390-dark.png`, `colleague-task-390-light.png`, `colleague-task-1366-dark-en.png`; с открытым просмотром картинки: `colleague-task-lightbox-1366-dark.png`, `colleague-task-lightbox-1366-light.png`, `colleague-task-lightbox-390-dark.png`, `colleague-task-lightbox-390-light.png`.

Назначение: одна отправленная задача: статус, спецификация, исходный текст, файлы, ход задачи и поле «Доповнити».

Тот же `main`, что у «Мої завдання» (880px, gap `--s-5`). Сверху вниз:

1. Ссылка «← Мої завдання»: `--fs-ui` (14px), `--ink-2`, без подчёркивания, `justify-self: start`; hover `--ink`.
2. Главная панель `.card`: padding `20px 22px 22px`, `display: grid; gap: var(--s-4)`.
   - `.cardHead`: `display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--s-3) var(--s-5)`. Слева MetaList: «**№ 0003**», «надіслано {when}», флаг. Справа `StatusTrail` (прийнято → в роботі → готово).
   - h1 заголовок задачи: `500 var(--fs-h2)/var(--lh-h2) var(--ff-display)` (24px/1.15), `letter-spacing: var(--tr-h2)` (-0.025em), `text-wrap: balance`, `overflow-wrap: anywhere`.
   - `Facts` (`dl`): `grid-template-columns: 96px minmax(0, 1fr); gap: var(--s-2) 14px`, `--fs-ui`. Термины meta: «що зробити», «навіщо», «готово, коли», «термін», «терміновість», «матеріали» (если есть). Значения через `ValueText`: `[уточнити: …]` рисуется цветом вопроса с пунктирным подчёркиванием (см. `SpecRow`). До 380 px первая колонка 80px.
3. Панель «Твій текст» (`.section`: padding `16px 22px 20px`, `display: grid; gap: var(--s-3)`): заголовок h2 в стиле meta `<b>`, текст `white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink)`. Подсветок здесь нет: это простой `<p>`, а не `HighlightedText`.
4. Панель «Відповіді на уточнення» (если есть): `dl`, gap `--s-3`; вопрос `--fs-small` `--ink-2`, ответ обычным текстом.
5. Панель «Файли» (если есть): `AttachmentGallery` размера `md`.
6. Панель «Хід завдання»: список событий `ol`, gap `--s-4`. Событие: `grid-template-columns: 150px minmax(0, 1fr); gap: 4px 14px`. Слева время (meta). Справа строка («Ти» / имя владельца жирным 500 и текст события), под ней тело комментария: `margin-top: 4px; padding-left: 12px; box-shadow: inset 2px 0 0 var(--accent-line); white-space: pre-wrap`. Под списком форма «Доповнити» или строка meta-prose «Завдання скасоване, доповнювати його вже не потрібно.».
7. Панель отмены (только пока статус «нове»): padding `14px 22px`, внутри `InlineConfirm` с ghost sm «Скасувати завдання».

Форма «Доповнити»:

```css
.add { display: grid; gap: var(--s-2); }
.addInput {
  width: 100%; border: 0; border-radius: var(--r-chip); padding: 10px 12px; resize: vertical; min-height: 76px;
  background: var(--raised); box-shadow: 0 0 0 1px var(--line-2); color: var(--ink); font-size: var(--fs-ui); line-height: 1.5;
}
.addInput:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 1px; }
.error { font-size: var(--fs-small); color: var(--ask); }
```

- Подпись meta «**Доповнити**», под ней meta-prose пояснение (`max-width: 60ch`), поле на 3 строки, ошибка `role="alert"` цветом `--ask`, primary sm «Надіслати». Пока отправляется: кнопка `disabled` и `aria-busy`. Ctrl/Cmd+Enter отправляет.

Подтверждение отмены (`InlineConfirm`): под кнопкой появляется полоса `--raised`, кольцо `--line-2`, радиус `--r-block`, padding `10px 12px 10px 14px`, анимация `actum-fade var(--dur-base)`. Вопрос «{ownerNom} побачить, що завдання скасовано. Скасувати?» (`--fs-ui`, `max-width: 52ch`), primary sm «Так, скасувати», quiet «Залишити».

Телефон 390 px: событие в одну колонку (время над текстом); у `.card` и `.section` боковой padding 16px; у панели отмены `12px 16px`.

Не найдено (`src/app/(colleague)/not-found.tsx`): тот же `main`, одна панель с `Empty`: «Такого завдання немає», «Можливо, у номері помилка або завдання надіслав хтось інший.», ghost «← Мої завдання». Чужая и несуществующая задача выглядят одинаково.

### Вход по ссылке (`/enter`)

Источник: `src/app/enter/page.tsx`, `src/app/enter/EnterForm.tsx`, `src/app/enter/enter.module.css`, `src/app/enter/layout.tsx`

Скриншотов нет (в `docs/screenshots/INDEX.md` экран не снят).

Назначение: сюда ведёт личная ссылка `/i/<token>`; коллега нажимает «Увійти» и, если нужно, вводит код из Telegram.

- Своя корневая разметка (без сессии). Шапка `TopBar` без навигации (`nav={false}`): логотип и переключатели.
- `main`: `max-width: 40rem`, по центру, padding `56px var(--gutter) 90px`.
- Одна панель: padding `var(--s-7) var(--s-7) var(--s-6)` (28/28/24), `display: grid; gap: var(--s-4)`, появление `rise var(--dur-rise) var(--ease) both` (600ms, из `opacity: 0; translateY(6px); blur(3px)`).
- h1: `500 40px/1.05 var(--ff-display)`, `letter-spacing: -0.04em`, `text-wrap: balance`. Текст `--ink-2`, `max-width: 44ch`. Мелкая строка внизу meta-prose `margin-top: var(--s-2); max-width: 52ch`.

Состояния (одна панель, меняется содержимое):
- Старт: h1 «Вхід у {brand}», primary «Увійти», внизу «Якщо посилання потрапило до тебе випадково, просто закрий сторінку.».
- Код: h1 «Ми надіслали код у Telegram»; подпись поля «Код із Telegram» (`--fs-ui`, 500, `--ink`); поле кода; подсказка «6 цифр. Код діє 5 хвилин.»; кнопки primary «Увійти» и quiet «Надіслати ще раз»; внизу «Немає доступу до Telegram? …».
- Смена человека: текст «Зараз ти в {brand} як {name}. …», primary «Так, увійти», ghost «Ні, залишитися».
- Ссылка не сработала: h1 «Посилання не спрацювало», текст, иногда ghost «Відкрити {brand}».
- Смена человека идёт под тем же h1 «Вхід у {brand}».
- Новые коды кончились: «Надіслати ще раз» неактивна, под полем подсказка «Нових кодів для цього входу вже не буде.».
- Код истёк / много попыток: только h1 и текст.

Поле кода:

```css
.code {
  width: 100%; max-width: 14rem; min-width: 0; border: 0; margin: 0;
  border-radius: var(--r-chip); background: var(--raised); color: var(--ink);
  box-shadow: 0 0 0 1px var(--line-2);
  padding: 9px 12px; font-family: var(--ff-mono); font-size: var(--fs-body); letter-spacing: .16em; line-height: 1.45;
  transition: box-shadow var(--dur-fast), background-color var(--dur-fast);
}
.code:hover { box-shadow: 0 0 0 1px var(--ink-3); }
.code:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 1px; }
.code[aria-invalid="true"] { box-shadow: 0 0 0 1px var(--danger); }
@media (pointer: coarse) { .code { min-height: 44px; } }
```

- Ошибки здесь цветом `--danger` (`#FF7A7A`), а не `--ask`: `font: 400 var(--fs-meta)/var(--lh-meta) var(--ff-text)`. Положительное сообщение («Новий код надіслано…») `--ink-2`. Сообщение всегда `role="alert"`.
- Поле: `inputMode="numeric"`, `autoComplete="one-time-code"`, `autoFocus`, `aria-describedby` на подсказку и ошибку. При отправке все кнопки `disabled`, у primary ещё `aria-busy`.
- Телефон (до 640 px): `main` `padding-top: 32px`; панель padding `var(--s-6) var(--s-5) var(--s-5)` (24/20/20); h1 32px.

### Нет доступа (`/no-access`)

Источник: `src/app/no-access/page.tsx`, `src/app/no-access/no-access.module.css`, `src/app/no-access/layout.tsx`

Скриншоты: `colleague-no-access-1366-dark.png`, `colleague-no-access-1366-light.png`, `colleague-no-access-390-dark.png`, `colleague-no-access-390-light.png`, `colleague-no-access-1366-dark-en.png`.

Назначение: статичная страница для тех, у кого нет сессии или сломана ссылка.

- Та же оболочка, что `/enter`: шапка без навигации, `main` `max-width: 40rem`, padding `56px var(--gutter) 90px`.
- Панель padding `var(--s-7) var(--s-7) var(--s-6)`, gap `--s-3` (12px), без анимации появления.
- h1 `500 40px/1.05`, -0.04em; текст `--ink-2`, `max-width: 44ch`; мелкая строка meta-prose `margin-top: var(--s-2)`.
- Варианты по `?r=`: без параметра «Потрібне особисте посилання»; `link` «Це посилання більше не працює»; `out` «Вихід виконано» (с подсказкой про историю браузера); `ended` «Вхід на цьому пристрої завершився».
- Телефон: как `/enter` (padding-top 32px, панель 24/20/20, h1 32px).

### Подключение Telegram

Источник: `src/components/telegram/TelegramConnectView.tsx`, `TelegramConnectView.module.css`, `src/app/(colleague)/_components/TelegramConnect.tsx`

Скриншоты: отдельных нет. На `colleague-mine-1366-dark.png` и `colleague-accepted-1366-dark.png` блока Telegram нет (снято 27.10; остальные варианты этих снимков не открывались).

Назначение: предложить уведомления в Telegram. Два вида: `card` — строка внутри карточки «Прийнято» над кнопками; `strip` — полоса под заголовком «Мої завдання».

Анатомия:
- `.root`: `display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--s-3) var(--s-4)`.
- Слева `.body` (`flex: 1 1 260px; display: grid; gap: 2px`): текст предложения или строка состояния с точкой.
- Справа одна кнопка (или ссылка).
- Вид `strip` получает поверхность полосы приветствия, но без акцентной кромки: padding `12px 14px 12px 18px`, радиус `--r-block`, фон `--surface`, кольцо `0 0 0 1px var(--line)`. До 560 px padding `12px 14px`.
- Вид `card` своей поверхности не имеет.

Типографика:
- Предложение `.offer`: `--fs-small`, `--ink-2`, `max-width: 72ch`: «Повідомимо в Telegram, коли {ownerNom} відповість або змінить статус завдання.».
- Строка состояния `.line`: flex, gap 9px, `--fs-small`, `--ink`.
- Пояснение `.sub`: `--fs-meta`/`--lh-meta`, `--ink-3`. Проблема `.problem`: то же, цвет `--ask`.

Состояния:
- `idle`: предложение и ghost sm «Підключити Telegram».
- `opening`: та же кнопка с `aria-busy` и `data-busy` (курсор `progress`).
- `waiting`: строка с дышащей точкой «Відкрий Telegram і натисни кнопку внизу чату з ботом. Посилання діє 15 хвилин.» и ссылка в виде ghost sm «Відкрити Telegram» с иконкой внешней ссылки 14px (`--ink-3`).
- `linked`: строка с залитой точкой «Telegram підключено». В виде `strip` ещё пояснение «Відповіді та зміни статусу приходитимуть у Telegram.» и quiet sm «Відключити».
- `error`, `rate_limited`, `taken`: предложение, кнопка подключения и строка проблемы цветом `--ask`.
- Если бот не настроен, блок не показывается. В виде `card` уже подключённый блок тоже не показывается.

```css
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); translate: 0 -1px; }
.dot[data-wait] { background: var(--accent-solid, var(--accent)); animation: actum-breathe 1.4s var(--ease) infinite; }
.dot[data-on]   { background: var(--accent-solid, var(--accent)); box-shadow: 0 0 0 3px var(--accent-wash); }
```

Доступность: смена состояния объявляется один раз через общий live-регион страницы. Если нажатая кнопка исчезла, фокус переходит на то, что её заменило. После подключения фокус ставится на строку «підключено», а не на «Відключити». У блока `data-tour="telegram"` (цель шага гайда).

### Телефон 390 px: сводка

| Экран | Что меняется до 640 px (и уже) |
|---|---|
| Все | `--gutter` 16px; навигация шапки во второй строке с горизонтальной прокруткой; цели на тач-экране не ниже 44px |
| `/` | одна колонка (с 980 px); `padding-top: 24px`, gap 20px; h1 40px (с 760 px); текст редактора 17px; `SendBar` прилипает к низу экрана; подсказка в инструментах на всю ширину |
| `/?sent=N` | карточка в одну колонку с 560 px; номер 48px (с 760 px); padding карточки `22px 20px` (с 760 px) |
| `/tasks` | строка задачи `44px 1fr`, статус под текстом; черновик переносится; h1 32px (с 760 px) |
| `/tasks/N` | события в одну колонку; боковой padding панелей 16px; плитки картинок 88px; документы без типа и размера |
| `/enter`, `/no-access` | `padding-top: 32px`; панель 24/20/20; h1 32px |

## Компоненты формы задачи

Общие примитивы, на которых стоят эти компоненты (подробно: раздел «Базовые компоненты»):
- `Panel`: фон `--surface`, радиус `--r-panel` (20px), тень `--shadow` (`0 0 0 1px var(--line), 0 24px 48px -24px rgb(0 0 0 / .6)`), `overflow: clip`, сверху блик `::before` высотой 1px `linear-gradient(90deg, transparent, var(--line-2), transparent)`.
- `PanelHeader`: flex, `space-between`, padding `14px 18px`, линия снизу `1px var(--line)`, слева и справа текст класса `meta`.
- `.meta`: `400 var(--fs-meta)/var(--lh-meta) var(--ff-meta)` (13px/1.4, цифры в Martian Mono), цвет `--ink-3`; `<b>` внутри: 500, `--ink-2`. `.meta-prose` то же, но шрифтом `--ff-text`.
- `Button`: primary (`--accent` `#C9B8FF`, текст `--accent-ink`, 600, радиус `--r-control` 11px, padding `11px 16px`, `--shadow-accent`), ghost (кольцо `--line-2`, padding `10px 14px`), quiet (без рамки, `--ink-3`), pill. Размер sm: primary `7px 12px`, ghost `7px 11px`, quiet `6px 4px`. Нажатие `scale(.97)`. Disabled: `opacity: .45`, без тени.

### Composer

Источник: `src/components/intake/Composer.tsx`, `src/components/intake/Composer.module.css`

Назначение: панель для свободного текста задачи с подсветками, вложениями и подсказкой о разборе.

Анатомия (сверху вниз внутри `Panel`, `data-tour="composer"`):
1. `PanelHeader`: слева MetaList «**чернетка**» и состояние сохранения («збережено 14:20», «зберігається…», «не збережено, немає зв’язку»); справа число файлов («2 файли»).
2. `HighlightTextarea` — поле текста.
3. `ComposerFiles` — плитки вложений (если есть).
4. Панель инструментов `.tools`: pill-метка «+ файл», quiet sm «Як писати завдання» (если стандарт показывается), справа слот подсказки `.hint`.
5. Строки уведомлений `.notice` (ошибка вложений и состояние разбора могут стоять обе сразу).

Под панелью (вне её) строка о приватности meta-prose «Текст розбирає зовнішній сервіс (Claude). Не вставляй паролі й персональні дані.» (`margin-top: var(--s-3); padding: 0 6px`). `FileDrop` подключается к окну.

```css
.panel:focus-within { box-shadow: 0 0 0 1px var(--accent-line), var(--shadow-drop); }
.saveFailed { color: var(--ask); }
.tools {
  display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap;
  padding: 12px 18px; border-top: 1px solid var(--line);
}
.hint { margin-left: auto; display: inline-flex; align-items: center; gap: var(--s-3); min-height: 28px; }
.inFlight { display: inline-flex; align-items: center; gap: var(--s-2); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-solid); animation: actum-breathe 1.6s ease-in-out infinite; }
.attach {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  background: var(--raised); color: var(--ink-2); font-size: 13px; line-height: 1.25;
  border-radius: var(--r-pill); padding: 5px 11px; box-shadow: 0 0 0 1px var(--line);
  transition: color var(--dur-fast), box-shadow var(--dur-fast);
}
.attach:hover { color: var(--ink); box-shadow: 0 0 0 1px var(--line-2); }
.attach:focus-within { outline: 2px solid var(--accent-line); outline-offset: 2px; }
.attach[data-disabled] { opacity: .45; cursor: not-allowed; }
.notice { padding: 0 18px 14px; font-size: var(--fs-small); color: var(--ink-2); max-width: 70ch; }
@media (max-width: 640px) { .hint { margin-left: 0; width: 100%; } }
```

Состояния:
- Фокус в поле: рамка фокуса не рисуется внутри, вместо этого кольцо всей панели становится `--accent-line` (`rgb(201 184 255 / .55)`).
- Подсказка в слоте: «розбір почнеться від 40 символів» (meta), «розбирається на льоту» (meta), «розбирається…» с дышащей точкой 6px. Рядом может стоять quiet sm «розібрати зараз» с `kbd` «Ctrl ↵» (на устройствах Apple «⌘ ↵»).
- Уведомление о разборе (`.notice`): «Автоматичний розбір зараз не працює. …», «Забагато розборів поспіль. Наступний о {time}…», «Автоматичний розбір вимкнено. …».
- Сохранение не удалось: текст в шапке цветом `--ask`.
- «+ файл» при 10 файлах: `data-disabled`, `opacity: .45`.
- Финальная проверка идёт: весь компонент `inert`, поле `disabled` (текст `--ink-2`).

Доступность: «+ файл» — это `<label>` вокруг визуально скрытого `<input type="file" multiple>`; в `title` и скрытом тексте «до 10 файлів, кожен до 10 МБ». Поле описано (`aria-describedby`) подсказкой, уведомлением, строкой приватности и строкой-резюме спецификации. Ctrl/Cmd+Enter внутри поля вызывает разбор или отправку.

### HighlightTextarea

Источник: `src/components/intake/HighlightTextarea.tsx`, `src/components/intake/HighlightTextarea.module.css`, `src/components/intake/marks.ts`, `docs/SPEC-DELTA.md` §5.6

Назначение: обычный `<textarea>`, под которым лежит зеркальный слой с подсветками того, что понял разбор. Никакого `contenteditable` и переписывания значения.

Техника наложения:
- Обёртка `position: relative`.
- Первым в обёртке стоит визуально скрытый `<label>`, за ним зеркало `div.text.mirror` (`aria-hidden="true"`): `position: absolute; inset: 0; overflow: hidden; color: transparent; pointer-events: none; user-select: none`. Внутри текст, разбитый на куски, понятые фрагменты обёрнуты в `<mark>`. В конце зеркала символ U+200B, чтобы последняя пустая строка тоже имела высоту.
- Поверх `textarea.text.input` с прозрачным фоном: видимый текст и каретка принадлежат textarea, а подсветка просвечивает снизу.
- Оба слоя получают один класс `.text` со всеми метриками текста. Любое расхождение ломает совпадение строк.
- Прокрутка: на `scroll` у textarea зеркалу ставятся те же `scrollTop` и `scrollLeft`.
- Высота: `field-sizing: content` от `min-height: 220px` до `max-height: 70vh`, дальше textarea скроллится. Где `field-sizing` нет, JS ставит `height = auto`, затем `height = scrollHeight`.
- Пока открыт ввод через IME (`compositionstart` → `compositionend`), зеркало показывает простой текст без меток.
- `spellCheck={false}`, `autoCorrect="off"`: волны орфографии легли бы поверх подсветок.

```css
.wrap { position: relative; min-width: 0; }

/* общие метрики зеркала и textarea */
.text {
  margin: 0; border: 0; width: 100%;
  padding: 22px 22px 18px;                       /* сверху не меньше 18px: подписи первой строки не обрезаются */
  font: 400 var(--fs-write)/var(--lh-write) var(--ff-text);   /* 19px/2.35, на телефоне 17px */
  letter-spacing: var(--tr-write);              /* -0.005em */
  word-spacing: normal; text-indent: 0; text-transform: none; text-align: start;
  font-kerning: normal; font-variant-ligatures: normal; font-feature-settings: normal; font-synthesis: none;
  white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; tab-size: 4; hyphens: manual;
  scrollbar-gutter: stable;                      /* полоса прокрутки не меняет ширину переноса только у одного слоя */
}
.mirror { position: absolute; inset: 0; overflow: hidden; color: transparent; pointer-events: none; user-select: none; }
.input {
  position: relative; display: block; background: transparent; color: var(--ink); caret-color: var(--accent-solid);
  resize: none; outline: none; overflow-y: auto; min-height: 220px; max-height: 70vh;
  field-sizing: content;
}
.input::placeholder { color: var(--ink-3); }
.input:disabled { color: var(--ink-2); cursor: default; }

/* метка: подчёркивание и заливка нижней части строки — два фоновых слоя, не border */
.mirror mark {
  --mark-line: linear-gradient(var(--accent-line), var(--accent-line));
  --mark-wash: linear-gradient(transparent 62%, var(--accent-wash) 62%);
  position: relative; color: transparent; padding: 0; margin: 0; border-radius: 0; font: inherit; letter-spacing: inherit;
  background: var(--mark-line) no-repeat 0 100% / 100% 1.5px, var(--mark-wash) no-repeat 0 0 / 100% 100%;
}
/* подпись над меткой */
.mirror mark::before {
  content: attr(data-k); position: absolute; left: 0; top: -1.45em;   /* -16px от 11px подписи */
  font: 500 var(--fs-label)/1 var(--ff-text); letter-spacing: 0; color: var(--accent-text); white-space: nowrap; opacity: .9;
}
.mirror mark[data-k-end]::before { left: auto; right: 0; }
.mirror mark[data-k-hidden]::before { content: none; }

/* фрагмент, по которому есть вопрос: пунктир и заливка цветом вопроса */
.mirror mark[data-ask] {
  --mark-line: repeating-linear-gradient(90deg, var(--ask) 0 4px, transparent 4px 7px);
  --mark-wash: linear-gradient(transparent 62%, var(--ask-wash) 62%);
}
.mirror mark[data-ask]::before { color: var(--ask); }

/* появление новых меток */
.mirror mark[data-new] { animation: actum-mark var(--dur-mark) var(--ease) both; animation-delay: calc(var(--i) * var(--stagger-mark)); }
.mirror mark[data-new]::before { animation: actum-label 450ms var(--ease) both; animation-delay: calc(var(--i) * var(--stagger-mark) + 60ms); }
@keyframes actum-mark  { from { background-size: 0 1.5px, 0 100%; } }
@keyframes actum-label { from { opacity: 0; transform: translateY(4px); } }
```

Метка:
- Подчёркивание 1.5px цветом `--accent-line` по низу и заливка нижних 38% строки цветом `--accent-wash` (`rgb(201 184 255 / .11)`).
- Подпись над меткой — короткое слово из разбора (`Quote.label`; примеры из `src/app/(dev)/kit/_kit/fixtures.ts`: «що», «період», «фільтр», «термін», «навіщо»): 11px, 500, `--accent-text` (`#D3C6FF`; в светлой теме `#5537C2`), прозрачность .9. Подпись стоит в абсолютном позиционировании и не влияет на разметку.
- Фрагмент с вопросом (`data-ask`): пунктир 4px штрих / 3px пробел цветом `--ask`, заливка `--ask-wash`, подпись цветом `--ask` со знаком вопроса на конце («термін?»).
- Запреты: у метки никогда нет горизонтального padding, `nowrap`, другого веса, размера или трекинга — иначе текст уедет от каретки.
- Межстрочный интервал 2.35 при 19px даёт строку 44.65px и место около 21px между строками; подпись 11px висит на 16px выше метки и помещается в этот зазор. Ниже 2.2 не опускать.

Движение:
- Новая метка (ключ `поле:текст`, которого не было) растёт слева направо: `actum-mark` 500ms (`--dur-mark`), `--ease` (`cubic-bezier(.2, .8, .2, 1)`), задержка `индекс × 80ms` (`--stagger-mark`) среди новых.
- Подпись всплывает на 4px за 450ms с задержкой +60ms.
- Метки, которые уже были при загрузке страницы, не анимируются. `data-new` снимается через 650ms + 110ms на каждую новую метку + 100ms.

Столкновения подписей: после каждого рендера JS меряет первый прямоугольник каждой метки (`getClientRects()`) и ширину подписи (через canvas). Если подпись налезает на предыдущую на той же строке (с запасом 6px), у метки ставится `data-k-hidden`. Если подпись метки в одну строку вылезает за правый край, она прижимается к концу метки (`data-k-end`). Пересчёт идёт на `ResizeObserver` и после загрузки шрифтов.

Доступность: зеркало `aria-hidden`. У textarea визуально скрытый `<label>` «Текст завдання» и `aria-describedby`. Placeholder цветом `--ink-3`.

Расхождения со SPEC-DELTA §5.6, важные для повтора: в спеке подчёркивание сделано `border-bottom` (у вопроса `dashed`), а в коде это фоновый слой 1.5px (у вопроса `repeating-linear-gradient`), чтобы оба слоя росли анимацией; `actum-mark` в коде — `from { background-size: 0 1.5px, 0 100%; }`; каретка в коде `--accent-solid`, а не `--accent`.

### HighlightedText

Источник: `src/components/intake/HighlightedText.tsx`, `HighlightTextarea.module.css` (`.static`)

Назначение: тот же текст с метками, но только для чтения. В коде применяется в карточке задачи у владельца («Исходный текст») и в галерее `/kit`. На странице задачи коллеги «Твій текст» сейчас выводится простым `<p>` без меток.

- Тот же класс `.text`, плюс `.static`: `position: relative; display: block; color: var(--ink); padding: 18px 0 6px; font-size: var(--fs-body); line-height: 2.3; letter-spacing: 0`. То есть 15px, без боковых отступов.
- Метки те же (фон, подпись, вопрос), но `color: inherit` (текст в самой метке виден) и без анимации.
- Столкновения подписей считаются так же.

### OptionChips

Источник: `src/components/intake/OptionChips.tsx`, `src/components/intake/OptionChips.module.css`

Назначение: ответы на вопрос разбора одним нажатием и поле «свій варіант…».

```css
.opts  { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; align-items: center; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 0 1 auto; }
.chip {
  border: 0; background: var(--raised); box-shadow: 0 0 0 1px var(--line-2); border-radius: var(--r-chip);
  padding: 6px 11px; font-size: var(--fs-small); line-height: 1.3; color: var(--ink-2);
  transition: box-shadow var(--dur-fast), color var(--dur-fast), transform 120ms var(--ease);
}
.chip:hover:not(:disabled)  { color: var(--ink); }
.chip:active:not(:disabled) { transform: scale(.97); }
.chip[data-on] { box-shadow: 0 0 0 1.5px var(--ink); color: var(--ink); }
.chip:disabled { opacity: .45; }
.free {
  flex: 1 1 180px; min-width: 0; border: 0; outline-offset: 2px;
  box-shadow: 0 0 0 1px var(--line-2); background: var(--raised); border-radius: var(--r-chip);
  padding: 6px 11px; font-size: var(--fs-small); line-height: 1.3; color: var(--ink);
}
.free[data-on] { box-shadow: 0 0 0 1.5px var(--ink); }
@media (pointer: coarse) { .free { min-height: 44px; font-size: 16px; } }
```

- Чип: фон `--raised`, кольцо `--line-2` (`rgb(255 255 255 / .12)`), радиус `--r-chip` (9px).
- Выбранный: кольцо 1.5px цветом `--ink`, текст `--ink`. Акцентного цвета у выбора нет.
- Поле своего ответа растягивается (`flex: 1 1 180px`), до 300 символов, Enter отправляет (не во время IME), уход фокуса тоже отправляет.
- На тач-экране поле 44px высотой и 16px шрифтом (чтобы iOS не приближал страницу).

Доступность: чипы — `role="radiogroup"` с `aria-label` = текст вопроса, каждый чип `role="radio"` и `aria-checked`. Роуминг-tabindex: в Tab попадает только выбранный (или первый). Стрелки и Home/End переводят выбор и фокус, но ответ «закрепляется» только кликом, Enter/Space или уходом фокуса из группы.

### SpecList

Источник: `src/components/intake/SpecList.tsx`, `src/components/intake/SpecList.module.css`, `src/components/intake/rows.ts`, `src/components/ui/ProgressRing.*`

Назначение: пятипунктовая спецификация, которая собирается из последнего разбора, плюс подвал с кнопкой отправки.

Анатомия (`Panel`, `data-tour="spec"`, кроме read-only):
1. `PanelHeader`: слева MetaList «**специфікація**», «№ — після надсилання» (только в редактируемом виде), «оновлюється…» с дышащей точкой (когда идёт повторный разбор). Справа `ProgressRing` «3 / 5».
2. Пустое состояние (разбора ещё не было): `.empty` padding `14px 18px 4px`, `--fs-small`, `--ink-2`, `max-width: 46ch`: «Тут з’явиться специфікація: що зробити, навіщо, коли готово, термін і терміновість.».
3. Блок «нужна доработка» после финальной проверки (`.revision`): резюме 500 `--ink`, заметки `--fs-small` `--ink-2`, строка meta-prose «Виправ позначене нижче або надішли як є.».
4. Подсказки о рисках (`.hints`): «Схоже, тут кілька окремих завдань…», «Схоже, в тексті є пароль…» — каждая с оранжевой точкой 6px слева.
5. Список строк `ol.rows`: 01 що зробити, 02 навіщо, 03 готово, коли, 04 термін, 05 терміновість; потом без номера «матеріали» (только если есть что показать), лишние вопросы по полям и вопросы «загалом».
6. Строка-резюме meta-prose (`.summary`, padding `14px 18px 0`, последней в панели — ещё `padding-bottom: 16px`), если нет блока доработки.
7. Подвал — `SendBar`.

```css
.rows[aria-busy="true"] { cursor: progress; }
.revision {
  display: grid; gap: 6px; padding: 14px 18px; border-bottom: 1px solid var(--line);
  background: var(--ask-wash); box-shadow: inset 2px 0 0 var(--ask);
}
.hints { display: grid; gap: 6px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--ask-wash); }
.hint  { font-size: var(--fs-small); color: var(--ink); padding-left: 12px; position: relative; }
.hint::before { content: ""; position: absolute; left: 0; top: .55em; width: 6px; height: 6px; border-radius: 50%; background: var(--ask); }
.updating { display: inline-flex; align-items: center; gap: 6px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-solid); animation: actum-breathe 1.6s ease-in-out infinite; }
```

Кольцо прогресса `ProgressRing` («3 / 5», для скринридера «зрозуміло 3 з 5»). Описание: см. раздел «Базовые компоненты» → «ProgressRing». «Понятым» считается пункт 01–05 со статусом ok, закреплённый вручную или с ответом.

Состояния:
- Первый разбор идёт: строки 01–05 в состоянии `pending` со скелетонами.
- Повторный разбор: старые значения остаются, у списка `aria-busy="true"` и курсор `progress`, в шапке «оновлюється…».
- Read-only (экран «Прийнято»): заголовок «Так завдання побачить {ownerNom}», нет «№ — після надсилання», нет чипов и кнопок правки.

Движение: строка, впервые получившая значение, всплывает (`actum-rise`) со сдвигом `--stagger-row` (110ms) по очереди. Строка, у которой значение сменилось, перерисовывает значение заново и проявляет его из прозрачности (`actum-fade var(--dur-base)`, только `opacity`). На экране «Прийнято» при свежей отправке строки всплывают все по очереди.

### SpecRow

Источник: `src/components/intake/SpecRow.tsx`, `src/components/intake/SpecRow.module.css`, `src/components/ui/Skeleton.module.css`

Назначение: один пункт спецификации: номер, ключ, значение или вопрос с ответами, правка на месте.

Анатомия:

```html
<li class="row" data-state="ok">
  <span class="meta n" aria-hidden="true">01</span>
  <div class="body">
    <div class="keyLine">
      <span class="meta k">що зробити</span>
      <span class="keyActions"><button class="keyButton">Змінити</button></span>
    </div>
    <div class="v">вивантажити з CRM оптових клієнтів <span class="meta source">з тексту</span></div>
    <p class="note">…</p>                                 <!-- заметка финальной проверки -->
  </div>
</li>
```

```css
.row {
  display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: var(--s-3);
  padding: 14px 18px; border-bottom: 1px solid var(--line);
  transition: background-color .5s var(--ease);
}
.row[data-rise] { animation: actum-rise var(--dur-rise) var(--ease) both; animation-delay: calc(var(--i) * var(--stagger-row)); }
.row[data-state="ask"] { background-color: var(--ask-wash); }
.n, .k { transition: color .4s var(--ease); }
.row[data-state="ask"] .n, .row[data-state="ask"] .k { color: var(--ask); }
.row[data-state="empty"] .k { color: var(--ink-3); }
.n { padding-top: 2px; }
.keyLine { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s-3); margin-bottom: 3px; min-height: 18px; }
.keyActions { display: flex; gap: 2px; margin: -4px -6px -4px 0; opacity: 0; transition: opacity var(--dur-fast); }
.row:hover .keyActions, .row:focus-within .keyActions { opacity: 1; }
@media (hover: none) { .keyActions { opacity: 1; } }
.keyButton {
  position: relative; border: 0; background: none; color: var(--ink-3); font-size: 12.5px; line-height: 1.3;
  padding: 4px 6px; border-radius: var(--r-tag);
}
.keyButton:hover { color: var(--ink); background: var(--hover); }
@media (pointer: coarse) { .keyButton::after { content: ""; position: absolute; inset: -10px -2px; } }
.v { font-size: var(--fs-body); overflow-wrap: anywhere; }
.v[data-fade] { animation: actum-fade var(--dur-base) var(--ease); }
.question { color: var(--ink); font-weight: 500; }
.row[data-state="answered"] .question { color: var(--ink-2); font-weight: 400; }
.source { margin-left: .6em; white-space: nowrap; }
.muted { color: var(--ink-3); }
.unknown { color: var(--ask); text-decoration: underline dashed var(--ask-line); text-decoration-thickness: 1.5px; text-underline-offset: 4px; }
.note { margin-top: 6px; font-size: var(--fs-small); color: var(--ink-2); max-width: 60ch; }
```

- Сетка: колонка номера 28px и тело, gap 12px, padding `14px 18px`, линия снизу `--line`.
- Номер «01»…«05» в meta (`--ff-meta` 13px, `--ink-3`). У «матеріали» и дополнительных вопросов номера нет (пустая ячейка).
- Ключ строчными в meta: «що зробити», «навіщо», «готово, коли», «термін», «терміновість», «матеріали», «загалом».
- Значение `--fs-body` (15px). Рядом источник meta: «з тексту», «з відповіді», «вручну», «типово».

Состояния (`data-state`):
- `empty`: ключ `--ink-3`, значение «—» цветом `--ink-3`.
- `pending`: скелетон в одну строку (`padding-top: 6px`): у нечётного номера ширина 78%, у чётного 56%. Полоса высотой .75em, радиус `--r-tag` (6px), фон `--hover` с бегущим бликом `linear-gradient(90deg, var(--hover) 30%, var(--line-2) 50%, var(--hover) 70%)` размером 300%, `shimmer 1.6s linear infinite`. У строки `aria-busy`.
- `ok`: значение и источник. Пустое значение — «не вказано» цветом `--ink-3`. Вставка `[уточнити: …]` внутри значения окрашена `--ask` с пунктирным подчёркиванием `--ask-line` 1.5px, отступ 4px.
- `ask`: фон строки `--ask-wash` (`rgb(255 180 92 / .08)`), номер и ключ `--ask`. Вместо значения текст вопроса (500, `--ink`), под ним заметка и `OptionChips`. Фон и цвета переливаются плавно (.5s и .4s). Пункт без вопроса, но с заметкой финальной проверки тоже получает `ask`: тот же фон и цвета, внутри значение с источником и заметка.
- `answered`: вопрос гаснет до `--ink-2` и веса 400. Варианты складываются (`grid-template-rows: 1fr → 0fr` за .45s, прозрачность за .3s). Появляется строка «✓ ответ» с галочкой цвета `--accent-text`, которая прорисовывается (`stroke-dasharray: 20`, `tick-draw .45s` с задержкой .25s), и кнопка «Інша відповідь». Сама строка ответа въезжает `ans-in .4s` с задержкой .15s (из `opacity: 0; translateY(3px)`).
- `pinned` (поправлено вручную): значение и «вручну»; в строке ключа «Повернути автоматичне» и «Змінити».

```css
.opts { display: grid; grid-template-rows: 1fr; transition: grid-template-rows .45s var(--ease), opacity .3s var(--ease); }
.opts > div { min-height: 0; }
.opts[data-collapsed] { grid-template-rows: 0fr; opacity: 0; }
.opts[data-collapsed] > div { overflow: hidden; }
.ans { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: var(--ink); animation: ans-in .4s var(--ease) .15s both; }
.tick { flex: none; color: var(--accent-text); }
.tick path { stroke-dasharray: 20; animation: tick-draw .45s var(--ease) .25s both; }
@keyframes ans-in { from { opacity: 0; transform: translateY(3px); } }
@keyframes tick-draw { from { stroke-dashoffset: 20; } }
```

Мелкие кнопки `.keyButton` («Змінити», «Повернути автоматичне», «Інша відповідь»): 12.5px, `--ink-3`, padding `4px 6px`, радиус `--r-tag`; hover `--ink` на фоне `--hover`. «Змінити» и «Повернути автоматичне» стоят в строке ключа (`.keyActions`): видны при наведении на строку и при фокусе внутри, на устройствах без hover видны всегда. «Інша відповідь» стоит в строке ответа и видна всегда. На тач-экране невидимая зона нажатия расширена на 10px вверх и вниз, строка не сдвигается.

Режим правки (по «Змінити»):
- Блок `.editor`: `display: grid; gap: 10px; margin-top: 4px`, кнопки primary sm «Зберегти» (неактивна, пока значение неверно) и quiet sm «Скасувати».
- Текст: textarea на 2 строки, `resize: none; min-height: 2.6lh; max-height: 40vh; field-sizing: content`, до 1000 символов, Ctrl/Cmd+Enter сохраняет.
- Термин: поля «Дата» (`type="date"`, от сегодня до +365 дней) и «Час, якщо важливо» (`type="time"`, активно только при дате) в ряд (`flex-wrap: wrap; gap: 10px; align-items: end`, поле `flex: 1 1 140px`, шрифт `--ff-meta`), плюс чип-переключатель «Не горить» (`aria-pressed`).
- Срочность: четыре чипа «Низька», «Звичайна», «Висока», «Терміново» (`role="radiogroup"`).
- Поле ввода: фон `--raised`, кольцо `--line-2`, радиус `--r-chip`, padding `8px 11px`, `--fs-body`, line-height 1.45. На тач-экране 16px и `min-height: 44px`.
- Чип редактора: как в `OptionChips`, но padding `7px 11px`; выбранный — кольцо 1.5px `--ink`.
- Esc закрывает редактор, фокус возвращается на «Змінити». При открытии фокус в первое поле.

Доступность: номер `aria-hidden`. У «Змінити» `aria-label` «Змінити: що зробити». После ответа кликом фокус переходит на «Інша відповідь», после «Інша відповідь» — на выбранный чип. Каждая редактируемая строка с вопросом несёт `data-tour="question"`; гайд берёт первую на странице.

### SendBar

Источник: `src/components/intake/SendBar.tsx`, `src/components/intake/SendBar.module.css`

Назначение: подвал спецификации с кнопкой «Надіслати», путём «надіслати як є» и состоянием проверки.

Анатомия:
- `.foot`: `display: grid; gap: var(--s-3); padding: 16px 18px`.
- `.row`: `display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap`. В ряд: primary «Надіслати» с `kbd` «Ctrl ↵» (на устройствах Apple «⌘ ↵»; `kbd` есть, только когда сочетание действительно отправит), причина блокировки meta-prose «Дай відповідь на питання вище або надішли як є.», quiet «надіслати як є».
- Под рядом: строка «Довше, ніж зазвичай. …» (после 20 с проверки) или форма «надіслати як є».

```css
.foot { display: grid; gap: var(--s-3); padding: 16px 18px; }
.row  { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
.busy { position: relative; overflow: hidden; }
.busy::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 250%; pointer-events: none;
  background: linear-gradient(100deg, transparent 30%, rgb(255 255 255 / .38) 50%, transparent 70%);
  transform: translateX(-60%);
  animation: shimmer 1.4s linear infinite;
}
@keyframes shimmer { from { transform: translateX(-60%); } to { transform: translateX(0); } }
.spin { display: inline-flex; --accent-solid: var(--accent-ink); }
.elapsed { font: 500 var(--fs-meta) var(--ff-meta); opacity: .75; min-width: 3.2ch; }
.slow { font-size: var(--fs-small); color: var(--ink-2); }

@media (max-width: 640px) {
  .foot {
    position: sticky; bottom: 12px; z-index: var(--z-top);
    margin: 0 8px 8px; padding: 12px; border-radius: var(--r-block);
    background: var(--surface); box-shadow: var(--shadow);
  }
  .row > :first-child { flex: 1 1 100%; }
  .slow, .asIs { max-height: 50vh; overflow: auto; }
  .asIsInput { font-size: 16px; }
}
```

Состояния:
- Отправить нельзя (короткий текст или открытые вопросы): кнопка `disabled` (`opacity: .45`, без тени). Причина рядом, связанная через `aria-describedby`, показывается только когда в тексте не меньше 10 символов.
- Проверка идёт: кнопка остаётся primary, но превращается в индикатор. Внутри анимированный знак логотипа 17px (цвет `--accent-ink` поверх сиреневой заливки), текст «{brand} перевіряє завдання…» и таймер «0:07» (`--ff-meta` 500, прозрачность .75). По кнопке бежит белый блик (`rgb(255 255 255 / .38)`, 1.4s). У кнопки `aria-busy` и `data-busy` (нажатие без сжатия, курсор `progress`). `kbd` скрыт.
- Смена ширины кнопки при переходе в индикатор анимируется по FLIP: 450ms, `cubic-bezier(.2, .8, .2, 1)` (при reduced motion — нет).
- Через 20 с: строка «Довше, ніж зазвичай. Завдання вже збережене, можна зачекати.» (`--fs-small`, `--ink-2`).

Форма «надіслати як є» (`SendAsIs`, на месте, без модалки):

```css
.asIs { display: grid; gap: 10px; padding: 14px; border-radius: var(--r-block); background: var(--raised); box-shadow: 0 0 0 1px var(--line-2); animation: actum-fade var(--dur-base) var(--ease); }
.asIsLabel { display: grid; gap: 8px; font-size: var(--fs-ui); color: var(--ink); }
.asIsInput {
  width: 100%; border: 0; border-radius: var(--r-chip); padding: 8px 11px; resize: none;
  background: var(--surface); box-shadow: 0 0 0 1px var(--line-2); color: var(--ink);
  font-size: var(--fs-body); line-height: 1.45; min-height: 2.6lh; field-sizing: content; max-height: 30vh;
}
.asIsInput[aria-invalid="true"] { box-shadow: 0 0 0 1.5px var(--ask); }
.error { font-size: var(--fs-small); color: var(--ask); }
.asIsActions { display: flex; align-items: center; gap: var(--s-2); }
```

- Подпись «Чому без уточнень? Пара слів для {ownerGen}», placeholder «Наприклад: деталі обговорили на планерці», 5–500 символов.
- Кнопки primary sm «Надіслати як є» и quiet sm «Скасувати».
- Ошибка (меньше 5 символов): кольцо поля 1.5px `--ask` и строка «Напиши хоча б кілька слів.».
- При открытии фокус в поле; Esc или «Скасувати» закрывают и возвращают фокус на «надіслати як є». Ctrl/Cmd+Enter отправляет.
- Ссылка «надіслати як є» показывается, когда в тексте не меньше 10 символов.

Телефон (до 640 px): подвал становится плавающей карточкой, прилипшей к низу экрана: `position: sticky; bottom: 12px`, отступ от краёв панели 8px, padding 12px, радиус `--r-block`, фон `--surface`, тень `--shadow`, над соседями (`--z-top` = 10). Кнопка «Надіслати» на всю ширину первой строкой. Прилипание работает, потому что `Panel` обрезает через `overflow: clip`, а не `hidden`. Длинная форма «як є» и строка «довше» ограничены 50vh и прокручиваются внутри.

Доступность: у кнопки `aria-keyshortcuts="Control+Enter Meta+Enter"` (когда есть `kbd`), `kbd` скрыт от скринридера. `data-tour="send"`.

Расхождение со SPEC-DELTA: в спеке кнопка «Надіслати {ownerDat}», в коде просто «Надіслати».

### FileDrop

Источник: `src/components/intake/FileDrop.tsx`, `src/components/intake/FileDrop.module.css`

Назначение: пока файлы тащат над окном, вся страница показывает, куда они упадут. Ещё ловит вставку скриншота, когда фокус не в поле.

```css
.veil {
  position: fixed; inset: 0; z-index: var(--z-dialog); display: grid; place-items: center; padding: var(--gutter);
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(6px);
  pointer-events: none;
  animation: fd-fade var(--dur-fast) var(--ease) both;
}
.veil::before {
  content: ""; position: absolute; inset: 14px; border-radius: var(--r-panel);
  box-shadow: inset 0 0 0 1.5px var(--accent-line), inset 0 0 60px -20px var(--accent-wash);
}
.card {
  position: relative; display: grid; justify-items: center; gap: var(--s-2); text-align: center;
  max-width: 420px; padding: var(--s-7) var(--s-8); border-radius: var(--r-panel);
  background: var(--surface); box-shadow: 0 0 0 1px var(--accent-line), var(--shadow-drop);
  animation: fd-lift var(--dur-base) var(--ease) both;
}
.icon  { color: var(--accent-text); }
.title { margin: 0; font: 600 var(--fs-h3)/var(--lh-h3) var(--ff-display); letter-spacing: var(--tr-h3); color: var(--ink); }
@keyframes fd-fade { from { opacity: 0; } }
@keyframes fd-lift { from { opacity: 0; transform: translateY(6px) scale(.98); } }
```

- Слой на уровне `--z-dialog` (40) через портал в `body` (гайд и тосты выше него): затемнение `--bg` 72% с размытием 6px и сиреневая рамка 1.5px с отступом 14px от краёв окна, радиус `--r-panel`.
- По центру карточка: иконка скрепки 22px (`--accent-text`), заголовок 600 20px «Відпусти, щоб додати файли», подсказка meta-prose «Скріншоти PNG, JPEG, WebP, GIF і документи. До 10 файлів, кожен до 10 МБ.».
- Появление: слой проявляется за 150ms, карточка поднимается за 220ms.
- Слой не перехватывает указатель (`pointer-events: none`), весь слой `aria-hidden`. Перетаскивание текста внутри страницы его не вызывает. Пока идёт финальная проверка, не показывается.

### ComposerFiles

Источник: `src/components/intake/ComposerFiles.tsx`, `src/components/intake/ComposerFiles.module.css`

Назначение: плитки вложений под текстом редактора: картинки квадратами, документы шире, прогресс загрузки, «Повторити», «Прибрати».

```css
.files { list-style: none; margin: 0; padding: 2px 18px 14px; display: flex; flex-wrap: wrap; gap: var(--s-2); }
.tile {
  --size: 76px;
  position: relative; flex: none; width: var(--size); height: var(--size);
  border-radius: var(--r-block); background: var(--hover); box-shadow: 0 0 0 1px var(--line);
  animation: cf-in var(--dur-base) var(--ease) both;
}
.docTile { width: 172px; background: var(--raised); }
.open { display: block; width: 100%; height: 100%; padding: 0; border: 0; border-radius: inherit; overflow: hidden; cursor: zoom-in; background: none; }
.open img { display: block; width: 100%; height: 100%; object-fit: cover; transition: opacity var(--dur-fast), transform var(--dur-base) var(--ease); }
.open:hover:not(:disabled) img { transform: scale(1.04); }
.tile:has(.open:hover:not(:disabled)) { box-shadow: 0 0 0 1px var(--accent-line); }
.remove { position: absolute; top: -7px; right: -7px; width: 22px; height: 22px; opacity: 0; }
.tile:hover .remove, .remove:focus-visible, .tile:focus-within .remove { opacity: 1; }
@keyframes cf-in { from { opacity: 0; transform: scale(.92); } }
@keyframes cf-breathe { 50% { opacity: .6; } }
```

Анатомия:
- Ряд плиток: flex с переносом, gap 8px, padding `2px 18px 14px`.
- Картинка: квадрат 76px, радиус `--r-block`, фон `--hover`, кольцо `--line`, превью `object-fit: cover`. Кнопка-плитка открывает `Lightbox` (курсор `zoom-in`, `aria-haspopup="dialog"`, `aria-label` «Переглянути {name}»).
- Документ: плитка 172×76px, фон `--raised`. Внутри (padding `11px 30px 22px 11px`, колонкой с gap 6px) иконка документа 16px `--ink-3` и тип файла «PDF» (`500 11px/1 --ff-text`, `letter-spacing: .04em`, `--accent-text`), ниже имя `--fs-chip` (12.5px) в одну строку с многоточием.
- Статус внизу плитки (11.5px): размер, «у черзі», «завантажено 42%» или причина ошибки. На картинке статус лежит на тёмном градиенте `linear-gradient(transparent, rgb(7 8 10 / .72))` белым `#F3F4F6` по центру. У готовой картинки статуса нет.
- Кнопка «Прибрати» (крестик 12px): круг 22px в правом верхнем углу со сдвигом -7px, фон `--surface`, кольцо `--line-2` и тень `0 4px 10px -4px rgb(0 0 0 / .4)`. Появляется при наведении или фокусе. У документа всегда видна, прозрачная, внутри плитки (`top: 7px; right: 7px`, `--ink-3`).

Состояния (`data-state`):
- `uploading`: превью картинки с прозрачностью .55. Полоса прогресса снизу: 2px, трек `--line-2`, заливка `--accent-solid` растёт через `transform: scaleX(var(--p))` (переход 180ms linear). На картинке виден только процент.
- В очереди (`data-queued`): плитка дышит `cf-breathe 1.6s` (прозрачность до .6), статус «у черзі».
- `failed`: кольцо `--ask-line`, превью прозрачностью .3, статус цветом `--ask` (`role="alert"`). По центру картинки круглая кнопка «Повторити» 30px с иконкой цвета `--ask`; у документа 24px справа внизу.
- Появление плитки: `cf-in` 220ms из `scale(.92)`.
- Нажатие на кнопки плитки: `scale(.94)`.

Телефон и тач:
- До 640 px: padding ряда `2px 14px 12px`, картинка 68px, документ 152px.
- Без hover: «Прибрати» видна всегда.
- `pointer: coarse`: «Прибрати» у картинки 32px со сдвигом -10px и невидимой зоной ещё на 6px вокруг.

### AcceptedCard

Источник: `src/components/intake/AcceptedCard.tsx`, `src/components/intake/AcceptedCard.module.css`, `src/components/ui/StatusTrail.module.css`

Назначение: карточка «Прийнято» с крупным номером задачи, куда она ушла, следом статусов и следующими действиями.

Анатомия (`Panel`, `data-tour="accepted"`):
1. `.head`: слева большой номер «№0148», справа блок `.side` с заголовком h2 («Передано», «Передано без перевірки» или «Передано як є») и `StatusTrail` под ним.
2. MetaList: время отправки и пояснения по исходу.
3. Слот `extra` (строка Telegram).
4. `.actions`: primary-ссылка «Мої завдання», ghost-ссылка «Нове завдання», quiet «Скопіювати номер».

```css
.card { display: grid; gap: var(--s-4); padding: 26px 28px; }
.head { --num: var(--fs-num-xl); display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 var(--s-6); align-items: start; }
.num  { font: 300 var(--num)/1 var(--ff-mono); letter-spacing: var(--tr-num-xl); white-space: nowrap; }
.sign { color: var(--ink-3); margin-right: .14em; }
.dg[data-run]  { color: var(--ink-3); }
.dg[data-lock] { animation: lock .7s var(--ease); }
.head[data-play] .num { animation: num-in .45s var(--ease) both; }
@keyframes lock   { 0% { color: var(--accent); text-shadow: 0 0 18px var(--accent-line); } 100% { color: var(--ink); text-shadow: none; } }
@keyframes num-in { from { opacity: 0; filter: blur(6px); } }

/* заголовок и след статусов выровнены по метрикам цифр Martian Mono */
.side  { min-width: 0; margin-top: calc(var(--num) * .015 - 3px); }
.title { font: 500 var(--fs-h3)/var(--lh-h3) var(--ff-display); letter-spacing: var(--tr-h3); }
.trail { margin-top: calc(var(--num) * .82 - 33.35px); }
.head[data-play] .side { animation: side-in .5s var(--ease) .15s both; }
@keyframes side-in { from { opacity: 0; transform: translateY(4px); } }

.actions { display: flex; align-items: center; gap: var(--s-2) var(--s-3); flex-wrap: wrap; border-top: 1px solid var(--line); padding-top: var(--s-4); }
@media (max-width: 760px) { .card { padding: 22px 20px; } }
@media (max-width: 560px) {
  .head { grid-template-columns: minmax(0, 1fr); row-gap: var(--s-3); }
  .side { margin-top: 0; }
  .trail { margin-top: var(--s-2); }
}
```

Номер:
- Вся строка «№» и цифры одним шрифтом `--ff-mono` (Martian Mono, «№» из кириллического файла), вес 300, размер `--fs-num-xl` (64px; до 760 px 48px), line-height 1, `letter-spacing: -0.07em`.
- Знак «№» цветом `--ink-3`, прижат к цифрам (`margin-right: .14em`, без пробела). Цифры `--ink`, четыре знака с нулями: «0148».
- Выравнивание: верх заглавных букв заголовка совпадает с верхом цифр, а след статусов стоит на базовой линии номера. Формулы в CSS выше рассчитаны на заголовок 20px/1.2 и meta 13px/1.4; при смене этих размеров их надо пересчитать.

MetaList по исходу:
- `passed`: «сьогодні 14:20», «перевірено за 7 с», «статус у «Мої завдання»».
- `unchecked`: время, «перевірка зараз не відповідає» (или «автоматичну перевірку вимкнено»), «{ownerNom} побачить завдання як звичайно».
- `forced`: время, «разом із твоїм поясненням», «статус у «Мої завдання»».

След статусов `StatusTrail` («прийнято → в роботі → готово», здесь с `animate`). Описание: см. раздел «Базовые компоненты» → «StatusTrail».

Движение (только сразу после отправки, `data-play`):
- Номер проявляется из размытия 6px за 450ms.
- Цифры «расшифровываются»: каждая перебирает случайные цифры (новая каждые 55ms) 380ms + 140ms на позицию, пока перебирает — цвет `--ink-3`. Затем фиксируется вспышкой: из `--accent` со свечением `0 0 18px var(--accent-line)` в `--ink` за 700ms.
- Заголовок со следом поднимаются на 4px за 500ms с задержкой 150ms.
- Точки достигнутых шагов следа заливаются (из `--ink-3`) за 500ms с задержками 0.9s, 1.1s, 1.3s.
- Reduced motion: без перебора цифр, всё сразу в конечном виде.

Телефон: до 760 px padding `22px 20px`; до 560 px номер над заголовком одной колонкой (row-gap 12px), след статусов с отступом 8px.

Доступность: крупный номер `aria-hidden`, а в h2 спрятан текст «№ 0148. » перед заголовком. После отправки фокус переходит на h2 (`tabindex="-1"`, без рамки). «Скопіювати номер» копирует «№ 0148» и показывает тост «Номер скопійовано: № 0148».

Расхождение со SPEC-DELTA: в спеке сетка `auto 1fr auto` с gap 28 и одна колонка с 760 px; в коде `auto minmax(0, 1fr)`, промежуток колонок `--s-6` (24px), одна колонка с 560 px.

## Вложения и просмотр

### AttachmentGallery

Источник: `src/components/media/AttachmentGallery.tsx`, `src/components/media/AttachmentGallery.module.css`

Назначение: файлы отправленной задачи: миниатюры картинок открывают просмотр, документы — строки со «Скачати». Используется на странице задачи коллеги (`md`) и в боковой панели владельца (`sm`).

Скриншоты: `colleague-task-1366-dark.png` и остальные `colleague-task-*` (две картинки в панели «Файли»).

```css
.gallery { display: grid; gap: var(--s-3); min-width: 0; }
.grid { --tile: 112px; list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--tile), 1fr)); gap: var(--s-2); }
.sm .grid { --tile: 84px; }
.thumb {
  display: block; width: 100%; aspect-ratio: 1; padding: 0; border: 0; cursor: zoom-in;
  border-radius: var(--r-block); background: var(--hover); box-shadow: 0 0 0 1px var(--line);
  overflow: hidden; transition: box-shadow var(--dur-fast), transform var(--dur-fast) var(--ease);
}
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; transition: transform var(--dur-base) var(--ease), opacity var(--dur-fast); }
.thumb:hover { box-shadow: 0 0 0 1px var(--accent-line); }
.thumb:hover img { transform: scale(1.03); }
.thumb:active { transform: scale(.97); }

.docs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.doc {
  display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--s-2);
  padding: 8px 8px 8px 12px; border-radius: var(--r-chip); box-shadow: 0 0 0 1px var(--line); background: var(--raised);
  font-size: var(--fs-small); color: var(--ink-2);
}
.docLink {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: var(--r-inner);
  color: var(--ink-2); text-decoration: none; font-weight: 500; white-space: nowrap;
  transition: color var(--dur-fast), background-color var(--dur-fast);
}
.docLink:hover { color: var(--ink); background: var(--hover); }
@media (max-width: 640px) {
  .grid { --tile: 88px; }
  .doc { grid-template-columns: auto minmax(0, 1fr) auto; }
  .docType, .docSize { display: none; }
}
```

- Сначала сетка квадратных миниатюр (без серверного ресайза, только `object-fit: cover`): минимум 112px, на телефоне 88px; у `sm` 84px на любой ширине (`.sm .grid` сильнее правила в media). Колонки `auto-fill`.
- Миниатюра: радиус `--r-block`, фон `--hover`, кольцо `--line`. Hover: кольцо `--accent-line` и картинка `scale(1.03)`. Нажатие: `scale(.97)`.
- Затем документы строками: иконка 18px `--ink-3`, тип «PDF» (11px 500, `.04em`, `--accent-text`), имя `--ink` с многоточием, размер meta, ссылка «Скачати» с иконкой 14px (500, `--ink-2`, hover `--ink` на `--hover`).
- Картинка, которая не загрузилась, переезжает в список документов.
- Телефон: в строке документа остаются иконка, имя и «Скачати».

Доступность: миниатюра — кнопка с `aria-haspopup="dialog"` и `aria-label` «Переглянути {name}», `<img alt="">`, `loading="lazy"`. У «Скачати» `aria-label` «Скачати: {name}, {size}».

### Lightbox

Источник: `src/components/media/Lightbox.tsx`, `src/components/media/Lightbox.module.css`, `src/components/media/icons.tsx`

Назначение: полноэкранный просмотр картинок: вырастает из миниатюры и сжимается обратно, листание, масштаб, перетаскивание, «Скачати».

Скриншоты: `colleague-task-lightbox-1366-dark.png`, `colleague-task-lightbox-1366-light.png`, `colleague-task-lightbox-390-dark.png`, `colleague-task-lightbox-390-light.png`.

Анатомия (модальный `<dialog>` на весь экран, нативный `::backdrop` прозрачный):
- `.backdrop`: `color-mix(in srgb, var(--bg) 90%, transparent)` с `backdrop-filter: blur(14px) saturate(.9)`. Страница позади почти не видна, но угадывается.
- Верхняя полоса `.bar`: flex `space-between`, gap 12px, padding `12px` и по бокам `max(var(--gutter), env(safe-area-inset-*))`, фон `linear-gradient(color-mix(in srgb, var(--bg) 82%, transparent) 55%, transparent)`. Слева имя файла (`500 var(--fs-ui)/1.3 --ff-text`, `--ink`, многоточие, `max-width: min(46vw, 520px)`) и счётчик meta «2 з 3» (только если картинок больше одной). Справа инструменты с gap 6px: «−», процент масштаба «100%» (кнопка сброса, неактивна на 100%), «+», «Скачати» с иконкой (если есть ссылка), «×».
- Боковые круглые кнопки 44px с иконками-шевронами по центру высоты (только если картинок больше одной).
- Сцена `.stage`: `inset: 64px 84px 40px`, внутри картинка `object-fit: contain`, радиус `--r-inner`, кольцо `--line-2` и `--shadow-drop`, фон `--surface`.

```css
.icon, .zoomLevel, .download, .nav {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-width: 40px; height: 40px; padding: 0 10px; border: 0; border-radius: var(--r-control);
  background: var(--raised); color: var(--ink-2); box-shadow: 0 0 0 1px var(--line);
  font: 500 var(--fs-small)/1 var(--ff-text); text-decoration: none; cursor: pointer;
  transition: color var(--dur-fast), background-color var(--dur-fast), box-shadow var(--dur-fast), transform var(--dur-fast) var(--ease);
}
.icon { padding: 0; }
.download { padding: 0 12px; }
.icon:hover:not(:disabled), .zoomLevel:hover:not(:disabled), .download:hover, .nav:hover { color: var(--ink); background: var(--hover); box-shadow: 0 0 0 1px var(--line-2); }
.icon:active:not(:disabled), .zoomLevel:active:not(:disabled), .download:active, .nav:active { transform: scale(.97); }
.icon:disabled, .zoomLevel:disabled { opacity: .4; cursor: default; }
.zoomLevel { min-width: 58px; font: 400 var(--fs-meta)/1 var(--ff-meta); }
.nav { position: absolute; z-index: 2; top: 50%; translate: 0 -50%; width: 44px; height: 44px; padding: 0; border-radius: var(--r-pill); }
.stage { position: absolute; z-index: 1; inset: 64px 84px 40px; touch-action: none; user-select: none; cursor: zoom-in; }
.stage[data-zoomed] { cursor: grab; }
.stage[data-zoomed]:active { cursor: grabbing; }
.img {
  display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain;
  border-radius: var(--r-inner); box-shadow: 0 0 0 1px var(--line-2), var(--shadow-drop); background: var(--surface);
}
.dialog[data-phase="entering"] .img { opacity: 0; }
.dialog[open] .bar, .dialog[open] .nav { animation: lb-chrome 260ms var(--ease) 120ms both; }
.dialog[data-phase="closing"] .bar, .dialog[data-phase="closing"] .nav { opacity: 0; transition: opacity 140ms ease-in; }
@keyframes lb-chrome { from { opacity: 0; transform: translateY(-4px); } }
```

Кнопки: 40×40px (или шире с подписью), радиус `--r-control` (11px), фон `--raised`, кольцо `--line`. Иконки 16px, штрих 1.5px `currentColor`, круглые концы. Масштаб на 1× и на 6× делает «−» / «+» неактивными (прозрачность .4).

Движение:
- Открытие: подложка проявляется за 280ms (`ease-out`). Пока картинка декодируется, она скрыта. Затем FLIP: картинка стартует с геометрии миниатюры (`translate` + `scale` + `clip-path: inset(… round …)`, так что выглядит как обрезанная миниатюра со своим радиусом) и раскрывается за 440ms `cubic-bezier(.2,.8,.2,1)`. Если миниатюры не видно на экране — короткое появление из `scale(.96)` за 220ms.
- Верхняя полоса и стрелки появляются `lb-chrome` 260ms с задержкой 120ms (сверху на 4px).
- Закрытие: обратный FLIP в миниатюру за 300ms, подложка гаснет за 300ms (`ease-in`), полоса и стрелки гаснут за 140ms.
- Листание: новая картинка въезжает со стороны листания на 28px за 240ms.
- Свайп: картинка едет за пальцем, тускнеет до .5. Листание срабатывает при горизонтальном сдвиге больше 70px или быстром (скорость больше .45 px/мс и сдвиг больше 20px). Иначе возврат за 200ms.
- Reduced motion: без вырастания из миниатюры, только короткие проявления (100–120ms).

Жесты и клавиши: колесо и щипок масштабируют вокруг указателя (до 6×), двойной клик или двойной тап переключают 1× / 2.5×, при увеличении — перетаскивание. Клик по пустому месту вокруг картинки закрывает. Клавиши: ← → листают (по кругу), `+` / `=` и `-` / `_` масштаб (шаг 1.6), `0` сброс, Esc закрывает с анимацией, Tab не выходит из диалога.

Телефон (до 640 px): сцена `inset: 60px 8px 64px`; имя `max-width: 38vw`; у «Скачати» только иконка; процент масштаба скрыт; стрелки опускаются вниз (`top: auto; bottom: 12px`). Без hover курсор на сцене обычный.

Доступность: `aria-labelledby` на скрытый h2 «Перегляд зображень», `aria-describedby` на скрытую подсказку «Стрілки гортають, колесо або два пальці змінюють масштаб, Esc закриває.». Счётчик `aria-live="polite"`. При открытии фокус на «×», после закрытия на миниатюру. Пока диалог открыт, у `html` `overflow: hidden`. Картинка, которая не открылась: текст «Зображення не відкрилося.» (`--ink-2`, `--fs-body`).

## Знакомство с сервисом

### Как устроено

Источник: `src/components/onboarding/Tour.tsx`, `src/components/onboarding/practice/Practice.tsx`, `src/components/onboarding/practice/practice.module.css`, `src/app/(colleague)/guide/page.tsx`, `src/app/(colleague)/_components/GuideHost.tsx`, `src/app/demo/*`, `src/app/(dev)/kit/onboarding/*`, `docs/ONBOARDING.md`

Назначение: игровое обучение поверх настоящего экрана «Нове завдання». Страница затемняется, один элемент остаётся подсвеченным и живым, рядом карточка с объяснением. Часть шагов ждёт действия (написать, ответить, отправить).

Скриншотов гайда в `docs/screenshots/INDEX.md` нет.

- `Practice` — копия экрана `/` из настоящих компонентов (`Composer`, `SpecList`, `SendBar`, `SentView`, `TopBar`, `PageIntro`) на локальном состоянии. Раскладка та же: классы `intake.module.css`. Свои добавки лежат в `practice.module.css`: обёртка `.practice { min-width: 0 }`; строка вступления `.intro` повторяет `.introRow` (`grid-column: 1 / -1; display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s-4) var(--s-5); flex-wrap: wrap`) с `.introText { flex: 1 1 560px; min-width: 0 }`; `.again` (см. ниже) и `.contents { display: contents }` для обёрток, которые только несут `inert` или метку слота. Ничего не сохраняется и не отправляется: разбор и проверку делает тестовый провайдер в браузере (разбор через 1,5 с после паузы, от 40 символов; ответ «провайдера» через 0,9 с).
- Строка вступления: `PageIntro` и кнопка ghost sm «Як це працює?» (`aria-haspopup="dialog"`) — она перезапускает гайд. На экране «Прийнято» эта кнопка стоит отдельной строкой справа над карточкой (`.again { display: flex; justify-content: flex-end; }`).
- Переходы по ссылкам в практике отключены: тост или строка на карточке «Це навчання: тут нічого не зберігається, а переходи вимкнено.».
- Пока не дошли до шага «Надіслати», подвал с кнопкой отправки `inert`. Обёртка `display: contents`, чтобы не сломать прилипание подвала.
- Три хоста:
  - `/guide` — для коллеги, с его именем; первый визит на `/` перенаправляет сюда. Шаг Telegram здесь настоящий.
  - `/demo` — публичный показ без входа.
  - `/kit/onboarding` — песочница разработчика, в production 404.
- Гайд стартует через 700ms после загрузки (перезапуск — через 250ms).

### Шаги

Источник: `src/components/onboarding/steps.ts`, `src/lib/copy/colleague/uk.ts` (`tour.*`)

| № | id | Цель (`data-tour`) | Тип | Заголовок (uk) |
|---|---|---|---|---|
| 01 | `intro` | нет (карточка по центру) | — | «Пройдімо шлях одного завдання» |
| 02 | `write` | `composer` (фокус в textarea) | действие | «Опиши завдання своїми словами» |
| 03 | `marks` | `composer` | ожидание | «{brand} підсвічує, що зрозумів» |
| 04 | `spec` | `spec` | — | «Специфікація збирається сама» |
| 05 | `answer` | `question` (фокус на чип) | действие | «Дай відповідь на питання» |
| 06 | `files` | `attach` | — | «Файли та скріншоти» |
| 07 | `send` | `send` | действие | «Перевірка перед надсиланням» |
| 08 | `done` | `accepted` (назад нельзя) | — | «Завдання передано» |
| 09 | `telegram` | `telegram` (фокус на кнопку) | действие, необязательный | «Повідомлення в Telegram» |
| 10 | `mine` | `mine` (пункт навигации в шапке) | — | «Мої завдання» |

Варианты шагов: если финальная проверка попросила доработку, шаг `send` подсвечивает всю спецификацию (`spec`) с заданием «виправ позначене і знову натисни «Надіслати» або обери «надіслати як є».». На `/guide` у шагов `intro` и `telegram` свои тексты (`tour.intro.textLive`, `tour.telegram.textLive`).

Если цели нет (например, нет вопросов), шаг пропускается через 450ms (пока страница не занята разбором). Шаг действия после выполнения показывает «Виконано» и сам переходит дальше через 1 с.

### Затемнение и окно

Источник: `src/components/onboarding/Tour.module.css` (`.root`, `.block`, `.spot`), `src/components/onboarding/place.ts`, `useTargetRect.ts`

- Корневой слой `position: fixed; inset: 0; z-index: calc(var(--z-dialog) + 2)` (выше полупрозрачного слоя `FileDrop` и подтверждений, ниже тостов `--z-toast` = 50), сам не ловит клики. Появление `tour-in var(--dur-base)` из прозрачности, уход — прозрачность за 220ms.
- Окно (спотлайт) — один бокс над целью. Затемнение — его огромная тень с разлётом `200vmax` цветом `color-mix(in srgb, var(--bg) 72%, transparent)`. Кольцо 1.5px `--accent-line` и мягкий ореол `0 0 26px 6px var(--accent-wash)`.
- Окно больше цели на 8px с каждой стороны (`WINDOW_PAD`). Радиус окна равен радиусу цели плюс 8px (радиус цели берётся из `getComputedStyle`).
- Клики вне окна гасят четыре прозрачных блокера вокруг окна; цель внутри остаётся живой.
- Без цели (шаг `intro`) окна нет: `data-empty`, только затемнение.
- Окно плавно переезжает к новой цели (`data-glide`): `transform`, `width`, `height`, `border-radius` за `--dur-rise` (600ms) `--ease`. При скролле и ресайзе следует мгновенно (следит `ResizeObserver` и `MutationObserver`). Цель прокручивается в видимую область с запасом 16px.
- На шаге действия, пока оно не выполнено, вокруг окна тихо дышит второе кольцо.

```css
.root {
  --tour-dim: color-mix(in srgb, var(--bg) 72%, transparent);
  position: fixed; inset: 0; z-index: calc(var(--z-dialog) + 2); pointer-events: none;
  animation: tour-in var(--dur-base) var(--ease) backwards;
  transition: opacity var(--dur-base) var(--ease);
}
.block { position: fixed; pointer-events: auto; }
.spot {
  position: fixed; left: 0; top: 0; pointer-events: none;
  width: var(--w); height: var(--h); border-radius: var(--r);
  transform: translate3d(var(--x), var(--y), 0);
  box-shadow:
    0 0 0 1.5px var(--accent-line),
    0 0 26px 6px var(--accent-wash),
    0 0 0 200vmax var(--tour-dim);
}
.spot[data-empty] { box-shadow: 0 0 0 200vmax var(--tour-dim); }
.spot[data-glide] {
  transition: transform var(--dur-rise) var(--ease), width var(--dur-rise) var(--ease),
              height var(--dur-rise) var(--ease), border-radius var(--dur-rise) var(--ease);
}
.spot[data-pulse]::after {
  content: ""; position: absolute; inset: -6px; border-radius: calc(var(--r) + 6px);
  box-shadow: 0 0 0 1.5px var(--accent-line); opacity: 0;
  animation: ring-pulse 2.2s var(--ease) infinite;
}
@keyframes ring-pulse { 0%, 100% { opacity: 0; } 45% { opacity: .9; } }
```

### Карточка

Источник: `src/components/onboarding/Tour.tsx` (рендер), `Tour.module.css` (`.card` и далее), `place.ts` (`placeCard`), `machine.ts` (`counter`)

Анатомия:

```html
<div role="dialog" aria-labelledby="t" aria-describedby="d" tabindex="-1" class="card" data-ready>
  <div class="top">
    <span class="count" aria-hidden="true">02 / 10</span><span class="vh">Крок 2 з 10</span>
    <span class="track" aria-hidden="true"><span class="fill" style="transform: scaleX(.2)"></span></span>
  </div>
  <div class="body">
    <h2 id="t" class="title">Опиши завдання своїми словами</h2>
    <p id="d" class="text">Пиши як у месенджері: …</p>
    <p class="task"><b class="try">Спробуй:</b> напиши кілька речень або встав приклад.</p>
    <div class="extra"><button class="btn ghost sm">Вставити приклад</button></div>
  </div>
  <div class="actions">
    <button class="btn quiet sm skip">Пропустити навчання</button>
    <span class="moves"><button class="btn quiet">Назад</button><button class="btn primary">Далі</button></span>
  </div>
</div>
```

```css
.card {
  position: fixed; left: 0; top: 0; pointer-events: auto;
  width: min(360px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px); overflow-y: auto; overscroll-behavior: contain;
  display: grid; gap: var(--s-3); padding: 14px 16px 12px;
  background: var(--raised); color: var(--ink); border-radius: var(--r-block); box-shadow: var(--shadow);
  opacity: 0; transition: opacity var(--dur-base) var(--ease);
}
.card[data-ready] { opacity: 1; }
.card[data-glide] { transition: opacity var(--dur-base) var(--ease), translate var(--dur-rise) var(--ease); }
.top   { display: flex; align-items: center; gap: var(--s-3); }
.count { flex: none; font: 400 var(--fs-meta)/var(--lh-meta) var(--ff-meta); color: var(--ink-3); }
.track { flex: 1; height: 2px; border-radius: 2px; background: var(--line-2); overflow: hidden; }
.fill  { display: block; height: 100%; background: var(--accent-solid); transform-origin: left center; transition: transform var(--dur-rise) var(--ease); }
.body  { display: grid; gap: var(--s-2); animation: body-in var(--dur-base) var(--ease) both; }
@keyframes body-in { from { opacity: 0; transform: translateY(4px); } }
.title { font: 500 var(--fs-h3)/var(--lh-h3) var(--ff-display); letter-spacing: var(--tr-h3); text-wrap: balance; }
.text  { font-size: var(--fs-body); line-height: var(--lh-body); color: var(--ink-2); }
.task {
  display: block; margin-top: 2px; padding: 8px 10px; border-radius: var(--r-inner);
  font-size: var(--fs-small); color: var(--ink-2);
  background: var(--accent-wash); box-shadow: inset 2px 0 0 var(--accent-solid);
}
.try { font-weight: 600; color: var(--ink); }
.task[data-done] { display: flex; align-items: center; gap: 6px; color: var(--accent-text); font-weight: 500; }
.actions {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); flex-wrap: wrap; margin-top: 2px;
  position: sticky; bottom: 0; margin-bottom: -12px; padding-bottom: 12px; background: var(--raised);
}
.skip  { margin-left: -4px; }
.moves { display: flex; align-items: center; gap: var(--s-1); margin-left: auto; }
```

- Поверхность: фон `--raised`, радиус `--r-block` (14px), тень `--shadow`, ширина `min(360px, calc(100vw - 32px))`, padding `14px 16px 12px`.
- Индикатор шагов: счётчик «02 / 10» (`--ff-meta` 13px, `--ink-3`, всегда две цифры) и рядом полоса 2px: трек `--line-2`, заливка `--accent-solid` по `scaleX((n)/10)`, анимация за 600ms.
- Заголовок 500 20px Fixel Display, текст 15px `--ink-2`.
- Строка-задание на шагах действия: сиреневая подложка `--accent-wash` с кромкой 2px `--accent-solid` слева, «Спробуй:» жирным 600 `--ink`. После выполнения превращается в «✓ Виконано» цветом `--accent-text`, вес 500.
- Строка ожидания (шаг `marks`): meta-prose с точкой 6px, которая дышит `1.4s` до прозрачности .35: «{brand} розбирає текст…».
- Доп. кнопка на шаге `write`: ghost sm «Вставити приклад». Заметка meta-prose (например, про отключённые переходы) появляется с той же анимацией `body-in`.
- Кнопки: слева quiet sm «Пропустити» (на первом шаге) или «Пропустити навчання»; справа quiet «Назад» (не на первом шаге и не после отправки) и primary «Почати» / «Далі» / «Завершити». «Далі» неактивна, пока шаг действия или ожидания не выполнен (кроме необязательного Telegram).
- Ряд кнопок прилипает к низу карточки, если карточка прокручивается внутри.
- Положение: карточка ставится рядом с окном с зазором 14px, на первую сторону, где помещается целиком (снизу, сверху, справа, слева). Если не помещается нигде — на сторону с наибольшим местом. Сверху и снизу карточка центрируется по окну, справа и слева выравнивается по его верху. Затем прижимается внутрь экрана с полем 16px. Без цели — по центру. Двигается через свойство `translate`; при смене цели переезжает за 600ms.
- Содержимое карточки на каждом шаге заново проявляется `body-in` 220ms (из `opacity: 0; translateY(4px)`).

### Телефон

Источник: `Tour.module.css` (`@media (max-width: 640px)`), `place.ts` (`sheetDock`)

- До 640 px карточка становится нижней шторкой на всю ширину: `inset: auto 0 0; width: auto; translate: none`, `max-height: calc(100dvh - 8px)`, padding `14px var(--gutter) calc(12px + env(safe-area-inset-bottom))`, радиус `--r-panel --r-panel 0 0`.
- Появление шторки: `sheet-in var(--dur-base)` из `opacity: 0; translateY(16px)`.
- Если шторка закрыла бы цель насовсем (липкий подвал с «Надіслати», конец страницы), она уходит к верхнему краю (`data-dock="top"`): `inset: 0 0 auto`, padding сверху `calc(14px + env(safe-area-inset-top))`, радиус `0 0 var(--r-panel) var(--r-panel)`, появление сверху (`sheet-in-top`, translateY(-16px)). При равенстве шторка остаётся, где была, чтобы не прыгать.
- Цель прокручивается так, чтобы показаться над шторкой.

```css
@media (max-width: 640px) {
  .card {
    inset: auto 0 0; width: auto; translate: none !important; max-height: calc(100dvh - 8px);
    padding: 14px var(--gutter) calc(12px + env(safe-area-inset-bottom));
    border-radius: var(--r-panel) var(--r-panel) 0 0;
  }
  .card[data-ready] { animation: sheet-in var(--dur-base) var(--ease) both; }
  .card[data-dock="top"] {
    inset: 0 0 auto;
    padding: calc(14px + env(safe-area-inset-top)) var(--gutter) 12px;
    border-radius: 0 0 var(--r-panel) var(--r-panel);
  }
  .card[data-dock="top"][data-ready] { animation-name: sheet-in-top; }
}
@keyframes sheet-in     { from { opacity: 0; transform: translateY(16px); } }
@keyframes sheet-in-top { from { opacity: 0; transform: translateY(-16px); } }
```

### Клавиатура и доступность

Источник: `Tour.tsx`, `docs/ONBOARDING.md` «Поведение и доступность»

- Карточка `role="dialog"` немодальная (цель должна оставаться доступной), с `aria-labelledby` и `aria-describedby`. Счётчик для скринридера «Крок 2 з 10». Номер и заголовок шага объявляются через общий live-регион.
- Клавиши: Enter — «Далі» (если доступно и фокус не на кнопке или другом контроле), → / ← — «Далі» / «Назад» (на контролах вне карточки не срабатывают), Esc — закрыть гайд (и из поля ввода). В текстовых полях Enter и стрелки гайд не трогает. Esc внутри редактора пункта, формы «як є» или подтверждения закрывает только их. Пока открыт просмотр картинок, гайд клавиши не трогает.
- На смене шага фокус уходит на карточку; на шагах действия — в саму цель (поле текста, первый вариант ответа, кнопку). Поле, в котором человек печатал меньше 1,2 с назад, фокус не теряет. Tab с последнего элемента цели ведёт в карточку, Shift+Tab — обратно.
- После закрытия фокус возвращается на «Як це працює?» (если был на карточке). На `/guide` в конце тост «Навчання пройдено. …» или «Навчання можна пройти будь-коли…», затем переход на `/`.
- Режим высокой контрастности (`forced-colors: active`): окно рисуется обводкой `3px solid Highlight`, кольцо пульса — `1.5px solid Highlight`, у карточки рамка `1px solid CanvasText`, у строки-задания левая кромка `2px solid Highlight`.
- Reduced motion: всё мгновенно (общее правило `motion.css`), без пульса.
- Без стекла, градиентов и конфетти; анимируются только `transform`, `opacity` и геометрия окна.

### Telegram в практике

Источник: `src/components/onboarding/practice/TelegramStub.tsx`

На карточке «Прийнято» в `/demo` и `/kit/onboarding` стоит тот же `TelegramConnectView` (вид `card`) без сервера. Нажатие «Підключити Telegram» → состояние `opening` → через 0,9 с строка с залитой точкой «Telegram підключено (у навчанні — без справжнього бота).». На `/guide` вместо заглушки настоящий контрол, и его ссылка «Відкрити Telegram» работает (слот помечен `data-practice-slot`).

### `/demo` и `/kit/onboarding`

Источник: `src/app/demo/page.tsx`, `src/app/demo/layout.tsx`, `src/app/(dev)/kit/onboarding/page.tsx`, `src/app/(dev)/kit/onboarding/_tour/Sandbox.tsx`, `sandbox.module.css`

- Оба показывают `Practice` с гайдом (тема и язык из cookie). У `/demo` своя корневая разметка; `/kit/onboarding` живёт в разметке `/kit` (`<html lang="uk">`), язык экрана ставится на обёртке `div lang`. Видимое отличие — только заголовок служебной панели и её строка.
- Служебная панель (на русском, для владельца) — `<details>` в правом нижнем углу: `position: fixed; right: 16px; bottom: 16px; z-index: calc(var(--z-toast) - 1)` (выше гайда, ниже тостов), `max-width: 270px`, padding `8px 12px`, радиус `--r-block`, фон `--surface`, кольцо `--line-2` и `--shadow-drop`, шрифт `--fs-small`.
  - Заголовок `summary` «Песочница обучения» (`/kit`) или «Показ обучения» (`/demo`): `500 var(--fs-meta)/var(--lh-meta) --ff-text`, `--ink-2`.
  - Внутри: ghost sm «Начать обучение заново», переключатель языка, сегменты «ты» / «вы».
  - Сегменты: обёртка с кольцом `--line-2`, радиус `--r-inner`, padding 2px; кнопка padding `4px 10px`, радиус `--r-tag`, `--ink-3`; выбранная (`aria-pressed="true"`) — фон `--nav-on`, текст `--nav-on-ink`.
  - Внизу meta-prose (`max-width: 34ch`): «Демонстрация: ничего не сохраняется и не отправляется, Telegram здесь не настоящий.» или «Видно только в dev: …».
- На телефоне (до 640 px) панель перестаёт плавать и встаёт в конец страницы (`position: relative; margin: 0 var(--gutter) var(--s-8)`), потому что низ экрана занимает шторка гайда.

## Тон текстов коллеги

Источник: `src/lib/copy/colleague/uk.ts`, `docs/SPEC-DELTA.md` §6.1

- Обращение на «ти» по умолчанию. У каждой строки, где меняются слова, есть пара на «ви»: «Опиши завдання.» / «Опишіть завдання.», «Дай відповідь на питання вище або надішли як є.» / «Дайте відповідь… або надішліть як є.». Владелец всегда подставляется формой падежа: «Попроси його в {ownerGen}», «напиши {ownerDat}», «{ownerNom} побачить це в картці завдання». Название сервиса только через `{brand}`, никогда буквально.
- Регистр. Заголовки и основные кнопки с заглавной: «Надіслати», «Мої завдання», «Скопіювати номер», «Підключити Telegram». Служебные подписи, статусы и ключи спецификации строчными: «чернетка», «специфікація», «збережено 14:20», «нове», «в роботі», «готово», «що зробити», «готово, коли». Второстепенные действия-ссылки тоже строчными: «надіслати як є», «розібрати зараз», «+ файл», «свій варіант…».
- Кнопки — короткий глагол без объекта или с одним словом: «Надіслати», «Зберегти», «Скасувати», «Змінити», «Прибрати», «Повторити», «Продовжити», «Відключити». В подтверждениях кнопка повторяет действие: «Так, скасувати» / «Залишити», «Так, увійти» / «Ні, залишитися», «Вийти» / «Залишитися». В кнопках гайда нет имён.
- Подтверждение: сначала последствие, потом короткий вопрос из одного-двух слов: «{ownerNom} побачить, що завдання скасовано. Скасувати?», «Щоб увійти знову, знадобиться твоє посилання. Вийти?».
- Ошибки: что случилось и что делать, без кодов и без вины. «Не вдалося зберегти. Перевір з’єднання і спробуй ще раз.», «Файл більший за 10 МБ. Додай його посиланням у тексті.». Где можно, успокаивают, что данные целы: «Забагато змін поспіль. Зачекай хвилину, текст нікуди не дінеться.», «Довше, ніж зазвичай. Завдання вже збережене, можна зачекати.». Лимиты называют время: «Спробуй за {n} хв.», «Наступний о {time}, а надіслати можна вже зараз.».
- Сбой автоматического разбора не блокирует отправку, и текст это прямо говорит: «Автоматичний розбір зараз не працює. Можна надіслати й так: {ownerNom} розбереться.».
- Вопросы к коллеге — по-человечески и с примером: «Чому без уточнень? Пара слів для {ownerGen}», placeholder «Наприклад: деталі обговорили на планерці». Подсказки о рисках начинаются со «Схоже, …» и предлагают выход: «Схоже, тут кілька окремих завдань. Краще надіслати їх по одному.».
- Разговорный, спокойный голос: «Пиши як у месенджері.», «Готово, ти в {brand}.», «Ще мить: показуємо, як завдання побачить {ownerNom}…». О приватности прямо: «Текст розбирає зовнішній сервіс (Claude). Не вставляй паролі й персональні дані.».
- Пунктуация: апостроф только `’` (U+2019): «з’явиться», «зв’язку»; знака «·» нигде нет; многоточие `…` у процессов и заготовок («зберігається…», «розбирається…», «свій варіант…»); двоеточие вводит пояснение («Збережи посилання: воно знадобиться…»); названия экранов и кнопок в «ёлочках» («статус у «Мої завдання»», «натисни «Надіслати»»).
- В гайде задание формулируется как «Спробуй:» плюс строчная фраза с глаголом: «Спробуй: напиши кілька речень або встав приклад.», «Спробуй: натисни «Надіслати».»; выполненное — одно слово «Виконано».

Расхождения кода со SPEC-DELTA §6.1 (код главнее): кнопка «Надіслати» без `{ownerDat}`; заголовки карточки «Передано», «Передано без перевірки», «Передано як є» без `{ownerDat}`; лимит вложений 10 файлов («до 10 файлів, кожен до 10 МБ»), а не 5.

# Приложение А. Готовые файлы стилей

Эти файлы скопированы из `src/styles/` без изменений. Стеки `--ff-*` в `tokens.css` ссылаются на переменные `--font-*` из `next/font`. Без `next/font` замените их стеками из раздела «Шрифты» → «То же на чистом CSS, без next/font».

## globals.css

```css
/*
 * The one global stylesheet. Every root layout imports it once:
 *   import "@/styles/globals.css";
 * (src/app/globals.css is intentionally not used: all styles live in src/styles.)
 */
@import "./tokens.css";
@import "./base.css";
@import "./motion.css";
```

## tokens.css

```css
/*
 * Actum design tokens (SPEC-DELTA 5.1, look from docs/design-directions/actum-2026b.html).
 * Dark is the default; light and system come from <html data-theme>, set on the server from the
 * tf_theme cookie (src/lib/theme.ts). Accent is lilac «Бузок», flat, never a gradient.
 * Additions to the spec block, all derived from it: --shadow-drop (the shadow without its ring, for
 * focus rings that replace the ring), --ask-line, --danger-wash, and --accent-solid: small accent marks
 * (status dots, caret, selected edge) that must stay visible; = --accent in dark, = --accent-line in light,
 * because the pale light fill #D9CCFF is ~1.4:1 on white. --nav-on / --nav-on-ink / --nav-on-meta: the current
 * nav item and inbox tab; = --hover / --ink / --ink-3 in dark, lilac in light (#5537C2 on #E4DAFF is 5.8:1; the
 * pill is a paler #D9CCFF, 1.24:1 on the page), because --hover is ~1.04:1 on the light page
 * (tests/design/tokens.test.ts). The light --grid is lighter than the mockup's .04: lines read stronger on
 * a light page, .025 looks as faint as the dark grid.
 */
:root {
  /* fonts: the --font-* variables come from next/font (src/app/fonts.ts) */
  --ff-display: var(--font-fixel-display), system-ui, sans-serif;
  --ff-text: var(--font-fixel-text), system-ui, sans-serif;
  --ff-meta: var(--font-num), var(--font-fixel-text), system-ui, sans-serif; /* digits : / $ % . in Martian Mono; «№» stays Fixel (Martian's reads as «₱» at 12–14 px) */
  --ff-mono: var(--font-mono), var(--font-mono-cyr), ui-monospace, monospace; /* whole string in Martian Mono, «№» too: the big serial */

  /* type scale */
  --fs-h1: 52px;   --lh-h1: 1.02;  --tr-h1: -0.045em;
  --fs-h2: 24px;   --lh-h2: 1.15;  --tr-h2: -0.025em;
  --fs-h3: 20px;   --lh-h3: 1.2;   --tr-h3: -0.02em;
  --fs-logo: 21px; --tr-logo: -0.035em;
  --fs-write: 19px; --lh-write: 2.35; --tr-write: -0.005em;
  --fs-body: 15px; --lh-body: 1.55;
  --fs-ui: 14px;
  --fs-small: 13.5px;
  --fs-meta: 13px; --lh-meta: 1.4;
  --fs-chip: 12.5px;
  --fs-label: 11px;
  --fs-num-xl: 64px; --tr-num-xl: -0.07em;
  --lh-log: 1.9;

  /* spacing (4 px base) */
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px; --s-6: 24px; --s-7: 28px; --s-8: 40px; --s-9: 56px; --s-10: 90px;

  /* radii */
  --r-panel: 20px;   /* Panel, CommandBar dialog */
  --r-block: 14px;   /* Block, CommandBar trigger, toasts */
  --r-control: 11px; /* ThemeSwitch track, buttons (primary, ghost) */
  --r-chip: 9px;     /* option chips, inputs */
  --r-inner: 8px;    /* segments, tabs, focus outline */
  --r-tag: 6px;      /* kbd, agent chip, logo square, skeleton bars */
  --r-pill: 999px;

  /* layout */
  --page-colleague: 1180px; --page-owner: 1280px; --side-w: 460px; --gutter: 24px;
  /* side column of the other admin pages: as wide as the inbox card, narrower on small laptops */
  --side-page: clamp(340px, 34vw, var(--side-w));

  /* motion */
  /* DECISIONS 3e: reactions 120–240 ms, brand moments 400–800 ms, marks 60–80 ms apart */
  --dur-fast: 150ms; --dur-base: 220ms; --dur-rise: 600ms; --dur-mark: 500ms;
  --stagger-mark: 80ms; --stagger-row: 110ms;
  --ease: cubic-bezier(.2, .8, .2, 1);
  --ease-spring: cubic-bezier(.34, 1.3, .5, 1); /* progress ring: a short spring */
  --ease-pop: cubic-bezier(.3, 1.25, .5, 1);    /* toasts: spring in, no visible bounce */

  /* layers */
  --z-top: 10; --z-dialog: 40; --z-toast: 50; --z-cursor: 60; /* cursor light: above everything, never takes clicks */
  --cursor-size: 48px;
}
@media (max-width: 640px) { :root { --gutter: 16px; --fs-write: 17px; } }
@media (max-width: 760px) { :root { --fs-h1: 40px; --fs-num-xl: 48px; } }

/* dark: the default theme */
:root,
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #07080A; --surface: #0E0F12; --raised: #141519; --hover: #1A1C21;
  --line: rgb(255 255 255 / .07); --line-2: rgb(255 255 255 / .12);
  --ink: #F3F4F6; --ink-2: #A3A9B3; --ink-3: #7E848E;
  --accent: #C9B8FF; --accent-ink: #0A0B0C; --accent-text: #D3C6FF;
  --accent-wash: rgb(201 184 255 / .11); --accent-line: rgb(201 184 255 / .55); --accent-solid: #C9B8FF;
  --ask: #FFB45C; --ask-wash: rgb(255 180 92 / .08); --ask-line: rgb(255 180 92 / .55);
  --danger: #FF7A7A; --danger-wash: rgb(255 122 122 / .09);
  --nav-on: var(--hover); --nav-on-ink: var(--ink); --nav-on-meta: var(--ink-3);
  --grid: rgb(255 255 255 / .035);
  --glow: var(--accent-wash);
  --cursor-rgb: 201 184 255; --cursor-a: .30; --cursor-wave-a: .6; --cursor-blend: screen; /* CursorLight: spot and soft click wave */
  --shadow-drop: 0 24px 48px -24px rgb(0 0 0 / .6);
  --shadow: 0 0 0 1px var(--line), var(--shadow-drop);
  --shadow-accent: 0 0 0 1px rgb(0 0 0 / .1), 0 8px 24px -10px var(--accent-line);
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #F6F7F8; --surface: #FFFFFF; --raised: #FBFBFC; --hover: #F1F2F4;
  --line: rgb(10 12 16 / .08); --line-2: rgb(10 12 16 / .14);
  --ink: #0A0C10; --ink-2: #555C68; --ink-3: #676D77;
  --accent: #D9CCFF; --accent-ink: #0A0B0C; --accent-text: #5537C2;
  --accent-wash: rgb(150 120 255 / .14); --accent-line: #7E62E0; --accent-solid: #7E62E0;
  --ask: #B45309; --ask-wash: rgb(245 158 11 / .09); --ask-line: rgb(180 83 9 / .6);
  --danger: #B42318; --danger-wash: rgb(180 35 24 / .07);
  --nav-on: #E4DAFF; --nav-on-ink: #5537C2; --nav-on-meta: #5537C2;
  --grid: rgb(10 12 16 / .025);
  --glow: var(--accent-wash);
  --cursor-rgb: 126 98 224; --cursor-a: .22; --cursor-wave-a: .45; --cursor-blend: multiply;
  --shadow-drop: 0 24px 48px -28px rgb(10 12 16 / .25);
  --shadow: 0 0 0 1px var(--line), var(--shadow-drop);
  --shadow-accent: 0 0 0 1px rgb(0 0 0 / .1), 0 8px 24px -10px var(--accent-line);
}
@media (prefers-color-scheme: light) {
  /* keep identical to [data-theme="light"]; tests/design/tokens.test.ts compares the two blocks */
  :root[data-theme="system"] {
    color-scheme: light;
    --bg: #F6F7F8; --surface: #FFFFFF; --raised: #FBFBFC; --hover: #F1F2F4;
    --line: rgb(10 12 16 / .08); --line-2: rgb(10 12 16 / .14);
    --ink: #0A0C10; --ink-2: #555C68; --ink-3: #676D77;
    --accent: #D9CCFF; --accent-ink: #0A0B0C; --accent-text: #5537C2;
    --accent-wash: rgb(150 120 255 / .14); --accent-line: #7E62E0; --accent-solid: #7E62E0;
    --ask: #B45309; --ask-wash: rgb(245 158 11 / .09); --ask-line: rgb(180 83 9 / .6);
    --danger: #B42318; --danger-wash: rgb(180 35 24 / .07);
    --nav-on: #E4DAFF; --nav-on-ink: #5537C2; --nav-on-meta: #5537C2;
    --grid: rgb(10 12 16 / .025);
    --glow: var(--accent-wash);
    --cursor-rgb: 126 98 224; --cursor-a: .22; --cursor-wave-a: .45; --cursor-blend: multiply;
    --shadow-drop: 0 24px 48px -28px rgb(10 12 16 / .25);
    --shadow: 0 0 0 1px var(--line), var(--shadow-drop);
    --shadow-accent: 0 0 0 1px rgb(0 0 0 / .1), 0 8px 24px -10px var(--accent-line);
  }
}
```

## base.css

```css
/* Base element styles and the few global helpers (SPEC-DELTA 5.1 "Base"). Component styles live in CSS Modules. */
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg); -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; color: var(--ink);
  font: 400 var(--fs-body)/var(--lh-body) var(--ff-text);
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  /* transparent between the grid lines: the glow below (z-index -1) sits between html's --bg and this grid */
  background:
    linear-gradient(var(--grid) 1px, transparent 1px) 0 0 / 48px 48px,
    linear-gradient(90deg, var(--grid) 1px, transparent 1px) 0 0 / 48px 48px;
  background-attachment: fixed;
}
/* the soft lilac glow at the top breathes very slowly (DECISIONS 3e); paused while the tab is hidden */
body::before {
  content: ""; position: fixed; inset: -20% -10% auto; height: 70vh; z-index: -1; pointer-events: none;
  background: radial-gradient(closest-side, var(--glow), transparent);
  animation: actum-glow 48s ease-in-out infinite;
}
:root[data-hidden] body::before { animation-play-state: paused; }
button, input, textarea, select { font: inherit; color: inherit; letter-spacing: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; }
a { color: inherit; text-decoration-color: var(--line-2); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
h1, h2, h3, h4, p, ul, ol, dl, dd, figure { margin: 0; }
::placeholder { color: var(--ink-3); opacity: 1; }
::selection { background: var(--accent-wash); }
[hidden] { display: none !important; }

/* the outline follows each control's own radius; plain links get a small one */
:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 2px; animation: actum-focus var(--dur-fast) var(--ease); }
a:focus-visible { border-radius: 4px; }
/* headings that receive focus programmatically (tabIndex=-1) show no ring (DESIGN 9.3) */
:is(h1, h2, h3, [data-focus-target])[tabindex="-1"]:focus { outline: none; }

.meta { font: 400 var(--fs-meta)/var(--lh-meta) var(--ff-meta); color: var(--ink-3); }
.meta b { font-weight: 500; color: var(--ink-2); }
/* meta that is a sentence: same size and colour, letters and punctuation in Fixel (a "." in Num looks detached) */
.meta-prose { font: 400 var(--fs-meta)/var(--lh-meta) var(--ff-text); color: var(--ink-3); }
kbd {
  font: 500 var(--fs-label) var(--ff-meta); padding: 2px 6px; border-radius: var(--r-tag);
  box-shadow: 0 0 0 1px var(--line-2); color: var(--ink-2); white-space: nowrap;
}
/* digits in Martian Mono inside any text run, e.g. a date inside a sentence */
.num { font-family: var(--ff-meta); }

/* visually hidden, still read by screen readers */
.vh { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* skip link: first focusable element of every page; invisible until focused */
.skip {
  position: fixed; left: var(--gutter); top: 12px; z-index: var(--z-toast);
  padding: 10px 14px; border-radius: var(--r-control);
  background: var(--accent); color: var(--accent-ink); font-weight: 600; text-decoration: none;
}
.skip:not(:focus) { width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

@media (pointer: coarse) { button, [role="radio"], .opt, .tab { min-height: 44px; } }
```

## motion.css

```css
/* Motion (SPEC-DELTA 5.4). Every animation's end state is the element's default style,
   so reduced motion shows the final state at once. */
@keyframes actum-mark   { from { background-size: 0 1.5px, 0 100%; } }
@keyframes actum-rise   { from { opacity: 0; transform: translateY(6px); filter: blur(3px); } }
@keyframes actum-pulse  { 0% { box-shadow: 0 0 0 0 var(--accent-line); } 50%, 100% { box-shadow: 0 0 0 5px transparent; } }
@keyframes actum-blink  { 50% { opacity: 0; } }
@keyframes actum-breathe { 50% { opacity: .5; } }
@keyframes actum-fade   { from { opacity: 0; } }
@keyframes actum-lift   { from { opacity: 0; transform: translateY(8px); } }
@keyframes actum-glow   { 50% { transform: translate3d(6%, 4%, 0) scale(1.08); opacity: .75; } }
@keyframes actum-focus  { from { outline-color: transparent; outline-offset: 5px; } }
@keyframes actum-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }

/* Theme reveal (ThemeSwitch): only while html[data-vt="theme"], so other view transitions keep their cross-fade. */
:root[data-vt="theme"]::view-transition-old(root),
:root[data-vt="theme"]::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
:root[data-vt="theme"]::view-transition-new(root) { z-index: 1; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
```

# Приложение Б. Что ещё взять из репозитория

- **Шрифты.**
  - Fixel Display: Medium 500, Bold 700, Black 900.
  - Fixel Text: Regular 400, Medium 500, SemiBold 600.
  - Martian Mono, вариативный 300–500: латиница и кириллица.

  Файлы лежат в `src/app/fonts/`. Копируйте их вместе с `OFL.txt`.
- **Эталонные скриншоты.** Они лежат в `docs/screenshots/`, описание в `docs/screenshots/INDEX.md`. Ширина 1366 и 390 px, обе темы. Сняты 27.10.2026, поэтому более поздних изменений (например, входа по коду из Telegram) на них может не быть. Для `/enter`, гайда и тура, страницы человека и страниц ошибок снимков нет.
- **Поведение на JS, которое переносится из кода:**
  - размещение карточки тура и её стыковка снизу на телефоне: `src/components/onboarding/place.ts`;
  - открытие и закрытие Lightbox (FLIP) и пороги жестов: `src/components/media/Lightbox.tsx`;
  - раскладка меток подсветки без наложений: `src/components/intake/HighlightTextarea.tsx`;
  - перебор цифр номера при появлении: `src/components/intake/AcceptedCard.tsx`;
  - плавная смена ширины кнопки отправки: `src/components/intake/SendBar.tsx`;
  - бегунок вкладок: `src/components/owner/TabIndicator.tsx`;
  - прокрутка строки навигации: `src/components/shell/ScrollRow.tsx`;
  - свет у курсора: `src/components/shell/CursorLight.tsx`.
- **Тексты интерфейса целиком.** В этом файле только примеры. Все тексты лежат в `src/lib/copy/colleague/{uk,ru,en}.ts` и `src/lib/copy/owner/{ru,uk,en}.ts`.
- **PNG-иконки приложения** (180, 192 и 512 px). Они рисуются через `next/og` в `src/app/_brand/home-icon.tsx`. Рецепт есть в разделе «Логотип и иконки», точную геометрию берите из этого файла.

# Приложение В. Что стоит проверить в браузере

Всё выше прочитано из кода. В нескольких местах результат зависит от того, как браузер применит каскад, поэтому там стоит пометка «(не проверено)»:

- точная высота шапки;
- край скелетона при `prefers-reduced-motion`;
- правило `white-space: nowrap` у `.fieldSelect .meta`;
- какой размер шрифта побеждает в поле кода входа;
- спокойное «дыхание» знака логотипа при уменьшенном движении.

При переносе эти места лучше сразу посмотреть глазами.
