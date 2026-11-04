/* ПРОТОТИП — throwaway. Экраны, часть 1: вход, оболочка, канбан, карточка сделки, список, контакт, организация, стани елементів. */
'use strict';

const G = (...ids) => ids.map((id) => [id, GENERIC[id]]);
const def = (id, cfg) => { SCREENS[id] = cfg; };
const ph = (title, { back, meta, actions, lead } = {}) => `<div class="ph">${back ? `<a class="back" href="${back[0]}">${ic('back', 14)}${back[1]}</a>` : ''}<div class="ph-row"><div style="display:grid;gap:6px;min-width:0">${meta ? `<div class="ml meta">${meta}</div>` : ''}<h1 class="h1" tabindex="-1">${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}</div>${actions ? `<div class="ph-actions">${actions}</div>` : ''}</div></div>`;
const sec = (title, body, { right = '', flush = false, label } = {}) => `<section class="panel"${label ? ` aria-label="${label}"` : ''}><div class="sh"><h2 class="h2">${title}</h2>${right ? `<div class="ml meta">${right}</div>` : ''}</div><div class="sb${flush ? ' flush' : ''}">${body}</div></section>`;
const field = (id, label, input, { hint, err, opt } = {}) => `<div class="field"><label class="label" for="${id}">${label}${opt ? '<span class="opt">необов’язково</span>' : ''}</label>${input}${hint ? `<p class="hint" id="${id}-h">${hint}</p>` : ''}${err ? `<p class="error" id="${id}-e" role="alert">${err}</p>` : ''}</div>`;
const inp = (id, val = '', { type = 'text', ph: p = '', err, cls = '', extra = '' } = {}) => `<input id="${id}" class="input ${cls}" type="${type}" value="${esc(val)}" placeholder="${esc(p)}" ${err ? `aria-invalid="true" aria-describedby="${id}-e"` : ''} ${extra}>`;
const sel = (id, opts, cur, { cls = '', err } = {}) => `<select id="${id}" class="select ${cls}" ${err ? 'aria-invalid="true"' : ''}>${opts.map((o) => `<option ${o === cur ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
const skRows = (n, wide = 70) => Array.from({ length: n }, (_, i) => `<div class="row" aria-hidden="true"><span class="sk" style="font-size:15px"><span class="bar" style="--w:${wide - (i % 3) * 12}%"></span><span class="bar" style="--w:${wide - 34 + (i % 2) * 10}%"></span></span></div>`).join('');

/* ================= AUTH ================= */
const authTop = () => `<header class="top"><div class="top-in"><a class="logo" href="#/signin/default" aria-label="Alpi CRM"><span class="mk" aria-hidden="true"></span>alpi<small>crm</small></a><div class="top-end">
  <div class="track"><span class="vh" id="al">Мова</span><div role="radiogroup" aria-labelledby="al" class="options"><button type="button" role="radio" class="option" data-lang="uk" aria-checked="${S.lang === 'uk'}">UA</button><button type="button" role="radio" class="option" data-lang="ru" aria-checked="${S.lang === 'ru'}">RU</button></div></div>
  <div class="track"><span class="group" id="at">Тема</span><div role="radiogroup" aria-labelledby="at" class="options"><button type="button" role="radio" class="option" data-theme-opt="dark" aria-checked="${S.theme === 'dark'}">Темна</button><button type="button" role="radio" class="option" data-theme-opt="light" aria-checked="${S.theme === 'light'}">Світла</button></div></div>
  </div></div></header>`;
const auth = (label, body, state) => `${authTop()}<main id="main" class="auth-main">${state === 'offline' ? `<div style="width:100%;max-width:28rem">${offlineBar()}</div>` : ''}<section class="panel auth" aria-label="${label}">${body}</section></main>`;

def('signin', {
  title: 'Вхід', group: '1. Вхід', shell: false,
  states: [['default', 'Звичайний'], ['validation', 'Порожні поля'], ['error', 'Невірний пароль'], ['busy', 'Надсилання'], ['locked', 'Заблоковано'], ['offline', 'Офлайн']],
  render(s) {
    const v = s === 'validation', e = s === 'error', b = s === 'busy', l = s === 'locked';
    return auth('Вхід', `<h1 class="h1" tabindex="-1">Вхід</h1>
      <form class="form" novalidate ${b ? 'aria-busy="true"' : ''} data-form="signin">
        ${field('em', 'Email', inp('em', v ? '' : 'olena.koval@example.com', { type: 'email', ph: 'name@example.com', err: v, extra: 'autocomplete="username"' }), { err: v ? 'Вкажіть email.' : '' })}
        ${field('pw', 'Пароль', inp('pw', v ? '' : 'Prototype-pass-26', { type: 'password', err: v || e, extra: 'autocomplete="current-password"' }), { err: v ? 'Вкажіть пароль.' : e ? 'Email або пароль не підійшли. Залишилось спроб: 3.' : l ? '' : '' })}
        ${l ? `<div class="notice">Забагато невдалих спроб. Вхід для цього email відкриється через <b class="num" style="font-weight:500">14:52</b>. Якщо це були не ви, скажіть адміністратору.</div>` : ''}
        <div class="actions"><button class="btn primary" type="submit" ${b ? 'disabled aria-busy="true"' : ''} ${l ? 'disabled' : ''}>${b ? 'Перевіряємо…' : 'Увійти'}</button><a class="btn quiet" href="#/temp-password/default">Забули пароль?</a></div>
      </form>
      <p class="meta-prose note">Облікові записи створює адміністратор проєкту. Своєї реєстрації немає. Після пароля система попросить код із застосунку автентифікації.</p>`, s);
  },
  after() { $('[data-form="signin"]')?.addEventListener('submit', (ev) => { ev.preventDefault(); const em = $('#em'), pw = $('#pw'); if (!em.value || !pw.value) { go('signin', 'validation'); return; } go('twofa', 'totp'); }); },
});

def('twofa', {
  title: 'Код 2FA', group: '1. Вхід', shell: false,
  states: [['totp', 'Код із застосунку'], ['backup', 'Резервний код'], ['error', 'Невірний код'], ['busy', 'Перевірка']],
  render(s) {
    const bk = s === 'backup', e = s === 'error', b = s === 'busy';
    return auth('Двофакторний вхід', `<div style="display:grid;gap:8px"><h1 class="h1" tabindex="-1">${bk ? 'Резервний код' : 'Код входу'}</h1><p class="lead">${bk ? 'Введіть один із 10 кодів, які ви зберегли під час налаштування. Кожен код працює один раз.' : 'Відкрийте застосунок автентифікації (Google Authenticator, 1Password, Authy) і введіть шість цифр для «Alpi CRM».'}</p></div>
      <form class="form" novalidate data-form="twofa">
        ${bk ? field('bc', 'Резервний код', inp('bc', '', { ph: 'xxxx-xxxx', cls: 'mono', extra: 'autocomplete="one-time-code" spellcheck="false"' }), { hint: 'Залишилось невикористаних кодів: 7.' })
          : field('code', 'Шість цифр', inp('code', e ? '418 207' : b ? '381 942' : '', { cls: 'code6', err: e, ph: '000 000', extra: 'inputmode="numeric" autocomplete="one-time-code" maxlength="16" spellcheck="false"' }), { hint: e ? '' : 'Код оновлюється кожні 30 секунд.', err: e ? 'Код не підійшов. Перевірте час на телефоні й спробуйте новий код. Залишилось спроб: 4.' : '' })}
        <div class="actions"><button class="btn primary" type="submit" ${b ? 'disabled aria-busy="true"' : ''}>${b ? 'Перевіряємо…' : 'Увійти'}</button>
        ${bk ? '<a class="btn quiet" href="#/twofa/totp">Код із застосунку</a>' : '<a class="btn quiet" href="#/twofa/backup">Немає телефона? Резервний код</a>'}
        <a class="btn quiet" href="#/signin/default">Назад до пароля</a></div>
      </form>`, s);
  },
  after() { $('[data-form="twofa"]')?.addEventListener('submit', (ev) => { ev.preventDefault(); const c = $('#code'); if (c && c.value.replace(/\D/g, '').length !== 6) { go('twofa', 'error'); return; } toast('Вхід виконано.'); go('dashboard'); }); },
});

function qrSvg() {
  const n = 25; let cells = '';
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const finder = (x, y) => `<rect x="${x}" y="${y}" width="7" height="7" fill="#0A0B0C"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="#0A0B0C"/>`;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const inF = (x < 8 && y < 8) || (x > 16 && y < 8) || (x < 8 && y > 16);
    if (!inF && rnd() > 0.52) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  }
  return `<svg viewBox="0 0 25 25" shape-rendering="crispEdges" role="img" aria-label="QR-код для застосунку автентифікації"><g fill="#0A0B0C">${cells}</g>${finder(0, 0)}${finder(18, 0)}${finder(0, 18)}</svg>`;
}
def('twofa-setup', {
  title: 'Налаштування 2FA', group: '1. Вхід', shell: false,
  states: [['default', 'QR-код'], ['error', 'Невірний код'], ['done', 'Резервні коди']],
  render(s) {
    if (s === 'done') return auth('Резервні коди', `<div style="display:grid;gap:8px"><h1 class="h1" tabindex="-1">Збережіть резервні коди</h1><p class="lead">Двофакторний вхід увімкнено. Якщо телефон загубиться, увійти можна одним із цих кодів. Кожен працює один раз.</p></div>
      <div class="secret"><div class="backup-codes">${['4k7q-9xm2', 'p3rt-8v6c', 'h2wz-5n4j', 'q9dk-7b3s', 'm6tf-2y8r', 'c5lp-4w9a', 'x8gn-3e7u', 'v2hb-6q5k', 'j7ra-9m2d', 'e4sy-8c6t'].map((c) => `<span class="mono" style="font-size:14px">${c}</span>`).join('')}</div>
      <div class="actions"><button class="btn ghost sm" data-act="copy">${ic('copy', 14)}Скопіювати</button><button class="btn ghost sm" data-act="copy">${ic('down', 14)}Завантажити .txt</button></div></div>
      <p class="meta-prose">Ми показуємо коди один раз. Нові коди можна створити в профілі, старі тоді перестануть діяти.</p>
      <div class="actions"><a class="btn primary" href="#/dashboard/default">Я зберегла коди</a></div>`, s);
    const e = s === 'error';
    return auth('Налаштування двофакторного входу', `<div style="display:grid;gap:8px"><p class="meta">крок <b>2</b> з 3</p><h1 class="h1" tabindex="-1">Двофакторний вхід</h1><p class="lead">Без нього в CRM не увійти. Це захищає дані клієнтів, навіть якщо пароль витече.</p></div>
      <ol class="steps"><li>Встановіть застосунок автентифікації: Google Authenticator, 1Password або Authy.</li><li>Відскануйте QR-код або введіть ключ вручну.</li><li>Введіть шість цифр, які покаже застосунок.</li></ol>
      <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap"><div class="qr">${qrSvg()}</div>
        <div style="display:grid;gap:6px;min-width:0;flex:1 1 160px"><span class="meta">ключ для ручного введення</span><span class="mono" style="font-size:13px;overflow-wrap:anywhere">JBSW Y3DP EHPK 3PXP Q7RT 2MZL</span><button class="btn ghost sm" style="justify-self:start" data-act="copy">${ic('copy', 14)}Скопіювати ключ</button></div></div>
      <form class="form" novalidate data-form="setup">${field('sc', 'Код із застосунку', inp('sc', e ? '112 900' : '', { cls: 'code6', err: e, ph: '000 000', extra: 'inputmode="numeric" autocomplete="one-time-code"' }), { err: e ? 'Код не підійшов. Переконайтеся, що відсканували QR саме цієї сторінки.' : '' })}
      <div class="actions"><button class="btn primary" type="submit">Увімкнути</button></div></form>`, s);
  },
  after() { $('[data-form="setup"]')?.addEventListener('submit', (ev) => { ev.preventDefault(); go('twofa-setup', $('#sc').value.replace(/\D/g, '').length === 6 ? 'done' : 'error'); }); },
});

def('temp-password', {
  title: 'Зміна тимчасового пароля', group: '1. Вхід', shell: false,
  states: [['default', 'Звичайний'], ['validation', 'Помилки'], ['success', 'Збережено']],
  toast: 'Пароль змінено.',
  render(s) {
    const v = s === 'validation', ok = s === 'success';
    const rules = [['щонайменше 12 символів', v ? 'bad' : ok ? 'ok' : 'ok'], ['не збігається з тимчасовим', 'ok'], ['не з переліку злитих паролів', v ? 'bad' : ok ? 'ok' : '']];
    return auth('Зміна тимчасового пароля', `<div style="display:grid;gap:8px"><p class="meta">крок <b>1</b> з 3</p><h1 class="h1" tabindex="-1">Новий пароль</h1><p class="lead">Ви увійшли з тимчасовим паролем від адміністратора. Придумайте свій, тимчасовий після цього перестане діяти.</p></div>
      <form class="form" novalidate data-form="tp">
        ${field('np', 'Новий пароль', inp('np', v ? 'qwerty2026' : 'Prototype-pass-26', { type: 'password', err: v, extra: 'autocomplete="new-password"' }), { err: v ? 'Пароль закороткий і є в переліку злитих.' : '' })}
        <ul class="pw-rules" aria-label="Вимоги до пароля">${rules.map(([t, c]) => `<li class="${c}"><i aria-hidden="true"></i>${t}</li>`).join('')}</ul>
        ${field('np2', 'Ще раз', inp('np2', v ? 'qwerty2025' : 'Prototype-pass-26', { type: 'password', err: v, extra: 'autocomplete="new-password"' }), { err: v ? 'Паролі не збігаються.' : '' })}
        <div class="actions"><button class="btn primary" type="submit">${ok ? 'Далі: двофакторний вхід' : 'Зберегти пароль'}</button>${v ? '<p class="error" role="alert">Перевірте поля у формі.</p>' : ''}</div>
      </form>`, s);
  },
  after(s) { $('[data-form="tp"]')?.addEventListener('submit', (ev) => { ev.preventDefault(); go(s === 'success' ? 'twofa-setup' : 'temp-password', s === 'success' ? 'default' : 'success'); }); },
});

