/* ПРОТОТИП — throwaway. Ядро: маршруты, оболочка, панель прототипа, тосты, диалоги, тема, свет курсора, перетаскивание.
   Адрес: index.html?theme=light&w=390#/kanban/drag  (theme = dark|light, w = 1440|390, embed=1 прячет панель прототипа). */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('uk-UA');
const money = (a, c) => (a ? `<span class="money">${fmt(a)} ${SYM[c]}</span>` : '<span class="meta">без суми</span>');
const st = (t, text) => `<span class="st" data-t="${t}"><i aria-hidden="true"></i>${text}</span>`;
const taskText = (t) => ({ none: 'немає задачі', today: 'сьогодні', overdue: 'прострочено', future: 'заплановано' }[t]);
const who = (id) => (id ? USERS[id].n : '');

/* inline SVG icons: 16 grid, stroke 1.5, currentColor (design system: no icon sets) */
const IC = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11z"/><path d="M6.5 14h3"/>',
  chev: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  phone: '<path d="M3.5 2.5h2.6l1.3 3.2-1.7 1.1a7.5 7.5 0 0 0 3.5 3.5l1.1-1.7 3.2 1.3v2.6a1 1 0 0 1-1 1A10.5 10.5 0 0 1 2.5 3.5a1 1 0 0 1 1-1z"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 4.5L8 9l5.5-4.5"/>',
  note: '<path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3"/>',
  pay: '<rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M1.5 6.5h13M4 10h3"/>',
  reg: '<path d="M9 2.5h4.5v11H9"/><path d="M2 8h8M7 5l3 3-3 3"/>',
  stage: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  task: '<circle cx="8" cy="8" r="5.5"/><path d="M5.6 8.1l1.7 1.7 3.2-3.3"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  cal: '<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>',
  filter: '<path d="M2 3.5h12L9.5 9v4l-3 1.5V9z"/>',
  more: '<circle cx="3.5" cy="8" r=".8"/><circle cx="8" cy="8" r=".8"/><circle cx="12.5" cy="8" r=".8"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-1v-8h8v1"/>',
  ext: '<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4"/>',
  down: '<path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10"/>',
  retry: '<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  play: '<path d="M5.5 4l6 4-6 4z" fill="currentColor"/>',
  arch: '<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v7h10V6M6.5 9h3"/>',
  back: '<path d="M13 8H3M7 4L3 8l4 4"/>',
  key: '<circle cx="5" cy="10.5" r="2.5"/><path d="M7 8.5l6-6M11 4.5l1.5 1.5"/>',
  off: '<path d="M2 6a9 9 0 0 1 3-1.8M14 6a9 9 0 0 0-5.5-2.2M4.5 8.6a5.5 5.5 0 0 1 2-1M11.5 8.6a5.4 5.4 0 0 0-1.4-.9M8 12.2h.01M2.5 2.5l11 11"/>',
  merge: '<path d="M4 2.5v3a4 4 0 0 0 4 4h0a4 4 0 0 1 4 4v0M12 2.5v3a4 4 0 0 1-4 4"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5a5 5 0 0 1 10 0"/>',
  pen: '<path d="M10.5 3l2.5 2.5L6 12.5l-3.2.7.7-3.2z"/><path d="M9 4.5L11.5 7"/>',
  file: '<path d="M4 1.5h5.5l3 3v10H4z"/><path d="M9.5 1.5v3h3"/>',
  clip: '<path d="M12.5 7.5l-4.8 4.8a3 3 0 0 1-4.2-4.2l5.2-5.2a2 2 0 0 1 2.8 2.8L6.4 10.8a1 1 0 0 1-1.4-1.4l4.5-4.5"/>',
  edit: '<path d="M2.5 13.5h11"/><path d="M9.5 3l2 2L6 10.5H4v-2z"/>',
  trash: '<path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9"/>',
  upsell: '<path d="M8 13V4M4.5 7.5L8 4l3.5 3.5M3 2.5h10"/>',
  org: '<rect x="3" y="2" width="10" height="12" rx="1"/><path d="M6 5h1M9 5h1M6 8h1M9 8h1M7 14v-3h2v3"/>',
};
const ic = (n, s = 16) => `<svg class="i" width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${IC[n]}</svg>`;

