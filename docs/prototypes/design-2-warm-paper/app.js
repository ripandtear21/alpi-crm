/* ПРОТОТИП — напрям 2 «Тепла папір». Throwaway: без тестов и обработки ошибок.
   Всё состояние в памяти; адрес страницы отражает экран, состояние, тему, язык и проект. */
'use strict';

const DATA = window.CRM_DATA;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ic = (n, cls = '') => `<i class="ph-light ph-${n}${cls ? ' ' + cls : ''}" aria-hidden="true"></i>`;
const fmt = n => Math.round(n).toLocaleString('uk-UA');
const SYM = { EUR: '€', USD: '$', UAH: '₴' };
const money = (n, cur) => `<span class="num">${fmt(n)}&nbsp;${SYM[cur]}</span>`;
const dm = iso => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) : '';
const clone = o => JSON.parse(JSON.stringify(o));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- Язык: украинский по умолчанию, RU — словарь для интерфейса (данные не переводятся) ---------- */
const RU = {
  'Угоди': 'Сделки', 'Канбан': 'Канбан', 'Список': 'Список', 'Контакти': 'Контакты', 'Організації': 'Организации',
  'Задачі': 'Задачи', 'Звіти': 'Отчёты', 'Налаштування': 'Настройки', 'Меню': 'Меню',
  'Пошук: імʼя, телефон, email, угода': 'Поиск: имя, телефон, email, сделка', 'Сповіщення': 'Уведомления',
  'Тема': 'Тема', 'Проєкт': 'Проект', 'Перемкнути проєкт': 'Переключить проект', 'Позначити все прочитаним': 'Отметить всё прочитанным',
  'Угода': 'Сделка', 'Воронка': 'Воронка', 'Мої': 'Мои', 'Команда': 'Команда', 'Усі': 'Все',
  'Без відповідального': 'Без ответственного', 'Прострочені': 'Просроченные', 'Фільтри': 'Фильтры',
  'угод': 'сделок', 'сум немає': 'сумм нет', 'за НБУ': 'по НБУ', 'Загальна черга': 'Общая очередь',
  'Взяти в роботу': 'Взять в работу', 'немає задач': 'нет задач', 'прострочено': 'просрочено', 'сьогодні': 'сегодня',
  'відкрити списком': 'открыть списком', 'ще': 'ещё', 'Виграна': 'Выиграна', 'Програна': 'Проиграна', 'В архів': 'В архив',
  'Відкрита': 'Открыта', 'Перетягніть сюди': 'Перетащите сюда', 'потрібна причина': 'нужна причина',
  'прибрати з канбану': 'убрать с канбана', 'Немає угод': 'Нет сделок',
  'Суми — окремо за валютами; ≈ — у ₴ за курсом НБУ на 04.11': 'Суммы — отдельно по валютам; ≈ — в ₴ по курсу НБУ на 04.11',
  'Відповідальна': 'Ответственная', 'оплачено': 'оплачено', 'з': 'из', 'створено': 'создана',
  'Відкрити знову': 'Открыть заново', 'Створити допродаж': 'Создать допродажу', 'Повернути з архіву': 'Вернуть из архива',
  'В архіві': 'В архиве', 'Що зробити далі': 'Что сделать дальше', 'Виконано': 'Выполнено', 'Задача': 'Задача',
  'Стрічка': 'Лента', 'Нотатка до угоди…': 'Заметка к сделке…', 'Зберегти нотатку': 'Сохранить заметку',
  'Нотатки': 'Заметки', 'Дзвінки': 'Звонки', 'Платежі': 'Платежи', 'Етапи': 'Этапы', 'Реєстрації': 'Регистрации',
  'Прослухати запис': 'Прослушать запись', 'Етап': 'Этап', 'Контакт': 'Контакт', 'Телефон': 'Телефон', 'Місто': 'Город',
  'Учасники': 'Участники', 'Товари': 'Товары', 'Сума по товарах': 'Сумма по товарам', 'Сума угоди': 'Сумма сделки',
  'Підставити': 'Подставить', 'Відрізняється на': 'Отличается на', 'збігається із сумою угоди': 'совпадает с суммой сделки',
  'Виставити рахунок': 'Выставить счёт', 'успішно': 'успешно', 'очікує оплати': 'ждёт оплаты', 'Поля угоди': 'Поля сделки',
  'Джерело': 'Источник', 'Кампанія': 'Кампания', 'Сторінка': 'Страница', 'Вебінар': 'Вебинар', 'Перегляд': 'Просмотр', 'Мітки': 'Метки',
  'Відкрити': 'Открыть', 'Змінити': 'Изменить', 'Обрано': 'Выбрано', 'Обрати всі': 'Выбрать все', 'за фільтром': 'по фильтру',
  'Архівувати': 'Архивировать', 'Передати': 'Передать', 'Змінити етап': 'Сменить этап', 'Видалити': 'Удалить', 'Зняти вибір': 'Снять выбор',
  'Назва': 'Название', 'Сума': 'Сумма', 'Відповідальний': 'Ответственный', 'Наступна задача': 'Следующая задача', 'Створено': 'Создана',
  'Статус': 'Статус', 'Архів': 'Архив', 'Створено з': 'Создана с', 'по': 'по', 'Скинути': 'Сбросить', 'Показати ще 25': 'Показать ещё 25',
  'Усі відкриті': 'Все открытые', 'Мої угоди': 'Мои сделки', 'Нові ліди старші 30 днів': 'Новые лиды старше 30 дней',
  'Зберегти фільтр': 'Сохранить фильтр', 'Вивантажити CSV': 'Выгрузить CSV', 'усі етапи': 'все этапы', 'усі': 'все',
  'будь-яка': 'любая', 'відкриті': 'открытые', 'без архівних': 'без архивных', 'Колонки': 'Колонки',
  'Ролі та користувачі': 'Роли и пользователи', 'Воронки та етапи': 'Воронки и этапы', 'Поля': 'Поля', 'Команди': 'Команды',
  'Причини програшу': 'Причины проигрыша', 'Типи задач': 'Типы задач', 'Інтеграції': 'Интеграции', 'Кошик': 'Корзина',
  'Нова роль': 'Новая роль', 'Назва ролі': 'Название роли', 'Частина системи': 'Часть системы', 'Перегляд': 'Просмотр',
  'Створення': 'Создание', 'Зміна': 'Изменение', 'Видалення': 'Удаление', 'Охват перегляду': 'Охват просмотра', 'Охват змін': 'Охват изменений',
  'Окремі права': 'Отдельные права', 'Свої': 'Свои', 'Своєї команди': 'Своей команды', 'Усі в проєкті': 'Все в проекте',
  'Зберегти': 'Сохранить', 'Скасувати': 'Отменить', 'Незбережені зміни': 'Несохранённые изменения',
  'Вхід': 'Вход', 'Пароль': 'Пароль', 'Увійти': 'Войти', 'Код підтвердження': 'Код подтверждения', 'Підтвердити': 'Подтвердить',
  'Використати код відновлення': 'Использовать код восстановления', 'Інший обліковий запис': 'Другая учётная запись',
  'Не вдалося завантажити': 'Не удалось загрузить', 'Спробувати знову': 'Попробовать снова', 'Немає доступу': 'Нет доступа',
  'До канбану': 'К канбану', 'Закрити': 'Закрыть', 'Група': 'Группа', 'Причина': 'Причина', 'Коментар': 'Комментарий',
  'необовʼязково': 'необязательно', 'Позначити програною': 'Отметить проигранной', 'Перенести в архів': 'Перенести в архив',
  'Журнал': 'Журнал', 'Задача на завтра': 'Задача на завтра',
};
const t = s => (S.lang === 'ru' && RU[s]) || s;

/* ---------- Состояние ---------- */
const Q = new URLSearchParams(location.search);
const S = {
  screen: Q.get('screen') || 'kanban',
  view: Q.get('state') || 'normal',
  theme: Q.get('theme') || 'light',
  lang: Q.get('lang') || 'uk',
  proj: Q.get('proj') || 'alpi',
  bar: Q.get('bar') !== '0',
  pop: null, navOpen: false, phone: false,
  mStage: { alpi: 3, fr: 3 },
  kf: 'all', scope: 'all',
  q: '',
  deal: { status: 'open', stage: 4, amount: 1290, archived: false, reason: null, notes: [] },
  feedF: 'all',
  savedF: 'old', sel: new Set(['L1', 'L2', 'L4']),
  role: 'Менеджер', dirty: false,
  signStep: 2,
  dialog: null, toasts: [],
};
const BOARD = { alpi: clone(DATA.projects.alpi.stages), fr: clone(DATA.projects.fr.stages) };
const proj = () => DATA.projects[S.proj];
const board = () => BOARD[S.proj];
const me = 'ok';

const SCREENS = [['kanban', 'Канбан угод'], ['deal', 'Картка угоди'], ['list', 'Список угод'], ['roles', 'Налаштування → ролі'], ['signin', 'Вхід з 2FA']];
const VIEWS = [['normal', 'Звичайний'], ['loading', 'Завантаження'], ['empty', 'Порожньо'], ['error', 'Помилка'], ['403', 'Немає доступу (403)'],
  ['validation', 'Помилка введення'], ['toast', 'Сповіщення (toast)'], ['confirm', 'Підтвердження'], ['drag', 'Перетягування']];
const VIEW_OK = { kanban: 'all', deal: ['drag'], list: ['drag'], roles: ['drag'], signin: ['confirm', 'drag'] };
const viewAllowed = (sc, v) => VIEW_OK[sc] === 'all' || !VIEW_OK[sc].includes(v);

function syncURL() {
  const p = new URLSearchParams();
  p.set('screen', S.screen);
  if (S.view !== 'normal') p.set('state', S.view);
  if (S.theme !== 'light') p.set('theme', S.theme);
  if (S.lang !== 'uk') p.set('lang', S.lang);
  if (S.proj !== 'alpi') p.set('proj', S.proj);
  if (!S.bar) p.set('bar', '0');
  history.replaceState(null, '', '?' + p.toString());
}

/* ---------- Мелкие части ---------- */
const initials = n => n.split(' ').map(x => x[0]).slice(0, 2).join('');
const userBy = id => proj().users.find(u => u.id === id);

function taskInd(task) {
  if (!task) return `<div class="task task-n">${ic('minus-circle')}<span>${t('немає задач')}</span></div>`;
  const when = dm(task.date) + (task.time ? ', ' + task.time : '');
  if (task.k === 'o') return `<div class="task task-o">${ic('warning-circle')}<span><b>${t('прострочено')}</b> · ${when} · ${esc(task.type)}</span></div>`;
  if (task.k === 'd') return `<div class="task task-d">${ic('clock')}<span><b>${t('сьогодні')}${task.time ? ', ' + task.time : ''}</b> · ${esc(task.type)}</span></div>`;
  return `<div class="task task-f">${ic('calendar-blank')}<span>${when} · ${esc(task.type)}</span></div>`;
}

function sumsLine(sums) {
  const parts = ['EUR', 'USD', 'UAH'].filter(c => sums[c]).map(c => money(sums[c], c));
  if (!parts.length) return `<div class="col-sums"><span class="none">${t('сум немає')}</span></div>`;
  const total = Object.entries(sums).reduce((a, [c, v]) => a + v * DATA.RATES[c], 0);
  return `<div class="col-sums">${parts.join('<span aria-hidden="true">·</span>')}</div>
    <div class="col-total">≈ <span class="num">${fmt(total)}&nbsp;₴</span> ${t('за НБУ')}</div>`;
}