/* ================= SHELL ================= */
def('shell', {
  title: 'Шапка й навігація', group: '2. Оболонка', nav: 'dashboard', what: 'панель',
  states: [['default', 'Звичайний'], ['proj', 'Перемикач проєкту'], ['search', 'Пошук Ctrl K'], ['notif', 'Сповіщення'], ['me', 'Меню користувача'], ['offline', 'Офлайн']],
  render() { return SCREENS.dashboard.render('default'); },
  after(s) {
    SCREENS.dashboard.after?.('default');
    const map = { proj: '[data-act="pop-proj"]', notif: '[data-act="pop-notif"]', me: '[data-act="pop-me"]' };
    if (map[s]) setTimeout(() => $(map[s])?.click(), 50);
    if (s === 'search') setTimeout(() => openSearch(), 50);
  },
});

/* ================= KANBAN ================= */
const sumsLine = (sums) => {
  const ks = Object.keys(sums);
  if (!ks.length) return '<span class="meta">сум немає</span>';
  const total = ks.reduce((a, k) => a + sums[k] * RATES[k], 0);
  return `<div class="sums meta">${ks.map((k) => `<span>${fmt(sums[k])} ${SYM[k]}</span>`).join('')}</div><div class="meta total">разом ≈ <b>${fmt(total)} ₴</b></div>`;
};
const kcard = (c, stage) => `<article class="kcard" tabindex="0" data-id="${c.id}" aria-label="Угода ${esc(c.t)}">
  <div class="ml meta"><span>№ ${c.id}</span>${c.src ? `<span>${c.src}</span>` : ''}</div>
  <div class="t">${esc(c.t)}</div>
  ${c.t !== c.c ? `<div class="meta-prose">${esc(c.c)}</div>` : ''}
  <div class="row2">${money(c.a, c.cur)}${st(c.task[0], c.task[1] || taskText(c.task[0]))}</div>
  <div class="row2">${c.r ? `<span class="meta">${who(c.r)}</span>` : `<span class="st" data-t="muted"><i aria-hidden="true"></i>загальна черга</span><button type="button" class="btn pill" data-act="take">Взяти в роботу</button>`}</div>
</article>`;
function board(stages = STAGES) {
  return `<div class="stage-tabs tabs bare" role="tablist" aria-label="Етапи">${stages.map((s) => `<button type="button" class="tab" role="tab" data-act="mstage" data-s="${s.id}" aria-selected="${S.mobileStage === s.id}">${s.name}<span class="count">${fmt(s.count)}</span></button>`).join('')}</div>
  <div class="board" aria-label="Канбан воронки ALPI">${stages.map((s) => `<section class="kcol ${s.queue ? 'queue' : ''} ${S.mobileStage === s.id ? 'mobile-on' : ''}" data-stage="${s.id}" aria-label="Етап ${s.name}">
    <header class="kh"><div class="name"><span class="ellip">${s.name}</span><span class="n meta"><b>${fmt(s.count)}</b></span></div>
    ${s.queue ? '<span class="meta-prose">загальна черга: угоди без відповідального</span>' : sumsLine(s.sums)}
    ${s.required ? `<span class="meta-prose ask">обов’язкові: ${s.required.join(', ')}</span>` : ''}</header>
    <div class="kcards">${(CARDS[s.id] || []).map((c) => kcard(c, s)).join('')}${s.queue ? `<a class="kmore" href="#/deals/default">ще ${fmt(s.count - CARDS[s.id].length)} відкрити списком</a>` : ''}</div>
  </section>`).join('')}</div>`;
}
const kanbanHead = (pressed = 'all') => `${ph('Воронка ALPI', { meta: `<span><b>1 432</b> відкриті угоди без першого етапу</span><span>курс НБУ на ${TODAY}: 1 € = 48,12 ₴, 1 $ = 41,62 ₴</span>`, actions: `<div class="tabs bare" role="tablist"><a class="tab" aria-current="page" href="#/kanban/default">Канбан</a><a class="tab" href="#/deals/default">Список</a></div><button class="btn primary sm" data-act="new-deal">${ic('plus', 14)}Нова угода</button>` })}
  <div class="toolbar">
    <select class="select sm" style="width:auto" aria-label="Воронка"><option>ALPI</option><option>Платформа (допродаж)</option></select>
    ${[['mine', 'Мої'], ['team', 'Моя команда'], ['all', 'Усі'], ['queue', 'Без відповідального']].map(([k, l]) => `<button type="button" class="fchip nox" aria-pressed="${pressed === k}" data-act="kfilter" data-k="${k}">${l}</button>`).join('')}
    <button class="btn ghost sm hide-m">${ic('filter', 14)}Фільтр</button>
    <span class="sp"></span>
    <div class="legend hide-m" aria-label="Наступна задача">${st('overdue', 'прострочена')}${st('today', 'сьогодні')}${st('future', 'пізніше')}${st('none', 'немає задачі')}</div>
  </div>`;
