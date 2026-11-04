/* ПРОТОТИП — throwaway. Напрям 3 «Кольорова воронка». Без збірки; стан живе в памʼяті.
   URL: ?screen=kanban|deal|list|roles|signin &state=normal|loading|empty|error|forbidden|validation|toast|confirm|drag
        &theme=light|dark &lang=uk|ru &project=alpi|franch &bar=0 (сховати панель прототипу) &preview=390 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => RM.matches;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ic = (n, cls = '') => `<span class="ms ${cls}" aria-hidden="true">${n}</span>`;

/* ───────────── стан ───────────── */
const Q = new URLSearchParams(location.search);
const S = {
  screen: Q.get('screen') || 'kanban',
  st: Q.get('state') || 'normal',
  theme: Q.get('theme') || 'light',
  lang: Q.get('lang') || 'uk',
  project: Q.get('project') || 'alpi',
  bar: Q.get('bar') !== '0',
  preview: Q.get('preview') === '390',
  frame: Q.get('frame') === '1',
  mobStage: 0,
  role: 'Менеджер',
  deal: { status: 'open', archived: false, amount: DEAL.amount, lostReason: '' },
  tl: 'all',
  sel: new Set([4782, 4699, 4650]),
  cards: JSON.parse(JSON.stringify(CARDS)),
  stages: JSON.parse(JSON.stringify(PROJECTS)),
  dealCard: null,
};
let lastScreen = null;

/* ───────────── мова: оболонка перекладена, дані лишаються українською ───────────── */
const T = {
  uk: {
    search: 'Пошук: імʼя, телефон, email, угода', dash: 'Панель', deals: 'Угоди', contacts: 'Контакти', orgs: 'Організації',
    calendar: 'Календар', reports: 'Звіти', settings: 'Налаштування', more: 'Ще', kanban: 'Канбан', list: 'Список',
    newDeal: 'Нова угода', won: 'Виграна', lost: 'Програна', archive: 'В архів', reopen: 'Відкрити знову',
    take: 'Взяти в роботу', queue: 'Загальна черга', noOwner: 'Без відповідального', notask: 'Немає задачі',
    deals_n: 'угод', notifs: 'Сповіщення', mine: 'Мої', overdue: 'Прострочені', today: 'Задача сьогодні', filter: 'Фільтр',
    total: 'Разом відкритих', save: 'Зберегти', cancel: 'Скасувати', next: 'Що зробити далі', timeline: 'Стрічка',
    contact: 'Контакт', products: 'Товари', payments: 'Платежі', regs: 'Реєстрації', fields: 'Поля угоди',
    roles: 'Ролі та користувачі', signin: 'Увійти', theme: 'Тема', open: 'Відкрита', inArchive: 'В архіві',
    retry: 'Спробувати ще раз', back: 'Угоди', amount: 'Сума угоди', owner: 'Відповідальна',
  },
  ru: {
    search: 'Поиск: имя, телефон, email, сделка', dash: 'Панель', deals: 'Сделки', contacts: 'Контакты', orgs: 'Организации',
    calendar: 'Календарь', reports: 'Отчёты', settings: 'Настройки', more: 'Ещё', kanban: 'Канбан', list: 'Список',
    newDeal: 'Новая сделка', won: 'Выиграна', lost: 'Проиграна', archive: 'В архив', reopen: 'Открыть заново',
    take: 'Взять в работу', queue: 'Общая очередь', noOwner: 'Без ответственного', notask: 'Нет задачи',
    deals_n: 'сделок', notifs: 'Уведомления', mine: 'Мои', overdue: 'Просроченные', today: 'Задача сегодня', filter: 'Фильтр',
    total: 'Всего открытых', save: 'Сохранить', cancel: 'Отмена', next: 'Что сделать дальше', timeline: 'Лента',
    contact: 'Контакт', products: 'Товары', payments: 'Платежи', regs: 'Регистрации', fields: 'Поля сделки',
    roles: 'Роли и пользователи', signin: 'Войти', theme: 'Тема', open: 'Открыта', inArchive: 'В архиве',
    retry: 'Повторить', back: 'Сделки', amount: 'Сумма сделки', owner: 'Ответственная',
  },
};
const t = k => (T[S.lang] && T[S.lang][k]) || T.uk[k] || k;

/* ───────────── формат ───────────── */
const fmt = n => Math.round(n).toLocaleString('uk-UA').replace(/ /g, ' ');
const money = (a, cur) => `${fmt(a)} ${SYM[cur]}`;
const compactUAH = n => n >= 1e6 ? `${(n / 1e6).toLocaleString('uk-UA', { maximumFractionDigits: 2 })} млн ₴` : `${fmt(n)} ₴`;
const toUAH = sums => Object.entries(sums).reduce((a, [c, v]) => a + v * RATES[c], 0);

/* ───────────── кольори етапів ───────────── */
const ON = { cyan: 'var(--on-light-fill)', blue: 'var(--on-light-fill)' };
function sv(st) {
  const base = `var(--st-${st.hue})`;
  let c = base, on = ON[st.hue] || 'var(--on-dark-fill)';
  if (st.tone === 'soft') { c = `color-mix(in srgb, ${base} 55%, var(--desat))`; on = st.hue === 'blue' ? 'var(--on-light-fill)' : 'var(--on-dark-fill)'; }
  if (st.tone === 'deep') { c = `color-mix(in srgb, ${base} 72%, var(--ink))`; on = 'var(--on-deep)'; }
  return `--sc:${c};--sb:var(--st-${st.hue}-bg);--son:${on}`;
}
const P = () => PROJECTS[S.project];
const STG = () => S.stages[S.project].stages;

/* ───────────── дрібні компоненти ───────────── */
const avatar = (uid, size = 24) => uid
  ? `<span class="av av-${size}" title="${esc(USERS[uid].n)}">${USERS[uid].ini}</span>`
  : `<span class="av av-${size} av-empty" title="${t('noOwner')}">${ic('person')}</span>`;

function taskInd(task, cls = '') {
  const [k, label] = task;
  if (k === 'overdue') return `<span class="ti ti-overdue ${cls}">${ic('schedule', 'ms-fill')}${esc(label)}</span>`;
  if (k === 'today') return `<span class="ti ti-today ${cls}">${ic('today', 'ms-fill')}${esc(label)}</span>`;
  if (k === 'future') return `<span class="ti ti-future ${cls}">${ic('event')}${esc(label)}</span>`;
  return `<span class="ti ti-none ${cls}">${ic('event_busy')}${t('notask')}</span>`;
}
const stageTag = (st, hollow = false) => `<span class="stag ${hollow ? 'is-hollow' : ''}" style="${sv(st)}"><i class="dot"></i>${esc(st.name)}</span>`;
const btn = (label, cls = '', icon = '', attrs = '') => `<button class="btn ${cls}" ${attrs}>${icon ? ic(icon) : ''}<span>${label}</span></button>`;
const iconBtn = (icon, label, attrs = '', cls = '') => `<button class="ibtn ${cls}" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${ic(icon)}</button>`;