/* ---------- state & routing ---------- */
const params = new URLSearchParams(location.search);
const S = {
  embed: params.has('embed'),
  theme: params.get('theme') || localStorage.getItem('actum-crm-theme') || 'dark',
  w: params.get('w') === '390' ? 390 : 1440,
  calm: params.has('calm'),
  project: 'alpi',
  lang: 'uk',
  screen: 'kanban',
  state: 'default',
  mobileStage: 's6',
};
const SCREENS = {}; // filled by screens.js: id -> { title, group, shell, states: [[id,label]], render(state), after(state) }
const GENERIC = { loading: 'Завантаження', empty: 'Порожньо', error: 'Помилка', forbidden: 'Немає доступу (403)', offline: 'Офлайн' };

function parseHash() {
  const [, screen, state] = (location.hash || '').split('/');
  S.screen = SCREENS[screen] ? screen : 'kanban';
  const sts = SCREENS[S.screen].states.map((x) => x[0]);
  S.state = sts.includes(state) ? state : sts[0];
}
function go(screen, state) { location.hash = `#/${screen}/${state || SCREENS[screen].states[0][0]}`; }

/* ---------- theme with circular reveal (ThemeSwitch) ---------- */
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  localStorage.setItem('actum-crm-theme', S.theme);
  $$('[data-theme-opt]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeOpt === S.theme)));
  $$('[data-proto-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.protoTheme === S.theme)));
}
function revealTheme(x, y, update) {
  const root = document.documentElement;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches || S.calm;
  if (calm || typeof document.startViewTransition !== 'function') { update(); return; }
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.dataset.vt = 'theme';
  const vt = document.startViewTransition(update);
  vt.ready.then(() => root.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
    { duration: 550, easing: 'cubic-bezier(.2, .8, .2, 1)', pseudoElement: '::view-transition-new(root)' },
  )).catch(() => {});
  vt.finished.finally(() => delete root.dataset.vt).catch(() => {});
}
function setTheme(t, ev) {
  if (t === S.theme) return;
  let x = ev?.clientX || 0, y = ev?.clientY || 0;
  if (!x && !y && ev?.currentTarget) { const r = ev.currentTarget.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
  revealTheme(x, y, () => { S.theme = t; applyTheme(); syncFrame(); });
}

/* ---------- toasts ---------- */
function toast(text, { tone = 'info', action } = {}) {
  const vp = $('#toasts');
  while (vp.children.length >= 2) vp.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'toast'; el.dataset.tone = tone;
  if (tone === 'error') el.setAttribute('role', 'alert');
  el.innerHTML = `<p class="text">${text}</p>${action ? `<button type="button" class="btn quiet sm act">${action}</button>` : ''}<button type="button" class="close">Закрити</button>`;
  vp.append(el);
  let left = 5000, t0 = Date.now(), timer = setTimeout(() => el.remove(), left);
  const pause = () => { clearTimeout(timer); left = Math.max(800, left - (Date.now() - t0)); };
  const resume = () => { t0 = Date.now(); timer = setTimeout(() => el.remove(), left); };
  el.addEventListener('pointerenter', pause); el.addEventListener('pointerleave', resume);
  el.querySelector('.close').onclick = () => el.remove();
  if (action) el.querySelector('.act').onclick = () => { el.remove(); toast('Дію скасовано.'); };
  announce(text.replace(/<[^>]+>/g, ''));
  return el;
}
function announce(text) { const r = $('#live'); r.textContent = ''; setTimeout(() => { r.textContent = text; }, 60); }

/* ---------- dialogs (native <dialog>, top layer) ---------- */
function openDialog(html, { wide = false, onOpen } = {}) {
  closeDialogs();
  const d = document.createElement('dialog');
  d.className = 'dlg' + (wide ? ' wide' : '');
  d.innerHTML = html;
  document.body.append(d);
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  d.addEventListener('close', () => d.remove());
  d.showModal();
  (d.querySelector('.dlg-b :is(input:not([readonly]):not([type=radio]):not([type=checkbox]), select, textarea)') || d.querySelector('.dlg-f .primary') || d.querySelector('.dlg-f .btn'))?.focus();
  onOpen?.(d);
  return d;
}
function closeDialogs() { $$('dialog.dlg').forEach((d) => d.close()); }
const dlgHead = (title, sub = '') => `<div class="dlg-h"><div style="display:grid;gap:4px"><h2 class="dlg-t">${title}</h2>${sub ? `<p class="meta-prose">${sub}</p>` : ''}</div><button type="button" class="icon-btn" data-close aria-label="Закрити">${ic('close')}</button></div>`;

/* ---------- shell ---------- */
const NAV = [
  ['Робота', [['kanban', 'Угоди', '130'], ['deals', 'Список угод'], ['tasks', 'Задачі', '3', 'ask'], ['contact', 'Контакти'], ['org', 'Організації']]],
  ['Аналітика', [['dashboard', 'Сьогодні'], ['reports', 'Звіти']]],
  ['Налаштування', [['roles', 'Ролі і права'], ['users', 'Користувачі'], ['teams', 'Команди'], ['audit', 'Журнал дій'], ['apikeys', 'Ключі API'], ['webhooks', 'Події'], ['fields', 'Поля']]],
  ['Прототип', [['kit', 'Стани елементів']]],
];
const NAV_RU = { 'Угоди': 'Сделки', 'Список угод': 'Список сделок', 'Задачі': 'Задачи', 'Контакти': 'Контакты', 'Організації': 'Организации', 'Сьогодні': 'Сегодня', 'Звіти': 'Отчёты', 'Ролі і права': 'Роли и права', 'Користувачі': 'Пользователи', 'Команди': 'Команды', 'Журнал дій': 'Журнал действий', 'Ключі API': 'Ключи API', 'Події': 'События', 'Поля': 'Поля', 'Робота': 'Работа', 'Аналітика': 'Аналитика', 'Налаштування': 'Настройки', 'Прототип': 'Прототип' };
const L = (s) => (S.lang === 'ru' ? NAV_RU[s] || s : s);

function shell(inner) {
  const P = PROJECTS[S.project];
  const navCur = SCREENS[S.screen].nav || S.screen;
  return `
  <a class="skip" href="#main">Перейти до основного вмісту</a>
  <header class="top"><div class="top-in">
    <a class="logo" href="#/kanban/default" aria-label="Alpi CRM"><span class="mk" aria-hidden="true"></span>alpi<small>crm</small></a>
    <div class="proj-wrap">
      <button type="button" class="proj" data-act="pop-proj" aria-haspopup="menu" aria-expanded="false"><span class="pdot" aria-hidden="true"></span><span>${P.code}</span><span class="role">${P.role}</span>${ic('chev', 14)}</button>
    </div>
    <button type="button" class="cmd" data-act="search" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K">${ic('search')}<span class="lbl">Угода, ім’я, телефон, email…</span><kbd aria-hidden="true">Ctrl K</kbd></button>
    <div class="top-end">
      <button type="button" class="icon-btn search-mobile" data-act="search" aria-label="Пошук">${ic('search', 18)}</button>
      <div class="me-wrap"><button type="button" class="icon-btn" data-act="pop-notif" aria-label="Сповіщення, 2 нових" aria-haspopup="menu">${ic('bell', 18)}<span class="badge">2</span></button></div>
      <div class="track lang-sw"><span class="vh" id="lang-l">Мова</span><div role="radiogroup" aria-labelledby="lang-l" class="options">
        <button type="button" role="radio" class="option" data-lang="uk" aria-checked="${S.lang === 'uk'}" aria-label="Українська" lang="uk">UA</button>
        <button type="button" role="radio" class="option" data-lang="ru" aria-checked="${S.lang === 'ru'}" aria-label="Русский" lang="ru">RU</button></div></div>
      <div class="track theme-sw"><span class="group" id="theme-l">Тема</span><div role="radiogroup" aria-labelledby="theme-l" class="options">
        <button type="button" role="radio" class="option" data-theme-opt="dark" aria-checked="${S.theme === 'dark'}">Темна</button>
        <button type="button" role="radio" class="option" data-theme-opt="light" aria-checked="${S.theme === 'light'}">Світла</button></div></div>
      <div class="me-wrap"><button type="button" class="me" data-act="pop-me" aria-haspopup="menu"><span class="ini" aria-hidden="true">ОК</span><span class="nm">Олена Коваль</span></button></div>
    </div>
  </div></header>
  <div class="shell">
    <nav class="side" aria-label="Основна навігація">
      ${NAV.map(([g, items]) => `<div class="nav-label meta">${L(g)}</div>` + items.map(([id, label, n, tone]) =>
        `<a class="nl" href="#/${id}/${SCREENS[id].states[0][0]}" ${navCur === id ? 'aria-current="page"' : ''}>${L(label)}${n ? `<span class="count ${tone || ''}">${n}</span>` : ''}</a>`).join('')).join('')}
    </nav>
    <main id="main" class="main" tabindex="-1">${S.state === 'offline' ? offlineBar() : ''}<div class="enter">${inner}</div></main>
  </div>`;
}
const offlineBar = () => `<div class="offline-bar" role="status">${ic('off')}<span class="grow"><b style="font-weight:500">Немає з’єднання.</b> <span class="ink2">Показуємо останні завантажені дані від 11:42. Зміни не збережуться, доки зв’язок не повернеться.</span></span><span class="st" data-t="wait"><i aria-hidden="true"></i>перевіряємо</span><button type="button" class="btn ghost sm" data-act="retry">${ic('retry', 14)}Повторити</button></div>`;

/* generic states shared by all screens */
function generic(state, what = 'дані') {
  if (state === 'loading') return `<div class="panel" aria-busy="true"><div class="sh"><span class="sk" style="width:180px;font-size:17px"><span class="bar"></span></span></div><div class="sb">${[80, 64, 72, 58, 76, 50].map((w) => `<span class="sk" aria-hidden="true" style="font-size:15px"><span class="bar" style="--w:${w}%"></span><span class="bar" style="--w:${w - 30}%"></span></span>`).join('')}</div></div>`;
  if (state === 'error') return `<section class="panel" aria-label="Помилка"><div class="empty"><h2 class="t">Не вдалося завантажити ${what}.</h2><p class="x">Сервер не відповів за 15 секунд. Спробуйте ще раз. Якщо повториться, передайте адміністратору код помилки.</p><p class="meta code-k">код <b>req_7f3a91c2</b></p><div class="a"><button type="button" class="btn ghost sm" data-act="retry">${ic('retry', 14)}Повторити</button></div></div></section>`;
  if (state === 'forbidden') return `<section class="panel" aria-label="Немає доступу"><div class="empty"><p class="meta" style="margin-bottom:10px"><b>403</b></p><h2 class="t">Немає доступу до цього розділу.</h2><p class="x">Ваша роль у проєкті ALPI — «Менеджер». Вона не дає права бачити ${what}. Якщо доступ потрібен для роботи, напишіть адміністратору проєкту.</p><div class="a"><a class="btn ghost sm" href="#/kanban/default">До угод</a></div></div></section>`;
  return '';
}
const emptyBox = (title, text, action = '') => `<section class="panel"><div class="empty"><h2 class="t">${title}</h2><p class="x">${text}</p>${action ? `<div class="a">${action}</div>` : ''}</div></section>`;

/* ---------- prototype bar ---------- */
function protoBar() {
  const groups = {};
  Object.entries(SCREENS).forEach(([id, s]) => { (groups[s.group] ||= []).push([id, s.title]); });
  return `
    <span class="tag"><i aria-hidden="true"></i>ПРОТОТИП</span>
    <label class="vh" for="pscreen">Екран</label>
    <select id="pscreen" class="select sm">${Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])).map(([g, items]) => `<optgroup label="${g}">${items.map(([id, t]) => `<option value="${id}" ${id === S.screen ? 'selected' : ''}>${t}</option>`).join('')}</optgroup>`).join('')}</select>
    <div class="states" role="group" aria-label="Стани екрана">${SCREENS[S.screen].states.map(([id, l]) => `<button type="button" class="st-chip" data-state="${id}" aria-pressed="${id === S.state}">${l}</button>`).join('')}</div>
    <div class="end">
      <div class="track"><span class="group">Тема</span><div class="options"><button type="button" class="option" data-proto-theme="dark" aria-pressed="${S.theme === 'dark'}">Темна</button><button type="button" class="option" data-proto-theme="light" aria-pressed="${S.theme === 'light'}">Світла</button></div></div>
      <div class="track"><span class="group">Ширина</span><div class="options"><button type="button" class="option" data-w="1440" aria-pressed="${S.w === 1440}">1440</button><button type="button" class="option" data-w="390" aria-pressed="${S.w === 390}">390</button></div></div>
      <div class="track"><div class="options"><button type="button" class="option" data-calm aria-pressed="${S.calm}" title="Емуляція prefers-reduced-motion">Менше руху</button></div></div>
    </div>`;
}

/* ---------- render ---------- */
function render() {
  parseHash();
  closeDialogs();
  $$('.kcard.lifted, .dropzones, .pop').forEach((n) => n.remove());
  const root = $('#root');
  const scr = SCREENS[S.screen];
  if (!S.embed) {
    const pb = $('#proto'); pb.className = 'proto'; pb.setAttribute('role', 'region'); pb.setAttribute('aria-label', 'Панель прототипу');
    pb.innerHTML = protoBar();
    syncProtoH();
  }
  if (!S.embed && S.w === 390) {
    const src = `index.html?embed=1&theme=${S.theme}${S.calm ? '&calm' : ''}#/${S.screen}/${S.state}`;
    root.innerHTML = `<div class="frame-stage"><div class="device"><iframe title="Телефон 390 px" src="${src}"></iframe></div><p class="meta cap">390 × 844, той самий прототип у фреймі: медіазапити працюють як на телефоні</p></div>`;
    return;
  }
  let inner;
  const custom = scr.render(S.state);
  if (custom != null) inner = custom; else inner = generic(S.state, scr.what);
  root.innerHTML = scr.shell === false ? inner : shell(inner);
  scr.after?.(S.state);
  if (S.state === 'toast' || S.state === 'success') scr.toast && toast(scr.toast);
}
function syncProtoH() { const p = $('#proto'); if (p) document.documentElement.style.setProperty('--proto-h', p.offsetHeight + 'px'); }
function syncFrame() {
  const f = $('.frame-stage iframe');
  if (f) f.src = `index.html?embed=1&theme=${S.theme}${S.calm ? '&calm' : ''}#/${S.screen}/${S.state}`;
}

/* ---------- popovers ---------- */
function togglePop(anchor, html, right = false) {
  const wrap = anchor.parentElement;
  const open = wrap.querySelector('.pop');
  $$('.pop').forEach((p) => p.remove());
  $$('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  if (open) return;
  wrap.insertAdjacentHTML('beforeend', `<div class="pop ${right ? 'right' : ''}" role="menu">${html}</div>`);
  anchor.setAttribute('aria-expanded', 'true');
  wrap.querySelector('.pop .opt')?.focus();
}
const POPS = {
  proj: () => `<div class="glabel meta">Проєкт</div>
    <button class="opt" role="menuitemradio" data-act="set-proj" data-p="alpi" aria-selected="${S.project === 'alpi'}"><span style="display:grid;gap:1px"><span>ALPI</span><span class="meta">AI-школа ALPI, ваша роль: Менеджер</span></span></button>
    <button class="opt" role="menuitemradio" data-act="set-proj" data-p="franch" aria-selected="${S.project === 'franch'}"><span style="display:grid;gap:1px"><span>«Франч»</span><span class="meta">франчайзинг-консалтинг, ваша роль: Керівник</span></span></button>
    <hr><p class="meta-prose" style="padding:6px 10px 8px;max-width:30ch">Дані проєктів не перетинаються. Під час перемикання фільтри й вибір скидаються.</p>`,
  notif: () => `<div class="glabel meta" style="display:flex;justify-content:space-between"><span>Сповіщення</span><button class="link-a" data-act="read-all" style="font-size:12.5px">Позначити всі прочитаними</button></div>
    ${[['Вам призначено угоду «Ірина Мельник — AI-контент PRO»', '10 хв тому', 1], ['Нагадування: дзвінок о 12:00, Ірина Мельник', 'через 15 хв', 1], ['Масову операцію завершено: архівовано 61 240 угод', 'вчора 18:40', 0], ['Ранковий список: 12 задач на сьогодні', 'сьогодні 08:00', 0]].map(([t, w, u]) =>
      `<button class="opt" role="menuitem" style="align-items:flex-start"><span class="st" data-t="${u ? 'ok' : 'muted'}" style="margin-top:6px"><i aria-hidden="true"></i></span><span style="display:grid;gap:2px;min-width:0"><span style="${u ? 'font-weight:500' : 'color:var(--ink-2)'};white-space:normal">${t}</span><span class="meta">${w}</span></span></button>`).join('')}`,
  me: () => `<div style="padding:8px 10px 10px;display:grid;gap:2px"><b style="font-weight:500">Олена Коваль</b><span class="meta">olena.koval@example.com</span></div><hr>
    <button class="opt" role="menuitem" data-act="go" data-to="twofa-setup">${ic('lock')}Двофакторний вхід</button>
    <button class="opt" role="menuitem" data-act="go" data-to="temp-password">${ic('key')}Змінити пароль</button><hr>
    <button class="opt" role="menuitem" data-act="logout">Вийти</button>`,
};

/* ---------- global events ---------- */
const ACT = {}; // filled by screens.js too
Object.assign(ACT, {
  'pop-proj': (b) => togglePop(b, POPS.proj()),
  'pop-notif': (b) => togglePop(b, POPS.notif(), true),
  'pop-me': (b) => togglePop(b, POPS.me(), true),
  'set-proj': (b) => { S.project = b.dataset.p; $$('.pop').forEach((p) => p.remove()); render(); toast(`Проєкт змінено на ${PROJECTS[S.project].name}. Фільтри й вибір скинуто.`); },
  'read-all': () => { $$('.pop').forEach((p) => p.remove()); $$('.badge').forEach((x) => x.remove()); toast('Усі сповіщення прочитано.'); },
  go: (b) => go(b.dataset.to, b.dataset.st),
  logout: () => go('signin'),
  retry: (b) => { b.setAttribute('data-busy', ''); b.innerHTML = `${ic('retry', 14)}Повторюємо…`; setTimeout(() => go(S.screen, SCREENS[S.screen].states[0][0]), 900); },
  search: () => openSearch(),
});

document.addEventListener('click', (e) => {
  const st = e.target.closest('.st-chip');
  if (st) { go(S.screen, st.dataset.state); return; }
  const pt = e.target.closest('[data-proto-theme]');
  if (pt) { setTheme(pt.dataset.protoTheme, e); return; }
  const to = e.target.closest('[data-theme-opt]');
  if (to) { setTheme(to.dataset.themeOpt, e); return; }
  const lg = e.target.closest('[data-lang]');
  if (lg) { S.lang = lg.dataset.lang; render(); toast(S.lang === 'ru' ? 'Язык интерфейса: русский.' : 'Мова інтерфейсу: українська.'); return; }
  const w = e.target.closest('[data-w]');
  if (w) { S.w = +w.dataset.w; render(); return; }
  if (e.target.closest('[data-calm]')) { S.calm = !S.calm; document.documentElement.toggleAttribute('data-calm', S.calm); render(); return; }
  const a = e.target.closest('[data-act]');
  if (a && ACT[a.dataset.act]) { e.preventDefault(); ACT[a.dataset.act](a, e); return; }
  if (!e.target.closest('.pop')) { $$('.pop').forEach((p) => p.remove()); $$('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false')); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'pscreen') go(e.target.value);
  const a = e.target.closest('[data-change]');
  if (a && ACT[a.dataset.change]) ACT[a.dataset.change](a, e);
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  if (e.key === 'Escape') $$('.pop').forEach((p) => p.remove());
  if (e.key === 'Enter' && e.target.classList?.contains('kcard')) go('deal');
});
addEventListener('hashchange', render);

/* ---------- quick search (CommandBar dialog) ---------- */
function openSearch(q = 'мельник') {
  const row = (a, b, c, sel) => `<div class="opt" role="option" aria-selected="${sel}" style="display:flex;align-items:baseline;gap:12px;padding:9px 10px;border-radius:8px;${sel ? 'background:var(--hover);box-shadow:inset 2px 0 0 var(--accent-solid)' : ''}">${a}<span class="ellip" style="flex:1">${b}</span><span class="meta" style="flex:none">${c}</span></div>`;
  openDialog(`<div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)">${ic('search')}<input id="q" role="combobox" aria-expanded="true" aria-label="Пошук" value="${q}" style="flex:1;border:0;background:none;outline:none;font-size:16px;color:var(--ink)"><kbd>Esc</kbd></div>
    <div style="padding:6px;max-height:60vh;overflow:auto" role="listbox" id="qres">${searchResults(q, row)}</div>`, {
    onOpen: (d) => { const i = $('#q', d); i.focus(); i.setSelectionRange(99, 99); i.addEventListener('input', () => { $('#qres', d).innerHTML = i.value.trim() ? (i.value.length > 2 && !/мел|ірин|123|ірина/i.test(i.value) ? `<p style="padding:14px 10px;color:var(--ink-2)">Нічого не знайшли за «${esc(i.value)}».</p>` : searchResults(i.value, row)) : `<p style="padding:14px 10px;color:var(--ink-2)">Шукаємо в угодах, контактах і організаціях проєкту ALPI. Телефон можна вводити в будь-якому форматі.</p>`; }); },
  });
}
function searchResults(q, row) {
  return `<div class="meta" style="padding:8px 10px 4px">Угоди</div>${SEARCH.deals.map(([n, t, s], i) => row(`<span class="meta" style="width:44px;flex:none"><b>${n}</b></span>`, t, s, i === 0)).join('')}
    <div style="margin-top:4px;border-top:1px solid var(--line);padding-top:4px"><div class="meta" style="padding:8px 10px 4px">Контакти</div>${SEARCH.contacts.map(([t, s]) => row('', t, s, false)).join('')}</div>
    <div style="margin-top:4px;border-top:1px solid var(--line);padding-top:4px"><div class="meta" style="padding:8px 10px 4px">Організації</div>${SEARCH.orgs.map(([t, s]) => row('', t, s, false)).join('')}</div>`;
}

/* ---------- kanban drag and drop (pointer events) ---------- */
function bindBoard() {
  const board = $('.board');
  if (!board) return;
  board.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.kcard');
    if (!card || e.button !== 0 || e.target.closest('button,a') || card.classList.contains('placeholder')) return;
    const sx = e.clientX, sy = e.clientY;
    let drag = null;
    const move = (ev) => {
      if (!drag) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return; drag = startDrag(card, ev); }
      ev.preventDefault();
      drag.ghost.style.left = ev.clientX - drag.dx + 'px';
      drag.ghost.style.top = ev.clientY - drag.dy + 'px';
      hit(drag, ev);
    };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      if (drag) endDrag(drag); else go('deal');
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', up);
  });
}
function startDrag(card, ev) {
  const r = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add('lifted');
  Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
  document.body.append(ghost);
  card.classList.add('placeholder');
  document.body.insertAdjacentHTML('beforeend', dropZones());
  return { card, ghost, dx: ev.clientX - r.left, dy: ev.clientY - r.top, from: card.closest('.kcol'), col: null, zone: null };
}
const dropZones = () => `<div class="dropzones" aria-hidden="true"><div class="dz won" data-zone="won"><b style="font-weight:500">Виграно</b><div class="meta">відпустіть, щоб закрити угоду</div></div><div class="dz lost" data-zone="lost"><b style="font-weight:500">Програно</b><div class="meta">потрібна причина програшу</div></div></div>`;
function hit(drag, ev) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const col = el?.closest('.kcol') || null;
  const zone = el?.closest('.dz') || null;
  $$('.kcol.over').forEach((c) => c !== col && c.classList.remove('over'));
  $$('.dz.over').forEach((z) => z !== zone && z.classList.remove('over'));
  if (col && col !== drag.from) col.classList.add('over');
  zone?.classList.add('over');
  drag.col = col; drag.zone = zone;
  const board = $('.board'), br = board.getBoundingClientRect();
  if (ev.clientX > br.right - 60) board.scrollLeft += 14; else if (ev.clientX < br.left + 60) board.scrollLeft -= 14;
}
function endDrag(drag) {
  const { card, ghost, col, zone, from } = drag;
  ghost.remove(); $('.dropzones')?.remove();
  $$('.over').forEach((c) => c.classList.remove('over'));
  card.classList.remove('placeholder');
  const title = card.querySelector('.t').textContent;
  if (zone) { zone.dataset.zone === 'lost' ? lostDialog(title) : wonDialog(title); return; }
  if (!col || col === from) return;
  const stage = STAGES.find((s) => s.id === col.dataset.stage);
  const doMove = () => {
    col.querySelector('.kcards').prepend(card);
    card.classList.remove('landed'); void card.offsetWidth; card.classList.add('landed');
    bump(from, -1); bump(col, +1);
    toast(`«${esc(title)}» → етап «${stage.name}».`, { action: 'Скасувати' });
  };
  if (stage.required) requiredDialog(title, stage, doMove); else doMove();
}
function bump(col, d) { const n = col.querySelector('.kh .n b'); if (n) n.textContent = fmt(+n.textContent.replace(/\D/g, '') + d); }