def('kanban', {
  title: 'Канбан угод', group: '3. Угоди', what: 'воронку',
  states: [['default', 'Звичайний'], ['drag', 'Перетягування'], ['validation', 'Обов’язкові поля'], ['lost', 'Причина програшу'], ['won', 'Підтвердження'], ['success', 'Переміщено (тост)'], ['loading', 'Завантаження'], ['empty', 'Порожньо'], ['error', 'Помилка'], ['offline', 'Офлайн']],
  render(s) {
    if (s === 'loading') return `${kanbanHead()}<div class="board" aria-busy="true">${STAGES.slice(0, 6).map((x, i) => `<section class="kcol ${i === 5 ? 'mobile-on' : ''}"><div class="kh"><span class="sk" style="font-size:14px"><span class="bar" style="--w:70%"></span><span class="bar" style="--w:45%"></span></span></div><div class="kcards">${Array.from({ length: 3 - (i % 2) }, () => '<span class="bar tall" aria-hidden="true"></span>').join('')}</div></section>`).join('')}</div>`;
    if (s === 'empty') return `${kanbanHead()}${emptyBox('У воронці ще немає угод.', 'Угоди з’являться, коли лендинг або вебінарна платформа надішле першу реєстрацію. Можна створити угоду й вручну.', `<button class="btn primary sm" data-act="new-deal">${ic('plus', 14)}Нова угода</button><a class="btn ghost sm" href="#/apikeys/default">Ключі для джерел</a>`)}`;
    if (s === 'error') return `${kanbanHead()}${generic('error', 'воронку')}`;
    return `${kanbanHead()}${board()}`;
  },
  after(s) {
    bindBoard();
    const tb = $('.stage-tabs'), on = $('.stage-tabs [aria-selected="true"]');
    if (tb && on) tb.scrollLeft = on.offsetLeft - 16;
    if (s === 'drag') staticDrag();
    if (s === 'validation') requiredDialog('Павло Сидоренко', STAGES[6], null, true);
    if (s === 'lost') lostDialog('Павло Сидоренко');
    if (s === 'won') wonDialog('Марта Гаврилюк');
    if (s === 'success') {
      const card = $('[data-id="4510"]'), col = $('[data-stage="s7"] .kcards');
      if (card && col) { col.prepend(card); card.classList.add('landed'); bump($('[data-stage="s6"]'), -1); bump($('[data-stage="s7"]'), 1); }
      toast('«Павло Сидоренко» → етап «Сплатив бронювання».', { action: 'Скасувати' });
    }
  },
});
function staticDrag() {
  const card = $('[data-id="4510"]');
  if (!card) return;
  const bd = $('.board'), c6 = $('[data-stage="s5"]');
  if (innerWidth > 640 && bd && c6) bd.scrollLeft = c6.offsetLeft - bd.offsetLeft;
  const r = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add('lifted');
  card.classList.add('placeholder');
  document.body.insertAdjacentHTML('beforeend', dropZones());
  const mobile = innerWidth <= 640;
  let x, y, w = r.width;
  if (mobile) { const z = $('.dz.lost'); z.classList.add('over'); const zr = z.getBoundingClientRect(); w = Math.min(r.width, zr.width * 1.2); x = zr.right - w; y = zr.top - 150; }
  else { const t = $('[data-stage="s7"]'); t.classList.add('over'); const tr = t.getBoundingClientRect(); x = tr.left + 30; y = tr.top + 120; }
  Object.assign(ghost.style, { left: x + 'px', top: y + 'px', width: w + 'px' });
  document.body.append(ghost);
}
Object.assign(ACT, {
  mstage: (b) => { S.mobileStage = b.dataset.s; $$('.stage-tabs .tab').forEach((t) => t.setAttribute('aria-selected', String(t === b))); $$('.kcol').forEach((c) => c.classList.toggle('mobile-on', c.dataset.stage === S.mobileStage)); },
  take: (b) => { const c = b.closest('.kcard'); b.parentElement.innerHTML = `<span class="meta">Олена Коваль</span>${st('none', 'немає задачі')}`; c.classList.remove('landed'); void c.offsetWidth; c.classList.add('landed'); toast('Угоду взято в роботу. Ви відповідальна, подію «відповідального змінено» надіслано.'); },
  kfilter: (b) => { $$('[data-act="kfilter"]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); if (b.dataset.k === 'queue') { $$('.kcard').forEach((c) => { c.hidden = !c.querySelector('[data-act="take"]'); }); } else $$('.kcard').forEach((c) => { c.hidden = false; }); },
  'new-deal': () => openDialog(`${dlgHead('Нова угода', 'Воронка ALPI, етап «Новий лід».')}<form class="dlg-b" novalidate>
      ${field('nd1', 'Контакт', inp('nd1', '', { ph: 'Ім’я, телефон або email' }), { hint: 'Якщо телефон уже є в іншого менеджера, побачите «клієнт уже в роботі».' })}
      <div class="grid2">${field('nd2', 'Сума', inp('nd2', '', { ph: '0', cls: 'num' }), { opt: true })}${field('nd3', 'Валюта', sel('nd3', ['EUR', 'UAH', 'USD'], 'EUR'))}</div>
      ${field('nd4', 'Відповідальний', sel('nd4', ['Олена Коваль', 'Без відповідального (загальна черга)'], 'Олена Коваль'))}</form>
      <div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="nd-ok">Створити</button></div>`),
  'nd-ok': () => { const c = $('#nd1'); if (!c.value) { c.setAttribute('aria-invalid', 'true'); if (!$('#nd1-e')) c.insertAdjacentHTML('afterend', '<p class="error" id="nd1-e" role="alert">Вкажіть контакт.</p>'); return; } closeDialogs(); toast('Угоду створено.'); },
  copy: () => toast('Скопійовано.'),
});

/* ================= DEAL ================= */
const PATH = STAGES.map((s) => s.name);
const tlItem = (icn, tone, what, meta, extra = '') => `<li><span class="ic ${tone}">${ic(icn, 12)}</span><div class="body"><div class="what">${what}</div>${extra}<div class="ml meta">${meta}</div></div></li>`;
function timeline() {
  return `<ul class="tl">
    ${tlItem('phone', 'ask', '<b style="font-weight:500">Пропущений вхідний дзвінок</b> з +380 00 123 45 67', '<span>сьогодні 09:12</span><span>Unitalk</span>')}
    ${tlItem('task', '', 'Задача «Очікую оплату» на 06.11', '<span>03.11 16:41</span><span>Олена Коваль</span>')}
    ${tlItem('pay', 'acc', 'Виставлено рахунок <span class="money">590 €</span>', '<span>03.11 16:40</span><span>Олена Коваль</span><span>WayForPay</span>')}
    ${tlItem('note', '', 'Нотатка', '<span>01.11 12:15</span><span>Олена Коваль</span>', '<div class="note">Доплатила 500 €. Залишок 590 € — чекає зарплату, обіцяла до 06.11.</div>')}
    ${tlItem('pay', 'acc', 'Платіж успішний: доплата <span class="money">500 €</span>', '<span>01.11 12:10</span><span>картка **** 4417</span><span>курс 48,02</span>')}
    ${tlItem('reg', '', 'Нова реєстрація: Google Ads, кампанія <span class="ctag">search_ai_kurs</span>', '<span>31.10 18:30</span><span>джерело «Лендинг ai-video»</span>')}
    ${tlItem('pay', 'acc', 'Платіж успішний: бронь <span class="money">200 €</span>', '<span>30.10 14:03</span><span>картка **** 4417</span>')}
    ${tlItem('stage', '', '<span class="chg">Етап: <b>Був на вебінарі</b> → <b>Приймає рішення</b></span>', '<span>29.10 11:24</span><span>Олена Коваль</span>')}
    ${tlItem('phone', '', 'Вхідний дзвінок, 12:48', '<span>29.10 11:05</span><span>Олена Коваль</span>', `<div class="player"><button class="play" aria-label="Прослухати запис">${ic('play', 12)}</button><span class="wave" aria-hidden="true"></span><span class="meta">4:52 / 12:48</span></div>`)}
    ${tlItem('stage', '', '<span class="chg">Етап: <b>Новий лід</b> → <b>Був на вебінарі</b>, поле «Перегляд, %»: <b>86</b></span>', '<span>28.10 21:40</span><span>ключ API «Make: вебінари»</span>')}
    ${tlItem('reg', '', 'Реєстрація на вебінар «AI-контент з нуля»: Facebook Ads', '<span>26.10 19:02</span><span>угоду створено</span>')}
  </ul>`;
}
/* Deal card in the layout of Pipedrive's deal view, measured from the owner's account: full-width header (title,
   owner, Won/Lost, stage bar, «pipeline → stage» link), then two columns with their own scroll — collapsible blocks
   of fields on the left (raised surface), composer / Фокус / Історія on the right (page background).
   Only the layout and density are borrowed; colours, fonts and radii are Actum's. Rights are those of the prototype
   user (role «Менеджер», ALPI). */
const DEAL_T = 'Ірина Мельник — AI-контент PRO';
const DEAL_RIGHTS = { archive: true, upsell: true, del: false };
const DEAL_DAYS = [2, 0, 1, 0, 0, 6, 1, 1, 0]; // days the deal spent on each stage
const D = { cur: 5, s: 'default' };
Object.assign(IC, {
  cash: '<rect x="1.5" y="4" width="13" height="8" rx="1.2"/><circle cx="8" cy="8" r="1.8"/><path d="M4 6.5v3M12 6.5v3"/>',
  scale: '<path d="M8 2.5v11M4.5 13.5h7M3 4.5h10"/><path d="M3 4.5L1.5 8.5a1.6 1.6 0 0 0 3 0zM13 4.5l-1.5 4a1.6 1.6 0 0 0 3 0z"/>',
  tag: '<path d="M2.5 2.5h5.2l6 6-5.2 5.2-6-6z"/><circle cx="5.3" cy="5.3" r=".9"/>',
  flag: '<path d="M3.5 14V2.5M3.5 3h8l-1.6 3 1.6 3h-8"/>',
  info: '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.6M8 5.1h.01"/>',
  pin: '<path d="M6 2.5h4M6.7 2.5v3.8L4.5 9h7L9.3 6.3V2.5M8 9v4.5"/>',
  fold: '<path d="M5 2.5L8 5.5l3-3M5 13.5l3-3 3 3"/>',
  grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  chat: '<path d="M2.5 13.5l1-3a5.5 5.5 0 1 1 2 2z"/><path d="M6 6.5c0 2 1.5 3.5 3.5 3.5l1-1-1.5-.8-.7.6a3 3 0 0 1-1.6-1.6l.6-.7L6.5 5z"/>',
  doc: '<path d="M4 1.5h5.5l3 3v10H4z"/><path d="M9.5 1.5v3h3M6 8h4.5M6 10.5h4.5"/>',
  sub: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5a5 5 0 0 1 10 0"/><path d="M12.5 2v3M11 3.5h3"/>',
});
const dayW = (n) => { const a = Math.abs(n) % 100, b = a % 10; return `${n} ${a > 10 && a < 20 ? 'днів' : b === 1 ? 'день' : b >= 2 && b <= 4 ? 'дні' : 'днів'}`; };
const ME = 'Олена Коваль';
const ib = (icn, label, act, extra = '') => `<button type="button" class="ib" ${act ? `data-act="${act}"` : ''} aria-label="${label}" title="${label}" ${extra}>${ic(icn, 16)}</button>`;
const moreB = (label, act = 'blk-more') => `<span class="me-wrap">${ib('more', label, act, 'aria-haspopup="menu" aria-expanded="false"')}</span>`;
const chevB = (title, open, cls = '') => `<button type="button" class="tog ${cls}" data-act="tog" aria-expanded="${open}">${ic('chev', 16)}<span>${title}</span></button>`;
/* collapsible block of the left column: 56px header (chevron, title, icons), body without gaps */
const blk = (id, title, body, { open = true, icons = '', cls = '' } = {}) => `<section class="blk tog-box ${cls}" data-blk="${id}" aria-label="${title}">
  <div class="blk-h">${chevB(title, open, 'blk-t')}<div class="blk-i">${icons}</div></div>
  <div class="blk-b tog-b" ${open ? '' : 'hidden'}>${body}</div></section>`;
/* field row: label column 100px right-aligned, value column; editable values are buttons */
const fld = (f, label, val, { edit = '', need = false, info = '', ro = false, empty = false, jump = false } = {}) => `<div class="dfl${need ? ' need' : ''}${ro ? ' ro' : ''}" data-f="${f}">
  <span class="k">${label}${info ? `<span class="inf" title="${info}" aria-label="${info}" role="img">${ic('info', 12)}</span>` : ''}</span>
  ${ro ? `<span class="v">${val}</span>` : `<button type="button" class="v fv${empty ? ' empty' : ''}" data-act="${jump ? 'fill' : 'fedit'}" ${edit ? `data-opts="${edit}"` : ''} aria-label="${label.replace(/<[^>]+>/g, '')}: ${empty ? 'не заповнено' : String(val).replace(/<[^>]+>/g, '')}, змінити">${empty ? '—' : val}${ic('pen', 14)}</button>`}</div>`;
/* field group of «Деталі»: bordered accordion card, 48px header with counter chip filled/total */
const grp = (id, title, rows, { open = true, ro = false, total } = {}) => {
  const filled = rows.filter((r) => !r.includes(' empty"') && !r.includes('class="v fv empty')).length;
  return `<div class="fgrp tog-box" data-grp="${id}"><div class="fgrp-h">${chevB(title, open, 'fgrp-t')}<span class="cnt" title="Заповнено ${filled} з ${total || rows.length}">${filled}/${total || rows.length}</span>${ro ? `<span class="ro-m" title="Лише перегляд для ролі «Менеджер»">${ic('lock', 12)}лише перегляд</span>` : ''}<span class="fgrp-i">${moreB(`Дії з групою «${title}»`)}</span></div>
    <div class="fgrp-b tog-b" ${open ? '' : 'hidden'}>${rows.join('')}</div></div>`;
};
const chg = (f, was, now) => `<span class="chg">${f}: <span class="was">${was}</span><span class="arrow" aria-label="стало">→</span><span class="now">${now}</span></span>`;

/* ---------- header ---------- */
function stageBar(s, cur) {
  const mode = s === 'won' ? 'won' : s === 'lost' ? 'lost' : s === 'archived' ? 'arch' : '';
  return `<div class="dv-stages ${mode}" role="group" aria-label="Етапи воронки ALPI${mode ? ', угода закрита' : ''}">${PATH.map((n, i) => {
    const t = i === cur ? `${dayW(DEAL_DAYS[i])} · ${n}` : n;
    return `<button type="button" class="sg ${i < cur ? 'done' : i === cur ? 'cur' : ''}" data-act="path" data-i="${i}" ${i === cur ? 'aria-current="step"' : ''} title="${n}${i <= cur ? `: ${dayW(DEAL_DAYS[i])} на етапі` : ''}" ${mode ? 'disabled' : ''}><span>${t}</span></button>`;
  }).join('')}</div>`;
}
function dealHeader(s, cur) {
  const won = s === 'won', lost = s === 'lost', arch = s === 'archived';
  const act = won ? `<span class="dv-badge win">${ic('check', 14)}Виграно 04.11</span><button type="button" class="dv-btn ghost-b" data-act="reopen">Відкрити знову</button>`
    : lost ? `<span class="dv-badge lose">Програно 04.11</span><button type="button" class="dv-btn ghost-b" data-act="reopen">Відкрити знову</button>`
    : arch ? `<span class="dv-badge">${ic('arch', 14)}В архіві з 04.11</span><button type="button" class="dv-btn ghost-b" data-act="unarch">Повернути з архіву</button>`
    : '<button type="button" class="dv-btn win-b" data-act="d-won">Виграно</button><button type="button" class="dv-btn lose-b" data-act="d-lost">Програно</button>';
  return `<header class="dv-head">
    <div class="dv-r1">
      <h1 class="dv-title" id="d-title" data-act="edit-title" title="Натисніть, щоб змінити назву">${DEAL_T}</h1>
      <div class="dv-acts">
        <button type="button" class="dv-owner" data-act="transfer" title="Передати угоду"><span class="ava" aria-hidden="true">ОК</span><span class="o-t"><b>${ME}</b><span>Власник</span></span></button>
        <span class="me-wrap"><button type="button" class="dv-btn ghost-b" data-act="subs" aria-haspopup="menu" aria-expanded="false">1 підписник${ic('chev', 14)}</button></span><span class="brk" aria-hidden="true"></span>
        ${act}
        <span class="me-wrap"><button type="button" class="dv-btn ghost-b view-b" data-act="view-sw" aria-label="Вигляд картки" aria-haspopup="menu" aria-expanded="false">${ic('grid', 16)}${ic('chev', 14)}</button></span>
        <span class="me-wrap"><button type="button" class="dv-btn ghost-b more-b" data-act="deal-more" aria-label="Інші дії з угодою" aria-haspopup="menu" aria-expanded="false">${ic('more', 16)}</button></span>
      </div>
    </div>
    ${stageBar(s, cur)}
    <div class="dv-path"><span class="me-wrap"><button type="button" class="link-a" data-act="pick-stage" aria-haspopup="menu" aria-expanded="false" ${won || lost || arch ? 'disabled' : ''}>ALPI<span class="arr" aria-hidden="true">→</span><span id="d-stage">${PATH[cur]}</span></button></span></div>
  </header>`;
}

/* ---------- left column ---------- */
function dealLeft(s, amount) {
  const won = s === 'won', lost = s === 'lost', arch = s === 'archived', dup = s === 'duplicate', val = s === 'validation';
  const closed = won || lost || arch;
  /* a) Заповніть: important fields that are still empty */
  const KANAL = 'Facebook Ads|Google Ads|Instagram|Рекомендація';
  const needRows = [fld('kanal', 'Канал', '', { empty: true, need: true, jump: true, info: 'Звідки прийшов клієнт. Потрібне для звіту за джерелами.' })];
  if (val) needRows.push(fld('paket', 'Пакет', '', { empty: true, need: true, jump: true, info: 'Обов’язкове з етапу «Сплатив бронювання».' }), fld('ztype', 'Тип закриття', '', { empty: true, need: true, jump: true, info: 'Обов’язкове з етапу «Сплатив бронювання».' }));
  const fill = blk('fill', 'Заповніть', `<div class="fill-sub">${ic('cash', 14)}Угода</div>${needRows.join('')}`, { icons: ib('pen', 'Налаштувати важливі поля', 'stub') + moreB('Дії з блоком «Заповніть»'), cls: 'fill' });
  /* b) Підсумок: rows of 32px, icon + value; empty ones are call-to-action links */
  const paidP = Math.round(700 / amount * 100);
  const sr = (icn, main, { right = '', edit = '', title = '', cls = '' } = {}) => `<div class="sr ${cls}" ${title ? `title="${title}"` : ''}>${ic(icn, 16)}<div class="sr-v">${main}</div>${edit && !arch ? ib('pen', 'Змінити', edit) : ''}${right ? `<span class="sr-x">${right}</span>` : ''}</div>`;
  const prods = `<div class="sr-sub" id="prod-sub" hidden>
      <div class="prod"><span>AI-контент PRO</span><span class="money">1 190 €</span><span class="meta">1 × 1 190 €</span></div>
      <div class="prod"><span>Модуль «AI-відео»</span><span class="money">100 €</span><span class="meta">1 × 100 €</span></div>
      <div class="prod tot"><span class="meta">сума по товарах</span><span class="money">1 290 €</span></div>
      ${won ? '' : `<div class="diff" id="sumhint"><span class="grow">Сума угоди <b class="num" style="font-weight:500">${fmt(amount)} €</b> відрізняється від суми товарів.</span><button type="button" class="dv-btn ghost-b" data-act="apply-sum" ${arch ? 'disabled' : ''}>Підставити 1 290 €</button></div>`}
      ${arch ? '' : '<button type="button" class="link-a sm-l" data-act="stub">+ Товар</button>'}</div>`;
  const pays = `<div class="sr-sub" id="pay-sub" hidden><div class="prog" role="progressbar" aria-valuenow="${paidP}" aria-valuemin="0" aria-valuemax="100" aria-label="Оплачено"><i style="--p:${paidP}%"></i></div>
      ${[['Бронь', 200, st('ok', 'успішний'), '30.10'], ['Доплата', 500, st('ok', 'успішний'), '01.11'], ['Рахунок', 590, st('wait', 'очікує'), 'до 06.11']].map(([t, a, s2, d]) => `<div class="prod"><span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${t}${s2}</span><span class="money">${a} €</span><span class="meta">${d} · WayForPay</span></div>`).join('')}</div>`;
  const summary = sr('cash', '<span class="money">45 000 ₴</span>', { title: 'Дохід на місяць', edit: 'stub' })
    + sr('cal', '<span class="num">28.10.2026</span>', { title: 'Дата вебінару', edit: 'stub' })
    + sr('cash', `<button type="button" class="sr-amt" data-act="edit-amount" ${arch ? 'disabled' : ''} title="Сума угоди"><span class="money" id="d-sum">${fmt(amount)} €</span></button>${won ? '' : '<button type="button" class="sr-warn" id="sumwarn" data-act="prod-toggle" title="Сума угоди відрізняється від суми товарів">≠ товари 1 290 €</button>'}`,
      { right: `<button type="button" class="link-a" data-act="prod-toggle" aria-expanded="false" aria-controls="prod-sub">${ic('plus', 14)}Товари</button>` }) + prods
    + sr('scale', `<span class="me-wrap"><button type="button" class="link-a" data-act="prob" id="d-prob" aria-haspopup="menu" aria-expanded="false" ${closed ? 'disabled' : ''}>Встановити ймовірність</button></span>`)
    + sr('plus', `<button type="button" class="link-a" data-act="org-attach" ${arch ? 'disabled' : ''}>Організація</button>`, { cls: 'sr-org' })
    + sr('user', `<a href="#/contact/default">Ірина Мельник</a>`, { right: `<span class="me-wrap"><button type="button" class="link-a" data-act="add-part" aria-haspopup="menu" aria-expanded="false" ${arch ? 'disabled' : ''}>${ic('plus', 14)}Учасники</button></span>` })
    + sr('tag', `<span class="labels" id="d-labels"><span class="me-wrap"><button type="button" class="link-a" data-act="add-label" aria-haspopup="menu" aria-expanded="false" ${arch ? 'disabled' : ''}>Додати мітки</button></span></span>`)
    + sr('flag', won || lost ? '<span class="num">04.11.2026</span><span class="meta">закрито</span>' : '<span class="num">06.11.2026</span><span class="meta">через 2 дні</span>', { title: 'Очікувана дата закриття', edit: 'stub' })
    + sr('pay', `<button type="button" class="sr-pay" data-act="pay-toggle" aria-expanded="false" aria-controls="pay-sub">Оплачено <span class="money">700 €</span> з <span class="money">${fmt(amount)} €</span></button>`,
      { right: `<button type="button" class="link-a" data-act="invoice" ${arch || lost ? 'disabled' : ''}>Виставити рахунок</button>` }) + pays;
  /* c) Деталі: groups of fields */
  const pk = val ? fld('paket', 'Пакет', '', { empty: true, need: true, edit: 'START|PRO|MAX' }) : fld('paket', 'Пакет', 'PRO', { edit: 'START|PRO|MAX', ro: won });
  const zt = val ? fld('ztype', 'Тип закриття', '', { empty: true, need: true, edit: 'Бронь + доплата|Повна оплата|Розстрочка' }) : fld('ztype', 'Тип закриття', 'Бронь + доплата', { edit: 'Бронь + доплата|Повна оплата|Розстрочка', ro: won });
  const E = (f, l, o = {}) => fld(f, l, '', { empty: true, ...o });
  const details = grp('qual', 'Кваліфікація', [
    fld('ctype', 'Тип клієнта', 'Найманий працівник', { edit: 'Найманий працівник|Підприємець|Фрилансер|Студент' }),
    fld('prof', 'Професія клієнта', 'Дизайнер'),
    E('kanal', 'Канал', { need: true, edit: KANAL }),
    fld('income', 'Дохід на місяць', '<span class="money">45 000 ₴</span>'),
    E('barrier', 'Бар’єр'), E('motive', 'Головний мотив'),
    fld('support', 'Менеджер саппорту', 'Андрій Шевчук', { info: 'Хто супроводжує після оплати' }),
  ], { total: 12 })
    + grp('web', 'Вебінар', [
      fld('webn', 'Вебінар', '«AI-контент з нуля», 28.10'),
      fld('view', 'Перегляд, %', '<span class="num">86</span>'),
      fld('warm', 'Рівень прогріву', 'Високий', { edit: 'Низький|Середній|Високий' }),
      E('qst', 'Питання з чату'),
    ])
    + grp('course', 'Курс', [pk, zt, E('paydate', 'Дата оплати'), E('flow', 'Потік навчання'), E('cur', 'Куратор')], { open: true })
    + grp('labels', 'Мітки', [fld('hot', 'Теплота', 'Гаряча', { edit: 'Холодна|Тепла|Гаряча' }), fld('rep', 'Повторна реєстрація', 'так', { edit: 'так|ні' }), E('seg', 'Сегмент')], { open: false })
    + grp('svc', 'Службове', [fld('ctr', 'Підрядник', 'Свій таргет', { ro: true }), fld('cpl', 'Вартість реєстрації', '<span class="money">3,10 $</span>', { ro: true })], { ro: true, open: false })
    + `<p class="fgrp-hid">${ic('lock', 14)}Ще 1 група полів прихована для ролі «Менеджер».</p>`;
  /* d) Контакт, e) Організація */
  const contact = `<div class="sr">${ic('user', 16)}<div class="sr-v"><a href="#/contact/default" class="nm">Ірина Мельник</a>${dup ? `<span class="dup-badge">${ic('merge', 12)}можливий дубль</span>` : ''}</div></div>
    ${fld('ph', 'Телефон', '<span class="num">+380 00 123 45 67</span><span class="meta">мобільний</span>')}${fld('em', 'Email', 'iryna.melnyk@example.com')}${fld('lang', 'Мова', 'українська', { edit: 'українська|російська|англійська' })}
    ${dup ? '<div class="diff"><span class="grow">Email збігається з контактом «Iryna M.» (№ 3302).</span><button type="button" class="dv-btn ghost-b" data-act="go" data-to="contact" data-st="duplicate">Порівняти</button></div>' : ''}`;
  const org = `<div class="blk-empty" id="org-body"><p>Організацію не прив’язано.</p><button type="button" class="link-a" data-act="org-attach" ${arch ? 'disabled' : ''}>${ic('plus', 14)}Прив’язати організацію</button></div>`;
  const icons3 = (n) => ib('filter', `Фільтр полів блоку «${n}»`, 'stub') + ib('pen', `Редагувати поля блоку «${n}»`, 'stub') + moreB(`Дії з блоком «${n}»`);
  return `<aside class="dv-left" aria-label="Поля угоди">
    <div class="dv-filter"><label class="vh" for="ffilter">Фільтрувати поля</label>${ic('search', 16)}<input id="ffilter" class="input" type="search" placeholder="Фільтрувати поля" autocomplete="off"></div>
    <p class="ff-none meta-prose" hidden>Полів з такою назвою немає.</p>
    ${fill}
    ${blk('sum', 'Підсумок', summary, { icons: moreB('Дії з блоком «Підсумок»') })}
    ${blk('details', 'Деталі', details, { icons: icons3('Деталі') })}
    ${blk('contact', 'Контакт', contact, { icons: icons3('Контакт') })}
    ${blk('org', 'Організація', org, { icons: moreB('Дії з блоком «Організація»') })}
  </aside>`;
}

/* ---------- right column ---------- */
function dealComposer(arch) {
  const dis = arch ? 'disabled' : '';
  const tab = (t, label, icn, on) => `<button type="button" class="ctab" role="tab" aria-selected="${on}" data-act="ctab" data-t="${t}">${ic(icn, 16)}${label}</button>`;
  const soon = (label, icn) => `<button type="button" class="ctab" role="tab" aria-selected="false" disabled title="З’явиться в наступній версії">${ic(icn, 16)}${label}<span class="soon">скоро</span></button>`;
  return `<section class="cmp" aria-label="Додати до угоди">
    <div class="cmp-tabs" role="tablist" aria-label="Що додати">${tab('note', 'Нотатка', 'note', true)}${tab('task', 'Задача', 'task', false)}${soon('Дзвінок', 'phone')}${soon('WhatsApp', 'chat')}${soon('Email', 'mail')}${tab('file', 'Файли', 'clip', false)}${soon('Документи', 'doc')}${tab('inv', 'Рахунок', 'pay', false)}</div>
    <div class="cpane" data-pane="note" role="tabpanel"><label class="vh" for="nt">Нотатка</label><textarea id="nt" class="cmp-in" rows="1" placeholder="${arch ? 'Угода в архіві: нотатки не додаються' : 'Введіть нотатку, @ім’я…'}" ${dis}></textarea>
      <div class="foot"><span class="meta-prose">бачать усі, хто має доступ до угоди</span><button type="button" class="dv-btn ghost-b" data-act="note-cancel">Скасувати</button><button type="button" class="btn primary sm" data-act="note" ${dis}>Зберегти <kbd aria-hidden="true">Ctrl ↵</kbd></button></div></div>
    <div class="cpane" data-pane="task" role="tabpanel" hidden><div class="task-f">
      ${field('ct1', 'Тип', sel('ct1', ['Дзвінок', 'Очікую оплату', 'Дожим', 'Консультація'], 'Дзвінок'))}${field('ct2', 'Дата', inp('ct2', '05.11.2026', { cls: 'num' }))}${field('ct3', 'Час', inp('ct3', '11:00', { cls: 'num' }))}
      <div class="wide">${field('ct4', 'Тема', inp('ct4', '', { ph: 'Наприклад: нагадати про залишок 490 €' }))}</div></div>
      <div class="foot"><span class="meta-prose">виконавець: ${ME}</span><button type="button" class="btn primary sm" data-act="ctask" ${dis}>Створити задачу</button></div></div>
    <div class="cpane" data-pane="file" role="tabpanel" hidden><div class="drop">${ic('clip', 18)}<span>Перетягніть файл сюди або <button type="button" class="link-a" data-act="cfile" ${dis}>виберіть на комп’ютері</button></span><span class="meta-prose">PDF, зображення, документи до 25 МБ</span></div></div>
    <div class="cpane" data-pane="inv" role="tabpanel" hidden><div class="foot"><span class="meta-prose">Рахунок WayForPay у валюті угоди. Залишок до суми угоди: <span class="money">490 €</span>.</span><button type="button" class="btn primary sm" data-act="invoice" ${dis}>Виставити рахунок</button></div></div>
  </section>`;
}

const NEXT = [['over', 'mail', 'Надіслати програму модуля «AI-відео»', 'лист', 'вчора 18:00 · прострочено'], ['today', 'phone', 'Дізнатись рішення', 'дзвінок', 'сьогодні 12:00'], ['future', 'pay', 'Очікую оплату: рахунок 590 €', 'оплата', '06.11 · через 2 дні']];
const tcActs = (full) => `<div class="tc-a">${ib('fold', 'Згорнути', 'tc-fold', 'aria-pressed="false"')}${full ? `<button type="button" class="tc-c" data-act="tc-comment">Коментар</button>${ib('pen', 'Редагувати', 'tc-edit')}${ib('pin', 'Закріпити у фокусі', 'tc-pin', 'aria-pressed="false"')}` : ''}${moreB('Інші дії', 'tc-more')}</div>`;
/* timeline item: 56px column with a round type icon and a dashed line, then a card (or a compact line for change log) */
const hCard = (k, icn, tone, head, body, { full = false, cls = '' } = {}) => `<li data-k="${k}" class="${cls}"><span class="ti ${tone}" aria-hidden="true">${ic(icn, 14)}</span><article class="tc"><header class="tc-h"><span class="tc-m">${head}</span>${tcActs(full)}</header><div class="tc-b">${body}</div></article></li>`;
const hLine = (k, icn, what, head, cls = '') => `<li data-k="${k}" class="flat ${cls}"><span class="ti" aria-hidden="true">${ic(icn, 14)}</span><div class="tl-line"><span class="what">${what}</span><span class="tc-m">${head}</span></div></li>`;
const fItem = ([tone, icn, t, kind, when], fresh) => `<li data-k="task" class="fx ${tone}${fresh ? ' fresh' : ''}"><span class="ti ${tone === 'over' ? 'dng' : ''}" aria-hidden="true">${ic(icn, 14)}</span><article class="tc"><header class="tc-h"><label class="fx-t"><input type="checkbox" class="cb" aria-label="Виконано: ${esc(t)}" data-change="nx-done"><span class="ttl">${esc(t)}</span></label>${tcActs(false)}</header><div class="tc-b fx-m"><span class="when">${when}</span><span>${kind}</span><span>${ME}</span></div></article></li>`;
const formInfo = (rows) => `<div class="form-info"><p class="fi-t">Інформація з форми</p>${rows.map(([k, v]) => `<div class="fi-r"><span class="fk">${k}:</span> ${v}</div>`).join('')}</div>`;

function dealFocus(empty, arch) {
  return `<section class="dv-sec tog-box" aria-label="Фокус"><div class="dv-sh">${chevB('Фокус', true, 'sec-t')}<label class="xall"><button type="button" role="switch" class="sw" aria-checked="true" data-act="xall"><i aria-hidden="true"></i></button><span>Розгорнути все</span></label></div>
    <div class="tog-b">${empty ? `<div class="focus-empty"><p class="fe-t">Поки немає елементів фокусу</p><p class="meta-prose">Тут з’являться заплановані задачі, закріплені нотатки й листи, що чекають відправки.</p>${arch ? '' : `<button type="button" class="link-a" data-act="ctab" data-t="task">${ic('plus', 14)}Заплануйте задачу</button>`}</div><ul class="tlx" id="nx-list"></ul>`
      : `<ul class="tlx" id="nx-list">${NEXT.map((n) => fItem(n)).join('')}</ul>`}</div></section>`;
}

function dealHistory(s) {
  const items = [];
  const at = (d) => `${d} · ${ME}`;
  if (s === 'won') items.push(hLine('change', 'check', chg('Статус', 'відкрита', 'виграна'), at('сьогодні 10:05')));
  if (s === 'lost') items.push(hCard('note', 'close', '', at('сьогодні 10:05'), `${chg('Статус', 'відкрита', 'програна')}<p>Причина: АІ 2 · Після вебінару → Дорого. «Повернеться після Нового року».</p>`));
  if (s === 'archived') items.push(hLine('change', 'arch', 'Угоду перенесено в архів', at('сьогодні 10:05')));
  items.push(
    hCard('call', 'phone', 'ask', 'сьогодні 09:12 · Unitalk', '<b class="w5">Пропущений вхідний дзвінок</b> з <span class="num">+380 00 123 45 67</span>'),
    hCard('file', 'file', '', at('03.11 16:45'), '<a class="file" href="#" onclick="return false"><span class="ext">PDF</span><span class="ellip">Договір-оферта_Мельник.pdf</span><span class="meta">214 КБ</span></a>'),
    hCard('pay', 'pay', 'acc', at('03.11 16:40'), 'Виставлено рахунок <span class="money">590 €</span> · WayForPay, дійсний до 06.11'),
    hLine('change', 'edit', chg('Сума угоди', '1 290 €', '1 190 €'), at('02.11 10:20')),
    hCard('note', 'note', '', at('01.11 12:15'), 'Доплатила 500 €. Залишок 590 € — чекає зарплату, обіцяла до 06.11. Просила нагадати в четвер увечері, після 19:00 — вдень на роботі не відповідає.', { full: true }),
    hCard('pay', 'pay', 'acc', '01.11 12:10 · WayForPay', 'Платіж успішний: доплата <span class="money">500 €</span>, картка **** 4417'),
    hCard('note', 'reg', '', '31.10 18:30 · Make: реєстрації (API)', formInfo([['Formtype', 'lead_magnet'], ['name', 'Ірина Мельник'], ['phone', '<span class="num">+380001234567</span>'], ['email', 'iryna.melnyk@example.com'], ['page', '<a href="#" onclick="return false">alpi.example/ai-video</a>'], ['utm_source', 'google'], ['utm_medium', 'cpc'], ['utm_campaign', 'search_ai_kurs'], ['utm_term', 'курс ai відео'], ['gclid', 'Cj0KFAKE-x7Qd2Lw0']]), { full: true }),
    hCard('task', 'check', '', at('30.10 15:30'), '<s class="ink3">Дзвінок після вебінару</s> · задачу виконано'),
    hCard('pay', 'pay', 'acc', '30.10 14:03 · WayForPay', 'Платіж успішний: бронь <span class="money">200 €</span>, картка **** 4417'),
    hLine('change', 'stage', chg('Етап', 'Був на вебінарі', 'Приймає рішення'), at('29.10 11:24')),
    hCard('call', 'phone', '', at('29.10 11:05'), `Вхідний дзвінок, <span class="num">12:48</span><div class="player"><button type="button" class="play" aria-label="Прослухати запис">${ic('play', 12)}</button><span class="wave" aria-hidden="true"></span><span class="meta">4:52 / 12:48</span></div>`),
    hLine('change', 'edit', chg('Перегляд, %', '—', '86'), '28.10 21:40 · ключ API «Make: вебінари»'),
    hLine('change', 'stage', chg('Етап', 'Новий лід', 'Був на вебінарі'), '28.10 21:40 · ключ API «Make: вебінари»'),
    hCard('note', 'reg', '', '26.10 19:02 · Make: вебінари (API)', formInfo([['Formtype', 'webinar_registration'], ['webinar', 'AI-контент з нуля, 28.10 19:00'], ['name', 'Ірина Мельник'], ['phone', '<span class="num">+380001234567</span>'], ['email', 'iryna.melnyk@example.com'], ['utm_source', 'facebook'], ['utm_medium', 'paid_social'], ['utm_campaign', 'ai_content_webinar_oct'], ['utm_content', 'reels_v2'], ['fbclid', 'IwAR0FAKEq9Zt3mVb7']]), { full: true }),
    hLine('change', 'plus', 'Угоду створено з реєстрації на вебінар', '26.10 19:02 · ключ API «Make: вебінари»'),
  );
  const n = (k) => items.filter((h) => h.startsWith(`<li data-k="${k}"`)).length;
  const chips = [['all', 'Усе'], ['note', `Нотатки (<span data-n="note">${n('note')}</span>)`], ['task', `Задачі (<span data-n="task">${n('task')}</span>)`], ['call', 'Дзвінки'], ['file', 'Файли'], ['pay', 'Рахунки'], ['change', 'Журнал змін']];
  return `<section class="dv-sec tog-box" aria-label="Історія"><div class="dv-sh">${chevB('Історія', true, 'sec-t')}</div>
    <div class="tog-b"><div class="hch" role="group" aria-label="Фільтр історії">${chips.map(([k, l]) => `<button type="button" aria-pressed="${k === 'all'}" data-act="hfilter" data-k="${k}">${l}</button>`).join('')}<button type="button" disabled title="З’явиться в наступній версії">Email</button><button type="button" disabled title="З’явиться в наступній версії">WhatsApp</button><button type="button" disabled title="З’явиться в наступній версії">Документи</button></div>
    <ul class="tlx hist">${items.join('')}</ul></div></section>`;
}

function dealPage(s) {
  const won = s === 'won', lost = s === 'lost', arch = s === 'archived', dup = s === 'duplicate', val = s === 'validation';
  const amount = won ? 1290 : 1190;
  D.cur = won ? 7 : 5; D.s = s;
  const notes = [
    arch && `<div class="notice">${ic('arch')}<span class="grow">Угода в архіві: не видна на канбані й у робочих списках, але є в пошуку та звітах. Нова реєстрація цієї людини створить нову угоду.</span></div>`,
    dup && `<div class="notice"><span class="grow"><b class="w5">Можливий дубль.</b> Телефон з нової реєстрації збігається з контактом «Ірина Мельник», email — з контактом «Iryna M.» (№ 3302). Об’єднайте їх, щоб історія була в одному місці.</span><button type="button" class="dv-btn ghost-b" data-act="go" data-to="contact" data-st="duplicate">${ic('merge', 14)}Порівняти й об’єднати</button></div>`,
    lost && '<div class="notice calm lost-n"><span class="grow">Причина програшу: <b class="w5">АІ 2 · Після вебінару → Дорого</b>. Коментар: «Повернеться після Нового року».</span></div>',
    val && '<div class="notice" role="alert"><span class="grow">Угоду не перенесено на етап «Сплатив бронювання»: заповніть поля <b class="w5">Пакет</b> і <b class="w5">Тип закриття</b> (блоки «Заповніть» і «Деталі»). Ці правила діють і для людей, і для запитів API.</span></div>',
  ].filter(Boolean);
  return `<div class="dv">
    ${dealHeader(s, D.cur)}
    ${notes.length ? `<div class="dv-notes">${notes.join('')}</div>` : ''}
    <div class="dv-body">
      ${dealLeft(s, amount)}
      <div class="dv-right"><div class="dv-rin">
        ${dealComposer(arch)}
        ${dealFocus(won || lost || arch || s === 'nofocus', arch)}
        ${dealHistory(s)}
      </div></div>
    </div>
  </div>`;
}

const dealLoading = () => `<div class="dv" aria-busy="true"><header class="dv-head"><div class="dv-r1"><span class="sk" style="font-size:25px;width:min(420px,70%)"><span class="bar"></span></span></div><span class="bar" style="height:24px;margin-top:14px;border-radius:var(--r-inner)"></span><span class="sk" style="font-size:12px;width:160px;margin-top:10px"><span class="bar"></span></span></header>
  <div class="dv-body"><aside class="dv-left"><div class="dv-filter"><span class="bar" style="height:32px;border-radius:var(--r-chip)"></span></div>${[3, 8, 6].map((n) => `<div class="blk"><div class="blk-h"><span class="sk" style="font-size:16px;width:40%"><span class="bar"></span></span></div><div class="blk-b"><span class="sk" style="font-size:14px">${Array.from({ length: n }, (_, i) => `<span class="bar" style="--w:${86 - (i % 3) * 14}%"></span>`).join('')}</span></div></div>`).join('')}</aside>
  <div class="dv-right"><div class="dv-rin"><span class="bar" style="height:101px;border-radius:var(--r-inner)"></span><span class="sk" style="font-size:16px;width:120px"><span class="bar"></span></span>${[0, 1, 2].map(() => '<span class="bar" style="height:84px;border-radius:var(--r-inner)"></span>').join('')}</div></div></div></div>`;

def('deal', {
  title: 'Картка угоди', group: '3. Угоди', nav: 'kanban', what: 'угоду',
  states: [['default', 'Відкрита'], ['won', 'Виграна'], ['lost', 'Програна'], ['archived', 'В архіві'], ['duplicate', 'Можливий дубль'], ['validation', 'Обов’язкові з етапу'], ['nofocus', 'Фокус порожній'], ['invoice', 'Рахунок: форма'], ['invoice-done', 'Рахунок створено'], ['loading', 'Завантаження'], ['error', 'Помилка'], ['forbidden', 'Немає доступу'], ['offline', 'Офлайн']],
  render(s) {
    if (s === 'loading') return dealLoading();
    if (s === 'forbidden') return `<section class="panel" style="margin-top:12px"><div class="empty"><p class="meta" style="margin-bottom:10px"><b>403</b></p><h2 class="t">Клієнт уже в роботі в Марії Бондар.</h2><p class="x">Угода № 4510 поза вашим охопленням «свої». Вміст угоди не показуємо. Якщо клієнт звернувся саме до вас, напишіть Марії або тімліду Дмитру Ткачу.</p><div class="a"><a class="btn ghost sm" href="#/kanban/default">До воронки</a></div></div></section>`;
    if (s === 'error') return null;
    return dealPage(s);
  },
  after(s) {
    const sb = $('.dv-stages'), cur = $('.sg.cur');
    if (sb && cur && sb.scrollWidth > sb.clientWidth) sb.scrollLeft += cur.getBoundingClientRect().left - sb.getBoundingClientRect().left - 40;
    /* on a phone the left blocks come first, collapsed into a 56px index; the one the state is about stays open */
    const keep = { duplicate: 'contact', validation: 'fill' }[s] || 'fill';
    if (innerWidth <= 860) $$('.blk[data-blk]').forEach((b) => setOpen(b, b.dataset.blk === keep));
    const nt = $('#nt');
    nt?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ACT.note(); } });
    nt?.addEventListener('focus', () => nt.closest('.cmp').classList.add('open'));
    nt?.addEventListener('blur', () => setTimeout(() => { if (!nt.value.trim() && !nt.closest('.cmp').contains(document.activeElement)) nt.closest('.cmp').classList.remove('open'); }, 150));
    $('#ffilter')?.addEventListener('input', (e) => filterFields(e.target.value));
    if (s === 'archived') $$('.dv-left .fv').forEach((b) => { b.disabled = true; }); // archived deal: fields are read-only
    if (s === 'invoice' || s === 'invoice-done') invoiceDialog(s === 'invoice-done');
    if (s === 'validation') requiredDialog(DEAL_T, STAGES[6], () => moveStage(6), true);
  },
});
function setOpen(box, open) {
  const t = $(':scope > .blk-h > .tog, :scope > .fgrp-h > .tog, :scope > .dv-sh > .tog', box), b = $(':scope > .tog-b', box);
  if (!t || !b) return;
  t.setAttribute('aria-expanded', String(open)); b.hidden = !open;
}
function filterFields(q) {
  const left = $('.dv-left'), v = q.trim().toLowerCase();
  left.classList.toggle('filtering', !!v);
  $$('.dfl', left).forEach((r) => { r.hidden = !!v && !$('.k', r).textContent.toLowerCase().includes(v); });
  $$('.fgrp', left).forEach((g) => { g.hidden = !!v && !$$('.dfl', g).some((r) => !r.hidden); });
  $$('.blk', left).forEach((b) => { b.hidden = !!v && !$$('.dfl', b).some((r) => !r.hidden); });
  $('.ff-none', left).hidden = !v || $$('.blk', left).some((b) => !b.hidden);
}
function invoiceDialog(done) {
  const d = openDialog(`${dlgHead('Виставити рахунок', 'WayForPay. Сума у валюті угоди: EUR.')}
    <div class="dlg-b" id="invb">${done ? invoiceDone() : `
      <fieldset class="choices"><legend class="label" style="margin-bottom:8px">Тип платежу</legend>${['Бронь', 'Рахунок', 'Доплата'].map((t, i) => `<label class="choice"><input type="radio" name="it" ${i === 2 ? 'checked' : ''}><span>${t}</span></label>`).join('')}</fieldset>
      <div class="grid2">${field('ia', 'Сума, €', inp('ia', '490', { cls: 'num' }), { hint: 'Залишок до суми угоди: 490 €.' })}${field('il', 'Посилання дійсне', sel('il', ['24 години', '3 дні', '7 днів'], '3 дні'))}</div>
      ${field('ip', 'Товар у призначенні платежу', sel('ip', ['AI-контент PRO', 'Модуль «AI-відео»'], 'AI-контент PRO'))}
      <p class="meta-prose">Платіж запишеться в угоду, коли WayForPay підтвердить оплату. Етап і статус угоди CRM сама не змінює.</p>`}</div>
    <div class="dlg-f">${done ? '<button class="btn primary sm" data-close>Готово</button>' : '<button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" id="invgo">Створити рахунок</button>'}</div>`);
  $('#invgo', d)?.addEventListener('click', (e) => {
    const b = e.currentTarget; b.disabled = true; b.setAttribute('aria-busy', 'true'); b.textContent = 'Створюємо…';
    setTimeout(() => { $('#invb', d).innerHTML = invoiceDone(); $('.dlg-f', d).innerHTML = '<button class="btn primary sm" data-close>Готово</button>'; toast('Рахунок на 490 € створено.'); histAdd('pay', 'pay', 'Виставлено рахунок <span class="money">490 €</span> · WayForPay, дійсний до 07.11'); }, 900);
  });
}
const invoiceDone = () => `<div class="secret"><p class="secret-title">Рахунок на <span class="num">490</span> € створено</p><p class="ink2" style="font-size:14px">Надішліть посилання клієнтці. Воно дійсне до 07.11.2026 23:59.</p>
  <div class="copy-row"><input class="input mono" readonly value="https://secure.wayforpay.com/invoice/i7f2c9a41d" aria-label="Посилання на оплату"><button class="btn ghost sm" data-act="copy">${ic('copy', 14)}Скопіювати</button></div></div>`;