const logo = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
  <rect x="3" y="6" width="26" height="5" rx="2.5" fill="var(--st-cyan)"/>
  <rect x="7" y="13.5" width="18" height="5" rx="2.5" fill="var(--st-iris)"/>
  <rect x="11" y="21" width="10" height="5" rx="2.5" fill="var(--st-plum)"/></svg>`;

/* ───────────── оболонка ───────────── */
const NAV = [
  ['dash', 'space_dashboard'], ['deals', 'handshake'], ['contacts', 'person'], ['orgs', 'apartment'],
  ['calendar', 'calendar_month'], ['reports', 'monitoring'], ['settings', 'settings'],
];
function navKey() { return S.screen === 'roles' ? 'settings' : 'deals'; }

function shell(inner) {
  const nk = navKey();
  const unread = NOTIFS.filter(n => n.unread).length;
  return `
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="#" data-go="kanban" aria-label="Alpi CRM">${logo}<span class="brand-name">Alpi CRM</span></a>
      <button class="proj" data-menu="proj" aria-haspopup="menu">
        <span class="proj-mark">${S.project === 'alpi' ? 'A' : 'Ф'}</span>
        <span class="proj-txt"><span class="t-ll">${esc(P().code)}</span><span class="t-ls proj-role">${esc(P().role)}</span></span>
        ${ic('expand_more')}
      </button>
      <label class="search">
        ${ic('search')}
        <input id="q" type="search" placeholder="${t('search')}" autocomplete="off">
        <kbd>Ctrl K</kbd>
      </label>
      <div class="top-actions">
        ${iconBtn('search', t('search'), 'data-act="msearch"', 'only-mobile')}
        <div class="lang seg-mini" role="group" aria-label="Мова">
          <button data-lang="uk" aria-pressed="${S.lang === 'uk'}">UK</button><button data-lang="ru" aria-pressed="${S.lang === 'ru'}">RU</button>
        </div>
        ${iconBtn(S.theme === 'dark' ? 'light_mode' : 'dark_mode', t('theme'), 'data-act="theme"', 'hide-mobile')}
        <button class="ibtn bell" data-menu="notifs" aria-label="${t('notifs')}" title="${t('notifs')}">${ic('notifications')}<span class="badge">${unread}</span></button>
        <button class="me" data-menu="me" aria-label="Олена Коваль">${avatar(ME, 32)}</button>
      </div>
    </header>
    <nav class="rail" aria-label="Розділи">
      ${NAV.map(([k, i]) => `<a href="#" class="rail-i ${k === nk ? 'is-on' : ''}" data-nav="${k}" ${k === nk ? 'aria-current="page"' : ''}>
        <span class="rail-ind">${ic(i, k === nk ? 'ms-fill' : '')}</span><span class="t-lm">${t(k)}</span></a>`).join('')}
    </nav>
    <main class="main" id="main">${inner}</main>
    <nav class="bnav" aria-label="Розділи">
      ${[['dash', 'space_dashboard'], ['deals', 'handshake'], ['calendar', 'calendar_month'], ['contacts', 'person'], ['more', 'menu']].map(([k, i]) =>
        `<a href="#" class="bnav-i ${k === nk ? 'is-on' : ''}" data-nav="${k}"><span class="rail-ind">${ic(i, k === nk ? 'ms-fill' : '')}</span><span class="t-lm">${t(k)}</span></a>`).join('')}
    </nav>
  </div>`;
}

/* ───────────── спільні стани ───────────── */
function stateError(what) {
  return `<div class="state-panel" role="alert">
    <span class="state-ic">${ic('cloud_off')}</span>
    <h2 class="t-hs">Не вдалося завантажити ${what}</h2>
    <p class="t-bl muted">Сервер не відповів за 10 секунд. Ваші дані не втрачено — зміни, зроблені до збою, збережені.</p>
    <div class="state-act">${btn(t('retry'), 'btn-primary', 'refresh', 'data-state="normal"')}${btn('Повідомити адміністратору', 'btn-text', 'support_agent')}</div>
    <p class="t-lm muted code">Код 503 · запит 7f3a91c2 · 04.11.2026 10:41</p>
  </div>`;
}
function stateForbidden(what) {
  return `<div class="state-panel">
    <span class="state-ic">${ic('lock')}</span>
    <h2 class="t-hs">Немає доступу до розділу «${what}»</h2>
    <p class="t-bl muted">Ваша роль у проєкті ${esc(P().code)} — «Менеджер». Цей розділ відкриває право «${S.screen === 'roles' ? 'Доступ до налаштувань проєкту' : 'Угоди: перегляд'}». Попросіть адміністратора проєкту змінити роль.</p>
    <div class="state-act">${btn('Повернутися до угод', 'btn-tonal', 'arrow_back', 'data-go="kanban" data-state="normal"')}</div>
    <p class="t-lm muted code">Код 403 · адміністратори: Тарас Левченко, Олена Коваль</p>
  </div>`;
}
const sk = (w, h = 12, r = 6) => `<span class="sk" style="width:${w};height:${h}px;border-radius:${r}px"></span>`;

/* ───────────── сторінка: заголовок угод ───────────── */
function dealsHead(view) {
  return `<div class="pagehead">
    <div class="ph-title">
      <h1 class="t-hs">${t('deals')}</h1>
      <button class="pipe" data-act="pipe">${ic('filter_alt')}<span class="t-ll">${esc(P().pipeline)}</span>${ic('expand_more')}</button>
    </div>
    <div class="ph-actions">
      <div class="segbtn" role="group" aria-label="Вигляд">
        <button data-go="kanban" aria-pressed="${view === 'kanban'}">${ic('view_kanban', view === 'kanban' ? 'ms-fill' : '')}<span>${t('kanban')}</span></button>
        <button data-go="list" aria-pressed="${view === 'list'}">${ic('table_rows', view === 'list' ? 'ms-fill' : '')}<span>${t('list')}</span></button>
      </div>
      ${btn(t('newDeal'), 'btn-primary hide-mobile', 'add', 'data-act="new"')}
    </div>
  </div>`;
}

/* ───────────── КАНБАН ───────────── */
function kcard(c, st) {
  const queue = !c.r;
  return `<article class="kcard ${queue ? 'is-queue' : ''} ${c.rot ? 'is-rot' : ''}" data-id="${c.id}" data-stage="${st.id}" tabindex="0" aria-label="${esc(c.t)}">
    <div class="kc-title">${esc(c.t)}</div>
    <div class="kc-meta">${queue ? `${ic('groups')}${t('queue')} · ` : ''}${esc(c.c === c.t ? ['AI-контент PRO', 'AI-контент BASE', 'AI для бізнесу', 'AI-дизайн'][c.id % 4] : c.c)}</div>
    <div class="kc-row">
      <span class="kc-amt num ${c.a ? '' : 'is-zero'}">${c.a ? money(c.a, c.cur) : 'Без суми'}</span>
      ${avatar(c.r)}
    </div>
    <div class="kc-foot">
      ${c.rot ? `<span class="rot">${ic('hourglass_bottom')}Без руху ${c.rot} дн.</span>` : taskInd(c.task)}
      ${queue ? `<button class="btn btn-tonal btn-sm" data-act="take" data-id="${c.id}">${t('take')}</button>` : ''}
    </div>
  </article>`;
}

function column(st, i, empty) {
  const cards = empty ? [] : (S.cards[st.id] || []);
  const count = empty ? 0 : st.count;
  const uah = empty ? 0 : toUAH(st.sums);
  const curs = empty ? [] : Object.entries(st.sums);
  const hidden = count - cards.length;
  return `<section class="col ${i === S.mobStage ? 'is-mob' : ''}" data-col="${st.id}" style="${sv(st)}" aria-label="${esc(st.name)}">
    <header class="col-h">
      <div class="col-name"><h2 class="t-tm" title="${esc(st.name)}">${esc(st.name)}</h2><span class="count t-ls">${fmt(count)}</span></div>
      <div class="col-sum t-tl">${uah ? '≈ ' + compactUAH(uah) : '0 ₴'}</div>
      <div class="col-cur t-lm">${curs.length ? curs.map(([c, v]) => `<span>${money(v, c)}</span>`).join('') : '<span class="muted">—</span>'}</div>
    </header>
    <div class="col-body">
      ${cards.map(c => kcard(c, st)).join('')}
      ${empty && i === 0 ? `<div class="col-empty">
          <span class="state-ic sm">${ic('inbox')}</span>
          <p class="t-ll">Угод поки немає</p>
          <p class="t-bm muted">Нові угоди зʼявляться тут, щойно прийде реєстрація із сайту, або створіть угоду вручну.</p>
          ${btn(t('newDeal'), 'btn-primary btn-sm', 'add')}
        </div>` : ''}
      ${empty && i > 0 ? `<div class="col-drop-hint t-bm">Перетягніть сюди угоду</div>` : ''}
      ${!empty && hidden > 0 ? `<a href="#" class="more t-ll" data-go="list">ще ${fmt(hidden)} — відкрити списком ${ic('arrow_forward')}</a>` : ''}
    </div>
  </section>`;
}

function kanbanSkeleton() {
  return STG().slice(0, 6).map((st, i) => `<section class="col is-sk ${i === 0 ? 'is-mob' : ''}" style="${sv(st)}">
    <header class="col-h">${sk('60%', 16)}${sk('45%', 22)}${sk('70%', 10)}</header>
    <div class="col-body">${[0, 1, 2].slice(0, 3 - (i % 2)).map(() => `<div class="kcard sk-card">${sk('80%', 14)}${sk('55%', 10)}<div class="kc-row">${sk('35%', 14)}${sk('24px', 24, 99)}</div>${sk('50%', 10)}</div>`).join('')}</div>
  </section>`).join('');
}

function kanban() {
  const st = S.st, stages = STG();
  const totalCount = stages.reduce((a, s) => a + s.count, 0);
  const totalUAH = stages.reduce((a, s) => a + toUAH(s.sums), 0);
  const queueN = Object.values(S.cards).flat().filter(c => !c.r).length;
  let body;
  if (st === 'error') body = stateError('угоди');
  else if (st === 'forbidden') body = stateForbidden('Угоди');
  else {
    const empty = st === 'empty';
    const tabs = `<div class="stabs" role="tablist" aria-label="Етапи">${stages.map((s, i) =>
      `<button class="stab" role="tab" aria-selected="${i === S.mobStage}" data-mob="${i}" style="${sv(s)}"><i class="dot"></i><span>${esc(s.name)}</span><span class="t-ls count">${empty ? 0 : fmt(s.count)}</span></button>`).join('')}</div>`;
    body = `
      <div class="filterbar">
        <div class="chips">
          <button class="chip" aria-pressed="false">${ic('person')}${t('mine')}</button>
          <button class="chip" aria-pressed="false">${ic('groups')}${t('noOwner')}<span class="chip-n">${empty ? 0 : queueN}</span></button>
          <button class="chip" aria-pressed="false">${t('overdue')}<span class="chip-n">${empty ? 0 : 146}</span></button>
          <button class="chip" aria-pressed="false">${t('today')}</button>
          <button class="chip chip-add">${ic('add')}${t('filter')}</button>
        </div>
        <p class="totals t-bm"><span class="muted">${t('total')}</span> ${st === 'loading' ? sk('140px', 14) : `<b class="num">${fmt(empty ? 0 : totalCount)}</b> <span class="muted">·</span> <b class="num">≈ ${compactUAH(empty ? 0 : totalUAH)}</b>`}
          <span class="muted rate">курс НБУ на ${TODAY}: 1 € = 48,12 ₴ · 1 $ = 41,62 ₴</span></p>
      </div>
      ${tabs}
      <div class="board ${st === 'loading' ? 'is-loading' : ''}" id="board" aria-busy="${st === 'loading'}">
        ${st === 'loading' ? kanbanSkeleton() : stages.map((s, i) => column(s, i, empty)).join('')}
      </div>
      <div class="dropzones" aria-hidden="true">
        <div class="dz dz-won" data-dz="won">${ic('check_circle', 'ms-fill')}<span>${t('won')}</span></div>
        <div class="dz dz-lost" data-dz="lost">${ic('cancel', 'ms-fill')}<span>${t('lost')}</span></div>
      </div>
      <button class="fab only-mobile" data-act="new">${ic('add')}<span>${t('newDeal')}</span></button>`;
  }
  return `<section class="page page-kanban">${dealsHead('kanban')}${body}</section>`;
}

/* ───────────── КАРТКА УГОДИ ───────────── */
function currentDeal() {
  const d = JSON.parse(JSON.stringify(DEAL));
  if (S.dealCard) {
    const c = S.dealCard;
    const si = STG().findIndex(s => s.id === c.stage);
    Object.assign(d, { id: c.id, title: c.t, amount: c.a, cur: c.cur, r: c.r, stage: si < 0 ? d.stage : si });
    d.contact.n = c.c.includes('·') ? c.t : c.c;
  }
  return d;
}

function path(d, stages) {
  const won = S.deal.status === 'won', lost = S.deal.status === 'lost';
  return `<ol class="path ${won ? 'is-won' : ''} ${lost ? 'is-lost' : ''}" aria-label="Шлях етапів">
    ${stages.map((s, i) => {
      const cls = i < d.stage ? 'is-complete' : i === d.stage ? 'is-current' : 'is-incomplete';
      return `<li class="ps ${cls}" style="${sv(s)};--i:${i}" ${i === d.stage ? 'aria-current="step"' : ''} title="${esc(s.name)}">
        <span class="ps-in">${i < d.stage || won ? ic('check', 'ps-check') : ''}<span class="ps-l">${esc(s.name)}</span></span></li>`;
    }).join('')}
  </ol>`;
}

function dealStatusTag(d, st) {
  if (S.deal.status === 'won') return `<span class="otag otag-won">${ic('check', 'ms-fill')}<span>${t('won')}</span></span>`;
  if (S.deal.status === 'lost') return `<span class="otag otag-lost">${ic('close')}<span>${t('lost')} · ${esc(S.deal.lostReason || 'Дорого')}</span></span>`;
  return `<span class="stag ${S.deal.archived ? 'is-hollow' : ''}" style="${sv(st)}"><i class="dot"></i>${S.deal.archived ? t('inArchive') : t('open')} · ${esc(st.name)}</span>`;
}

function dealSkeleton() {
  return `<div class="deal-head blk">${sk('40%', 26)}<div style="height:10px"></div>${sk('25%', 12)}<div style="height:20px"></div>${sk('100%', 48, 24)}</div>
  <div class="deal-grid"><div class="deal-side">${[0, 1, 2].map(() => `<div class="blk">${sk('30%', 16)}<div style="height:12px"></div>${sk('90%')}<div style="height:8px"></div>${sk('70%')}<div style="height:8px"></div>${sk('80%')}</div>`).join('')}</div>
  <div class="deal-main">${[0, 1, 2, 3].map(() => `<div class="blk">${sk('20%', 14)}<div style="height:12px"></div>${sk('95%')}<div style="height:8px"></div>${sk('60%')}</div>`).join('')}</div></div>`;
}

function deal() {
  const st = S.st;
  if (st === 'error') return `<section class="page">${crumbs()}${stateError('угоду #4517')}</section>`;
  if (st === 'forbidden') return `<section class="page">${crumbs()}${stateForbidden('Угода #4517')}</section>`;
  if (st === 'loading') return `<section class="page page-deal" aria-busy="true">${crumbs()}${dealSkeleton()}</section>`;
  const empty = st === 'empty';
  const d = currentDeal(), stages = STG(), cur = stages[d.stage];
  const amount = S.deal.amount;
  const psum = d.products.reduce((a, p) => a + p.q * p.p, 0);
  const paid = empty ? 0 : d.paid;
  const closed = S.deal.status !== 'open';
  const head = `
  <header class="deal-head blk">
    <div class="dh-top">
      <div class="dh-title">
        <h1 class="t-hs">${esc(d.title)}</h1>
        <div class="dh-tags">
          <span id="dstatus">${dealStatusTag(d, cur)}</span>
          ${closed ? '' : (empty ? taskInd(['none']) : taskInd([d.next.k, d.next.when]))}
          <span class="dh-owner">${avatar(d.r, 24)}<span class="t-bm">${esc(USERS[d.r || 'ok'].n)}</span></span>
          <span class="t-bm muted">#${d.id} · створено ${d.created} · ${esc(d.source)}</span>
        </div>
      </div>
      <div class="dh-money">
        <div class="t-lm muted">${t('amount')}</div>
        <div class="dh-amt num" id="damt">${money(amount, d.cur)}</div>
        <div class="paid"><span class="bar"><i style="width:${amount ? Math.min(100, paid / amount * 100) : 0}%"></i></span><span class="t-lm muted">Сплачено <b class="num">${money(paid, d.cur)}</b> з ${money(amount, d.cur)}</span></div>
      </div>
      <div class="path-actions">
        ${closed
          ? btn(t('reopen'), 'btn-outline', 'undo', 'data-act="reopen"')
          : btn(t('won'), 'btn-won', 'check', 'data-act="win"') + btn(t('lost'), 'btn-lost', 'close', 'data-act="lose"')}
        ${iconBtn('inventory_2', t('archive'), 'data-act="archive"', 'ibtn-outline')}
        ${iconBtn('more_vert', 'Ще дії')}
      </div>
    </div>
    <div class="path-row">${path(d, stages)}</div>
  </header>`;

  const contact = `
  <section class="blk">
    <div class="blk-h"><h2 class="t-tm">${t('contact')}</h2>${iconBtn('edit', 'Змінити')}</div>
    <div class="contact">
      <span class="av av-48">${d.contact.n.split(' ').map(x => x[0]).join('').slice(0, 2)}</span>
      <div><div class="t-ll">${esc(d.contact.n)}</div><div class="t-lm muted">${esc(d.contact.city)} · клієнт з 14.09.2026</div></div>
    </div>
    <ul class="kv">
      <li>${ic('call')}<a href="#" class="t-bm">${d.contact.phone}</a>${iconBtn('phone_in_talk', 'Подзвонити через Ringostat', '', 'ibtn-sm')}</li>
      <li>${ic('mail')}<a href="#" class="t-bm">${d.contact.email}</a></li>
      <li>${ic('send')}<span class="t-bm">${d.contact.tg}</span></li>
    </ul>
    <div class="notice">${ic('person_search')}<div class="t-bm"><b>Можливий дубль.</b> Телефон збігається з контактом «Ірина Мельник» (email інший). <a href="#">Порівняти і злити</a></div></div>
    <div class="parts"><div class="t-lm muted">Учасники</div>${d.participants.map(p => `<div class="part"><span class="av av-24">${p.n.split(' ').map(x => x[0]).join('')}</span><span class="t-bm">${esc(p.n)}</span><span class="chip-static t-lm">${esc(p.role)}</span></div>`).join('')}
      <button class="btn btn-text btn-sm">${ic('add')}<span>Учасник</span></button></div>
  </section>`;

  const products = `
  <section class="blk">
    <div class="blk-h"><h2 class="t-tm">${t('products')}</h2>${btn('Товар', 'btn-text btn-sm', 'add')}</div>
    ${empty ? `<p class="t-bm muted empty-line">${ic('inventory_2')}Товарів немає. Додайте пакет із каталогу проєкту.</p>` : `
    <table class="ptable">
      <thead><tr><th>Товар</th><th class="r">К-сть</th><th class="r">Ціна</th><th class="r">Сума</th></tr></thead>
      <tbody>${d.products.map(p => `<tr><td>${esc(p.n)}</td><td class="r num">${p.q}</td><td class="r num">${money(p.p, d.cur)}</td><td class="r num">${money(p.q * p.p, d.cur)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">Сума по товарах</td><td class="r num">${money(psum, d.cur)}</td></tr></tfoot>
    </table>
    ${psum !== amount ? `<div class="mismatch" id="mismatch">
      <span class="t-bm">Сума угоди <b class="num">${money(amount, d.cur)}</b> не збігається із сумою по товарах.</span>
      ${btn(`Підставити ${money(psum, d.cur)}`, 'btn-tonal btn-sm', 'south_west', `data-act="apply-sum" data-v="${psum}"`)}
    </div>` : `<p class="t-lm muted ok-line">${ic('check')}Сума угоди дорівнює сумі по товарах</p>`}`}
  </section>`;

  const payments = `
  <section class="blk">
    <div class="blk-h"><h2 class="t-tm">${t('payments')} <span class="t-lm muted">WayForPay</span></h2>${btn('Виставити рахунок', 'btn-outline btn-sm', 'receipt_long')}</div>
    ${empty ? `<p class="t-bm muted empty-line">${ic('payments')}Платежів ще немає.</p>` : `<ul class="pays">${d.payments.map(p => `<li>
      <span class="pay-ic ${p.st === 'Сплачено' ? 'is-paid' : ''}">${ic(p.st === 'Сплачено' ? 'check' : 'schedule')}</span>
      <div><div class="t-ll">${esc(p.n)}</div><div class="t-lm muted">${p.st} · ${p.d}${p.uah ? ` · списано ${fmt(p.uah)} ₴` : ''}</div></div>
      <span class="num t-ll">${money(p.a, d.cur)}</span></li>`).join('')}</ul>`}
  </section>`;

  const fields = `
  <section class="blk">
    <div class="blk-h"><h2 class="t-tm">${t('fields')}</h2><span class="t-lm muted">Продаж · 4 з 4</span></div>
    <dl class="fields">${d.fields.map(([k, v]) => `<div><dt class="t-lm muted">${k}</dt><dd class="t-bm">${empty ? '<span class="muted">—</span>' : esc(v)}</dd></div>`).join('')}</dl>
  </section>`;

  const regs = `
  <section class="blk">
    <div class="blk-h"><h2 class="t-tm">${t('regs')} <span class="count t-ls">${empty ? 0 : d.registrations.length}</span></h2></div>
    ${empty ? `<p class="t-bm muted empty-line">${ic('how_to_reg')}Угоду створено вручну — реєстрацій немає.</p>` : `<ul class="regs">${d.registrations.map((r, i) => `<li class="reg">
      <div class="reg-h"><span class="t-ll">${esc(r.what)}</span><span class="t-lm muted">${r.d}</span></div>
      <dl class="reg-d t-lm">
        <div><dt>Джерело</dt><dd>${esc(r.src)}</dd></div><div><dt>utm_campaign</dt><dd>${esc(r.camp)}</dd></div>
        <div><dt>utm_content</dt><dd>${esc(r.content)}</dd></div><div><dt>Клік</dt><dd>${esc(r.click)}</dd></div>
        <div class="wide"><dt>Сторінка</dt><dd>${esc(r.page)}</dd></div>
      </dl>
      ${r.watch ? `<div class="watch"><span class="bar"><i style="width:${r.watch[0] / r.watch[1] * 100}%"></i></span><span class="t-lm muted">Дивилась ${r.watch[0]} з ${r.watch[1]} хв</span></div>` : ''}
    </li>`).join('')}</ul>`}
  </section>`;

  const next = `
  <section class="blk next ${empty ? 'is-none' : ''}">
    <div class="blk-h"><h2 class="t-tm">${t('next')}</h2>${btn('Нова задача', 'btn-tonal btn-sm', 'add_task')}</div>
    ${empty ? `<div class="next-row"><span class="next-ic">${ic('event_busy')}</span><div><div class="t-ll">Задачі немає</div><div class="t-bm muted">Угода без наступного кроку «гниє». Заплануйте дзвінок або зустріч.</div></div></div>` :
    `<div class="next-row"><span class="next-ic">${ic('call', 'ms-fill')}</span>
      <div class="grow"><div class="t-ll">${d.next.type}: ${esc(d.next.text)}</div><div class="t-bm muted">${esc(USERS.ok.n)} · ${taskInd([d.next.k, d.next.when])}</div></div>
      ${btn('Виконано', 'btn-outline btn-sm', 'check')}</div>`}
  </section>`;

  const TL_IC = { note: 'sticky_note_2', call: 'call', stage: 'swap_horiz', pay: 'payments', reg: 'how_to_reg' };
  const TL_N = { note: 'Нотатка', call: 'Дзвінок', stage: 'Зміна етапу', pay: 'Платіж отримано', reg: 'Реєстрація' };
  const items = (empty ? [] : d.timeline).filter(x => S.tl === 'all' || x.k === S.tl);
  const tl = `
  <section class="blk tl-blk">
    <div class="blk-h"><h2 class="t-tm">${t('timeline')}</h2></div>
    <div class="composer">
      <div class="ctabs" role="tablist">${[['note', 'Нотатка', 'sticky_note_2'], ['task', 'Задача', 'add_task'], ['call', 'Дзвінок', 'call'], ['file', 'Файл', 'attach_file']].map(([k, l, i], n) =>
        `<button role="tab" aria-selected="${n === 0}">${ic(i, n === 0 ? 'ms-fill' : '')}${l}</button>`).join('')}</div>
      <textarea rows="2" class="t-bl" placeholder="Напишіть нотатку: що домовились, що далі…"></textarea>
      <div class="composer-f"><span class="t-lm muted">@ — згадати колегу</span>${btn(t('save'), 'btn-primary btn-sm')}</div>
    </div>
    <div class="chips tl-filter">${[['all', 'Усі'], ['note', 'Нотатки'], ['call', 'Дзвінки'], ['pay', 'Платежі'], ['stage', 'Етапи'], ['reg', 'Реєстрації']].map(([k, l]) =>
      `<button class="chip" data-tl="${k}" aria-pressed="${S.tl === k}">${S.tl === k ? ic('check', 'ms-fill') : ''}${l}</button>`).join('')}</div>
    ${items.length ? `<ol class="tl">${items.map(x => `<li class="tl-i tl-${x.k}">
      <span class="tl-ic">${ic(TL_IC[x.k])}</span>
      <div class="tl-b">
        <div class="tl-h t-bm"><b>${TL_N[x.k]}</b><span class="muted">${esc(x.who)} · ${x.at}</span></div>
        ${x.k === 'note' ? `<div class="tl-card note t-bl">${esc(x.text)}</div>` : ''}
        ${x.k === 'call' ? `<div class="tl-card"><div class="t-lm muted">${x.dir} · Ringostat · ${x.dur}</div>
            <div class="player"><button class="play" aria-label="Слухати запис">${ic('play_arrow', 'ms-fill')}</button><span class="wave">${Array.from({ length: 48 }, (_, i) => `<i style="height:${6 + Math.round(Math.abs(Math.sin(i * 1.7) * 14 + Math.cos(i * .6) * 6))}px"></i>`).join('')}</span><span class="t-lm num">0:00 / ${x.dur}</span></div>
            <div class="t-bm">${esc(x.text)}</div></div>` : ''}
        ${x.k === 'stage' ? `<div class="tl-stage">${stageTag(stages[x.from])}${ic('arrow_forward', 'muted')}${stageTag(stages[x.to])}</div>` : ''}
        ${x.k === 'pay' ? `<div class="tl-card pay"><span class="num t-tl">300 €</span><span class="t-bm muted">${esc(x.text)}</span></div>` : ''}
        ${x.k === 'reg' ? `<div class="t-bm">${esc(x.text)}</div>` : ''}
      </div></li>`).join('')}</ol>` : `<div class="tl-empty">${ic('history')}<p class="t-ll">Подій ще немає</p><p class="t-bm muted">Додайте нотатку або заплануйте задачу — вони зʼявляться тут.</p></div>`}
  </section>`;

  return `<section class="page page-deal">${crumbs()}${head}
    <div class="deal-grid">
      <div class="deal-side">${contact}${products}${payments}${fields}${regs}</div>
      <div class="deal-main">${next}${tl}</div>
    </div></section>`;
}
function crumbs() {
  return `<nav class="crumbs t-bm" aria-label="Шлях">
    <a href="#" data-go="kanban" class="crumb-back">${ic('arrow_back')}<span>${t('back')}</span></a>
    <span class="muted">/</span><span class="muted">${esc(P().pipeline)}</span></nav>`;
}

/* ───────────── СПИСОК ───────────── */
function listRows() {
  const stages = STG(), rows = [];
  stages.forEach((s, si) => (S.cards[s.id] || []).forEach(c => rows.push({ ...c, si })));
  return rows.sort((a, b) => b.id - a.id);
}
function list() {
  const st = S.st;
  const stages = STG();
  let body;
  if (st === 'error') body = stateError('список угод');
  else if (st === 'forbidden') body = stateForbidden('Список угод');
  else {
    const rows = st === 'empty' ? [] : listRows();
    const total = stages.reduce((a, s) => a + s.count, 0);
    const n = S.sel.size;
    const allOn = rows.length && rows.every(r => S.sel.has(r.id));
    body = `
    <div class="filterbar list-filters">
      <div class="chips">
        <span class="t-lm muted chips-l">Збережені</span>
        <button class="chip" aria-pressed="true">${ic('check', 'ms-fill')}Усі відкриті</button>
        <button class="chip" aria-pressed="false">Мої прострочені</button>
        <button class="chip" aria-pressed="false">Без задач</button>
        <button class="chip" aria-pressed="false">Новий лід старше 60 днів</button>
        <button class="chip" aria-pressed="false">${ic('groups')}Для команди</button>
      </div>
      <div class="chips conds">
        <span class="cond">${ic('filter_alt')}Статус: <b>відкрита</b>${iconBtn('close', 'Прибрати умову', '', 'ibtn-xs')}</span>
        <span class="cond">Архів: <b>ні</b>${iconBtn('close', 'Прибрати умову', '', 'ibtn-xs')}</span>
        <span class="cond">${st === 'empty' ? 'Джерело: <b>TikTok</b>' : 'Відповідальний: <b>будь-хто</b>'}${iconBtn('close', 'Прибрати умову', '', 'ibtn-xs')}</span>
        <button class="chip chip-add">${ic('add')}Умова</button>
        <span class="grow"></span>
        <span class="t-bm muted">${st === 'empty' ? '0 угод' : `≈ ${fmt(total)} угод`}</span>
        ${btn('CSV', 'btn-text btn-sm', 'download')}
        ${iconBtn('view_column', 'Колонки')}
      </div>
    </div>
    <div class="bulk ${n ? 'is-on' : ''}" role="region" aria-label="Масові дії">
      ${iconBtn('close', 'Зняти вибір', 'data-act="unsel"')}
      <span class="t-ll">Обрано ${n}</span>
      <a href="#" class="t-ll link">Вибрати всі ≈ ${fmt(total)} за фільтром</a>
      <span class="grow"></span>
      ${btn('Архівувати', 'btn-text', 'inventory_2', 'data-act="bulk-archive"')}
      ${btn('Передати', 'btn-text', 'swap_horiz')}
      ${btn('Змінити етап', 'btn-text', 'move_down')}
      ${btn('Видалити', 'btn-text btn-danger', 'delete')}
    </div>
    ${st === 'empty' ? `<div class="state-panel">${'<span class="state-ic">' + ic('search_off') + '</span>'}<h2 class="t-hs">Угод за цим фільтром немає</h2><p class="t-bl muted">Умова «Джерело: TikTok» нічого не знаходить у воронці ${esc(P().pipeline)}.</p><div class="state-act">${btn('Скинути фільтр', 'btn-tonal', 'filter_alt_off')}</div></div>` : `
    <div class="tablewrap">
      <table class="dtable" aria-busy="${st === 'loading'}">
        <thead><tr>
          <th class="cb"><label class="check"><input type="checkbox" data-act="selall" ${allOn ? 'checked' : ''} ${n && !allOn ? 'data-indet="1"' : ''} aria-label="Вибрати все"><span></span></label></th>
          <th>Угода</th><th class="hide-m">Контакт</th><th class="hide-m">Етап</th><th class="r">Сума ${ic('arrow_downward', 'sort')}</th><th class="hide-m">Відповідальний</th><th class="hide-m">Наступна задача</th><th class="hide-m">Створено</th>
        </tr></thead>
        <tbody>${st === 'loading' ? Array.from({ length: 10 }, () => `<tr class="sk-row"><td class="cb">${sk('18px', 18, 4)}</td><td>${sk('70%')}</td><td class="hide-m">${sk('60%')}</td><td class="hide-m">${sk('80%')}</td><td class="r">${sk('50%')}</td><td class="hide-m">${sk('70%')}</td><td class="hide-m">${sk('60%')}</td><td class="hide-m">${sk('50%')}</td></tr>`).join('') :
        rows.map(r => {
          const s = stages[r.si];
          const on = S.sel.has(r.id);
          return `<tr class="${on ? 'is-sel' : ''}" data-row="${r.id}">
            <td class="cb"><label class="check"><input type="checkbox" data-sel="${r.id}" ${on ? 'checked' : ''} aria-label="Вибрати ${esc(r.t)}"><span></span></label></td>
            <td class="title-cell"><a href="#" class="row-title" data-open="${r.id}" style="${sv(s)}"><i class="dot"></i><span>${esc(r.t)}</span></a><span class="t-lm muted rid">#${r.id}</span><span class="m-stage">${stageTag(s)}</span></td>
            <td class="hide-m t-bm">+380 00 ${String(r.id * 7).slice(-3)} ${String(r.id).slice(-2)} ${String(r.id * 3).slice(-2)}</td>
            <td class="hide-m">${stageTag(s)}</td>
            <td class="r num">${r.a ? money(r.a, r.cur) : '<span class="muted">—</span>'}</td>
            <td class="hide-m"><span class="owner">${avatar(r.r)}<span class="t-bm">${r.r ? esc(USERS[r.r].n) : `<span class="muted">${t('queue')}</span>`}</span></span></td>
            <td class="hide-m">${r.rot ? `<span class="rot">${ic('hourglass_bottom')}Без руху ${r.rot} дн.</span>` : taskInd(r.task)}</td>
            <td class="hide-m t-bm muted">${['04.11', '03.11', '02.11', '30.10', '28.10', '21.10', '14.10'][r.id % 7]}.2026</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      <div class="tfoot t-bm muted">Показано ${st === 'loading' ? '…' : rows.length} з ≈ ${fmt(total)} · підвантаження під час прокрутки</div>
    </div>`}`;
  }
  return `<section class="page page-list">${dealsHead('list')}${body}</section>`;
}

/* ───────────── НАЛАШТУВАННЯ → РОЛІ ───────────── */
function roles() {
  const st = S.st;
  const SNAV = [['Воронки та етапи', 'view_kanban'], ['Поля', 'tune'], ['Ролі та користувачі', 'admin_panel_settings'], ['Товари', 'inventory_2'], ['Причини програшу', 'heart_broken'], ['Типи задач', 'checklist'], ['Інтеграції', 'hub'], ['Кошик', 'delete']];
  const snav = `<nav class="snav" aria-label="Налаштування">${SNAV.map(([n, i]) => `<a href="#" class="snav-i ${n === 'Ролі та користувачі' ? 'is-on' : ''}">${ic(i, n === 'Ролі та користувачі' ? 'ms-fill' : '')}<span class="t-ll">${n}</span></a>`).join('')}</nav>`;
  let body;
  if (st === 'error') body = stateError('ролі');
  else if (st === 'forbidden') body = stateForbidden('Налаштування');
  else {
    const empty = st === 'empty';
    const role = empty ? 'Стажер' : S.role;
    const scopeSeg = (val, label) => `<div class="scope" role="radiogroup" aria-label="${label}">${[['own', 'Свої'], ['team', 'Команда'], ['all', 'Усі']].map(([k, l]) =>
      `<button role="radio" aria-checked="${val === k}">${val === k ? ic('check') : ''}${l}</button>`).join('')}</div>`;
    const tabsRoles = [...ROLES, ...(empty ? ['Стажер'] : [])];
    body = `
    <div class="roles-head">
      <div><h1 class="t-hs">${t('roles')}</h1><p class="t-bm muted">Права діють лише в проєкті ${esc(P().code)}. В іншому проєкті в людини може бути інша роль.</p></div>
    </div>
    <div class="ctabs underline" role="tablist"><button role="tab" aria-selected="true">Ролі</button><button role="tab" aria-selected="false">Користувачі <span class="count t-ls">14</span></button><button role="tab" aria-selected="false">Команди</button></div>
    <div class="chips role-chips">${tabsRoles.map(r => `<button class="chip" data-role="${r}" aria-pressed="${r === role}">${r === role ? ic('check', 'ms-fill') : ''}${r}<span class="chip-n">${ROLE_USERS[r] ?? 0}</span></button>`).join('')}
      <button class="chip chip-add" data-act="newrole">${ic('add')}Нова роль</button></div>
    <section class="blk role-card" aria-busy="${st === 'loading'}">
      <div class="blk-h role-h">
        <div><h2 class="t-tm">${role}</h2><p class="t-lm muted">${empty ? 'Нова роль · копія без прав · користувачів немає' : `Шаблон проєкту · ${ROLE_USERS[role]} користувачів`}</p></div>
        <div class="role-act">${btn('Копіювати', 'btn-text btn-sm', 'content_copy')}${empty ? btn('Видалити', 'btn-text btn-sm btn-danger', 'delete', 'data-act="delrole"') : ''}${btn(t('save'), 'btn-primary btn-sm', 'check')}</div>
      </div>
      ${empty ? `<div class="notice">${ic('info')}<div class="t-bm">У ролі «Стажер» ще немає жодного права. Людина з нею побачить лише порожню панель — увімкніть хоча б «Угоди: перегляд».</div></div>` : ''}
      <div class="tablewrap">
      <table class="matrix">
        <thead><tr><th>Частина системи</th><th>Перегляд</th><th>Створення</th><th>Зміна</th><th>Видалення</th><th>Охват: бачить</th><th>Охват: змінює</th></tr></thead>
        <tbody>${PERM_ROWS.map(row => {
          const p = empty ? [0, 0, 0, 0] : row.p[role];
          const sc = empty ? ['own', 'own'] : SCOPE[role];
          return `<tr><th scope="row"><span class="res">${ic(row.ic)}<span class="t-bm">${row.n}</span></span></th>
            ${p.map((v, i) => `<td class="c">${st === 'loading' ? sk('18px', 18, 4) : `<label class="check"><input type="checkbox" ${v ? 'checked' : ''} aria-label="${row.n}: ${['перегляд', 'створення', 'зміна', 'видалення'][i]}"><span></span></label>`}</td>`).join('')}
            <td>${row.scope ? (st === 'loading' ? sk('150px', 28, 99) : scopeSeg(sc[0], 'Бачить')) : '<span class="muted t-lm">—</span>'}</td>
            <td>${row.scope ? (st === 'loading' ? sk('150px', 28, 99) : scopeSeg(sc[1], 'Змінює')) : '<span class="muted t-lm">—</span>'}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <h3 class="t-tm sub-h">Окремі права</h3>
      <ul class="extras">${EXTRA.map(x => `<li><div><div class="t-ll">${x.n}</div><div class="t-lm muted">${x.d}</div></div>
        <label class="switch"><input type="checkbox" role="switch" ${!empty && x.on[role] ? 'checked' : ''} aria-label="${x.n}"><span></span></label></li>`).join('')}</ul>
    </section>`;
  }
  return `<section class="page page-roles"><div class="settings">${snav}<div class="settings-body">${body}</div></div></section>`;
}

/* ───────────── ВХІД ───────────── */
function signin() {
  const st = S.st;
  const bad = st === 'validation';
  const code = bad ? ['4', '8', '1', '9', '0', '2'] : ['3', '7', '0', '', '', ''];
  return `<div class="signin">
    <div class="si-top">
      <a class="brand" href="#">${logo}<span class="brand-name">Alpi CRM</span></a>
      <div class="lang seg-mini"><button data-lang="uk" aria-pressed="${S.lang === 'uk'}">UK</button><button data-lang="ru" aria-pressed="${S.lang === 'ru'}">RU</button></div>
    </div>
    <main class="si-card" aria-labelledby="si-h">
      <p class="t-lm muted step">Крок 2 з 2 · двофакторна перевірка</p>
      <h1 id="si-h" class="t-hs">Вхід до Alpi CRM</h1>
      ${st === 'error' ? `<div class="banner banner-err" role="alert">${ic('cloud_off')}<span class="t-bm">Сервер недоступний. Спробуйте ще раз за хвилину — введений код не згорить.</span></div>` : ''}
      <div class="si-user">${avatar(ME, 32)}<div class="grow"><div class="t-ll">Олена Коваль</div><div class="t-lm muted">olena.koval@example.com</div></div><a href="#" class="t-ll link">Змінити</a></div>
      <label class="t-ll" for="otp0">Код із застосунку автентифікації</label>
      <p class="t-bm muted">Відкрийте Google Authenticator, 1Password або інший застосунок і введіть 6 цифр для «Alpi CRM».</p>
      <div class="otp ${bad ? 'is-err' : ''}" role="group" aria-label="Код з 6 цифр">
        ${code.map((v, i) => `<input id="otp${i}" class="num" inputmode="numeric" maxlength="1" value="${v}" aria-label="Цифра ${i + 1}" ${bad ? 'aria-invalid="true"' : ''} ${i === 3 && !bad ? 'data-focus' : ''}>`).join('')}
      </div>
      ${bad ? `<p class="field-err t-bm" role="alert">${ic('error', 'ms-fill')}Код не підходить. Перевірте час на телефоні. Залишилось 4 спроби, потім вхід блокується на 15 хвилин.</p>` : `<p class="t-lm muted">Код оновлюється кожні 30 секунд.</p>`}
      <button class="btn btn-primary btn-block ${st === 'loading' ? 'is-loading' : ''}" ${st === 'loading' ? 'aria-busy="true"' : ''}>${st === 'loading' ? '<span class="spinner"></span><span>Перевіряємо…</span>' : `<span>${t('signin')}</span>`}</button>
      <div class="si-links"><a href="#" class="t-ll link">Використати код відновлення</a><a href="#" class="t-ll link">Назад до пароля</a></div>
    </main>
    <p class="t-lm muted si-foot">Своєї реєстрації немає: обліковий запис створює адміністратор. Загубили телефон — напишіть адміністратору проєкту.</p>
  </div>`;
}

/* ───────────── оверлеї: діалоги, листи, меню ───────────── */
const overlay = () => $('#overlay');
function closeOverlay() {
  const o = overlay();
  const box = o.firstElementChild;
  if (!box) return;
  o.classList.add('is-leaving');
  setTimeout(() => { o.innerHTML = ''; o.className = ''; }, reduced() ? 0 : 200);
}
function dialog(html, cls = '') {
  const o = overlay();
  o.className = 'is-open';
  o.innerHTML = `<div class="scrim" data-close></div><div class="dialog ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  setTimeout(() => $('.dialog [autofocus], .dialog select, .dialog button', o)?.focus(), 50);
}
function lostDialog(title, withError, onOk) {
  dialog(`<span class="dlg-ic lost">${ic('cancel', 'ms-fill')}</span>
    <h2 class="t-hs">Позначити угоду програною?</h2>
    <p class="t-bm muted">«${esc(title)}». Причина обовʼязкова — вона потрапить у звіт «Чому програємо».</p>
    <div class="field ${withError ? 'is-err' : ''}"><label class="t-lm" for="lg">Група причин</label>
      <select id="lg"><option value="">Оберіть групу</option>${Object.keys(LOST_REASONS).map(g => `<option>${g}</option>`).join('')}</select>
      ${withError ? `<p class="field-err t-lm">${ic('error', 'ms-fill')}Оберіть групу причин</p>` : ''}</div>
    <div class="field ${withError ? 'is-err' : ''}"><label class="t-lm" for="lr">Причина</label>
      <select id="lr" disabled><option value="">Спершу оберіть групу</option></select>
      ${withError ? `<p class="field-err t-lm">${ic('error', 'ms-fill')}Оберіть причину</p>` : ''}</div>
    <div class="field"><label class="t-lm" for="lc">Коментар (необовʼязково)</label><textarea id="lc" rows="2"></textarea></div>
    <div class="dlg-act">${btn(t('cancel'), 'btn-text', '', 'data-close')}${btn('Позначити програною', 'btn-lost-fill', 'close', 'data-ok')}</div>`);
  const o = overlay();
  $('#lg', o).onchange = e => { const r = $('#lr', o); r.disabled = !e.target.value; r.innerHTML = (LOST_REASONS[e.target.value] || []).map(x => `<option>${x}</option>`).join(''); };
  $('[data-ok]', o).onclick = () => {
    const g = $('#lg', o).value;
    if (!g) { const keep = $('#lc', o).value; lostDialog(title, true, onOk); $('#lc').value = keep; return; }
    onOk($('#lr', o).value); closeOverlay();
  };
}
function requiredSheet(card, stage, withError, onOk, onCancel) {
  dialog(`<div class="sheet-grip"></div>
    <h2 class="t-hs">Заповніть поля для етапу</h2>
    <p class="t-bm">${stageTag(stage)}</p>
    <p class="t-bm muted">Угода «${esc(card.t)}» переходить на етап, де ці поля обовʼязкові. Без них угоду не перемістити.</p>
    <div class="field ${withError ? 'is-err' : ''}"><label class="t-lm" for="rf1">Пакет *</label>
      <select id="rf1" ${withError ? 'aria-invalid="true"' : ''}><option value="">Не вибрано</option><option>BASE</option><option>PRO</option><option>VIP</option></select>
      ${withError ? `<p class="field-err t-lm">${ic('error', 'ms-fill')}Оберіть пакет, який оплачує клієнт</p>` : ''}</div>
    <div class="field ${withError ? 'is-err' : ''}"><label class="t-lm" for="rf2">Тип закриття *</label>
      <select id="rf2" ${withError ? 'aria-invalid="true"' : ''}><option value="">Не вибрано</option><option>Повна оплата</option><option>Розстрочка</option><option>Кредит банку</option></select>
      ${withError ? `<p class="field-err t-lm">${ic('error', 'ms-fill')}Вкажіть, як клієнт платить</p>` : ''}</div>
    <div class="dlg-act">${btn(t('cancel'), 'btn-text', '', 'data-cancel')}${btn('Зберегти і перемістити', 'btn-primary', 'arrow_forward', 'data-ok')}</div>`, 'sheet');
  const o = overlay();
  $('[data-cancel]', o).onclick = () => { closeOverlay(); onCancel && onCancel(); };
  $('.scrim', o).removeAttribute('data-close');
  $('.scrim', o).onclick = () => { closeOverlay(); onCancel && onCancel(); };
  $('[data-ok]', o).onclick = () => {
    if (!$('#rf1', o).value || !$('#rf2', o).value) { requiredSheet(card, stage, true, onOk, onCancel); return; }
    closeOverlay(); onOk();
  };
}
function confirmDialog({ icon, title, text, ok, okCls = 'btn-primary', onOk }) {
  dialog(`<span class="dlg-ic">${ic(icon)}</span><h2 class="t-hs">${title}</h2><p class="t-bm muted">${text}</p>
    <div class="dlg-act">${btn(t('cancel'), 'btn-text', '', 'data-close')}${btn(ok, okCls, '', 'data-ok')}</div>`);
  $('[data-ok]', overlay()).onclick = () => { closeOverlay(); onOk && onOk(); };
}
function newRoleDialog(withError) {
  dialog(`<h2 class="t-hs">Нова роль</h2><p class="t-bm muted">Роль діє лише в проєкті ${esc(P().code)}. Права можна скопіювати з наявної ролі.</p>
    <div class="field ${withError ? 'is-err' : ''}"><label class="t-lm" for="rn">Назва ролі *</label><input id="rn" value="${withError ? '' : ''}" ${withError ? 'aria-invalid="true"' : ''} placeholder="Наприклад, Стажер">
      ${withError ? `<p class="field-err t-lm">${ic('error', 'ms-fill')}Вкажіть назву ролі — від 2 до 40 символів</p>` : ''}</div>
    <div class="field"><label class="t-lm" for="rc">Скопіювати права з</label><select id="rc"><option>Не копіювати — порожня роль</option>${ROLES.map(r => `<option>${r}</option>`).join('')}</select></div>
    <div class="dlg-act">${btn(t('cancel'), 'btn-text', '', 'data-close')}${btn('Створити', 'btn-primary', '', 'data-ok')}</div>`);
  $('[data-ok]', overlay()).onclick = () => { if (!$('#rn').value.trim()) return newRoleDialog(true); closeOverlay(); toast('Роль «' + $('#rn').value + '» створено'); };
}

function menu(anchor, html) {
  const o = overlay();
  o.className = 'is-open is-menu';
  o.innerHTML = `<div class="scrim clear" data-close></div><div class="menu" role="menu">${html}</div>`;
  const m = $('.menu', o), r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  m.style.top = (r.bottom + 6) + 'px';
  m.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + (r.width > 200 ? 0 : r.width - w))) + 'px';
  if (anchor.classList.contains('proj')) m.style.left = Math.max(8, r.left) + 'px';
}
function projMenu(a) {
  menu(a, `<p class="menu-h t-lm muted">Проєкт</p>${Object.entries(PROJECTS).map(([k, p]) => `<button class="menu-i" role="menuitem" data-project="${k}">
    <span class="proj-mark">${k === 'alpi' ? 'A' : 'Ф'}</span><span class="grow"><span class="t-ll">${esc(p.name)}</span><br><span class="t-lm muted">Ваша роль: ${p.role}</span></span>${k === S.project ? ic('check') : ''}</button>`).join('')}
    <p class="menu-note t-lm muted">Дані проєктів не перетинаються: контакт у ALPI і у «Франчі» — два різні записи.</p>`);
}
function notifMenu(a) {
  menu(a, `<div class="menu-hrow"><span class="t-tm">${t('notifs')}</span><a href="#" class="t-lm link">Позначити прочитаними</a></div>
  ${NOTIFS.map(n => `<button class="menu-i notif ${n.unread ? 'is-unread' : ''}" role="menuitem"><span class="n-ic">${ic(n.ic)}</span><span class="grow"><span class="t-ll">${n.t}</span><br><span class="t-bm muted">${n.s}</span></span><span class="t-ls muted">${n.at}</span></button>`).join('')}`);
  $('.menu', overlay()).classList.add('menu-wide');
}
function searchMenu(input) {
  const q = input.value.trim().toLowerCase();
  const all = Object.entries(S.cards).flatMap(([sid, cs]) => cs.map(c => ({ ...c, sid })));
  const hit = q ? all.filter(c => c.t.toLowerCase().includes(q) || c.c.toLowerCase().includes(q)).slice(0, 5) : all.slice(0, 3);
  const stages = STG();
  const anchor = input.closest('.search') || input;
  menu(anchor, `<p class="menu-h t-lm muted">${q ? 'Угоди' : 'Нещодавні'}</p>
    ${hit.length ? hit.map(c => { const s = stages.find(x => x.id === c.sid); return s ? `<button class="menu-i" data-open="${c.id}"><span class="row-title" style="${sv(s)}"><i class="dot"></i></span><span class="grow"><span class="t-ll">${esc(c.t)}</span><br><span class="t-lm muted">${esc(s.name)} · #${c.id}</span></span>${c.a ? `<span class="num t-lm">${money(c.a, c.cur)}</span>` : ''}</button>` : ''; }).join('')
    : `<p class="menu-note t-bm muted">У проєкті ${esc(P().code)} нічого не знайдено. Архівні угоди теж шукаються.</p>`}
    <p class="menu-h t-lm muted">Контакти</p><button class="menu-i"><span class="av av-24">ІМ</span><span class="grow"><span class="t-ll">Ірина Мельник</span><br><span class="t-lm muted">+380 00 123 45 67 · iryna.melnyk@example.com</span></span></button>`);
  const m = $('.menu', overlay()); m.classList.add('menu-search'); m.style.width = Math.max(anchor.offsetWidth, 320) + 'px';
}

/* ───────────── снекбар ───────────── */
let snackTimer;
function toast(text, action, onAction, opts = {}) {
  const el = $('#snack');
  clearTimeout(snackTimer);
  el.innerHTML = `<div class="snack ${opts.progress != null ? 'has-progress' : ''}">${opts.icon ? ic(opts.icon, 'ms-fill') : ''}<span class="t-bm grow">${text}</span>
    ${action ? `<button class="snack-act t-ll">${action}</button>` : ''}${iconBtn('close', 'Закрити', 'data-snack-close', 'ibtn-sm')}
    ${opts.progress != null ? `<span class="snack-bar"><i style="width:${opts.progress}%"></i></span>` : ''}</div>`;
  el.classList.remove('is-on'); void el.offsetWidth; el.classList.add('is-on');
  if (action) $('.snack-act', el).onclick = () => { hideToast(); onAction && onAction(); };
  $('[data-snack-close]', el).onclick = hideToast;
  if (!opts.sticky) snackTimer = setTimeout(hideToast, 6000);
}
function hideToast() { $('#snack').classList.remove('is-on'); }

/* ───────────── перетягування карток ───────────── */
let drag = null;
function findCard(id) {
  for (const [sid, cs] of Object.entries(S.cards)) { const i = cs.findIndex(c => c.id === +id); if (i >= 0) return { sid, i, c: cs[i] }; }
  return null;
}
function adjustAgg(sid, c, sign) {
  const st = STG().find(s => s.id === sid); if (!st) return;
  st.count += sign;
  if (c.a) st.sums[c.cur] = Math.max(0, (st.sums[c.cur] || 0) + sign * c.a);
  if (st.sums[c.cur] === 0) delete st.sums[c.cur];
}
function startDrag(card, x, y) {
  const r = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add('kghost');
  ghost.removeAttribute('tabindex');
  Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
  document.body.append(ghost);
  requestAnimationFrame(() => ghost.classList.add('is-lifted'));
  card.classList.add('is-origin');
  $('.page-kanban')?.classList.add('is-dragging');
  drag = { card, ghost, id: card.dataset.id, from: card.dataset.stage, ox: x - r.left, oy: y - r.top, rect: r, target: null };
}
function moveDrag(x, y) {
  if (!drag) return;
  drag.ghost.style.left = (x - drag.ox) + 'px';
  drag.ghost.style.top = (y - drag.oy) + 'px';
  const el = document.elementFromPoint(x, y);
  $$('.is-over').forEach(n => n.classList.remove('is-over'));
  const dz = el?.closest('.dz'), col = el?.closest('.col'), tab = el?.closest('.stab');
  drag.target = null;
  if (dz) { dz.classList.add('is-over'); drag.target = { dz: dz.dataset.dz }; }
  else if (tab) { tab.classList.add('is-over'); drag.target = { sid: STG()[+tab.dataset.mob].id }; }
  else if (col) { col.classList.add('is-over'); drag.target = { sid: col.dataset.col }; }
  const board = $('#board');
  if (board) {
    const br = board.getBoundingClientRect();
    if (x > br.right - 80) board.scrollLeft += 14; else if (x < br.left + 80) board.scrollLeft -= 14;
  }
}
function springBack() {
  const { ghost, card } = drag; const r = card.getBoundingClientRect();
  ghost.classList.add('is-returning'); ghost.classList.remove('is-lifted');
  ghost.style.left = r.left + 'px'; ghost.style.top = r.top + 'px';
  const done = () => { ghost.remove(); card.classList.remove('is-origin'); };
  reduced() ? done() : setTimeout(done, 300);
}
function finishDrag() {
  $$('.is-over').forEach(n => n.classList.remove('is-over'));
  $('.page-kanban')?.classList.remove('is-dragging');
}
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  finishDrag();
  const found = findCard(d.id); if (!found) { d.ghost.remove(); return; }
  const { c, sid } = found;
  const stages = STG();
  const tg = d.target;
  if (tg && tg.dz === 'won') {
    d.ghost.classList.add('is-gone');
    setTimeout(() => d.ghost.remove(), reduced() ? 0 : 200);
    removeCard(c, sid);
    toast(`«${esc(c.t)}» — ${t('won').toLowerCase()}. Подію записано у стрічку угоди.`, t('cancel'), () => { restoreCard(c, sid); }, { icon: 'check_circle' });
    return;
  }
  if (tg && tg.dz === 'lost') {
    drag = d; springBack(); drag = null;
    lostDialog(c.t, false, reason => { removeCard(c, sid); toast(`«${esc(c.t)}» — ${t('lost').toLowerCase()}: ${esc(reason)}`, t('cancel'), () => restoreCard(c, sid)); });
    return;
  }
  if (tg && tg.sid && tg.sid !== sid) {
    const to = stages.find(s => s.id === tg.sid);
    const go = () => moveCard(c, sid, tg.sid, d.ghost);
    if (to.required && !c.filled) {
      drag = d; springBack(); drag = null;
      requiredSheet(c, to, false, () => { c.filled = true; moveCard(c, sid, tg.sid, null); });
      return;
    }
    go(); return;
  }
  drag = d; springBack(); drag = null;
}
function removeCard(c, sid) {
  S.cards[sid] = S.cards[sid].filter(x => x.id !== c.id); adjustAgg(sid, c, -1); rerenderBoard();
}
function restoreCard(c, sid) { S.cards[sid].unshift(c); adjustAgg(sid, c, +1); rerenderBoard(); }
function moveCard(c, from, to, ghost) {
  const stages = STG();
  const gr = ghost ? ghost.getBoundingClientRect() : null;
  S.cards[from] = S.cards[from].filter(x => x.id !== c.id); adjustAgg(from, c, -1);
  (S.cards[to] = S.cards[to] || []).unshift(c); adjustAgg(to, c, +1);
  rerenderBoard();
  const el = $(`.kcard[data-id="${c.id}"]`);
  if (ghost) ghost.remove();
  if (el && gr && !reduced()) {
    const r = el.getBoundingClientRect();
    el.style.transform = `translate(${gr.left - r.left}px, ${gr.top - r.top}px) rotate(2deg)`;
    el.style.boxShadow = 'var(--el-3)';
    el.getBoundingClientRect();
    el.classList.add('is-snapping');
    el.style.transform = ''; el.style.boxShadow = '';
    setTimeout(() => el.classList.remove('is-snapping'), 320);
  }
  const fromN = stages.find(s => s.id === from).name, toN = stages.find(s => s.id === to).name;
  toast(`«${esc(c.t)}»: ${esc(fromN)} → ${esc(toN)}`, t('cancel'), () => { S.cards[to] = S.cards[to].filter(x => x.id !== c.id); adjustAgg(to, c, -1); S.cards[from].unshift(c); adjustAgg(from, c, +1); rerenderBoard(); }, { icon: 'swap_horiz' });
}
function rerenderBoard() {
  if (S.screen !== 'kanban') return render();
  const page = $('.page-kanban'); if (!page) return;
  const scroll = $('#board')?.scrollLeft || 0;
  const tmp = document.createElement('div'); tmp.innerHTML = kanban();
  page.replaceWith(tmp.firstElementChild);
  $('#board') && ($('#board').scrollLeft = scroll);
  bindKanban();
}
function bindKanban() {
  $$('.kcard:not(.sk-card)').forEach(card => {
    card.addEventListener('pointerdown', e => {
      if (e.button > 0 || e.target.closest('button')) return;
      const sx = e.clientX, sy = e.clientY, touch = e.pointerType === 'touch';
      let started = false, lp = null;
      const begin = (x, y) => { started = true; startDrag(card, sx, sy); moveDrag(x, y); };
      if (touch) lp = setTimeout(() => begin(sx, sy), 350);
      const mv = ev => {
        if (!started) {
          const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
          if (!touch && dist > 6) begin(ev.clientX, ev.clientY);
          else if (touch && dist > 10) { clearTimeout(lp); cleanup(); }
          return;
        }
        ev.preventDefault(); moveDrag(ev.clientX, ev.clientY);
      };
      const up = () => { clearTimeout(lp); cleanup(); if (started) endDrag(); else openDeal(card.dataset.id); };
      const cancel = () => { clearTimeout(lp); cleanup(); if (started) endDrag(); };
      const cleanup = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel); };
      addEventListener('pointermove', mv, { passive: false }); addEventListener('pointerup', up); addEventListener('pointercancel', cancel);
    });
    card.addEventListener('touchmove', ev => { if (drag) ev.preventDefault(); }, { passive: false });
    card.addEventListener('keydown', e => { if (e.key === 'Enter') openDeal(card.dataset.id); });
  });
  if (innerWidth <= 720) centerIn($('.stabs'), $('.stab[aria-selected="true"]'));
}
function staticDragPose() {
  const mobile = innerWidth <= 720;
  const card = mobile ? $('.col.is-mob .kcard:not(.is-queue)') : $('.kcard[data-id="4782"]');
  if (!card) return;
  const r = card.getBoundingClientRect();
  startDrag(card, r.left + 40, r.top + 20);
  if (mobile) {
    const tab = $$('.stab')[1]; const tr = tab.getBoundingClientRect();
    moveDrag(tr.left + 30, tr.top + tr.height / 2);
    drag.ghost.style.left = (r.left + 10) + 'px'; drag.ghost.style.top = (tr.bottom + 10) + 'px';
    tab.classList.add('is-over');
  } else {
    const col = $('.col[data-col="a3"]') || $$('.col')[2]; const cr = col.getBoundingClientRect();
    moveDrag(cr.left + 70, cr.top + 150);
  }
  drag.ghost.classList.add('is-lifted');
  const kill = () => { if (drag) { springBack(); drag = null; finishDrag(); } removeEventListener('pointerdown', kill); };
  setTimeout(() => addEventListener('pointerdown', kill), 0);
}

/* прокрутити смугу так, щоб елемент був по центру — без прокрутки сторінки */
function centerIn(strip, el, smooth) {
  if (!strip || !el) return;
  const left = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2;  /* смуга має position: relative */
  strip.scrollTo({ left: Math.max(0, left), behavior: smooth && !reduced() ? 'smooth' : 'auto' });
}

/* ───────────── дії ───────────── */
function openDeal(id) {
  const f = findCard(id);
  S.dealCard = f && +id !== DEAL.id ? { ...f.c, stage: f.sid } : null;
  S.deal = { status: 'open', archived: false, amount: f && +id !== DEAL.id ? f.c.a || 0 : DEAL.amount, lostReason: '' };
  go('deal');
}
function go(screen) { S.screen = screen; S.st = 'normal'; closeOverlay(); render(); scrollTo(0, 0); }

function winDeal() {
  S.deal.status = 'won';
  const p = $('.path');
  if (!p) return render();
  p.classList.add('is-won', reduced() ? 'no-anim' : 'is-winning');
  $$('.ps', p).forEach(ps => { if (!$('.ps-check', ps)) $('.ps-in', ps).insertAdjacentHTML('afterbegin', ic('check', 'ps-check')); });
  $('#dstatus').innerHTML = `<span class="otag otag-won is-drawing"><svg class="drawcheck" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>${t('won')}</span></span>`;
  $('.path-actions').innerHTML = btn(t('reopen'), 'btn-outline', 'undo', 'data-act="reopen"') + iconBtn('inventory_2', t('archive'), 'data-act="archive"', 'ibtn-outline') + iconBtn('more_vert', 'Ще дії');
  $$('.dh-tags .ti').forEach(n => n.remove());
  toast('Угоду виграно. Зовнішня автоматизація отримає подію «угода виграна».', t('cancel'), () => { S.deal.status = 'open'; render(); }, { icon: 'check_circle' });
}
function applySum(v) {
  const from = S.deal.amount;
  S.deal.amount = v;
  const el = $('#damt'); const cur = currentDeal().cur;
  const t0 = performance.now(), dur = reduced() ? 0 : 400;
  const step = now => {
    const k = dur ? Math.min(1, (now - t0) / dur) : 1;
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = money(from + (v - from) * e, cur);
    if (k < 1) requestAnimationFrame(step); else render();
  };
  requestAnimationFrame(step);
  toast(`Суму угоди оновлено: ${money(v, cur)} (було ${money(from, cur)})`, t('cancel'), () => { S.deal.amount = from; render(); });
}

document.addEventListener('click', e => {
  const a = e.target.closest('[data-go],[data-nav],[data-act],[data-lang],[data-menu],[data-project],[data-open],[data-close],[data-tl],[data-mob],[data-role],[data-sel],[data-state]');
  if (!a) return;
  if (a.matches('a')) e.preventDefault();
  const ds = a.dataset;
  if (ds.state) { S.st = ds.state; if (!ds.go) return render(); }
  if (ds.close !== undefined) return closeOverlay();
  if (ds.go) { if (ds.go === 'kanban' || ds.go === 'list') S.dealCard = null; return go(ds.go); }
  if (ds.nav) { if (ds.nav === 'settings') return go('roles'); if (ds.nav === 'deals') return go('kanban'); return toast(`Розділ «${t(ds.nav)}» у цьому прототипі не намальований.`); }
  if (ds.lang) { S.lang = ds.lang; return render(); }
  if (ds.project) { S.project = ds.project; S.mobStage = 0; S.dealCard = null; closeOverlay(); if (S.screen === 'deal') S.screen = 'kanban'; return render(); }
  if (ds.open) { closeOverlay(); return openDeal(ds.open); }
  if (ds.tl) { S.tl = ds.tl; return render(); }
  if (ds.mob) { S.mobStage = +ds.mob; $$('.stab').forEach((b, i) => b.setAttribute('aria-selected', i === S.mobStage)); $$('.col').forEach((c, i) => c.classList.toggle('is-mob', i === S.mobStage)); centerIn($('.stabs'), a, true); return; }
  if (ds.role) { S.role = ds.role; if (S.st === 'empty') S.st = 'normal'; return render(); }
  if (ds.sel) { const id = +ds.sel; S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); return render(); }
  if (ds.menu === 'proj') return projMenu(a);
  if (ds.menu === 'notifs') return notifMenu(a);
  if (ds.menu === 'me') return menu(a, `<div class="menu-hrow">${avatar(ME, 40)}<span class="grow"><span class="t-ll">Олена Коваль</span><br><span class="t-lm muted">olena.koval@example.com</span></span></div>
      <button class="menu-i" data-act="theme">${ic(S.theme === 'dark' ? 'light_mode' : 'dark_mode')}<span class="grow t-ll">${S.theme === 'dark' ? 'Світла тема' : 'Темна тема'}</span></button>
      <button class="menu-i" data-go="signin">${ic('logout')}<span class="grow t-ll">Вийти</span></button>`);
  switch (ds.act) {
    case 'theme': S.theme = S.theme === 'dark' ? 'light' : 'dark'; closeOverlay(); return render();
    case 'take': { const f = findCard(ds.id); if (f) { f.c.r = ME; f.c.task = ['today', 'Сьогодні']; rerenderBoard(); toast(`«${esc(f.c.t)}» тепер ваша. Угода зникла із загальної черги.`, t('cancel'), () => { f.c.r = null; f.c.task = ['none']; rerenderBoard(); }, { icon: 'person_add' }); } return; }
    case 'win': return winDeal();
    case 'lose': return lostDialog(currentDeal().title, false, r => { S.deal.status = 'lost'; S.deal.lostReason = r; render(); toast(`Угоду програно: ${esc(r)}`, t('cancel'), () => { S.deal.status = 'open'; render(); }); });
    case 'reopen': S.deal.status = 'open'; render(); return toast('Угоду відкрито знову на етапі, де вона була.');
    case 'archive': S.deal.archived = !S.deal.archived; if (S.screen === 'deal') render(); return toast(S.deal.archived ? 'Угоду перенесено в архів. Вона зникла з канбану, але є в пошуку і звітах.' : 'Угоду повернуто з архіву.', t('cancel'), () => { S.deal.archived = !S.deal.archived; render(); }, { icon: 'inventory_2' });
    case 'apply-sum': return applySum(+ds.v);
    case 'unsel': S.sel.clear(); return render();
    case 'selall': { const rows = listRows(); const allOn = rows.every(r => S.sel.has(r.id)); rows.forEach(r => allOn ? S.sel.delete(r.id) : S.sel.add(r.id)); return render(); }
    case 'bulk-archive': return archiveConfirm();
    case 'newrole': return newRoleDialog(false);
    case 'delrole': return delRoleConfirm();
    case 'new': return toast('Форма нової угоди в цьому прототипі не намальована.');
    case 'pipe': return toast('Перемикач воронок: ALPI — продажі курсів, Платформа (допродаж).');
    case 'msearch': { const q = $('#q'); q.closest('.search').classList.add('is-open'); q.focus(); return; }
  }
});
document.addEventListener('focusin', e => { if (e.target.id === 'q') searchMenu(e.target); });
document.addEventListener('input', e => { if (e.target.id === 'q') { searchMenu(e.target); e.target.focus(); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeOverlay(); $('.search.is-open')?.classList.remove('is-open'); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q')?.focus(); }
  if (e.target.matches('.otp input') && /^\d$/.test(e.key)) { setTimeout(() => e.target.nextElementSibling?.focus(), 0); }
});
function archiveConfirm() {
  const total = STG().reduce((a, s) => a + s.count, 0);
  confirmDialog({
    icon: 'inventory_2', title: `Архівувати ${S.sel.size} угоди?`,
    text: `Угоди зникнуть з канбану і робочих списків, але залишаться в пошуку і звітах. Статус не зміниться. Скасувати можна з журналу масових дій. Щоб архівувати всі ≈ ${fmt(total)} за фільтром, спершу натисніть «Вибрати всі».`,
    ok: 'Архівувати', onOk: () => { const n = S.sel.size; S.sel.clear(); render(); toast(`Архівуємо ${n} угоди…`, 'Журнал', null, { progress: 100, icon: 'inventory_2' }); },
  });
}
function delRoleConfirm() {
  confirmDialog({ icon: 'delete', title: 'Видалити роль «Стажер»?', text: '2 користувачі з цією роллю втратять доступ до проєкту ALPI, доки ви не призначите їм іншу роль. Дію не можна скасувати.', ok: 'Видалити роль', okCls: 'btn-lost-fill' });
}

/* ───────────── панель прототипу ───────────── */
const SCREENS = [['kanban', 'Канбан'], ['deal', 'Картка угоди'], ['list', 'Список угод'], ['roles', 'Налаштування → ролі'], ['signin', 'Вхід з 2FA']];
const STATES = [['normal', 'Звичайний'], ['loading', 'Завантаження'], ['empty', 'Порожньо'], ['error', 'Помилка'], ['forbidden', '403 — немає доступу'], ['validation', 'Помилка валідації'], ['toast', 'Тост'], ['confirm', 'Діалог підтвердження'], ['drag', 'Перетягування']];
function protoBar() {
  const el = $('#proto');
  if (!S.bar || S.frame) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="pbar ${el.dataset.min === '1' ? 'is-min' : ''}">
    <button class="pb-min" data-pb="min" aria-label="Згорнути панель прототипу">${ic('tune')}</button>
    <span class="pb-tag">ПРОТОТИП · Напрям 3 «Кольорова воронка»</span>
    <label>Екран<select data-pb="screen">${SCREENS.map(([k, l]) => `<option value="${k}" ${k === S.screen ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Стан<select data-pb="state">${STATES.map(([k, l]) => `<option value="${k}" ${k === S.st ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <button data-pb="theme">${ic(S.theme === 'dark' ? 'light_mode' : 'dark_mode')}${S.theme === 'dark' ? 'Світла' : 'Темна'}</button>
    <button data-pb="preview" aria-pressed="${S.preview}">${ic('smartphone')}390 px</button>
  </div>`;
}
document.addEventListener('change', e => {
  const k = e.target.dataset.pb;
  if (k === 'screen') { S.screen = e.target.value; S.dealCard = null; if (S.st === 'drag' && S.screen !== 'kanban') S.st = 'normal'; render(); }
  if (k === 'state') { S.st = e.target.value; if (S.st === 'drag') S.screen = 'kanban'; render(); }
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-pb]'); if (!b || b.tagName === 'SELECT') return;
  if (b.dataset.pb === 'theme') { S.theme = S.theme === 'dark' ? 'light' : 'dark'; render(); }
  if (b.dataset.pb === 'preview') { S.preview = !S.preview; render(); }
  if (b.dataset.pb === 'min') { const el = $('#proto'); el.dataset.min = el.dataset.min === '1' ? '0' : '1'; protoBar(); }
});

function syncURL() {
  if (S.frame) return;
  const p = new URLSearchParams({ screen: S.screen, state: S.st, theme: S.theme, lang: S.lang, project: S.project });
  if (S.preview) p.set('preview', '390');
  if (!S.bar) p.set('bar', '0');
  history.replaceState(null, '', '?' + p);
}

/* ───────────── рендер ───────────── */
function render() {
  document.documentElement.dataset.theme = S.theme;
  document.documentElement.lang = S.lang;
  syncURL();
  protoBar();
  const app = $('#app');
  if (S.preview && !S.frame) {
    const p = new URLSearchParams({ screen: S.screen, state: S.st, theme: S.theme, lang: S.lang, project: S.project, frame: '1' });
    app.innerHTML = `<div class="preview"><div class="phone"><iframe title="Мобільний вигляд 390 px" src="?${p}"></iframe></div>
      <p class="t-lm muted">Мобільний вигляд, 390 × 844. Зміни екрана і стану на панелі внизу перезавантажують рамку.</p></div>`;
    return;
  }
  $$('.kghost').forEach(g => g.remove()); drag = null;
  const screens = { kanban, deal, list, roles };
  const changed = lastScreen !== S.screen;
  lastScreen = S.screen;
  if (S.screen === 'signin') app.innerHTML = signin();
  else app.innerHTML = shell(screens[S.screen]());
  if (changed && !reduced()) $('.page, .si-card')?.classList.add('is-entering');
  if (S.screen === 'kanban') bindKanban();
  if (S.screen === 'deal' && innerWidth <= 720) centerIn($('.path'), $('.ps.is-current'));
  $$('[data-indet]').forEach(i => i.indeterminate = true);
  $('[data-focus]')?.focus({ preventScroll: true });
  if (overlay().firstElementChild && !overlay().classList.contains('is-menu')) { /* діалог лишається */ } else { overlay().innerHTML = ''; overlay().className = ''; }
  applyState();
}

let appliedState = null;
function applyState() {
  const key = [S.screen, S.st, S.theme, S.lang, S.project, S.preview].join(':');
  if (appliedState === key) return;
  appliedState = key;
  const st = S.st, sc = S.screen;
  if (st === 'drag' && sc === 'kanban') requestAnimationFrame(() => requestAnimationFrame(staticDragPose));
  if (st === 'toast') {
    if (sc === 'kanban') toast('«Тетяна Гнатенко»: Передано в роботу → Був на вебінарі', t('cancel'), null, { icon: 'swap_horiz', sticky: true });
    if (sc === 'deal') toast('Суму угоди оновлено: 1 440 € (було 1 290 €)', t('cancel'), null, { sticky: true });
    if (sc === 'list') toast('Архівуємо 61 200 угод · 34 %. Можна працювати далі.', 'Журнал', null, { progress: 34, icon: 'inventory_2', sticky: true });
    if (sc === 'roles') toast('Права ролі «Менеджер» збережено. Діють з наступного запиту.', null, null, { icon: 'check_circle', sticky: true });
    if (sc === 'signin') toast('Новий код можна ввести за 30 с.', null, null, { sticky: true });
  } else hideToast();
  if (st === 'confirm') {
    if (sc === 'kanban' || sc === 'deal') lostDialog(sc === 'deal' ? currentDeal().title : 'Тетяна Гнатенко', false, () => {});
    if (sc === 'list') archiveConfirm();
    if (sc === 'roles') delRoleConfirm();
    if (sc === 'signin') confirmDialog({ icon: 'key', title: 'Увійти кодом відновлення?', text: 'Кожен код відновлення діє один раз. Після входу налаштуйте застосунок автентифікації заново.', ok: 'Продовжити' });
  }
  if (st === 'validation') {
    const st7 = STG().find(s => s.required) || STG()[6];
    if (sc === 'kanban' || sc === 'deal' || sc === 'list') requiredSheet({ t: sc === 'kanban' ? 'Наталія Шевчишин' : currentDeal().title }, st7, true, () => {}, () => {});
    if (sc === 'roles') newRoleDialog(true);
  }
  if (!['confirm', 'validation'].includes(st)) { overlay().innerHTML = ''; overlay().className = ''; }
}

matchMedia('(max-width: 720px)').addEventListener('change', () => render());
render();