function lostDialog(title) {
  openDialog(`${dlgHead('Угода програна', `«${esc(title)}». Причину бачитимуть у звіті «Причини програшу».`)}
    <form class="dlg-b" novalidate id="lostf">
      <div class="field"><label class="label" for="lg">Група причин</label><select id="lg" class="select"><option>АІ 2 · Після вебінару</option><option>АІ 1 · До вебінару</option><option>АІ 3 · Після броні</option></select></div>
      <fieldset class="choices"><legend class="label" style="margin-bottom:8px">Причина</legend>${['Дорого', 'Немає часу зараз', 'Не вірить у результат', 'Обрав інший курс'].map((r) => `<label class="choice"><input type="radio" name="lr" value="${r}"><span>${r}</span></label>`).join('')}</fieldset>
      <p class="error" id="lr-err" role="alert"></p>
      <div class="field"><label class="label" for="lc">Коментар <span class="opt">необов’язково</span></label><textarea id="lc" class="textarea" placeholder="Що саме сказала людина"></textarea></div>
    </form>
    <div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="lost-ok">Позначити програною</button></div>`);
}
ACT['lost-ok'] = () => {
  if (!$('input[name="lr"]:checked')) { $('#lr-err').textContent = 'Оберіть причину програшу.'; $('.dlg .choices').style.outline = 'none'; return; }
  closeDialogs(); if (S.screen === 'deal') go('deal', 'lost'); toast('Угоду позначено програною. Подію «угоду програно» надіслано автоматизації.');
};
function wonDialog(title) {
  openDialog(`${dlgHead('Позначити угоду виграною?', `«${esc(title)}»`)}<div class="dlg-b"><p class="ink2" style="font-size:14px">Угода зникне з канбана й потрапить у звіти як виграна. Відкрити її знову можна з картки угоди. CRM нічого не робить сама: задачу після виграшу поставить ваша автоматизація, якщо вона налаштована.</p></div>
    <div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="won-ok">Так, виграна</button></div>`);
}
ACT['won-ok'] = () => { closeDialogs(); if (S.screen === 'deal') go('deal', 'won'); toast('Угоду виграно. Подію «угоду виграно» надіслано.'); };
function requiredDialog(title, stage, done, showErr = false) {
  const E = showErr ? 'aria-invalid="true"' : '', T = showErr ? 'Заповніть це поле.' : '';
  const d = openDialog(`${dlgHead('Заповніть обов’язкові поля', `На етапі «${stage.name}» ці поля обов’язкові. Угода «${esc(title)}».`)}
    <form class="dlg-b" novalidate id="reqf">
      <div class="field"><label class="label" for="rq1">Пакет</label><select id="rq1" class="select" ${E} aria-describedby="rq1e"><option value="">Не вибрано</option><option>START</option><option>PRO</option><option>MAX</option></select><p class="error" id="rq1e" role="alert">${T}</p></div>
      <div class="field"><label class="label" for="rq2">Тип закриття</label><select id="rq2" class="select" ${E} aria-describedby="rq2e"><option value="">Не вибрано</option><option>Бронь + доплата</option><option>Повна оплата</option><option>Розстрочка</option></select><p class="error" id="rq2e" role="alert">${T}</p></div>
    </form>
    <div class="dlg-f"><button class="btn quiet sm" data-close>Залишити на етапі</button><button class="btn primary sm" id="reqok">Зберегти й перемістити</button></div>`);
  $('#reqok', d).onclick = () => {
    const bad = ['rq1', 'rq2'].filter((id) => !$('#' + id, d).value);
    ['rq1', 'rq2'].forEach((id) => { const el = $('#' + id, d); const b = !el.value; el.toggleAttribute('aria-invalid', b); if (!b) el.removeAttribute('aria-invalid'); $('#' + id + 'e', d).textContent = b ? 'Заповніть це поле.' : ''; });
    if (bad.length) return;
    d.close(); done?.();
  };
}