const closePops = () => { $$('.pop').forEach((p) => p.remove()); $$('[aria-expanded="true"][aria-haspopup]').forEach((b) => b.setAttribute('aria-expanded', 'false')); };
function histCounts() { $$('[data-n]').forEach((n) => { n.textContent = $$('.hist > li').filter((li) => li.dataset.k === n.dataset.n).length; }); }
function histAdd(k, icn, body, { line = false, full = false } = {}) {
  const ul = $('.hist');
  if (!ul) return;
  ul.insertAdjacentHTML('afterbegin', line ? hLine(k, icn, body, `щойно · ${ME}`, 'fresh') : hCard(k, icn, '', `щойно · ${ME}`, body, { full, cls: 'fresh' }));
  histCounts();
  const on = $('[data-act="hfilter"][aria-pressed="true"]')?.dataset.k;
  if (on && on !== 'all' && on !== k) ul.firstElementChild.hidden = true;
}
function moveStage(i) {
  const from = D.cur;
  if (i === from) return;
  D.cur = i;
  $$('.sg').forEach((x, j) => {
    const between = (j - from) * (j - i) <= 0;
    x.style.setProperty('--k', between ? Math.abs(j - from) : 0);
    x.classList.toggle('done', j < i); x.classList.toggle('cur', j === i); x.classList.remove('landed');
    if (j === i) x.setAttribute('aria-current', 'step'); else x.removeAttribute('aria-current');
    $('span', x).textContent = j === i ? `${dayW(0)} · ${PATH[j]}` : PATH[j];
    x.title = j < i ? `${PATH[j]}: ${dayW(DEAL_DAYS[j])} на етапі` : j === i ? `${PATH[j]}: ${dayW(0)} на етапі` : PATH[j];
  });
  $('#d-stage').textContent = PATH[i];
  const c = $('.sg.cur');
  setTimeout(() => { c.classList.add('landed'); }, Math.abs(i - from) * 45 + 120);
  histAdd('change', 'stage', chg('Етап', PATH[from], PATH[i]), { line: true });
  toast(`Етап змінено на «${PATH[i]}».`, { action: 'Скасувати' });
}
function setAmount(v) {
  const was = $('#d-sum').textContent;
  $('#d-sum').textContent = `${fmt(v)} €`;
  $$('.sr-pay .money')[1].textContent = `${fmt(v)} €`;
  if (v === 1290) { $('#sumhint')?.remove(); $('#sumwarn')?.remove(); }
  histAdd('change', 'edit', chg('Сума угоди', was, `${fmt(v)} €`), { line: true });
}
const subToggle = (b, id) => { const s = $('#' + id), open = s.hidden; s.hidden = !open; $$(`[aria-controls="${id}"]`).forEach((x) => x.setAttribute('aria-expanded', String(open))); };
Object.assign(ACT, {
  'sub-me': (b) => { closePops(); $('[data-act="subs"]').firstChild.textContent = '2 підписники'; toast('Ви підписалися на угоду.'); },
  stub: () => { closePops(); toast('У прототипі ця дія не реалізована.'); },
  fill: (b) => {
    const f = b.closest('.dfl').dataset.f, t = $(`.blk[data-blk="details"] .dfl[data-f="${f}"] .fv`);
    if (!t) return;
    setOpen(t.closest('.blk'), true); setOpen(t.closest('.fgrp'), true);
    t.scrollIntoView({ behavior: S.calm ? 'auto' : 'smooth', block: 'center' });
    ACT.fedit(t);
  },
  tog: (b) => setOpen(b.closest('.tog-box'), b.getAttribute('aria-expanded') !== 'true'),
  invoice: () => invoiceDialog(false),
  'prod-toggle': (b) => subToggle(b, 'prod-sub'),
  'pay-toggle': (b) => subToggle(b, 'pay-sub'),
  'apply-sum': () => { setAmount(1290); toast('Суму угоди змінено на 1 290 €.', { action: 'Скасувати' }); },
  path: (b) => { closePops(); const i = +b.dataset.i; if (i === D.cur) return; if (i >= 6 && i > D.cur && D.s !== 'won') { requiredDialog(DEAL_T, STAGES[6], () => moveStage(i)); return; } moveStage(i); },
  'pick-stage': (b) => togglePop(b, `<div class="glabel meta">Воронка</div><button class="opt" role="menuitemradio" aria-selected="true">ALPI</button><button class="opt" role="menuitemradio" aria-selected="false" disabled style="opacity:.55">Платформа (допродаж)<span class="meta" style="margin-left:auto">через допродаж</span></button><hr><div class="glabel meta">Етап</div>${PATH.map((n, i) => `<button class="opt" role="menuitemradio" aria-selected="${i === D.cur}" data-act="path" data-i="${i}">${n}${STAGES[i].required ? `<span class="meta" style="margin-left:auto">${ic('lock', 12)}</span>` : ''}</button>`).join('')}`),
  subs: (b) => togglePop(b, `<div class="glabel meta">Підписники угоди</div><div class="opt" style="cursor:default"><span class="ava" aria-hidden="true">ІЛ</span>Ірина Лисенко<span class="meta" style="margin-left:auto">тімлід</span></div><hr><button class="opt" role="menuitem" data-act="sub-me">${ic('plus')}Підписатися самій</button>`),
  'view-sw': (b) => togglePop(b, `<button class="opt" role="menuitemradio" aria-selected="true">Детальний вигляд</button><button class="opt" role="menuitemradio" aria-selected="false" disabled style="opacity:.55">Компактний вигляд<span class="soon-t">скоро</span></button>`, true),
  'blk-more': (b) => togglePop(b, `<button class="opt" role="menuitem" data-act="stub">${ic('pen')}Налаштувати поля</button><button class="opt" role="menuitem" data-act="copy">${ic('copy')}Копіювати значення</button>`, true),
  'tc-more': (b) => togglePop(b, `<button class="opt" role="menuitem" data-act="copy">${ic('copy')}Копіювати посилання</button>`, true),
  prob: (b) => togglePop(b, `<div class="glabel meta">Ймовірність виграшу</div>${[10, 25, 50, 75, 90].map((p) => `<button class="opt" role="menuitem" data-act="prob-set" data-p="${p}"><span class="num">${p} %</span></button>`).join('')}`),
  'prob-set': (b) => { closePops(); const x = $('#d-prob'); x.textContent = `Ймовірність ${b.dataset.p} %`; x.classList.add('set'); histAdd('change', 'edit', chg('Ймовірність', '—', `${b.dataset.p} %`), { line: true }); toast(`Ймовірність: ${b.dataset.p} %.`); },
  'add-part': (b) => togglePop(b, `<div class="glabel meta">Учасники угоди</div><button class="opt" role="menuitem" data-act="part-set">${ic('user')}Андрій Мельник<span class="meta" style="margin-left:auto">співрішення</span></button><button class="opt" role="menuitem" data-act="stub">${ic('plus')}Новий контакт</button>`, true),
  'part-set': () => { closePops(); toast('Учасника «Андрій Мельник» додано.'); },
  'org-attach': () => openDialog(`${dlgHead('Прив’язати організацію', 'Угода «Ірина Мельник — AI-контент PRO».')}<div class="dlg-b">${field('oq', 'Організація', inp('oq', 'ФОП Мельник', { ph: 'Назва або ЄДРПОУ' }), { hint: 'Знайдено 1: ФОП Мельник І. В., Київ.' })}</div><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="org-ok">Прив’язати</button></div>`),
  'org-ok': () => {
    closeDialogs();
    $('.sr-org').innerHTML = `${ic('org', 16)}<div class="sr-v"><a href="#/org/default">ФОП Мельник І. В.</a></div>`;
    $('#org-body').innerHTML = `<div class="sr">${ic('org', 16)}<div class="sr-v"><a href="#/org/default" class="nm">ФОП Мельник І. В.</a></div></div>${fld('city', 'Місто', 'Київ')}${fld('odeals', 'Угоди', '1 відкрита', { ro: true })}`;
    histAdd('change', 'org', chg('Організація', '—', 'ФОП Мельник І. В.'), { line: true });
    toast('Організацію прив’язано.');
  },
  'd-won': () => wonDialog(DEAL_T),
  'd-lost': () => lostDialog(DEAL_T),
  'd-arch': () => { closePops(); openDialog(`${dlgHead('Перенести угоду в архів?')}<div class="dlg-b"><p class="ink2" style="font-size:14px">Угода зникне з канбана й робочих списків, але залишиться в пошуку та звітах. Статус «відкрита» не зміниться.</p></div><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="go" data-to="deal" data-st="archived">В архів</button></div>`); },
  'deal-more': (b) => {
    const items = [];
    if (DEAL_RIGHTS.archive && S.state !== 'archived') items.push(`<button class="opt" role="menuitem" data-act="d-arch">${ic('arch')}В архів</button>`);
    if (DEAL_RIGHTS.upsell) items.push(`<button class="opt" role="menuitem" data-act="upsell">${ic('upsell')}Створити допродаж</button>`);
    if (DEAL_RIGHTS.del) items.push(`<hr><button class="opt dng" role="menuitem" data-act="copy">${ic('trash')}Видалити</button>`); // hidden: «Менеджер» has no right to delete
    togglePop(b, items.join(''), true);
  },
  unarch: () => { go('deal', 'default'); toast('Угоду повернено з архіву.'); },
  reopen: () => { go('deal', 'default'); toast('Угоду відкрито знову.'); },
  upsell: () => { closePops(); toast('Створено угоду в воронці «Платформа (допродаж)» з тим самим контактом.'); },
  transfer: () => openDialog(`${dlgHead('Передати угоду')}<div class="dlg-b">${field('tr', 'Новий власник', sel('tr', ['Андрій Шевчук', 'Ірина Лисенко', 'Без відповідального (загальна черга)'], 'Андрій Шевчук'))}</div><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-close data-act="copy">Передати</button></div>`),
  'edit-title': (h) => {
    if (h.isContentEditable) return;
    const before = h.textContent;
    h.contentEditable = 'true'; h.focus();
    getSelection().selectAllChildren(h);
    const done = (save) => {
      h.contentEditable = 'false';
      const now = h.textContent.trim();
      if (!save || !now) { h.textContent = before; return; }
      if (now !== before) { histAdd('change', 'edit', chg('Назва', esc(before), esc(now)), { line: true }); toast('Назву угоди змінено.'); }
    };
    h.addEventListener('keydown', function k(e) { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); h.removeEventListener('keydown', k); done(e.key === 'Enter'); h.blur(); } });
    h.addEventListener('blur', () => { if (h.isContentEditable) done(true); }, { once: true });
  },
  'edit-amount': () => openDialog(`${dlgHead('Сума угоди', 'Сума по товарах: 1 290 €. Зміна потрапить в історію угоди.')}<div class="dlg-b"><div class="grid2">${field('ea', 'Сума', inp('ea', $('#d-sum').textContent.replace(/[^\d]/g, ''), { cls: 'num' }))}${field('ec', 'Валюта', sel('ec', ['EUR', 'UAH', 'USD'], 'EUR'))}</div></div><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="ea-ok">Зберегти</button></div>`),
  'ea-ok': () => {
    const v = +$('#ea').value.replace(/\D/g, '');
    closeDialogs();
    if (!v || `${fmt(v)} €` === $('#d-sum').textContent) return;
    setAmount(v);
    toast(`Суму угоди змінено на ${fmt(v)} €.`);
  },
  'add-label': (b) => togglePop(b, `<div class="glabel meta">Мітки угоди</div>${[['Гаряча', 'ask'], ['VIP', 'acc'], ['Розстрочка', ''], ['Партнер', 'ask']].map(([l, c]) => `<button class="opt" role="menuitem" data-act="pick-label" data-l="${l}" data-c="${c}"><span class="ltag" data-c="${c}"><i aria-hidden="true"></i>${l}</span></button>`).join('')}`),
  'pick-label': (b) => {
    closePops();
    const box = $('#d-labels'), add = $('[data-act="add-label"]', box);
    box.insertAdjacentHTML('afterbegin', `<span class="ltag" data-c="${b.dataset.c}" style="animation:actum-lift var(--dur-base) var(--ease)"><i aria-hidden="true"></i>${b.dataset.l}</span>`);
    add.textContent = '+ мітка';
    toast(`Мітку «${b.dataset.l}» додано.`);
  },
  fedit: (b) => {
    const row = b.closest('.dfl'), label = $('.k', row).textContent.trim(), opts = b.dataset.opts?.split('|');
    const was = b.classList.contains('empty') ? '—' : b.textContent.trim();
    const ed = document.createElement(opts ? 'select' : 'input');
    ed.className = (opts ? 'select' : 'input') + ' sm fe'; ed.setAttribute('aria-label', label);
    if (opts) ed.innerHTML = `<option value="">Не вибрано</option>${opts.map((o) => `<option ${o === was ? 'selected' : ''}>${o}</option>`).join('')}`; else ed.value = was === '—' ? '' : was;
    b.hidden = true; b.after(ed); ed.focus();
    let closed = false;
    const finish = (save) => {
      if (closed) return; closed = true;
      const now = ed.value.trim(); ed.remove(); b.hidden = false; b.focus();
      if (!save || now === (was === '—' ? '' : was)) return;
      b.innerHTML = (now || '—') + ic('pen', 14); b.classList.toggle('empty', !now);
      if (now) { $$(`.dfl.need[data-f="${row.dataset.f}"]`).forEach((r) => { if (r.closest('.blk.fill')) r.remove(); else r.classList.remove('need'); }); }
      const fill = $('.blk.fill');
      if (fill && !$('.dfl', fill)) fill.remove();
      const g = row.closest('.fgrp');
      if (g) { const c = $('.cnt', g), [f, t] = c.textContent.split('/').map(Number); c.textContent = `${f + (was === '—' ? 1 : 0) - (now ? 0 : 1)}/${t}`; }
      histAdd('change', 'edit', chg(esc(label), esc(was), esc(now || '—')), { line: true });
      toast(`Поле «${esc(label)}» збережено.`);
    };
    ed.addEventListener('change', () => opts && finish(true));
    ed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    ed.addEventListener('blur', () => finish(true));
  },
  ctab: (b) => {
    const t = b.dataset.t;
    $$('.cmp .ctab[data-t]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.t === t)));
    $$('.cmp .cpane').forEach((p) => { p.hidden = p.dataset.pane !== t; });
    const pane = $(`.cmp .cpane[data-pane="${t}"]`);
    pane.style.animation = 'none'; void pane.offsetWidth; pane.style.animation = 'actum-fade var(--dur-base) var(--ease)';
    if (!b.closest('.cmp')) { $('.cmp').scrollIntoView({ behavior: S.calm ? 'auto' : 'smooth', block: 'start' }); setTimeout(() => $('#ct4')?.focus({ preventScroll: true }), 300); }
  },
  'note-cancel': () => { const t = $('#nt'); t.value = ''; t.removeAttribute('aria-invalid'); t.closest('.cmp').classList.remove('open'); },
  note: () => { const t = $('#nt'); if (!t.value.trim()) { t.setAttribute('aria-invalid', 'true'); toast('Нотатка порожня.', { tone: 'error' }); return; } t.removeAttribute('aria-invalid'); histAdd('note', 'note', esc(t.value), { full: true }); t.value = ''; t.closest('.cmp').classList.remove('open'); toast('Нотатку збережено.'); },
  ctask: () => {
    const subj = $('#ct4').value.trim() || $('#ct1').value, when = `${$('#ct2').value.slice(0, 5)} ${$('#ct3').value}`.trim();
    $('.focus-empty')?.remove();
    $('#nx-list').insertAdjacentHTML('beforeend', fItem(['future', 'task', subj, $('#ct1').value.toLowerCase(), when], true));
    histAdd('change', 'task', `Заплановано задачу «${esc(subj)}» на ${esc(when)}`, { line: true });
    $('#ct4').value = ''; toast('Задачу створено.');
  },
  cfile: () => { histAdd('file', 'file', '<a class="file" href="#" onclick="return false"><span class="ext">PDF</span><span class="ellip">Програма_AI-відео.pdf</span><span class="meta">1,2 МБ</span></a>'); toast('Файл «Програма_AI-відео.pdf» додано.'); },
  'nx-done': (b) => {
    const row = b.closest('.fx'); row.classList.toggle('done', b.checked);
    if (!b.checked) return;
    histAdd('task', 'check', `<s class="ink3">${esc($('.ttl', row).textContent)}</s> · задачу виконано`);
    $('.dv-sec .strip')?.remove();
    $('#nx-list').insertAdjacentHTML('afterend', `<div class="strip"><p>Задачу виконано. Запланувати наступну?</p><div class="actions"><button type="button" class="btn primary sm" data-act="ctab" data-t="task">Запланувати</button><button type="button" class="btn quiet sm" onclick="this.closest('.strip').remove()">Ні, дякую</button></div></div>`);
  },
  xall: (b) => { const on = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(on)); $$('.dv-right .tc').forEach((c) => c.classList.toggle('folded', !on)); $$('.dv-right [data-act="tc-fold"]').forEach((x) => x.setAttribute('aria-pressed', String(!on))); },
  'tc-fold': (b) => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Розгорнути' : 'Згорнути'); b.title = b.getAttribute('aria-label'); b.closest('.tc').classList.toggle('folded', on); },
  'tc-comment': (b) => {
    const card = b.closest('.tc');
    if ($('.tc-cm', card)) { $('.tc-cm textarea', card).focus(); return; }
    $('.tc-b', card).insertAdjacentHTML('afterend', `<div class="tc-cm"><textarea class="textarea" rows="2" aria-label="Коментар" placeholder="Коментар до запису"></textarea><div class="foot"><button type="button" class="btn quiet sm" onclick="this.closest('.tc-cm').remove()">Скасувати</button><button type="button" class="btn primary sm" data-act="tc-cm-ok">Коментувати</button></div></div>`);
    $('.tc-cm textarea', card).focus();
  },
  'tc-cm-ok': (b) => { const box = b.closest('.tc-cm'), t = $('textarea', box).value.trim(); if (!t) { $('textarea', box).setAttribute('aria-invalid', 'true'); return; } box.outerHTML = `<div class="tc-cmt"><span class="meta">щойно · ${ME}</span><p>${esc(t)}</p></div>`; toast('Коментар додано.'); },
  'tc-edit': (b) => {
    const body = $('.tc-b', b.closest('.tc'));
    if (body.isContentEditable) return;
    body.contentEditable = 'true'; body.classList.add('editing'); body.focus();
    body.addEventListener('blur', () => { body.contentEditable = 'false'; body.classList.remove('editing'); toast('Нотатку змінено.'); }, { once: true });
  },
  'tc-pin': (b) => {
    const on = b.getAttribute('aria-pressed') !== 'true', li = b.closest('li');
    b.setAttribute('aria-pressed', String(on));
    if (on) { $('.focus-empty')?.remove(); const c = li.cloneNode(true); c.classList.add('pinned', 'fresh'); c.dataset.pin = li.dataset.pin = String(Date.now()); $('[data-act="tc-pin"]', c).remove(); $('#nx-list').prepend(c); toast('Нотатку закріплено у фокусі.'); }
    else { $(`#nx-list [data-pin="${li.dataset.pin}"]`)?.remove(); toast('Нотатку відкріплено.'); }
  },
  hfilter: (b) => {
    const k = b.dataset.k;
    $$('[data-act="hfilter"]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $$('.hist > li').forEach((li) => { li.hidden = k !== 'all' && li.dataset.k !== k; });
  },
});