function stateBlock(kind, title, text, actions = '', metaLine = '') {
  const icons = { error: 'cloud-slash', '403': 'lock-key', empty: 'tray' };
  return `<section class="state-block ${kind === 'error' ? 'err' : ''}" role="${kind === 'error' ? 'alert' : 'status'}">
    ${ic(icons[kind] || 'tray', 'big-ic')}
    <h2 class="sec-title">${title}</h2><p>${text}</p>${actions}
    ${metaLine ? `<div class="meta">${metaLine}</div>` : ''}</section>`;
}
const errBlock = what => stateBlock('error', `${t('Не вдалося завантажити')} ${what}`,
  'Сервер не відповів за 10 секунд. Дані на екрані не змінені.',
  `<button class="btn btn-secondary" data-act="retry">${ic('arrow-clockwise')}${t('Спробувати знову')}</button>`,
  'Код запиту 7f3a-21c9 — передайте його адміністратору, якщо помилка повториться.');

/* ---------- Оболочка ---------- */
function shell() {
  const pr = proj();
  const sc = S.screen;
  const navA = (key, label, icon, opt = {}) => {
    const cur = opt.cur ?? sc === key;
    const curAttr = cur ? (opt.parent ? 'class-on' : 'aria-current="page"') : '';
    return `<a class="nav-item ${opt.sub ? 'nav-sub' : ''} ${curAttr === 'class-on' ? 'on-parent' : ''}" href="#" data-act="${opt.stub ? 'stub' : 'go'}" data-screen="${key}" ${curAttr === 'class-on' ? '' : curAttr}>
      ${opt.sub ? '' : ic(icon)}<span>${t(label)}</span>${opt.cnt ? `<span class="cnt">${opt.cnt}</span>` : ''}</a>`;
  };
  const unread = DATA.notifications.filter(n => n.unread).length;
  return `<div class="app ${S.navOpen ? 'nav-open' : ''} ${S.msearch ? 'search-open' : ''}">
  <header class="topbar">
    <button class="btn btn-icon nav-toggle" data-act="nav" aria-label="${t('Меню')}" aria-expanded="${S.navOpen}">${ic(S.navOpen ? 'x' : 'list')}</button>
    <a class="brand" href="#" data-act="go" data-screen="kanban" aria-label="Alpi CRM"><b>Alpi</b><span>CRM</span></a>
    <button class="proj-btn" data-act="pop" data-pop="proj" aria-haspopup="menu" aria-expanded="${S.pop === 'proj'}" title="${t('Перемкнути проєкт')}">
      <span class="proj-mark" aria-hidden="true"></span>${esc(pr.name)}${ic('caret-down')}</button>
    <div class="search" role="search">
      ${ic('magnifying-glass')}
      <label class="sr" for="q">${t('Пошук: імʼя, телефон, email, угода')}</label>
      <input class="input" id="q" type="search" placeholder="${t('Пошук: імʼя, телефон, email, угода')}" value="${esc(S.q)}" autocomplete="off">
      <kbd aria-hidden="true">/</kbd>
      <div id="sres"></div>
    </div>
    <div class="top-right">
      <button class="btn btn-icon m-only" data-act="msearch" aria-label="Пошук" aria-expanded="${!!S.msearch}">${ic(S.msearch ? 'x' : 'magnifying-glass')}</button>
      <div class="seg lang" role="group" aria-label="Мова">
        <button data-act="lang" data-lang="uk" aria-pressed="${S.lang === 'uk'}">UK</button>
        <button data-act="lang" data-lang="ru" aria-pressed="${S.lang === 'ru'}">RU</button>
      </div>
      <button class="btn btn-icon theme-btn" data-act="theme" aria-label="${t('Тема')}">${ic(S.theme === 'dark' ? 'sun' : 'moon')}</button>
      <button class="btn btn-icon bell" data-act="pop" data-pop="notif" aria-label="${t('Сповіщення')}: ${unread}" aria-expanded="${S.pop === 'notif'}">${ic('bell-simple')}${unread ? `<span class="dot">${unread}</span>` : ''}</button>
      <button class="me-btn" aria-label="Олена Коваль"><span class="avatar avatar-lg">ОК</span></button>
    </div>
    ${S.pop === 'proj' ? projPop() : ''}${S.pop === 'notif' ? notifPop() : ''}
  </header>
  <nav class="sidenav" aria-label="Розділи">
    ${navA('kanban', 'Угоди', 'kanban', { cur: ['kanban', 'deal', 'list'].includes(sc), parent: true })}
    ${navA('kanban', 'Канбан', '', { sub: true, cur: sc === 'kanban' || sc === 'deal' })}
    ${navA('list', 'Список', '', { sub: true })}
    ${navA('contacts', 'Контакти', 'address-book', { stub: true })}
    ${navA('orgs', 'Організації', 'buildings', { stub: true })}
    ${navA('tasks', 'Задачі', 'check-square-offset', { stub: true, cnt: 7 })}
    ${navA('reports', 'Звіти', 'chart-line', { stub: true })}
    <div class="nav-sep"></div>
    ${navA('roles', 'Налаштування', 'gear-six')}
    <div class="nav-prefs">
      <div class="seg" role="group" aria-label="Мова"><button data-act="lang" data-lang="uk" aria-pressed="${S.lang === 'uk'}">UK</button><button data-act="lang" data-lang="ru" aria-pressed="${S.lang === 'ru'}">RU</button></div>
      <button class="btn btn-secondary" data-act="theme">${ic(S.theme === 'dark' ? 'sun' : 'moon')}${S.theme === 'dark' ? 'Світла тема' : 'Темна тема'}</button>
    </div>
    <div class="nav-foot"><span class="avatar avatar-lg">ОК</span>
      <div><div style="font-size:var(--fs-table);font-weight:600">Олена Коваль</div><span class="meta">${esc(pr.role)} · ${esc(pr.name)}</span></div></div>
  </nav>
  <main class="main" id="main">${screenHTML()}</main>
</div>`;
}

function projPop() {
  return `<div class="pop projmenu" role="menu" aria-label="${t('Проєкт')}">
    <div class="pop-head">${t('Проєкт')}</div>
    ${Object.values(DATA.projects).map(p => `<button class="pop-item" role="menuitemradio" aria-checked="${p.key === S.proj}" data-act="proj" data-proj="${p.key}">
      <span style="flex:1"><span style="display:block">${esc(p.name)}</span><span class="meta">${esc(p.long)} · ${esc(p.role)}</span></span>
      ${p.key === S.proj ? ic('check') : ''}</button>`).join('')}
    <div class="meta" style="padding:8px 12px 4px">Дані проєктів не перетинаються: інший проєкт — інші угоди, контакти й ролі.</div>
  </div>`;
}
function notifPop() {
  return `<div class="pop notif" role="dialog" aria-label="${t('Сповіщення')}">
    <div class="pop-head" style="display:flex;justify-content:space-between"><span>${t('Сповіщення')}</span><button class="link-btn" style="font-size:12px">${t('Позначити все прочитаним')}</button></div>
    ${DATA.notifications.map(n => `<div class="notif-item ${n.unread ? 'unread' : ''}">${ic(n.ic)}<span>${esc(n.text)}</span><span class="meta">${n.at}</span></div>`).join('')}
  </div>`;
}

function searchResults() {
  const q = S.q.trim().toLowerCase();
  if (q.length < 2) return '';
  const dig = q.replace(/\D/g, '');
  const all = board().flatMap((s, i) => s.cards.map(c => ({ c, stage: s.name })));
  const hit = all.filter(({ c }) => c.title.toLowerCase().includes(q) || c.contact.toLowerCase().includes(q) || String(c.num) === q.replace('#', '') || (dig.length >= 3 && c.contact.replace(/\D/g, '').includes(dig)));
  if (!hit.length) return `<div class="pop searchres"><div class="meta" style="padding:12px">Нічого не знайдено в проєкті ${esc(proj().name)}. Пошук не виходить за межі проєкту.</div></div>`;
  const deals = hit.slice(0, 5).map(({ c, stage }) => `<a class="res-item" href="#" data-act="open-deal"><span>${esc(c.title)}</span><span class="meta">${esc(stage)} · #${c.num}</span></a>`).join('');
  const contacts = hit.slice(0, 3).map(({ c }) => `<a class="res-item" href="#" data-act="stub"><span>${esc(c.contact.split(' · ')[0])}</span><span class="meta">контакт</span></a>`).join('');
  return `<div class="pop searchres" role="listbox">
    <div class="res-group"><div class="pop-head">${t('Угоди')}</div>${deals}</div>
    <div class="res-group"><div class="pop-head">${t('Контакти')}</div>${contacts}</div></div>`;
}

function screenHTML() {
  if (S.screen === 'deal') return dealScreen();
  if (S.screen === 'list') return listScreen();
  if (S.screen === 'roles') return rolesScreen();
  return kanbanScreen();
}

/* ---------- Канбан ---------- */
function contactLine(c) {
  if (c.contact.startsWith(c.title + ' · ')) return c.contact.slice(c.title.length + 3);
  return c.contact;
}
function cardHTML(c) {
  const owner = c.owner ? userBy(c.owner) : null;
  const amt = c.amount ? money(c.amount, c.cur) : `<span class="zero">—</span>`;
  if (c.queue) {
    return `<article class="card is-queue" draggable="true" tabindex="0" data-id="${c.id}" data-act="open-deal" aria-label="${esc(c.title)}, ${t('Загальна черга')}">
      <div class="card-title">${esc(c.title)}</div>
      <div class="card-contact">${esc(contactLine(c))}</div>
      <div class="queue-line"><span class="meta">${ic('tray')}${t('Загальна черга')}</span>
        <button class="btn btn-secondary btn-sm" data-act="take" data-id="${c.id}">${t('Взяти в роботу')}</button></div>
      ${taskInd(c.task)}
    </article>`;
  }
  return `<article class="card" draggable="true" tabindex="0" data-id="${c.id}" data-act="open-deal" aria-label="${esc(c.title)}">
    <div class="card-title">${esc(c.title)}</div>
    <div class="card-contact">${esc(contactLine(c))}</div>
    <div class="card-row"><span class="amt ${c.amount ? '' : 'zero'}">${amt}</span>${owner ? `<span class="avatar" title="${esc(owner.n)}">${initials(owner.n)}</span>` : ''}</div>
    ${taskInd(c.task)}
  </article>`;
}