/* ---------- cursor light (CursorLight) ---------- */
function cursorLight() {
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  if (!fine.matches || calm.matches) return;
  const layer = Object.assign(document.createElement('div'), { className: 'cl' });
  const spot = Object.assign(document.createElement('div'), { className: 'spot' });
  layer.setAttribute('aria-hidden', 'true'); layer.append(spot); document.body.append(layer);
  const editable = (t) => t instanceof Element && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  let x = 0, y = 0, frame = 0, typing = 0;
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || S.calm) return;
    x = e.clientX; y = e.clientY; layer.dataset.on = '';
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; spot.style.translate = `${x}px ${y}px`; });
  }, { passive: true });
  addEventListener('pointerdown', (e) => {
    if (S.calm || e.button !== 0 || e.pointerType === 'touch' || editable(e.target) || layer.childElementCount > 4) return;
    const wave = Object.assign(document.createElement('i'), { className: 'wave' });
    wave.style.left = `${e.clientX}px`; wave.style.top = `${e.clientY}px`;
    wave.addEventListener('animationend', () => wave.remove(), { once: true });
    layer.append(wave);
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) delete layer.dataset.on; });
  addEventListener('blur', () => delete layer.dataset.on);
  addEventListener('keydown', (e) => {
    if (!editable(e.target)) return;
    layer.dataset.typing = ''; clearTimeout(typing);
    typing = setTimeout(() => delete layer.dataset.typing, 1200);
  }, true);
}

/* ---------- boot ---------- */
function boot() {
  if (S.embed) { $('#proto').remove(); document.body.classList.remove('has-proto'); }
  document.documentElement.toggleAttribute('data-calm', S.calm);
  applyTheme();
  const sync = () => document.documentElement.toggleAttribute('data-hidden', document.visibilityState === 'hidden');
  sync(); document.addEventListener('visibilitychange', sync);
  render();
  if (!S.embed && 'ResizeObserver' in window) new ResizeObserver(syncProtoH).observe($('#proto'));
  cursorLight();
}