/* ================= DEALS LIST ================= */
const listRow = (r, selRow) => { const [id, t, c, stg, a, cur, resp, task, created, src, camp] = r; return `<tr ${selRow ? 'aria-selected="true"' : ''}><td class="w-cb"><input type="checkbox" class="cb" aria-label="Вибрати угоду ${id}" ${selRow ? 'checked' : ''} data-change="rowsel"></td><td><span class="meta"><b>${id}</b></span></td><td class="t1"><a href="#/deal/default" style="text-decoration:none">${esc(t)}</a></td><td class="ink2">${stg}</td><td class="r">${money(a, cur)}</td><td>${resp ? who(resp) : '<span class="meta">загальна черга</span>'}</td><td>${st(task[0], task[1])}</td><td class="meta">${created}</td><td><span title="utm_campaign: ${camp}">${src}</span></td></tr>`; };
const listHead = (s) => `${ph('Угоди', { meta: '<span>воронка ALPI</span><span>курсорне підвантаження</span>', actions: `<div class="tabs bare" role="tablist"><a class="tab" href="#/kanban/default">Канбан</a><a class="tab" aria-current="page" href="#/deals/default">Список</a></div><button class="btn primary sm" data-act="new-deal">${ic('plus', 14)}Нова угода</button>` })}
  <div class="tabs bare" style="margin-bottom:12px" role="tablist" aria-label="Збережені фільтри">${[['Усі відкриті', '1 518'], ['Мої', '64'], ['Без задачі', '212'], ['Старі «Новий лід»', '≈ 61 240', 1], ['Facebook жовтень', '3 904']].map(([t, n, on]) => `<button class="tab" role="tab" aria-selected="${!!on}">${t}<span class="count">${n}</span></button>`).join('')}<button class="btn quiet sm">${ic('plus', 14)}Зберегти фільтр</button></div>
  <div class="toolbar">${['етап: Новий лід', 'створена раніше 01.09.2026', 'або: джерело ManyChat і без відповідального', 'архів: ні'].map((c) => `<button class="fchip" aria-label="Прибрати фільтр «${c}»">${c}<span class="x" aria-hidden="true">×</span></button>`).join('')}
    <button class="btn ghost sm" data-act="go" data-to="deals" data-st="filters" aria-expanded="${s === 'filters'}">${ic('filter', 14)}Умови</button><span class="sp"></span><span class="meta hide-m">≈ <b>61 240</b> угод</span><button class="btn ghost sm hide-m">Колонки</button><button class="btn ghost sm hide-m" disabled title="Немає права «Вивантаження у файл»">${ic('down', 14)}CSV</button></div>`;