function kanbanScreen() {
  const pr = proj(), v = S.view, st = board();
  const mI = Math.min(S.mStage[S.proj], st.length - 1);
  const head = `<div class="kanban-head">
    <div class="page-head" style="margin-bottom:var(--s4)">
      <h1 class="page-title">${t('Угоди')}</h1>
      <div class="seg" role="group" aria-label="Вигляд"><button aria-pressed="true">${t('Канбан')}</button><button data-act="go" data-screen="list" aria-pressed="false">${t('Список')}</button></div>
      <label class="sr" for="pl">${t('Воронка')}</label>
      <select class="select hide-m" id="pl" style="min-width:200px">${pr.pipelines.map(p => `<option>${t('Воронка')} ${esc(p)}</option>`).join('')}</select>
      <span class="spacer"></span>
      <button class="btn btn-primary" data-act="stub">${ic('plus')}${t('Угода')}</button>
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Охват">
        ${[['mine', 'Мої'], ['team', 'Команда'], ['all', 'Усі']].map(([k, l]) => `<button data-act="scope" data-k="${k}" aria-pressed="${S.scope === k}">${t(l)}</button>`).join('')}
      </div>
      <button class="chip" data-act="kf" data-k="queue" aria-pressed="${S.kf === 'queue'}">${ic('tray')}${t('Без відповідального')}</button>
      <button class="chip" data-act="kf" data-k="o" aria-pressed="${S.kf === 'o'}">${ic('warning-circle')}${t('Прострочені')}</button>
      <button class="chip hide-m" data-act="stub">${ic('funnel-simple')}${t('Фільтри')}</button>
      <span class="spacer" style="flex:1"></span>
      <span class="meta legend">${t('Суми — окремо за валютами; ≈ — у ₴ за курсом НБУ на 04.11')}: 1&nbsp;€ = 48,12&nbsp;₴, 1&nbsp;$ = 41,63&nbsp;₴</span>
    </div>
  </div>`;

  if (v === 'error') return `<div class="kanban-wrap">${head}${errBlock('дошку')}</div>`;
  if (v === '403') return `<div class="kanban-wrap">${head}${stateBlock('403', t('Немає доступу'),
    `Ваша роль у проєкті ${esc(pr.name)} не дає права переглядати воронку «${esc(pr.pipelines[pr.pipelines.length - 1])}». Право видає адміністратор проєкту.`,
    `<button class="btn btn-secondary" data-act="go" data-screen="kanban">${t('До канбану')} ${esc(pr.pipelines[0])}</button>`)}</div>`;

  const tabs = `<div class="stage-tabs" role="tablist" aria-label="Етапи">${st.map((s, i) => `<button role="tab" aria-selected="${i === mI}" data-act="mstage" data-i="${i}">${esc(s.name)}<span class="c">${v === 'empty' ? 0 : fmt(s.count)}</span></button>`).join('')}</div>`;

  const cols = st.map((s, i) => {
    let body;
    if (v === 'loading') {
      body = [0, 1, 2].map(() => `<div class="card" style="cursor:default" aria-hidden="true">
        <div class="sk" style="height:14px;width:70%"></div><div class="sk" style="height:12px;width:50%;margin-top:8px"></div>
        <div class="sk" style="height:12px;width:30%;margin-top:14px"></div><div class="sk" style="height:12px;width:60%;margin-top:8px"></div></div>`).join('');
      return `<section class="col ${i === mI ? 'm-active' : ''}" aria-busy="true"><header class="col-head">
        <div class="sk" style="height:14px;width:60%"></div><div class="sk" style="height:12px;width:80%;margin-top:8px"></div></header>
        <div class="cards">${body}</div></section>`;
    }
    const cards = v === 'empty' ? [] : s.cards.filter(c => S.kf === 'all' || (S.kf === 'queue' ? c.queue : c.task && c.task.k === S.kf));
    body = cards.length ? cards.map(cardHTML).join('') : `<div class="col-empty">${t('Немає угод')}</div>`;
    if (v === 'empty' && i === 0) body = `<div class="col-empty" style="font-style:normal">Угоди зʼявляться тут після першої реєстрації з сайту чи вебінару.<br><br><button class="btn btn-secondary btn-sm" data-act="stub">${ic('plus')}${t('Угода')}</button></div>`;
    if (v === 'drag' && i === 2) body = `<div class="insert-line" aria-hidden="true"></div>` + body;
    const hidden = s.count - s.cards.length;
    const more = s.more && v !== 'empty' && S.kf === 'all' ? `<a class="col-more" href="#" data-act="go" data-screen="list">${t('ще')} <span class="num">${fmt(hidden)}</span> — ${t('відкрити списком')}</a>` : '';
    return `<section class="col ${i === mI ? 'm-active' : ''}" data-i="${i}" aria-label="${esc(s.name)}">
      <header class="col-head">
        <div class="col-name"><span>${esc(s.name)}</span><span class="count num">${v === 'empty' ? 0 : fmt(s.count)} ${t('угод')}</span></div>
        ${v === 'empty' ? `<div class="col-sums"><span class="none">${t('сум немає')}</span></div>` : sumsLine(s.sums)}
      </header>
      <div class="cards">${body}</div>${more}
    </section>`;
  }).join('');

  const zones = v === 'drag' ? zonesHTML() : '';
  return `<div class="kanban-wrap" style="position:relative">${head}${tabs}<div class="board" id="board">${cols}</div>${zones}</div>`;
}

function zonesHTML() {
  return `<div class="dropzones" id="zones" aria-label="Закрити угоду">
    <div class="zone zone-won" data-zone="won">${ic('check-circle')} ${t('Виграна')}<span class="meta">${t('Перетягніть сюди')}</span></div>
    <div class="zone zone-lost" data-zone="lost">${ic('x-circle')} ${t('Програна')}<span class="meta">${t('потрібна причина')}</span></div>
    <div class="zone zone-arch" data-zone="arch">${ic('archive')} ${t('В архів')}<span class="meta">${t('прибрати з канбану')}</span></div>
  </div>`;
}

function placeGhost() {
  const wrap = $('.kanban-wrap'); if (!wrap) return;
  const mobile = innerWidth <= 760;
  const src = mobile ? $('.col.m-active .card') : $('.card[data-id="d51718"]'); if (!src) return;
  src.classList.add('dragging-src');
  const tgt = mobile ? null : $('.col[data-i="2"]');
  if (tgt) tgt.classList.add('drop-target');
  const ghost = src.cloneNode(true);
  ghost.classList.remove('dragging-src'); ghost.classList.add('ghost'); ghost.removeAttribute('tabindex'); ghost.setAttribute('aria-hidden', 'true');
  const wr = wrap.getBoundingClientRect();
  const anchor = (tgt ? $('.cards', tgt) : src).getBoundingClientRect();
  ghost.style.left = (anchor.left - wr.left + (tgt ? 14 : 18)) + 'px';
  ghost.style.top = (anchor.top - wr.top + (tgt ? 10 : 84)) + 'px';
  wrap.appendChild(ghost);
  if (mobile) { const z = $('.zone-won'); if (z) z.classList.add('over'); }
}

/* Перетаскивание (HTML5 drag and drop). Во время перетаскивания DOM не перерисовывается. */
let dragId = null;
function findCard(id) {
  for (const [i, s] of board().entries()) { const j = s.cards.findIndex(c => c.id === id); if (j >= 0) return { i, j, c: s.cards[j] }; }
  return null;
}
function takeOut(id) {
  const f = findCard(id); if (!f) return null;
  const s = board()[f.i]; s.cards.splice(f.j, 1); s.count -= 1; if (f.c.amount) s.sums[f.c.cur] -= f.c.amount;
  return f;
}
function putIn(c, i, j = 0) {
  const s = board()[i]; s.cards.splice(j, 0, c); s.count += 1; if (c.amount) s.sums[c.cur] += c.amount;
}
function moveCard(id, to) {
  const f = takeOut(id); if (!f) return;
  putIn(f.c, to);
  const toName = board()[to].name;
  toast(`Угоду «${f.c.title}» переміщено на етап «${toName}»`, 'arrows-left-right', { label: t('Скасувати'), fn: () => { takeOut(id); putIn(f.c, f.i, f.j); render(); } });
  render();
}
function closeCard(id, how, reason) {
  const f = takeOut(id); if (!f) return;
  const msg = how === 'won' ? `Угоду «${f.c.title}» позначено виграною` : how === 'lost' ? `Угоду «${f.c.title}» позначено програною: ${reason}` : `Угоду «${f.c.title}» перенесено в архів`;
  toast(msg, how === 'won' ? 'check-circle' : how === 'lost' ? 'x-circle' : 'archive', { label: t('Скасувати'), fn: () => { putIn(f.c, f.i, f.j); render(); } });
  render();
}
function bindDrag() {
  const wrap = $('.kanban-wrap'); if (!wrap || S.view !== 'normal') return;
  wrap.addEventListener('dragstart', e => {
    const card = e.target.closest('.card'); if (!card) return;
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    requestAnimationFrame(() => { card.classList.add('dragging-src'); if (!$('#zones')) wrap.insertAdjacentHTML('beforeend', zonesHTML()); });
  });
  wrap.addEventListener('dragover', e => {
    if (!dragId) return;
    const col = e.target.closest('.col'), zone = e.target.closest('.zone');
    if (!col && !zone) return;
    e.preventDefault();
    $$('.col.drop-target, .zone.over').forEach(x => x.classList.remove('drop-target', 'over'));
    if (zone) zone.classList.add('over'); else col.classList.add('drop-target');
  });
  wrap.addEventListener('drop', e => {
    if (!dragId) return;
    e.preventDefault();
    const col = e.target.closest('.col'), zone = e.target.closest('.zone');
    const id = dragId; dragId = null;
    if (zone) {
      const z = zone.dataset.zone;
      if (z === 'lost') { cleanupDrag(); openDialog({ kind: 'lost', id }); return; }
      closeCard(id, z); return;
    }
    if (col) {
      const to = +col.dataset.i, f = findCard(id);
      if (f && f.i !== to) {
        if (S.proj === 'alpi' && to === 5) { cleanupDrag(); openDialog({ kind: 'required', id, to }); return; }
        moveCard(id, to); return;
      }
    }
    cleanupDrag();
  });
  wrap.addEventListener('dragend', () => { dragId = null; cleanupDrag(); });
}
function cleanupDrag() {
  $$('.dragging-src').forEach(x => x.classList.remove('dragging-src'));
  $$('.col.drop-target, .zone.over').forEach(x => x.classList.remove('drop-target', 'over'));
  const z = $('#zones'); if (z && S.view !== 'drag') z.remove();
}

/* ---------- Карточка сделки ---------- */
const FEED_T = [['all', 'Усі'], ['note', 'Нотатки'], ['call', 'Дзвінки'], ['pay', 'Платежі'], ['stage', 'Етапи'], ['reg', 'Реєстрації']];
const FEED_IC = { note: 'note-pencil', pay: 'credit-card', stage: 'arrows-left-right', reg: 'globe-simple' };

function feedItem(e) {
  const icon = e.t === 'call' ? (e.dir === 'missed' ? 'phone-x' : e.dir === 'in' ? 'phone-incoming' : 'phone-outgoing') : FEED_IC[e.t];
  let body = esc(e.text);
  if (e.t === 'stage') body = `<span class="stage-chg">${t('Етап')}: ${esc(e.from)} → <b>${esc(e.to)}</b></span>`;
  if (e.t === 'pay') body = `${esc(e.text.split(' · ')[0])} · ${e.st === 'ok' ? `<span class="status pay-ok">${ic('check-circle')}${t('успішно')}</span>` : `<span class="status pay-wait">${ic('hourglass-medium')}${t('очікує оплати')}</span>`}${e.text.split(' · ')[2] ? ' · <span class="meta">' + esc(e.text.split(' · ')[2]) + '</span>' : ''}`;
  const rec = e.t === 'call' && e.dur ? `<div class="rec"><button class="link-btn" data-act="stub">${ic('play')} ${t('Прослухати запис')}</button><span class="meta">${e.dur}</span></div>` : '';
  return `<li class="${e.dir === 'missed' ? 'is-missed' : ''}"><span class="ic">${ic(icon)}</span>
    <div><div class="who"><b>${esc(e.who)}</b> · ${esc(e.at)}</div><div class="body">${body}</div>${rec}</div></li>`;
}