function filterBuilder() {
  const cond = (lead, a, b, c) => `<div class="cond"><span class="meta">${lead}</span>${sel('', [a], a, { cls: 'sm' })}${sel('', [b], b, { cls: 'sm' })}${c.startsWith('<') ? c : `<input class="input sm" value="${c}" aria-label="Значення">`}<button class="icon-btn" aria-label="Прибрати умову" style="width:30px;height:30px">${ic('close', 14)}</button></div>`;
  return `<section class="panel rise" aria-label="Умови фільтра" style="margin-bottom:16px"><div class="sh"><h2 class="h2">Умови</h2><div class="ml meta"><span>групи з’єднані через «АБО», умови в групі — через «І»</span></div></div><div class="sb">
    <div class="cond-group"><span class="meta"><b>Група 1</b> усі умови</span>${cond('коли', 'Етап', 'дорівнює', 'Новий лід')}${cond('і', 'Створена', 'раніше', '01.09.2026')}${cond('і', 'Наступна задача', 'дорівнює', 'немає задачі')}<button class="btn quiet sm" style="justify-self:start">${ic('plus', 14)}Умова</button></div>
    <div class="cond-or">або</div>
    <div class="cond-group"><span class="meta"><b>Група 2</b> усі умови</span>${cond('коли', 'Реєстрація: джерело', 'дорівнює', 'ManyChat')}${cond('і', 'Відповідальний', 'не заданий', '<span></span>')}<button class="btn quiet sm" style="justify-self:start">${ic('plus', 14)}Умова</button></div>
    <div class="actions"><button class="btn ghost sm">${ic('plus', 14)}Група «АБО»</button><span style="flex:1"></span>
      <fieldset class="choices" aria-label="Кому видно фільтр"><label class="choice"><input type="radio" name="vis" checked><span>Особистий</span></label><label class="choice"><input type="radio" name="vis"><span>Для команди</span></label><label class="choice"><input type="radio" name="vis" disabled><span style="opacity:.45">Для проєкту</span></label></fieldset>
      <button class="btn ghost sm">Зберегти як…</button><button class="btn primary sm" data-act="go" data-to="deals" data-st="default">Застосувати</button></div></div></section>`;
}
function bulkProgress(done) {
  return `<section class="panel" aria-label="Масова операція" style="margin-bottom:16px"><div class="sh"><h2 class="h2">${done ? 'Архівовано 61 240 угод' : 'Архівуємо 61 240 угод'}</h2><div class="ml meta"><span>запустила Олена Коваль о 14:02</span>${done ? st('ok', 'завершено') : st('live', 'виконується')}</div></div><div class="sb">
    <div style="display:grid;gap:8px"><div class="kv"><span class="meta"><b id="bp-n">${done ? '61 240' : '18 372'}</b> з 61 240</span><span class="meta" id="bp-eta">${done ? 'за 3 хв 12 с' : 'залишилось ≈ 2 хв'}</span></div><div class="prog" role="progressbar" aria-label="Прогрес" aria-valuenow="${done ? 100 : 30}"><i id="bp-bar" style="--p:${done ? 100 : 30}%"></i></div></div>
    <details class="dis"><summary><span class="chev" aria-hidden="true"></span><span class="lbl">Журнал</span><span class="meta">${done ? '4 записи' : '3 записи'}</span></summary><div class="body"><ul class="rows meta" style="display:grid;gap:4px">${(done ? [['14:05', 'Готово: 61 238 угод архівовано, 2 пропущено (вже в архіві).']] : []).concat([['14:03', 'Оброблено 10 000 угод.'], ['14:02', 'Знімок фільтра зафіксовано: 61 240 угод.'], ['14:02', 'Запущено: архівувати за фільтром «Старі «Новий лід»».']]).map(([t, x]) => `<li><b>${t}</b> ${x}</li>`).join('')}</ul></div></details>
    ${done ? '' : '<div class="actions"><button class="btn ghost sm">Зупинити</button><span class="meta-prose">Можна закрити сторінку: операція виконується на сервері, про завершення прийде сповіщення.</span></div>'}</div></section>`;
}
def('deals', {
  title: 'Список угод', group: '3. Угоди', what: 'список угод',
  states: [['default', 'Звичайний'], ['filters', 'Умови І/АБО'], ['selected', 'Вибір'], ['bulk-confirm', 'Підтвердження'], ['bulk-progress', 'Прогрес'], ['bulk-done', 'Готово'], ['empty', 'Нічого не знайдено'], ['loading', 'Завантаження'], ['error', 'Помилка'], ['offline', 'Офлайн']],
  render(s) {
    const head = listHead(s);
    if (s === 'empty') return `${head}${emptyBox('За цими умовами угод немає.', 'Спробуйте прибрати умову «створена раніше 01.09.2026» або подивіться архів.', '<button class="btn ghost sm">Скинути умови</button>')}`;
    if (s === 'loading') return `${head}<section class="panel" aria-busy="true">${skRows(8, 92)}</section>`;
    if (s === 'error') return `${head}${generic('error', 'угоди')}`;
    const selN = s === 'selected' || s === 'bulk-confirm' ? 3 : 0;
    return `${head}${s === 'filters' ? filterBuilder() : ''}${s === 'bulk-progress' || s === 'bulk-done' ? bulkProgress(s === 'bulk-done') : ''}
      <section class="panel tbl-cards" aria-label="Угоди"><div class="tbl-wrap"><table class="tbl"><thead><tr><th class="w-cb"><input type="checkbox" class="cb" aria-label="Вибрати всі на сторінці" ${selN ? 'checked style="opacity:.6"' : ''}></th><th>№</th><th class="sorted">Угода ↓</th><th>Етап</th><th class="r">Сума</th><th>Відповідальний</th><th>Наступна задача</th><th>Створена</th><th>Джерело</th></tr></thead>
      <tbody>${LIST_ROWS.map((r, i) => listRow(r, i < selN)).join('')}</tbody></table></div>
      <div class="sh" style="border-top:1px solid var(--line);border-bottom:0"><span class="meta">показано 12 з ≈ 61 240</span><button class="btn ghost sm">Показати ще 50</button></div></section>
      ${selN ? `<div class="bulkbar" role="region" aria-label="Масові дії"><span class="grow"><b style="font-weight:500">Вибрано ${selN}</b> <button class="link-a">Вибрати всі ≈ 61 240 за фільтром</button></span><button class="btn ghost sm" data-act="bulk">${ic('arch', 14)}Архівувати</button><button class="btn ghost sm">Передати</button><button class="btn ghost sm">Змінити етап</button><button class="btn ghost sm danger-text">Видалити</button><button class="btn quiet sm" data-act="go" data-to="deals" data-st="default">Скасувати</button></div>` : ''}`;
  },
  after(s) {
    if (s === 'bulk-confirm') ACT.bulk();
    if (s === 'bulk-progress') { let n = 18372; const tick = setInterval(() => { const el = $('#bp-n'); if (!el) return clearInterval(tick); n = Math.min(61240, n + 1937); el.textContent = fmt(n); $('#bp-bar').style.setProperty('--p', (n / 61240 * 100) + '%'); if (n >= 61240) { clearInterval(tick); setTimeout(() => go('deals', 'bulk-done'), 400); } }, 700); }
    if (s === 'bulk-done') toast('Масову операцію завершено: архівовано 61 238 угод.');
  },
});
Object.assign(ACT, {
  bulk: () => openDialog(`${dlgHead('Архівувати 61 240 угод?', 'Фільтр «Старі «Новий лід»»: етап Новий лід, створені раніше 01.09.2026.')}<div class="dlg-b"><p class="ink2" style="font-size:14px">Угоди зникнуть з канбана й робочих списків, але залишаться в пошуку та звітах. Операцію виконує сервер у фоні, прогрес і журнал буде видно тут.</p>
    ${field('bc', 'Щоб підтвердити, введіть число угод', inp('bc', '', { ph: '61240', cls: 'num' }))}</div><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="bulk-go">Архівувати 61 240</button></div>`),
  'bulk-go': () => { const i = $('#bc'); if (i.value.replace(/\D/g, '') !== '61240') { i.setAttribute('aria-invalid', 'true'); if (!$('#bc-e')) i.insertAdjacentHTML('afterend', '<p class="error" id="bc-e" role="alert">Число не збігається з кількістю угод: 61 240.</p>'); return; } closeDialogs(); go('deals', 'bulk-progress'); },
  rowsel: (cb) => { cb.closest('tr').setAttribute('aria-selected', String(cb.checked)); },
});

/* ================= CONTACT & ORGANIZATION ================= */
def('contact', {
  title: 'Картка контакту', group: '4. Контакти', what: 'контакт',
  states: [['default', 'Звичайний'], ['duplicate', 'Можливий дубль: злиття'], ['forbidden', 'Чужий клієнт'], ['loading', 'Завантаження'], ['error', 'Помилка']],
  render(s) {
    if (s === 'forbidden') return `<section class="panel"><div class="empty"><h2 class="t">Клієнт уже в роботі в Марії Бондар.</h2><p class="x">Телефон +380 00 555 01 23 належить контакту поза вашим охопленням. Дані контакту й угод не показуємо.</p><div class="a"><a class="btn ghost sm" href="#/deals/default">До угод</a></div></div></section>`;
    if (s === 'loading' || s === 'error') return null;
    return `${ph('Ірина Мельник', { back: ['#/deal/default', 'Угода № 4517'], meta: '<span>контакт проєкту ALPI</span><span>створено 26.10.2026 з реєстрації</span>', actions: `<button class="btn ghost sm" data-act="merge">${ic('merge', 14)}Об’єднати з…</button><button class="btn primary sm" data-act="new-deal">${ic('plus', 14)}Нова угода</button>` })}
    ${s === 'duplicate' ? `<div class="notice" style="margin-bottom:16px"><span class="grow"><b style="font-weight:500">Можливий дубль.</b> Остання реєстрація прийшла з телефоном цього контакту й email контакту «Iryna M.». Перевірте й об’єднайте.</span><button class="btn ghost sm" data-act="merge">Порівняти</button></div>` : ''}
    <div class="split"><div class="col">
      ${sec('Угоди', `<div class="line-item"><div><a href="#/deal/default">Ірина Мельник — AI-контент PRO</a><div class="ml meta"><span>№ 4517</span><span>Приймає рішення</span><span>Олена Коваль</span></div></div><div style="display:grid;gap:4px;justify-items:end"><span class="money">1 190 €</span>${st('live', 'відкрита')}</div></div>
        <div class="line-item"><div><a href="#/deal/archived">Ірина Мельник</a><div class="ml meta"><span>№ 3302</span><span>Новий лід</span><span>в архіві з 12.08</span></div></div><div style="display:grid;gap:4px;justify-items:end"><span class="meta">без суми</span>${st('muted', 'програна')}</div></div>`, { flush: true, right: '<span>2</span>' })}
      <section class="panel"><div class="sh"><h2 class="h2">Стрічка</h2><div class="ml meta"><span>з усіх угод контакту</span></div></div>${timeline()}</section>
    </div><div class="col">
      ${sec('Контактні дані', `<dl class="facts"><dt class="meta">телефони</dt><dd><span class="num">+380 00 123 45 67</span> <span class="meta">основний</span><br><span class="num">+380 00 765 00 11</span></dd><dt class="meta">email</dt><dd>iryna.melnyk@example.com</dd><dt class="meta">мова</dt><dd>українська</dd><dt class="meta">організація</dt><dd><a href="#/org/default">Мережа кав’ярень «Зерно»</a></dd><dt class="meta">у Pipedrive</dt><dd>${st('warn', 'є відкрита угода')}</dd></dl>`, { right: `<button class="btn quiet sm">Змінити</button>` })}
      ${sec('Поля контакту', '<div class="field-row" style="padding-top:0"><span class="meta">місто</span><span>Львів</span></div><div class="field-row"><span class="meta">день народження</span><span class="num">14.03</span></div><div class="field-row"><span class="meta">канал зв’язку</span><span>Telegram</span></div>')}
    </div></div>`;
  },
  after(s) { if (s === 'duplicate') ACT.merge(); },
});
ACT.merge = () => {
  const r = (k, a, b, pick = 0) => `<tr><td class="meta">${k}</td><td><label class="check"><input type="radio" name="m-${k}" ${pick === 0 ? 'checked' : ''}><span>${a}</span></label></td><td><label class="check"><input type="radio" name="m-${k}" ${pick === 1 ? 'checked' : ''}><span>${b}</span></label></td></tr>`;
  openDialog(`${dlgHead('Об’єднати контакти', 'Угоди, реєстрації, дзвінки й нотатки обох контактів зберуться в одному. Відмінити злиття не можна.')}
    <div class="dlg-b" style="padding:0"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Поле</th><th>Ірина Мельник <span class="meta">№ 1182</span></th><th>Iryna M. <span class="meta">№ 3302</span></th></tr></thead><tbody>
    ${r('імʼя', 'Ірина Мельник', 'Iryna M.')}${r('телефон', '+380 00 123 45 67', '—')}${r('email', 'iryna.melnyk@example.com', 'iryna.m@example.com', 1)}${r('мова', 'українська', 'російська')}<tr><td class="meta">угоди</td><td colspan="2">обидві: № 4517 (відкрита), № 3302 (архів)</td></tr></tbody></table></div>
    <div style="padding:0 20px"><div class="notice">Правило «одна відкрита угода на контакт у воронці» не порушується: друга угода в архіві.</div></div></div>
    <div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="merge-ok">Об’єднати</button></div>`, { wide: true });
};
ACT['merge-ok'] = () => { closeDialogs(); toast('Контакти об’єднано. Пометку «можливий дубль» знято.'); };