function dealScreen() {
  const v = S.view, d = DATA.demo, ds = S.deal, pr = DATA.projects.alpi;
  const crumbs = `<nav class="crumbs" aria-label="Шлях"><a href="#" data-act="go" data-screen="kanban">${t('Угоди')}</a>${ic('caret-right')}<span>${t('Воронка')} ALPI</span>${ic('caret-right')}<span>#${d.num}</span></nav>`;
  if (v === 'loading') return `<div class="page" aria-busy="true">${crumbs}
    <div class="sk" style="height:26px;width:46%;margin-bottom:12px"></div><div class="sk" style="height:14px;width:32%;margin-bottom:24px"></div>
    <div class="sk" style="height:14px;width:70%;margin-bottom:40px"></div>
    <div class="deal-grid"><div>${[90, 60, 75, 50].map(w => `<div class="sk" style="height:14px;width:${w}%;margin:0 0 14px"></div><div class="sk" style="height:12px;width:${w - 20}%;margin:0 0 28px"></div>`).join('')}</div>
    <div>${[80, 55, 70].map(w => `<div class="sk" style="height:16px;width:40%;margin:0 0 12px"></div><div class="sk" style="height:12px;width:${w}%;margin:0 0 32px"></div>`).join('')}</div></div></div>`;
  if (v === 'error') return `<div class="page">${crumbs}${errBlock('угоду')}</div>`;
  if (v === '403') return `<div class="page">${crumbs}${stateBlock('403', 'Клієнт уже в роботі',
    'Угода #51433 поза вашим охватом: клієнта веде <b>Дмитро Савчук</b>. Зміст угоди приховано. Щоб передати угоду вам, зверніться до керівника.',
    `<button class="btn btn-secondary" data-act="go" data-screen="kanban">${t('До канбану')}</button>`)}</div>`;

  const fresh = v === 'empty';
  const stages = pr.stages.map(s => s.name);
  const stIdx = fresh ? 0 : ds.stage;
  const amount = fresh ? 0 : ds.amount;
  const status = fresh ? 'open' : ds.status;
  const statusHTML = status === 'won' ? `<span class="status status-won">${ic('check-circle')}${t('Виграна')}</span>`
    : status === 'lost' ? `<span class="status status-lost">${ic('x-circle')}${t('Програна')}</span>`
    : `<span class="status status-open">${ic('circle')}${t('Відкрита')}</span>`;
  const actions = status === 'open'
    ? `<button class="btn btn-primary" data-act="deal-won">${ic('check')}${t('Виграна')}</button>
       <button class="btn btn-secondary" data-act="deal-lost">${ic('x')}${t('Програна')}</button>
       <button class="btn btn-ghost" data-act="deal-arch">${ic('archive')}${ds.archived ? t('Повернути з архіву') : t('В архів')}</button>`
    : `${status === 'won' ? `<button class="btn btn-secondary" data-act="stub">${ic('plus')}${t('Створити допродаж')}</button>` : ''}
       <button class="btn btn-secondary" data-act="deal-reopen">${ic('arrow-counter-clockwise')}${t('Відкрити знову')}</button>
       <button class="btn btn-ghost" data-act="deal-arch">${ic('archive')}${ds.archived ? t('Повернути з архіву') : t('В архів')}</button>`;

  const header = `<div class="deal-head">
    <div>
      <h1 class="deal-title">${fresh ? 'Роман Петренко' : esc(d.title)}</h1>
      <div class="deal-facts">
        ${statusHTML}
        <span class="big">${amount ? money(amount, 'EUR') : '<span class="muted">сума не вказана</span>'}</span>
        ${fresh ? '' : `<span>${t('оплачено')} ${money(d.paid, 'EUR')} ${t('з')} ${money(amount, 'EUR')}</span>`}
        <span>${t('Відповідальна')}: <a href="#" data-act="stub">${esc(d.owner)}</a></span>
        <span class="meta">#${fresh ? 51899 : d.num} · ${t('створено')} ${fresh ? '04.11.2026' : d.created}</span>
        ${ds.archived && !fresh ? `<span class="meta">${ic('archive')} ${t('В архіві')}</span>` : ''}
      </div>
      ${status === 'lost' && ds.reason ? `<div class="lost-reason" style="margin-top:4px">${esc(ds.reason)}</div>` : ''}
    </div>
    <div class="deal-actions">${actions}</div>
    <nav class="stagepath" aria-label="${t('Етап')}">${stages.map((s, i) => `${i ? '<span class="sep" aria-hidden="true">—</span>' : ''}<button data-act="deal-stage" data-i="${i}" ${i === stIdx ? 'aria-current="step"' : ''} ${status !== 'open' ? 'disabled' : ''}>${esc(s)}</button>`).join('')}</nav>
  </div>`;

  // Что сделать дальше
  const next = fresh
    ? `<div class="next-task"><div class="grow">${taskInd(null)}<div class="meta" style="margin-top:4px">Угода нікуди не рухається, доки немає наступного кроку.</div></div>
       <button class="btn btn-secondary btn-sm" data-act="stub">${ic('plus')}${t('Задача')}</button></div>`
    : `<div class="next-task"><div class="grow">${taskInd({ k: 'd', time: '14:00', type: d.next.type })}<div style="margin-top:4px">${esc(d.next.text)}</div></div>
       <button class="btn btn-secondary btn-sm" data-act="task-done">${ic('check')}${t('Виконано')}</button>
       <button class="btn btn-ghost btn-sm" data-act="stub">${ic('plus')}${t('Задача')}</button></div>`;

  // Лента
  const feedAll = fresh ? [] : [...ds.notes, ...d.feed];
  const cnt = k => k === 'all' ? feedAll.length : feedAll.filter(e => e.t === k).length;
  const items = feedAll.filter(e => S.feedF === 'all' || e.t === S.feedF);
  const feed = `<section class="deal-sec" aria-labelledby="h-feed">
    <header><h2 class="sec-title" id="h-feed">${t('Стрічка')}</h2></header>
    <form class="composer" data-form="note">
      <label class="sr" for="note">${t('Нотатка до угоди…')}</label>
      <textarea class="input" id="note" placeholder="${t('Нотатка до угоди…')}"></textarea>
      <div class="row"><span class="meta">Нотатку бачать усі, хто має доступ до угоди.</span><button class="btn btn-primary btn-sm" type="submit">${t('Зберегти нотатку')}</button></div>
    </form>
    <div class="tabs" role="tablist">${FEED_T.map(([k, l]) => `<button role="tab" aria-selected="${S.feedF === k}" data-act="feedf" data-k="${k}">${t(l)}<span class="c">${cnt(k)}</span></button>`).join('')}</div>
    ${items.length ? `<ul class="feed" id="feed">${items.map(feedItem).join('')}</ul>` : `<p class="meta" style="font-style:italic">Подій ще немає. Тут зʼявляться дзвінки, нотатки, платежі й зміни етапу.</p>`}
  </section>`;

  // Правая колонка
  const psum = d.products.reduce((a, p) => a + p.q * p.p, 0);
  const products = fresh ? `<p class="meta" style="font-style:italic;margin:0">Товарів ще немає. <button class="link-btn" data-act="stub">Додати товар</button></p>` : `
    <table class="lines"><tbody>${d.products.map(p => `<tr><td>${esc(p.n)}<div class="meta">${p.q} × ${money(p.p, 'EUR')}</div></td><td class="r">${money(p.q * p.p, 'EUR')}</td></tr>`).join('')}</tbody></table>
    <div class="sum-box">
      <div class="row"><span>${t('Сума по товарах')}</span><b>${money(psum, 'EUR')}</b></div>
      <div class="row muted"><span>${t('Сума угоди')}</span><span>${money(amount, 'EUR')}</span></div>
      ${psum !== amount
        ? `<div class="diff"><span>${ic('warning-circle')} ${t('Відрізняється на')} ${money(Math.abs(psum - amount), 'EUR')}</span><button class="link-btn" data-act="apply-sum" data-v="${psum}">${t('Підставити')} ${money(psum, 'EUR')}</button></div>`
        : `<div class="meta">${ic('check')} ${t('збігається із сумою угоди')}</div>`}
    </div>`;
  const payments = fresh ? `<p class="meta" style="font-style:italic;margin:0">Платежів немає.</p>` : `
    <table class="lines"><tbody>${d.payments.map(p => `<tr><td>${esc(p.k)}<div class="meta">${p.d}${p.uah !== '—' ? ' · ' + p.uah : ''}</div></td>
      <td class="r">${money(p.a, 'EUR')}<div>${p.st === 'ok' ? `<span class="status pay-ok" style="font-size:13px">${ic('check-circle')}${t('успішно')}</span>` : `<span class="status pay-wait" style="font-size:13px">${ic('hourglass-medium')}${t('очікує оплати')}</span>`}</div></td></tr>`).join('')}</tbody></table>
    <div class="sum-box"><div class="row"><span>${t('оплачено')}</span><b>${money(d.paid, 'EUR')} ${t('з')} ${money(amount, 'EUR')}</b></div></div>`;
  const regs = fresh ? [] : d.regs;

  const aside = `<aside>
    <section class="deal-sec" aria-labelledby="h-contact">
      <header><h2 class="sec-title" id="h-contact">${t('Контакт')}</h2><button class="link-btn" data-act="stub">${t('Відкрити')}</button></header>
      <div class="contact-name">${fresh ? 'Роман Петренко' : esc(d.contact.name)}</div>
      <dl class="kv" style="margin-top:8px">
        <dt>${t('Телефон')}</dt><dd><a href="#" data-act="stub">${fresh ? '+380 00 902 18 44' : esc(d.contact.phone)}</a></dd>
        <dt>Email</dt><dd><a href="#" data-act="stub">${fresh ? 'roman.petrenko@example.com' : esc(d.contact.email)}</a></dd>
        ${fresh ? '' : `<dt>${t('Місто')}</dt><dd>${esc(d.contact.city)}</dd><dt>${t('Учасники')}</dt><dd>${d.participants.map(p => `${esc(p.n)} <span class="meta">— ${esc(p.role)}</span>`).join('')}</dd>`}
      </dl>
      ${fresh ? `<div class="flag">${ic('warning')}Можливий дубль: email збігається з контактом «Роман Петренко-Гай»</div>` : ''}
    </section>
    <section class="deal-sec" aria-labelledby="h-prod"><header><h2 class="sec-title" id="h-prod">${t('Товари')}</h2><button class="link-btn" data-act="stub">${ic('plus')} товар</button></header>${products}</section>
    <section class="deal-sec" aria-labelledby="h-pay"><header><h2 class="sec-title" id="h-pay">${t('Платежі')}</h2><button class="link-btn" data-act="stub">${t('Виставити рахунок')}</button></header>${payments}</section>
    <section class="deal-sec" aria-labelledby="h-reg"><header><h2 class="sec-title" id="h-reg">${t('Реєстрації')}</h2><span class="meta">${regs.length ? `${regs.length} · перша 26.10, остання 31.10` : ''}</span></header>
      ${regs.length ? regs.map(r => `<div class="reg"><div class="reg-head"><span>${esc(r.at)}</span><span class="meta" style="font-weight:400">${esc(r.src)}</span></div>
        <dl class="kv"><dt>${t('Кампанія')}</dt><dd>${esc(r.camp)}</dd><dt>${t('Вебінар')}</dt><dd>${esc(r.webinar)}</dd>
        <dt>${t('Перегляд')}</dt><dd>${esc(r.watch)}</dd><dt>${t('Сторінка')}</dt><dd>${esc(r.page)}</dd><dt>${t('Мітки')}</dt><dd class="muted">${esc(r.utm)}</dd></dl></div>`).join('')
        : `<p class="meta" style="font-style:italic;margin:0">Угоду створено вручну, реєстрацій немає.</p>`}
    </section>
    ${fresh ? '' : `<section class="deal-sec" aria-labelledby="h-f"><header><h2 class="sec-title" id="h-f">${t('Поля угоди')}</h2><button class="link-btn" data-act="stub">${t('Змінити')}</button></header>
      <dl class="kv">${d.fields.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl></section>`}
  </aside>`;

  return `<div class="page">${crumbs}${header}
    <div class="deal-grid"><div><section class="deal-sec" aria-labelledby="h-next"><header><h2 class="sec-title" id="h-next">${t('Що зробити далі')}</h2></header>${next}</section>${feed}</div>${aside}</div></div>`;
}

/* ---------- Список ---------- */
const OLD = [
  ['L1', 47012, 'Ірина Бондар', '+380 00 611 20 14', 'mh', '2026-09-12'], ['L2', 46980, 'Олександр Ткачук', '+380 00 372 90 55', null, '2026-09-11'],
  ['L3', 46931, 'Яна Коваленко', 'yana.kovalenko@example.com', 'al', '2026-09-10'], ['L4', 46877, 'Микола Дорошенко', '+380 00 845 11 30', null, '2026-09-08'],
  ['L5', 46802, 'Христина Левченко', '+380 00 290 47 81', 'ok', '2026-09-07'], ['L6', 46765, 'Василь Ярошенко', 'vasyl.yaroshenko@example.com', 'ds', '2026-09-05'],
  ['L7', 46711, 'Оксана Демченко', '+380 00 538 62 09', null, '2026-09-04'], ['L8', 46690, 'Тарас Зінченко', '+380 00 107 33 48', 'mh', '2026-09-02'],
  ['L9', 46654, 'Лариса Федоренко', '+380 00 764 25 17', 'tr', '2026-08-30'], ['L10', 46602, 'Євген Прокопенко', '+380 00 481 90 63', null, '2026-08-29'],
  ['L11', 46588, 'Діана Остапчук', 'diana.ostapchuk@example.com', 'ok', '2026-08-27'], ['L12', 46541, 'Борис Кравець', '+380 00 926 14 72', 'al', '2026-08-26'],
];
function listRows() {
  const st = board();
  if (S.savedF === 'old' && S.proj === 'alpi') return OLD.map(([id, num, n, c, owner, created]) => ({ id, num, title: n, contact: c, stage: st[0].name, amount: 0, cur: 'EUR', owner, task: null, created }));
  const all = st.flatMap(s => s.cards.map(c => ({ ...c, stage: s.name, created: '2026-10-' + String(10 + (c.num % 20)).padStart(2, '0') })));
  if (S.savedF === 'mine') return all.filter(c => c.owner === me);
  if (S.savedF === 'queue') return all.filter(c => c.queue);
  return all;
}
function listScreen() {
  const v = S.view, pr = proj(), st = board();
  const isOld = S.savedF === 'old' && S.proj === 'alpi';
  const rows = v === 'empty' ? [] : listRows();
  const total = isOld ? 61240 : st.reduce((a, s) => a + s.count, 0);
  const head = `<div class="page-head">
      <h1 class="page-title">${t('Угоди')}</h1>
      <div class="seg" role="group" aria-label="Вигляд"><button data-act="go" data-screen="kanban" aria-pressed="false">${t('Канбан')}</button><button aria-pressed="true">${t('Список')}</button></div>
      <span class="spacer"></span>
      <button class="btn btn-ghost hide-m" data-act="stub">${ic('download-simple')}${t('Вивантажити CSV')}</button>
      <button class="btn btn-primary" data-act="stub">${ic('plus')}${t('Угода')}</button></div>
    <div class="saved" role="group" aria-label="Збережені фільтри">
      ${[['all', 'Усі відкриті'], ['mine', 'Мої угоди'], ['queue', 'Загальна черга'], ['old', 'Нові ліди старші 30 днів']].map(([k, l]) => `<button data-act="savedf" data-k="${k}" aria-pressed="${S.savedF === k}">${t(l)}</button>`).join('')}
      <button data-act="stub" class="muted">${ic('plus')} ${t('Зберегти фільтр')}</button>
    </div>`;
  if (v === 'error') return `<div class="page">${head}${errBlock('список угод')}</div>`;
  if (v === '403') return `<div class="page">${head}${stateBlock('403', t('Немає доступу'), `Ваша роль у проєкті ${esc(pr.name)} не дає права на масові операції. Вибрати угоди й змінити їх по одній можна з картки угоди.`, `<button class="btn btn-secondary" data-act="go" data-screen="kanban">${t('До канбану')}</button>`)}</div>`;

  const invalid = v === 'validation';
  const opt = (sel, list) => list.map(([val, l]) => `<option ${val === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const filters = `<form class="filters" aria-label="${t('Фільтри')}" onsubmit="return false">
    <div class="field"><label for="f-st">${t('Етап')}</label><select class="select" id="f-st">${opt(isOld ? 'n' : '', [['', t('усі етапи')], ['n', st[0].name], ...st.slice(1).map(s => [s.name, s.name])])}</select></div>
    <div class="field"><label for="f-ow">${t('Відповідальний')}</label><select class="select" id="f-ow">${opt('', [['', t('усі')], ...pr.users.map(u => [u.id, u.n]), ['none', 'без відповідального']])}</select></div>
    <div class="field"><label for="f-tk">${t('Наступна задача')}</label><select class="select" id="f-tk">${opt('', [['', t('будь-яка')], ['o', 'прострочена'], ['d', 'сьогодні'], ['f', 'у майбутньому'], ['n', 'немає задач']])}</select></div>
    <div class="field"><label for="f-ss">${t('Статус')}</label><select class="select" id="f-ss">${opt('o', [['o', t('відкриті')], ['w', 'виграні'], ['l', 'програні'], ['a', t('усі')]])}</select></div>
    <div class="field"><label for="f-ar">${t('Архів')}</label><select class="select" id="f-ar">${opt('n', [['n', t('без архівних')], ['o', 'лише архівні'], ['a', t('усі')]])}</select></div>
    <div class="field"><label for="f-from">${t('Створено з')}</label><input class="input date" id="f-from" value="${invalid ? '10.10.2026' : ''}" placeholder="дд.мм.рррр"></div>
    <div class="field ${invalid ? 'has-error' : ''}"><label for="f-to">${t('по')}</label><input class="input date" id="f-to" value="${isOld || invalid ? '05.10.2026' : ''}" placeholder="дд.мм.рррр" ${invalid ? 'aria-invalid="true" aria-describedby="f-to-err"' : ''}></div>
    <button class="btn btn-ghost" data-act="reset-f">${t('Скинути')}</button>
    ${invalid ? `<div class="field-error" id="f-to-err" style="flex-basis:100%">${ic('warning-circle')}<span>Дата «по» (05.10.2026) раніша за дату «з» (10.10.2026). Виправте одну з дат — список не оновлено.</span></div>` : ''}
  </form>`;

  if (v === 'loading') return `<div class="page" aria-busy="true">${head}${filters}<div class="list-meta"><div class="sk" style="height:14px;width:120px"></div></div>
    <table class="tbl"><tbody>${Array.from({ length: 9 }, (_, i) => `<tr><td class="cb"><div class="sk" style="width:18px;height:18px"></div></td><td class="title"><div class="sk" style="height:14px;width:${140 + (i * 37) % 90}px"></div></td><td class="c-stage"><div class="sk" style="height:12px;width:90px"></div></td><td class="c-amt"><div class="sk" style="height:12px;width:60px;margin-left:auto"></div></td><td class="c-owner"><div class="sk" style="height:12px;width:100px"></div></td><td class="c-task"><div class="sk" style="height:12px;width:120px"></div></td><td class="c-created"><div class="sk" style="height:12px;width:50px"></div></td></tr>`).join('')}</tbody></table></div>`;

  const sel = S.sel;
  const pageSel = rows.filter(r => sel.has(r.id)).length;
  const allChecked = rows.length && pageSel === rows.length;
  const meta = pageSel
    ? `<div class="bulkbar" role="region" aria-label="Масові дії">
        <span class="sel-count">${t('Обрано')} ${pageSel}</span>
        <button class="link-btn hide-m" data-act="stub">${t('Обрати всі')} ≈ ${fmt(total)} ${t('за фільтром')}</button>
        <span class="spacer"></span>
        <button class="btn btn-secondary btn-sm" data-act="bulk-arch">${ic('archive')}${t('Архівувати')}</button>
        <button class="btn btn-ghost btn-sm" data-act="stub">${ic('arrows-left-right')}${t('Передати')}</button>
        <button class="btn btn-ghost btn-sm hide-m" data-act="stub">${ic('swap')}${t('Змінити етап')}</button>
        <button class="btn btn-ghost btn-sm danger-text" data-act="stub">${ic('trash')}${t('Видалити')}</button>
        <button class="btn btn-ghost btn-sm btn-icon" data-act="sel-clear" aria-label="${t('Зняти вибір')}">${ic('x')}</button>
      </div>`
    : `<span class="meta">≈ <span class="num">${fmt(total)}</span> ${t('угод')} · показано ${rows.length}</span><button class="btn btn-ghost btn-sm hide-m" data-act="stub">${ic('columns')}${t('Колонки')}</button>`;

  const body = rows.length ? rows.map(r => {
    const o = r.owner ? userBy(r.owner) : null;
    return `<tr class="${sel.has(r.id) ? 'sel' : ''}">
      <td class="cb"><input type="checkbox" class="check" data-act="sel" data-id="${r.id}" ${sel.has(r.id) ? 'checked' : ''} aria-label="Обрати ${esc(r.title)}"></td>
      <td class="title ellip"><a href="#" data-act="open-deal">${esc(r.title)}</a></td>
      <td class="c-stage">${esc(r.stage)}</td>
      <td class="c-amt r">${r.amount ? money(r.amount, r.cur) : '<span class="meta">—</span>'}</td>
      <td class="c-owner">${o ? esc(o.n) : `<span class="meta">${ic('tray')} ${t('Загальна черга')}</span>`}</td>
      <td class="c-task">${taskInd(r.task)}</td>
      <td class="c-created meta">${dm(r.created)}.${r.created.slice(0, 4)}</td></tr>`;
  }).join('') : '';

  const table = rows.length ? `<table class="tbl">
    <thead><tr><th class="cb"><input type="checkbox" class="check" data-act="sel-all" ${allChecked ? 'checked' : ''} aria-label="Обрати всі на сторінці"></th>
      <th>${t('Назва')}</th><th>${t('Етап')}</th><th class="r">${t('Сума')}</th><th>${t('Відповідальний')}</th><th>${t('Наступна задача')}</th>
      <th><button data-act="stub">${t('Створено')} ${ic('caret-down')}</button></th></tr></thead>
    <tbody>${body}</tbody></table>
    <div class="list-foot"><button class="btn btn-secondary" data-act="stub">${t('Показати ще 25')}</button></div>`
    : stateBlock('empty', 'За цим фільтром угод немає', 'Спробуйте прибрати умову «Створено по» або обрати інший етап. Архівні угоди за замовчуванням не показуються.', `<button class="btn btn-secondary" data-act="reset-f">${t('Скинути')} фільтри</button>`);

  return `<div class="page">${head}${filters}<div class="list-meta">${meta}</div>${table}</div>`;
}

/* ---------- Настройки → роли ---------- */
const RES = [
  ['Робота з клієнтами', [['Угоди', 1], ['Контакти', 1], ['Задачі', 1], ['Платежі', 1], ['Організації', 0]]],
  ['Довідники', [['Товари', 0], ['Причини програшу', 0], ['Типи задач', 0]]],
  ['Аналітика', [['Звіти', 2]]],
  ['Налаштування проєкту', [['Воронки та етапи', 0], ['Поля', 0], ['Користувачі та ролі', 0], ['Інтеграції', 0], ['Кошик', 0]]],
];
// [смотреть, создавать, изменять, удалять], охват просмотра, охват изменений (для частей с охватом)
const ROLE = {
  'Адміністратор': { all: [1, 1, 1, 1], scope: ['Усі в проєкті', 'Усі в проєкті'], extra: [1, 1, 1, 1, 1], users: 2 },
  'Керівник': { client: [1, 1, 1, 1], org: [1, 1, 1, 1], ref: [1, 0, 0, 0], rep: [1], set: [0, 0, 0, 0], trash: [1, 0, 1, 0], scope: ['Усі в проєкті', 'Усі в проєкті'], extra: [0, 1, 1, 0, 1], users: 3 },
  'Тімлід': { client: [1, 1, 1, 0], org: [1, 1, 1, 0], ref: [1, 0, 0, 0], rep: [1], set: [0, 0, 0, 0], trash: [0, 0, 0, 0], scope: ['Своєї команди', 'Своєї команди'], extra: [0, 0, 1, 0, 1], users: 2 },
  'Менеджер': { client: [1, 1, 1, 0], org: [1, 1, 1, 0], ref: [1, 0, 0, 0], rep: [0], set: [0, 0, 0, 0], trash: [0, 0, 0, 0], scope: ['Свої', 'Свої'], extra: [0, 0, 0, 0, 0], users: 14 },
  'Стажер': { client: [1, 0, 1, 0], org: [1, 0, 0, 0], ref: [1, 0, 0, 0], rep: [0], set: [0, 0, 0, 0], trash: [0, 0, 0, 0], scope: ['Свої', 'Свої'], extra: [0, 0, 0, 0, 0], users: 2 },
};
const EXTRA = [['Вивантаження у файл', 'CSV зі списків і звітів'], ['Масові операції', 'архівувати, передати, змінити етап для багатьох угод'],
  ['Передача угод іншому', 'зміна відповідального'], ['Доступ до налаштувань проєкту', 'разом із правами на відповідні частини'], ['Спільні фільтри', 'зберігати фільтри для команди й проєкту']];
function rights(role, group, name) {
  const r = ROLE[role];
  if (r.all) return r.all;
  if (group === 'Робота з клієнтами') return name === 'Організації' ? r.org : r.client;
  if (group === 'Довідники') return r.ref;
  if (group === 'Аналітика') return [r.rep[0], null, null, null];
  if (name === 'Кошик') return r.trash;
  return r.set;
}
function rolesScreen() {
  const v = S.view, pr = proj();
  const sub = [['Воронки та етапи', 'kanban'], ['Поля', 'list-checks'], ['Ролі та користувачі', 'shield-check'], ['Команди', 'users-three'], ['Товари', 'package'],
    ['Причини програшу', 'tag'], ['Типи задач', 'check-square-offset'], ['Інтеграції', 'plugs'], ['Кошик', 'trash']];
  const subnav = `<nav class="subnav" aria-label="${t('Налаштування')}">${sub.map(([l, i]) => `<a href="#" data-act="stub" ${l === 'Ролі та користувачі' ? 'aria-current="page"' : ''}>${ic(i)}${t(l)}</a>`).join('')}</nav>`;
  const head = `<div class="page-head"><h1 class="page-title">${t('Налаштування')}</h1><span class="meta">${t('Проєкт')} ${esc(pr.name)}</span></div>`;
  const wrap = inner => `<div class="page">${head}<div class="settings">${subnav}<div>${inner}</div></div></div>`;
  if (v === 'error') return wrap(errBlock('ролі'));
  if (v === '403') return wrap(stateBlock('403', t('Немає доступу'), `Ролі та користувачів проєкту ${esc(pr.name)} налаштовує лише адміністратор. Ваша роль: ${esc(pr.role === 'Адміністратор' ? 'Менеджер' : pr.role)}.`, `<button class="btn btn-secondary" data-act="go" data-screen="kanban">${t('До канбану')}</button>`));

  const fresh = v === 'empty';
  const role = fresh ? 'Нова роль' : S.role;
  const tabs = `<div class="role-tabs" role="group" aria-label="Ролі">${Object.keys(ROLE).map(r => `<button data-act="role" data-r="${r}" aria-pressed="${!fresh && r === S.role}">${esc(r)}</button>`).join('')}
    <button class="add" data-act="go-empty" aria-pressed="${fresh}">${ic('plus')} ${t('Нова роль')}</button></div>`;
  const sec = `<header style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap"><h2 class="sec-title">${t('Ролі та користувачі')}</h2>
    <span class="meta">Шаблони ролей створюються в кожному проєкті; їх можна змінювати й копіювати.</span></header>`;
  if (v === 'loading') return wrap(`${sec}<div class="role-tabs">${[90, 80, 70, 90].map(w => `<div class="sk" style="height:36px;width:${w}px;border-radius:6px"></div>`).join('')}</div>
    ${Array.from({ length: 10 }, () => `<div style="display:flex;gap:40px;align-items:center;height:40px"><div class="sk" style="height:14px;width:160px"></div>${[0, 0, 0, 0].map(() => '<div class="sk" style="height:18px;width:18px"></div>').join('')}<div class="sk" style="height:14px;width:120px"></div></div>`).join('')}`);

  const invalid = v === 'validation';
  const meta = `<div class="role-meta">
    <div class="field ${invalid ? 'has-error' : ''}"><label for="rname">${t('Назва ролі')}</label>
      <input class="input" id="rname" value="${invalid ? '' : esc(role === 'Нова роль' ? '' : role)}" placeholder="Наприклад, «Старший менеджер»" ${invalid ? 'aria-invalid="true" aria-describedby="rname-err"' : ''}>
      ${invalid ? `<div class="field-error" id="rname-err">${ic('warning-circle')}<span>Вкажіть назву ролі.</span></div>` : ''}</div>
    <div class="meta" style="padding-top:22px">${fresh ? 'Роль без прав: користувач побачить лише порожню панель. Увімкніть потрібні права нижче.' : `${ROLE[role].users} користувачів · охват задається окремо для перегляду й змін («бачити все, змінювати лише свої»).`}</div>
  </div>`;

  const scopeSel = (val, id, err) => `<select class="select" aria-label="${id}" ${err ? 'aria-invalid="true" style="border-color:var(--lost)"' : ''} data-act="dirty">${['Свої', 'Своєї команди', 'Усі в проєкті'].map(o => `<option ${o === val ? 'selected' : ''}>${t(o)}</option>`).join('')}</select>`;
  let rowsH = '';
  for (const [g, items] of RES) {
    rowsH += `<tr class="grp"><td colspan="7">${esc(g)}</td></tr>`;
    for (const [name, kind] of items) {
      const r = fresh ? [0, 0, 0, 0] : rights(role, g, name);
      const sc = fresh ? ['Свої', 'Свої'] : ROLE[role].scope;
      const err = invalid && name === 'Угоди';
      const cell = (val, k) => val === null ? `<td class="na" aria-label="не застосовується">—</td>`
        : `<td><input type="checkbox" class="check" data-act="dirty" ${val ? 'checked' : ''} aria-label="${esc(name)}: ${['перегляд', 'створення', 'зміна', 'видалення'][k]}" ${role === 'Адміністратор' ? 'disabled' : ''}></td>`;
      const scopes = kind === 1 ? `<td>${scopeSel(sc[0], name + ': охват перегляду')}</td><td>${scopeSel(err ? 'Усі в проєкті' : sc[1], name + ': охват змін', err)}</td>`
        : kind === 2 ? `<td>${scopeSel(sc[0], name + ': охват')}</td><td class="na">—</td>` : `<td class="na">—</td><td class="na">—</td>`;
      rowsH += `<tr><td>${t(name)}</td>${r.map(cell).join('')}${scopes}</tr>`;
      if (err) rowsH += `<tr><td colspan="7" style="height:auto;padding:0 0 8px"><div class="field-error" style="justify-content:flex-end">${ic('warning-circle')}<span>Охват змін («Усі в проєкті») не може бути ширшим за охват перегляду («Свої»).</span></div></td></tr>`;
    }
  }
  const matrix = `<div class="matrix-wrap"><table class="matrix">
    <thead><tr><th>${t('Частина системи')}</th><th>${t('Перегляд')}</th><th>${t('Створення')}</th><th>${t('Зміна')}</th><th>${t('Видалення')}</th><th>${t('Охват перегляду')}</th><th>${t('Охват змін')}</th></tr></thead>
    <tbody>${rowsH}</tbody></table></div>`;
  const ex = fresh ? [0, 0, 0, 0, 0] : ROLE[role].extra;
  const extra = `<h3 class="sec-title" style="margin:32px 0 8px">${t('Окремі права')}</h3>
    <table class="matrix" style="min-width:0"><tbody>${EXTRA.map(([n, d], i) => `<tr><td>${esc(n)} <span class="meta">— ${esc(d)}</span></td><td style="width:64px"><input type="checkbox" class="check" data-act="dirty" ${ex[i] ? 'checked' : ''} aria-label="${esc(n)}" ${role === 'Адміністратор' ? 'disabled' : ''}></td></tr>`).join('')}</tbody></table>
    ${role === 'Стажер' ? `<p style="margin-top:24px"><button class="btn btn-ghost danger-text" data-act="del-role">${ic('trash')}Видалити роль «Стажер»</button></p>` : ''}
    ${role === 'Адміністратор' ? `<p class="meta" style="margin-top:16px">${ic('lock-simple')} Права адміністратора не змінюються: у проєкті завжди має бути хтось із повним доступом.</p>` : ''}`;
  const save = S.dirty || invalid || fresh ? `<div class="savebar"><span class="meta">${t('Незбережені зміни')} · ${esc(role)}</span><span style="display:flex;gap:8px">
    <button class="btn btn-ghost" data-act="role-cancel">${t('Скасувати')}</button><button class="btn btn-primary" data-act="role-save">${t('Зберегти')}</button></span></div>` : '';
  return wrap(`${sec}${tabs}${meta}${matrix}${extra}${save}`);
}

/* ---------- Вход ---------- */
function signinScreen() {
  const v = S.view;
  const loading = v === 'loading', invalid = v === 'validation';
  const step = v === 'empty' ? 1 : S.signStep;
  const banner = v === 'error' ? `<div class="banner err" role="alert">${ic('cloud-slash')}<span>Сервер недоступний. Спробуйте за хвилину. Код запиту 9b10-44de.</span></div>`
    : v === '403' ? `<div class="banner err" role="alert">${ic('prohibit')}<span>Обліковий запис вимкнено. Зверніться до адміністратора проєкту — увійти зараз не можна.</span></div>` : '';
  const code = invalid ? '481902' : loading ? '305718' : '';
  const form = step === 1 ? `
    <span class="meta">Крок 1 з 2</span>
    <h1 class="page-title">${t('Вхід')}</h1>
    <p>Обліковий запис створює адміністратор. Самостійної реєстрації немає.</p>
    <form data-form="signin1">${banner}
      <div class="field"><label for="em">Email</label><input class="input" id="em" type="email" autocomplete="username" placeholder="імʼя@example.com" style="height:44px"></div>
      <div class="field"><label for="pw">${t('Пароль')}</label><input class="input" id="pw" type="password" autocomplete="current-password" style="height:44px"></div>
      <button class="btn btn-primary" type="submit">${ic('sign-in')}${t('Увійти')}</button>
    </form>`
    : `
    <span class="meta">Крок 2 з 2</span>
    <h1 class="page-title">${t('Код підтвердження')}</h1>
    <p>Відкрийте застосунок-автентифікатор і введіть 6-значний код для <b style="color:var(--ink)">olena.koval@example.com</b>.</p>
    <form data-form="signin2">${banner}
      <div class="field ${invalid ? 'has-error' : ''}">
        <label id="code-l">Код із застосунку</label>
        <div class="code" role="group" aria-labelledby="code-l">${Array.from({ length: 6 }, (_, i) => `<input class="input" inputmode="numeric" maxlength="1" aria-label="Цифра ${i + 1}" value="${code[i] || ''}" ${loading ? 'disabled' : ''} ${invalid ? 'aria-invalid="true" aria-describedby="code-err"' : ''}>`).join('')}</div>
        ${invalid ? `<div class="field-error" id="code-err">${ic('warning-circle')}<span>Код не підходить. Перевірте, чи правильний час на телефоні, і введіть новий код. Залишилось 4 спроби.</span></div>` : ''}
      </div>
      <button class="btn btn-primary" type="submit" ${loading ? 'disabled aria-busy="true" style="opacity:1"' : ''}>${loading ? '<span class="spin" aria-hidden="true"></span>Перевіряємо код…' : t('Підтвердити')}</button>
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:var(--fs-table)">
        <button type="button" class="link-btn" data-act="stub">${t('Використати код відновлення')}</button>
        <button type="button" class="link-btn" style="color:var(--ink-2);font-weight:400" data-act="sign-back">${t('Інший обліковий запис')}</button>
      </div>
    </form>`;
  return `<div class="signin">
    <div class="signin-side">
      <div class="brand"><b>Alpi</b><span>CRM</span></div>
      <div><blockquote>Угоди, дзвінки й оплати двох проєктів — на одному аркуші.</blockquote>
        <p class="meta" style="margin-top:16px">AI-школа ALPI та франчайзинг-консалтинг «Франч». Дані проєктів ізольовані; роль — своя в кожному проєкті.</p></div>
      <div class="meta">Вхід лише для співробітників · двофакторна перевірка обовʼязкова</div>
    </div>
    <div class="signin-main"><div class="signin-card">${form}</div></div>
  </div>`;
}

/* ---------- Диалоги и уведомления ---------- */
function openDialog(d) { S.dialog = d; renderLayer(); setTimeout(() => { const f = $('#layer .dialog select, #layer .dialog input, #layer .dialog .btn-primary'); f && f.focus(); }, 30); }
function closeDialog() { S.dialog = null; if (['confirm', 'validation'].includes(S.view) && !['list', 'roles', 'signin'].includes(S.screen)) { S.view = 'normal'; render(); return; } renderLayer(); }
function toast(text, icon = 'check', action = null, persist = false, progress = false) {
  const id = Math.random().toString(36).slice(2);
  S.toasts.push({ id, text, icon, action, progress });
  renderLayer();
  if (!persist) setTimeout(() => { S.toasts = S.toasts.filter(x => x.id !== id); renderLayer(); }, 6000);
}

function viewDialog() {
  if (S.view === 'confirm') {
    if (S.screen === 'kanban') return { kind: 'lost', id: 'd51402', preset: true };
    if (S.screen === 'deal') return { kind: 'arch-deal' };
    if (S.screen === 'list') return { kind: 'bulk-arch' };
    if (S.screen === 'roles') return { kind: 'del-role' };
  }
  if (S.view === 'validation') {
    if (S.screen === 'kanban') return { kind: 'required', id: 'd51399', to: 5, errors: true };
    if (S.screen === 'deal') return { kind: 'lost', deal: true, errors: true };
  }
  return null;
}
function viewToast() {
  if (S.view !== 'toast') return null;
  return {
    kanban: { text: 'Угоду «Олег Шевченко — AI-відео MAX» переміщено на етап «Сплатив бронювання»', icon: 'arrows-left-right', action: { label: t('Скасувати') } },
    deal: { text: 'Суму угоди змінено на 1 340 € — як сума по товарах', icon: 'check', action: { label: t('Скасувати') } },
    list: { text: 'Архівуємо 3 угоди у фоні · 1 з 3', icon: 'archive', action: { label: t('Журнал') }, progress: true },
    roles: { text: 'Роль «Менеджер» збережено. Зміни діють для 14 користувачів з наступного запиту.', icon: 'check' },
    signin: { text: 'Використано код відновлення. Залишилось 7 кодів — створіть нові в профілі.', icon: 'key' },
  }[S.screen];
}

function dialogHTML(d) {
  const pr = proj();
  const close = `<button class="btn btn-ghost" data-act="dlg-close">${t('Скасувати')}</button>`;
  if (d.kind === 'lost') {
    const c = d.id ? findCard(d.id) : null;
    const name = d.deal ? DATA.demo.title : c ? c.c.title : '';
    const groups = Object.keys(pr.lostReasons);
    const g = d.preset ? groups[0] : (d.g || '');
    const reasons = g ? pr.lostReasons[g] : [];
    const r = d.preset ? reasons[1] : (d.r || '');
    const e = d.errors;
    return `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h2 id="dlg-t">${t('Позначити програною')}</h2>
      <p>«${esc(name)}». Причину видно у звітах; вільного тексту замість причини немає — лише довідник проєкту.</p>
      <form class="fields" data-form="lost">
        <div class="field ${e ? 'has-error' : ''}"><label for="lg">${t('Група')}</label>
          <select class="select" id="lg" data-act="lost-g" ${e ? 'aria-invalid="true" aria-describedby="lg-e"' : ''}><option value="">— оберіть групу —</option>${groups.map(x => `<option ${x === g ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
          ${e ? `<div class="field-error" id="lg-e">${ic('warning-circle')}<span>Оберіть групу причини.</span></div>` : ''}</div>
        <div class="field ${e ? 'has-error' : ''}"><label for="lr">${t('Причина')}</label>
          <select class="select" id="lr" ${g ? '' : 'disabled'} ${e ? 'aria-invalid="true" aria-describedby="lr-e"' : ''}><option value="">${g ? '— оберіть причину —' : 'спершу оберіть групу'}</option>${reasons.map(x => `<option ${x === r ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
          ${e ? `<div class="field-error" id="lr-e">${ic('warning-circle')}<span>Без причини угоду не можна позначити програною.</span></div>` : ''}</div>
        <div class="field"><label for="lc">${t('Коментар')} <span style="font-weight:400">(${t('необовʼязково')})</span></label><textarea class="input" id="lc" rows="2"></textarea></div>
      </form>
      <div class="dialog-actions">${close}<button class="btn btn-primary" data-act="lost-ok">${ic('x-circle')}${t('Позначити програною')}</button></div></div>`;
  }
  if (d.kind === 'required') {
    const c = findCard(d.id); const e = d.errors;
    const to = board()[d.to].name;
    return `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h2 id="dlg-t">Заповніть поля етапу «${esc(to)}»</h2>
      <p>«${esc(c ? c.c.title : '')}». Ці поля обовʼязкові з етапу «${esc(to)}» — без них угода залишиться на своєму етапі.</p>
      <form class="fields" data-form="required">
        <div class="field ${e ? 'has-error' : ''}"><label for="rq1">Пакет</label><select class="select" id="rq1" ${e ? 'aria-invalid="true"' : ''}><option value="">— оберіть —</option><option>START</option><option>PRO</option><option>MAX</option></select>
          ${e ? `<div class="field-error">${ic('warning-circle')}<span>Оберіть пакет — від нього залежить сума рахунку.</span></div>` : ''}</div>
        <div class="field ${e ? 'has-error' : ''}"><label for="rq2">Тип закриття</label><select class="select" id="rq2" ${e ? 'aria-invalid="true"' : ''}><option value="">— оберіть —</option><option>Бронь + доплата</option><option>Повна оплата</option><option>Розстрочка</option></select>
          ${e ? `<div class="field-error">${ic('warning-circle')}<span>Оберіть тип закриття.</span></div>` : ''}</div>
        <div class="field"><label for="rq3">Сума угоди, €</label><input class="input" id="rq3" value="${c ? c.c.amount : ''}" inputmode="decimal"></div>
      </form>
      <div class="dialog-actions">${close}<button class="btn btn-primary" data-act="req-ok">Зберегти й перемістити</button></div></div>`;
  }
  if (d.kind === 'arch-deal') return `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h2 id="dlg-t">Перенести угоду в архів?</h2>
      <p>«${esc(DATA.demo.title)}» зникне з канбану й робочих списків, але залишиться в пошуку та звітах. Статус «Відкрита» не зміниться; повернути можна будь-коли.</p>
      <div class="dialog-actions">${close}<button class="btn btn-primary" data-act="arch-ok">${ic('archive')}${t('Перенести в архів')}</button></div></div>`;
  if (d.kind === 'bulk-arch') return `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h2 id="dlg-t">Архівувати ${S.sel.size || 3} угоди?</h2>
      <p>Угоди зникнуть з канбану й робочих списків, залишаться в пошуку та звітах. Операція виконується у фоні; прогрес і журнал — у сповіщеннях.</p>
      <div class="dialog-actions">${close}<button class="btn btn-primary" data-act="bulk-ok">${ic('archive')}${t('Архівувати')}</button></div></div>`;
  if (d.kind === 'del-role') return `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h2 id="dlg-t">Видалити роль «Стажер»?</h2>
      <p>2 користувачі з цією роллю втратять доступ до проєкту ${esc(pr.name)}, доки ви не призначите їм іншу роль. Дію не можна скасувати.</p>
      <div class="dialog-actions">${close}<button class="btn btn-secondary danger-text" data-act="delrole-ok" style="border-color:var(--lost)">${ic('trash')}Видалити роль</button></div></div>`;
  return '';
}

function renderLayer() {
  const d = S.dialog || viewDialog();
  const vt = viewToast();
  const toasts = [...(vt ? [{ id: 'v', ...vt, persist: true }] : []), ...S.toasts];
  $('#layer').innerHTML = (d ? `<div class="scrim" data-act="scrim">${dialogHTML(d)}</div>` : '')
    + `<div class="toasts" aria-live="polite">${toasts.map(x => `<div class="toast" role="status">${ic(x.icon)}<div class="t-text">${esc(x.text)}${x.progress ? '<div class="progress"><i></i></div>' : ''}</div>
      ${x.action ? `<button class="link-btn" data-act="toast-act" data-id="${x.id}">${esc(x.action.label)}</button>` : ''}
      <button class="x" data-act="toast-x" data-id="${x.id}" aria-label="${t('Закрити')}">${ic('x')}</button></div>`).join('')}</div>`;
}

/* ---------- Панель прототипа ---------- */
function renderProto() {
  const el = $('#proto');
  if (!S.bar) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="proto" role="toolbar" aria-label="Панель прототипу">
    <span class="lbl">Екран</span><select class="select" data-ctl="screen" aria-label="Екран">${SCREENS.map(([k, l]) => `<option value="${k}" ${k === S.screen ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <span class="lbl">Стан</span><select class="select" data-ctl="view" aria-label="Стан">${VIEWS.map(([k, l]) => `<option value="${k}" ${k === S.view ? 'selected' : ''} ${viewAllowed(S.screen, k) ? '' : 'disabled'}>${l}</option>`).join('')}</select>
    <span class="vr"></span>
    <div class="seg" role="group" aria-label="Тема"><button data-act="theme-set" data-v="light" aria-pressed="${S.theme === 'light'}">${ic('sun')} Світла</button><button data-act="theme-set" data-v="dark" aria-pressed="${S.theme === 'dark'}">${ic('moon')} Темна</button></div>
    <button class="btn btn-secondary" data-act="phone" aria-pressed="${S.phone}">${ic('device-mobile')}390 px</button>
  </div>
  ${S.phone ? `<div class="phone-ov" data-act="phone-ov"><div class="phone"><iframe title="Перегляд на телефоні, 390 px" src="${phoneSrc()}"></iframe></div></div>` : ''}`;
}
function phoneSrc() { const p = new URLSearchParams(location.search); p.set('bar', '0'); return '?' + p.toString(); }

/* ---------- Отрисовка ---------- */
function render() {
  document.documentElement.dataset.theme = S.theme;
  document.documentElement.lang = S.lang;
  syncURL();
  $('#root').innerHTML = S.screen === 'signin' ? signinScreen() : shell();
  if (S.screen === 'kanban') { if (S.view === 'drag') requestAnimationFrame(placeGhost); else bindDrag(); }
  const tab = $('.stage-tabs [aria-selected="true"]'); if (tab) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
  renderLayer(); renderProto();
}
function go(screen, view = 'normal') { S.screen = screen; S.view = viewAllowed(screen, view) ? view : 'normal'; S.pop = null; S.navOpen = false; S.dialog = null; S.toasts = []; render(); $('#main') && ($('#main').scrollTop = 0); }

/* ---------- События ---------- */
const ACT = {
  go: a => go(a.dataset.screen),
  stub: () => toast('Цей розділ не входить у прототип напряму 2', 'info'),
  retry: () => { S.view = 'loading'; render(); setTimeout(() => { S.view = 'normal'; render(); }, 900); },
  nav: () => { S.navOpen = !S.navOpen; render(); },
  msearch: () => { S.msearch = !S.msearch; render(); if (S.msearch) $('#q').focus(); },
  pop: a => { S.pop = S.pop === a.dataset.pop ? null : a.dataset.pop; render(); },
  proj: a => { S.proj = a.dataset.proj; S.pop = null; S.sel.clear(); if (S.screen === 'deal') S.screen = 'kanban'; render(); toast(`Проєкт ${proj().name}: показано лише його угоди й контакти`, 'swap'); },
  lang: a => { S.lang = a.dataset.lang; render(); },
  theme: () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; render(); },
  'theme-set': a => { S.theme = a.dataset.v; render(); },
  phone: () => { S.phone = !S.phone; renderProto(); },
  'phone-ov': (a, e) => { if (e.target === a) { S.phone = false; renderProto(); } },
  scope: a => { S.scope = a.dataset.k; render(); },
  kf: a => { S.kf = S.kf === a.dataset.k ? 'all' : a.dataset.k; render(); },
  mstage: a => { S.mStage[S.proj] = +a.dataset.i; render(); },
  take: a => {
    const f = findCard(a.dataset.id); if (!f) return;
    f.c.owner = me; f.c.queue = false; f.c.task = { k: 'd', date: DATA.TODAY, time: '', type: 'Звʼязатися' };
    render(); toast(`«${f.c.title}» тепер ваша угода. Задачу «Звʼязатися» поставлено на сьогодні.`, 'check',
      { label: t('Скасувати'), fn: () => { f.c.owner = null; f.c.queue = true; f.c.task = null; render(); } });
  },
  'open-deal': (a, e) => { if (e.target.closest('[data-act="take"]')) return; S.q = ''; go('deal'); },
  'deal-stage': a => {
    const i = +a.dataset.i; if (i === S.deal.stage) return;
    const st = DATA.projects.alpi.stages, from = st[S.deal.stage].name;
    S.deal.stage = i; S.deal.notes.unshift({ t: 'stage', at: '04.11 · зараз', who: 'Олена Коваль', from, to: st[i].name });
    render(); toast(`Етап змінено: ${from} → ${st[i].name}`, 'arrows-left-right');
  },
  'deal-won': () => { S.deal.status = 'won'; render(); toast('Угоду позначено виграною', 'check-circle', { label: t('Скасувати'), fn: () => { S.deal.status = 'open'; render(); } }); },
  'deal-lost': () => openDialog({ kind: 'lost', deal: true }),
  'deal-reopen': () => { S.deal.status = 'open'; S.deal.reason = null; render(); toast('Угоду відкрито знову', 'arrow-counter-clockwise'); },
  'deal-arch': () => { if (S.deal.archived) { S.deal.archived = false; render(); toast('Угоду повернуто з архіву', 'archive'); } else openDialog({ kind: 'arch-deal' }); },
  'arch-ok': () => { S.deal.archived = true; S.dialog = null; S.view = 'normal'; render(); toast('Угоду перенесено в архів', 'archive', { label: t('Скасувати'), fn: () => { S.deal.archived = false; render(); } }); },
  'task-done': () => { toast('Задачу виконано. Запланувати наступну?', 'check', { label: t('Задача на завтра'), fn: () => toast('Задачу «Очікую оплату» поставлено на 05.11', 'calendar-check') }); },
  'apply-sum': a => { const old = S.deal.amount; S.deal.amount = +a.dataset.v; render(); toast(`Суму угоди змінено на ${fmt(S.deal.amount)} € — як сума по товарах`, 'check', { label: t('Скасувати'), fn: () => { S.deal.amount = old; render(); } }); },
  feedf: a => { S.feedF = a.dataset.k; render(); },
  'lost-ok': () => {
    const d = S.dialog || viewDialog();
    const g = $('#lg').value, r = $('#lr').value;
    if (!g || !r) { S.dialog = { ...d, errors: true, preset: false, g, r }; renderLayer(); return; }
    S.dialog = null; S.view = 'normal';
    if (d.deal) { S.deal.status = 'lost'; S.deal.reason = `${g} — ${r}`; render(); toast('Угоду позначено програною', 'x-circle', { label: t('Скасувати'), fn: () => { S.deal.status = 'open'; render(); } }); }
    else closeCard(d.id, 'lost', `${g} — ${r}`);
  },
  'req-ok': () => {
    const d = S.dialog || viewDialog();
    if (!$('#rq1').value || !$('#rq2').value) { S.dialog = { ...d, errors: true }; renderLayer(); return; }
    S.dialog = null; S.view = 'normal'; moveCard(d.id, d.to);
  },
  'dlg-close': () => closeDialog(),
  scrim: (a, e) => { if (e.target === a) closeDialog(); },
  'toast-x': a => { if (a.dataset.id === 'v') { S.view = 'normal'; render(); return; } S.toasts = S.toasts.filter(x => x.id !== a.dataset.id); renderLayer(); },
  'toast-act': a => { const x = S.toasts.find(x => x.id === a.dataset.id); S.toasts = S.toasts.filter(y => y !== x); if (a.dataset.id === 'v') { S.view = 'normal'; render(); return; } renderLayer(); x && x.action.fn && x.action.fn(); },
  savedf: a => { S.savedF = a.dataset.k; S.sel.clear(); render(); },
  sel: a => { a.checked ? S.sel.add(a.dataset.id) : S.sel.delete(a.dataset.id); render(); },
  'sel-all': a => { const rows = listRows(); if (a.checked) rows.forEach(r => S.sel.add(r.id)); else S.sel.clear(); render(); },
  'sel-clear': () => { S.sel.clear(); render(); },
  'reset-f': () => { S.savedF = 'all'; S.sel.clear(); S.view = 'normal'; render(); },
  'bulk-arch': () => openDialog({ kind: 'bulk-arch' }),
  'bulk-ok': () => { const n = S.sel.size; S.dialog = null; S.view = 'normal'; S.sel.clear(); render(); toast(`Архівуємо ${n} угоди у фоні · 1 з ${n}`, 'archive', { label: t('Журнал'), fn: () => {} }, false, true); },
  role: a => { S.role = a.dataset.r; S.dirty = false; S.view = 'normal'; render(); },
  'go-empty': () => { S.view = 'empty'; render(); },
  dirty: () => { if (!S.dirty) { S.dirty = true; render(); } },
  'role-cancel': () => { S.dirty = false; S.view = 'normal'; render(); },
  'role-save': () => {
    const n = $('#rname'); if (n && !n.value.trim()) { S.view = 'validation'; render(); return; }
    S.dirty = false; S.view = 'normal'; render(); toast(`Роль «${S.role}» збережено`, 'check');
  },
  'del-role': () => openDialog({ kind: 'del-role' }),
  'delrole-ok': () => { S.dialog = null; S.view = 'normal'; S.role = 'Менеджер'; render(); toast('Роль «Стажер» видалено. 2 користувачам потрібна нова роль.', 'trash'); },
  'sign-back': () => { S.signStep = 1; S.view = 'normal'; render(); },
};

document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (S.pop && !e.target.closest('.pop') && !(a && a.dataset.act === 'pop')) { S.pop = null; if (!a) { render(); return; } }
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'lost-g' || act === 'dirty' && a.tagName === 'SELECT') return;
  if (a.tagName === 'A') e.preventDefault();
  if (ACT[act]) ACT[act](a, e);
});
document.addEventListener('change', e => {
  const c = e.target.closest('[data-ctl]');
  if (c) { if (c.dataset.ctl === 'screen') go(c.value, 'normal'); else { S.view = c.value; if (c.value === 'drag' && S.screen !== 'kanban') S.screen = 'kanban'; S.dialog = null; S.toasts = []; render(); } if (S.phone) { const f = $('.phone iframe'); f && (f.src = phoneSrc()); } return; }
  if (e.target.id === 'lg') { const d = S.dialog || viewDialog(); S.dialog = { ...d, preset: false, g: e.target.value, r: '', errors: false }; renderLayer(); $('#lr') && $('#lr').focus(); return; }
  if (e.target.dataset.act === 'dirty' && !S.dirty) { S.dirty = true; render(); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { S.q = e.target.value; $('#sres').innerHTML = searchResults(); return; }
  if (e.target.closest('.code')) {
    const ins = $$('.code input');
    const i = ins.indexOf(e.target);
    e.target.value = e.target.value.replace(/\D/g, '').slice(-1);
    if (e.target.value && i < 5) ins[i + 1].focus();
    if (ins.every(x => x.value)) { S.view = 'loading'; render(); setTimeout(() => { S.signStep = 2; go('kanban'); toast('Вхід виконано. Проєкт ALPI', 'sign-in'); }, 900); }
  }
});
document.addEventListener('submit', e => {
  const f = e.target.dataset.form; if (!f) return;
  e.preventDefault();
  if (f === 'note') {
    const v = $('#note').value.trim(); if (!v) { $('#note').focus(); return; }
    S.deal.notes.unshift({ t: 'note', at: '04.11 · зараз', who: 'Олена Коваль', text: v }); render(); toast('Нотатку збережено', 'note-pencil');
  }
  if (f === 'signin1') { S.signStep = 2; S.view = 'normal'; render(); setTimeout(() => { const x = $('.code input'); x && x.focus(); }, 30); }
  if (f === 'signin2') { const ins = $$('.code input'); if (ins.some(x => !x.value)) { S.view = 'validation'; render(); } }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (S.dialog || viewDialog()) closeDialog(); else if (S.pop || S.q) { S.pop = null; S.q = ''; render(); } else if (S.phone) { S.phone = false; renderProto(); } }
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { const q = $('#q'); if (q) { e.preventDefault(); q.focus(); } }
  if (e.key === 'Enter' && document.activeElement.classList.contains('card')) { go('deal'); }
});

render();