def('org', {
  title: 'Картка організації', group: '4. Контакти', what: 'організацію',
  states: [['default', 'Звичайний'], ['empty', 'Без угод'], ['loading', 'Завантаження'], ['error', 'Помилка']],
  render(s) {
    if (s === 'loading' || s === 'error') return null;
    const deals = s === 'empty' ? emptyBox('Угод з організацією ще немає.', 'Створіть угоду або прив’яжіть існуючу з картки угоди.', `<button class="btn primary sm" data-act="new-deal">${ic('plus', 14)}Нова угода</button>`)
      : sec('Угоди', `<div class="line-item"><div><a href="#/deal/default">«Зерно» — упаковка франшизи PRO 2.0</a><div class="ml meta"><span>№ 1204</span><span>Друга зустріч</span><span>Софія Гнатюк</span></div></div><div style="display:grid;gap:4px;justify-items:end"><span class="money">6 900 €</span>${st('live', 'відкрита')}</div></div>
         <div class="line-item"><div><a href="#/deal/won">«Зерно» — стратегічна сесія</a><div class="ml meta"><span>№ 988</span><span>закрита 14.07.2026</span></div></div><div style="display:grid;gap:4px;justify-items:end"><span class="money">1 500 $</span>${st('ok', 'виграна')}</div></div>`, { flush: true, right: '<span>2 угоди</span><span>≈ 394 450 ₴</span>' });
    return `${ph('Мережа кав’ярень «Зерно»', { back: ['#/contact/default', 'Ірина Мельник'], meta: '<span>організація</span><span>створено 03.06.2026</span>', actions: '<button class="btn ghost sm">Змінити</button>', lead: 'Організації потрібні переважно в проєкті «Франч». Контакт працює не більше ніж в одній організації.' })}
      <div class="split"><div class="col">${deals}<section class="panel"><div class="sh"><h2 class="h2">Стрічка</h2></div><ul class="tl">${tlItem('note', '', 'Нотатка', '<span>02.11 10:12</span><span>Софія Гнатюк</span>', '<div class="note">7 точок у Львові, планують Київ. Власник хоче зрозуміти вартість упаковки до кінця року.</div>')}${tlItem('stage', '', '<span class="chg">Етап: <b>Зустріч проведена</b> → <b>Друга зустріч</b></span>', '<span>28.10 17:40</span><span>Софія Гнатюк</span>')}</ul></section></div>
      <div class="col">${sec('Дані', '<dl class="facts"><dt class="meta">адреса</dt><dd>Львів, вул. Зелена, 10 (вигадана)</dd><dt class="meta">сайт</dt><dd><a href="#">zerno.example</a></dd><dt class="meta">точок</dt><dd class="num">7</dd><dt class="meta">сфера</dt><dd>Кав’ярні</dd></dl>')}
      ${sec('Контакти', '<div class="line-item"><div><a href="#/contact/default">Ірина Мельник</a><div class="meta">власниця, ЛПР</div></div><span class="meta num">+380 00 123 45 67</span></div><div class="line-item"><div>Степан Іваненко<div class="meta">операційний директор</div></div><span class="meta num">+380 00 222 41 08</span></div>', { flush: true, right: '<span>2</span>' })}</div></div>`;
  },
});

/* ================= UI KIT: element states ================= */
def('kit', {
  title: 'Стани елементів', group: '9. Прототип', what: 'елементи',
  states: [['default', 'Усі стани'], ['toast', 'Тости'], ['dialog', 'Діалог підтвердження']],
  render() {
    const cell = (label, html) => `<div class="kit-cell"><span class="meta">${label}</span>${html}</div>`;
    return `${ph('Стани елементів', { lead: 'Наведення, фокус, натискання, вимкнено й очікування показані статично, щоб їх було видно на знімку. Живі стани працюють на всіх екранах.' })}
    <div class="kit">
      ${sec('Кнопки', `<div class="kit-row">${cell('звичайна', '<button class="btn primary">Зберегти</button>')}${cell('наведення', '<button class="btn primary is-hover">Зберегти</button>')}${cell('фокус', '<button class="btn primary focus-ring">Зберегти</button>')}${cell('натиснута', '<button class="btn primary is-active">Зберегти</button>')}${cell('вимкнена', '<button class="btn primary" disabled>Зберегти</button>')}${cell('очікування', '<button class="btn primary" data-busy aria-busy="true">Зберігаємо…</button>')}</div>
        <div class="kit-row">${cell('ghost', '<button class="btn ghost">Передати</button>')}${cell('ghost: наведення', '<button class="btn ghost is-hover">Передати</button>')}${cell('ghost: фокус', '<button class="btn ghost focus-ring">Передати</button>')}${cell('ghost: вимкнена', '<button class="btn ghost" disabled>CSV</button>')}${cell('quiet', '<button class="btn quiet">Скасувати</button>')}${cell('quiet: наведення', '<button class="btn quiet is-hover">Скасувати</button>')}${cell('pill', '<button class="btn pill">Взяти в роботу</button>')}${cell('небезпечна', '<button class="btn ghost sm danger-text">Видалити</button>')}</div>`)}
      ${sec('Поля', `<div class="grid3">${field('k1', 'Звичайне', inp('k1', '', { ph: 'Ім’я' }))}${field('k2', 'Фокус', inp('k2', 'Ірина', { cls: 'is-focus' }))}${field('k3', 'Помилка', inp('k3', 'iryna@', { err: true }), { err: 'Email має вигляд name@example.com.' })}${field('k4', 'Вимкнене', '<input id="k4" class="input" disabled value="ALPI">')}${field('k5', 'Тільки читання', '<input id="k5" class="input mono" readonly value="package_type">', { hint: 'Код не змінюється після першого значення.' })}${field('k6', 'Список', sel('k6', ['PRO', 'START'], 'PRO'))}</div>
        <div class="kit-row"><label class="check"><input type="checkbox" checked><span>Приймає нові угоди<span class="hint">Бере участь у розподілі по колу, якщо його налаштує автоматизація.</span></span></label><fieldset class="choices"><legend class="vh">Охоплення</legend><label class="choice"><input type="radio" name="kk"><span>свої</span></label><label class="choice"><input type="radio" name="kk" checked><span>команда</span></label><label class="choice"><input type="radio" name="kk"><span>усі</span></label></fieldset></div>`)}
      ${sec('Статуси: текст і точка', `<div class="kit-row">${st('live', 'відкрита')}${st('ok', 'успішний')}${st('wait', 'очікує оплати')}${st('overdue', 'прострочено 2 дні')}${st('today', 'сьогодні 14:00')}${st('future', '06.11')}${st('none', 'немає задачі')}${st('err', '500, 3 спроби')}${st('muted', 'відкликаний')}</div>`)}
      ${sec('Завантаження й порожньо', `<div class="split even"><div class="block" aria-busy="true"><span class="sk" style="font-size:15px"><span class="bar"></span><span class="bar" style="--w:62%"></span><span class="bar" style="--w:80%"></span></span></div><div class="block"><p class="meta-prose">Порожній стан без ілюстрацій: заголовок, один рядок, одна дія.</p></div></div>`)}
      ${sec('Підтвердження на місці', `<div style="display:inline-flex;flex-direction:column;gap:8px;align-items:flex-start"><button class="btn ghost sm" aria-expanded="true">Відкликати ключ</button><div class="strip" role="group"><p>Make перестане працювати з CRM одразу. Відкликати?</p><div class="actions"><button class="btn primary sm">Так, відкликати</button><button class="btn quiet sm">Залишити</button></div></div></div>`)}
    </div>`;
  },
  after(s) {
    if (s === 'toast') { toast('Збережено.'); setTimeout(() => toast('Не вдалося зберегти. Перевірте з’єднання і спробуйте ще раз.', { tone: 'error' }), 300); }
    if (s === 'dialog') openDialog(`${dlgHead('Видалити 3 угоди?', 'Вони пролежать у кошику 30 днів, звідти їх може відновити керівник або адміністратор.')}<div class="dlg-b"><ul class="meta" style="display:grid;gap:4px;padding-left:18px"><li>№ 4821 Оксана Савченко</li><li>№ 4820 Богдан Кравченко</li><li>№ 4790 Максим Бойко</li></ul></div><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-close>Видалити 3</button></div>`);
  },
});
