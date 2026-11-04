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
/* Deal card arranged like Pipedrive's deal view (Actum tokens and components, only the arrangement is borrowed):
   full-width header + stage bar, a narrow column of collapsible sections on the left, and the working column on the
   right: composer, "what to do next", history. Rights below are those of the prototype user (role «Менеджер», ALPI). */
const DEAL_T = 'Ірина Мельник — AI-контент PRO';
const DEAL_RIGHTS = { archive: true, upsell: true, del: false };
const DEAL_DAYS = [2, 0, 1, 0, 0, 6, 1, 1, 0]; // days the deal spent on each stage
const D = { cur: 5 };
const icx = (n, s, cls) => ic(n, s).replace('class="i"', `class="i ${cls}"`);
const drow = (k, v, cls = '') => `<div class="drow ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
const dsec = (id, title, body, { open = true, right = '' } = {}) => `<details class="dsec" data-sec="${id}" ${open ? 'open' : ''}><summary><span class="chev" aria-hidden="true"></span><h2 class="h2">${title}</h2>${right ? `<span class="r meta">${right}</span>` : ''}</summary><div class="dsec-b">${body}</div></details>`;
const dgrp = (title, right, body, open = true) => `<details class="dgrp" ${open ? 'open' : ''}><summary><span class="chev" aria-hidden="true"></span><span class="lbl">${title}</span>${right ? `<span class="r meta-prose">${right}</span>` : ''}</summary><div class="body">${body}</div></details>`;
const chg = (f, was, now) => `<span class="chg">${f}: <span class="was">${was}</span><span class="arrow" aria-label="стало">→</span><span class="now">${now}</span></span>`;
const hItem = (k, icn, tone, what, meta, extra = '', cls = '') => `<li data-k="${k}" class="${cls}"><span class="ic ${tone}">${ic(icn, 12)}</span><div class="body"><div class="what">${what}</div>${extra}<div class="ml meta">${meta}</div></div></li>`;
const ME = '<span>Олена Коваль</span>';

function stageBar(s, cur) {
  const mode = s === 'won' ? 'won' : s === 'lost' ? 'lost' : s === 'archived' ? 'arch' : '';
  const closed = !!mode;
  return `<div class="stagebar ${mode}" role="group" aria-label="Етапи воронки ALPI${closed ? ', угода закрита' : ''}">${PATH.map((n, i) => {
    const past = i <= cur;
    return `<button type="button" class="sg ${i < cur ? 'done' : i === cur ? 'cur' : ''}" data-act="path" data-i="${i}" ${i === cur ? 'aria-current="step"' : ''} title="${n}${past ? `: ${DEAL_DAYS[i]} дн. на етапі` : ''}" ${closed ? 'disabled' : ''}><span class="n">${n}</span><span class="d ${past ? '' : 'hov'}">${past ? `${DEAL_DAYS[i]} дн.` : closed ? '—' : 'перемістити'}</span></button>`;
  }).join('')}</div>`;
}

function dealHeader(s, amount, cur) {
  const won = s === 'won', lost = s === 'lost', arch = s === 'archived';
  const act = won ? `<span class="dh-badge win">${ic('check', 14)}Виграно 04.11</span><button class="btn ghost sm" data-act="reopen">Відкрити знову</button>`
    : lost ? `<span class="dh-badge lose">Програно 04.11</span><button class="btn ghost sm" data-act="reopen">Відкрити знову</button>`
    : arch ? `<span class="dh-badge">${ic('arch', 14)}В архіві з 04.11</span><button class="btn primary sm" data-act="unarch">Повернути з архіву</button>`
    : `<button type="button" class="btn win-b" data-act="d-won">Виграно</button><button type="button" class="btn lose-b" data-act="d-lost">Програно</button>`;
  return `<a class="back" href="#/kanban/default" style="margin-top:12px">${ic('back', 14)}Воронка ALPI</a>
  <header class="dh">
    <div class="dh-top">
      <div class="dh-main">
        <div class="ml meta"><span>№ <b>4517</b></span><span>воронка ALPI</span><span>створено 26.10.2026</span></div>
        <div class="dh-tw editable" data-act="edit-title" title="Натисніть, щоб змінити назву"><h1 class="h1" id="d-title" tabindex="-1">${DEAL_T}</h1>${icx('pen', 18, 'pen')}</div>
        <div class="dh-sub">
          <button type="button" class="dh-amount editable" data-act="edit-amount" title="Змінити суму"><span class="big-money" id="d-amt">${fmt(amount)} €</span><span class="meta">≈ ${fmt(amount * RATES.EUR)} ₴</span></button>
          <span class="sep" aria-hidden="true"></span>
          <button type="button" class="owner" data-act="transfer" title="Передати угоду"><span class="ava" aria-hidden="true">ОК</span>Олена Коваль<span class="meta">відповідальна</span></button>
          <span class="sep" aria-hidden="true"></span>
          <div class="labels" aria-label="Мітки"><span class="ltag" data-c="ask"><i aria-hidden="true"></i>Гаряча</span><span class="ltag" data-c="acc"><i aria-hidden="true"></i>Повторна реєстрація</span>${arch ? '' : '<span class="me-wrap"><button type="button" class="ltag add" data-act="add-label" aria-haspopup="menu">+ Мітка</button></span>'}</div>
        </div>
      </div>
      <div class="dh-act">${act}<div class="me-wrap"><button type="button" class="icon-btn more-b" data-act="deal-more" aria-label="Інші дії з угодою" aria-haspopup="menu" aria-expanded="false">${ic('more')}</button></div></div>
    </div>
    ${stageBar(s, cur)}
  </header>`;
}

function dealSide(s, amount) {
  const won = s === 'won', lost = s === 'lost', arch = s === 'archived', dup = s === 'duplicate', val = s === 'validation';
  const paidP = Math.round(700 / amount * 100);
  const summary = drow('сума угоди', `<span class="money" id="d-sum">${fmt(amount)} €</span> <span class="meta">EUR</span>`)
    + drow('оплачено', `<span class="money">700 €</span> <span class="meta">з ${fmt(amount)} €</span><div class="prog" style="margin-top:6px" role="progressbar" aria-valuenow="${paidP}" aria-valuemin="0" aria-valuemax="100" aria-label="Оплачено"><i style="--p:${paidP}%"></i></div>`)
    + drow(won || lost ? 'закрито' : 'очікуване закриття', won || lost ? '<span class="num">04.11.2026</span>' : '<span class="num">06.11.2026</span> <span class="meta">через 2 дн.</span>')
    + drow('мітки', '<span class="labels"><span class="ltag" data-c="ask"><i aria-hidden="true"></i>Гаряча</span><span class="ltag" data-c="acc"><i aria-hidden="true"></i>Повторна реєстрація</span></span>')
    + `<div class="sub-h"><span>Товари</span>${arch ? '' : '<button type="button" class="link-a" style="font-size:13px;font-weight:400" data-act="copy">+ Товар</button>'}</div>
      <div class="prod"><span>AI-контент PRO</span><span class="money">1 190 €</span><span class="meta">1 × 1 190 €</span></div>
      <div class="prod"><span>Модуль «AI-відео»</span><span class="money">100 €</span><span class="meta">1 × 100 €</span></div>
      <div class="prod tot"><span class="meta">сума по товарах</span><span class="money">1 290 €</span></div>
      ${won ? '' : `<div class="diff" id="sumhint"><span class="grow">Сума угоди <b class="num" style="font-weight:500">${fmt(amount)} €</b> відрізняється від суми товарів.</span><button type="button" class="btn ghost sm" data-act="apply-sum" ${arch ? 'disabled' : ''}>Підставити 1 290 €</button></div>`}
      <div class="sub-h"><span>Платежі</span><span class="meta" style="font-weight:400">WayForPay</span></div>
      ${[['Бронь', 200, st('ok', 'успішний'), '30.10'], ['Доплата', 500, st('ok', 'успішний'), '01.11'], ['Рахунок', 590, st('wait', 'очікує'), 'до 06.11']].map(([t, a, s2, d]) => `<div class="prod"><span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${t}${s2}</span><span class="money">${a} €</span><span class="meta">${d}</span></div>`).join('')}
      <button type="button" class="btn ghost sm" style="justify-self:start;margin-top:8px" data-act="invoice" ${arch || lost ? 'disabled' : ''}>Виставити рахунок</button>`;
  const contact = `<div class="who-line"><span class="ava" aria-hidden="true">ІМ</span><a class="nm" href="#/contact/default">Ірина Мельник</a>${dup ? `<span class="dup-badge">${ic('merge', 12)}можливий дубль</span>` : '<span class="meta">основний контакт</span>'}</div>
    ${drow('телефон', '<span class="num">+380 00 123 45 67</span>')}${drow('email', 'iryna.melnyk@example.com')}${drow('мова', 'українська')}${drow('учасник', 'Андрій Мельник <span class="meta">співрішення</span>')}
    ${dup ? `<div class="diff"><span class="grow">Email збігається з контактом «Iryna M.» (№ 3302).</span><button type="button" class="btn ghost sm" data-act="go" data-to="contact" data-st="duplicate">Порівняти</button></div>` : ''}`;
  const org = `<div class="who-line"><span class="ava" aria-hidden="true" style="border-radius:var(--r-inner)">${ic('org', 14)}</span><a class="nm" href="#/org/default">ФОП Мельник І. В.</a></div>
    ${drow('місто', 'Київ')}${drow('угоди', '1 відкрита')}${drow('сайт', '<span class="meta">—</span>')}`;
  const need = val ? ' need' : '';
  const selOrVal = (label, opts, v) => (won ? v : `<select class="select sm" aria-label="${label}" ${val ? 'aria-invalid="true"' : ''} ${arch ? 'disabled' : ''}>${opts.map((o) => `<option>${o}</option>`).join('')}</select>`);
  const details = dgrp('Кваліфікація', '', drow('тип клієнта', 'Найманий працівник') + drow('професія', 'Дизайнер') + drow('дохід на місяць', '<span class="money">45 000 ₴</span>'))
    + dgrp('Закриття', val ? '<span class="ask">2 порожні обов’язкові</span>' : 'обов’язкові з 7-го етапу',
      drow('пакет <span class="ask" aria-label="обов’язкове">*</span>', selOrVal('Пакет', ['Не вибрано', 'START', 'PRO', 'MAX'], 'PRO'), need)
      + drow('тип закриття <span class="ask" aria-label="обов’язкове">*</span>', selOrVal('Тип закриття', ['Не вибрано', 'Бронь + доплата', 'Повна оплата'], 'Бронь + доплата'), need)
      + drow('дата оплати', '<span class="meta">—</span>'))
    + dgrp('Вебінар', '3 поля', drow('вебінар', '«AI-контент з нуля», 28.10') + drow('перегляд', '<span class="num">86 %</span> <span class="meta">68 хв з 79</span>') + drow('рівень прогріву', 'Високий'), false)
    + dgrp('Службове', `${ic('lock', 12)}лише перегляд`, drow('підрядник', 'Свій таргет', 'ro') + drow('вартість реєстрації', '<span class="money">3,10 $</span>', 'ro'))
    + `<p class="hidden-grp meta-prose">${ic('lock', 14)}Ще 1 група полів прихована для ролі «Менеджер».</p>`;
  const regs = [['Google Ads', '31.10 18:30', [['utm_source', 'google'], ['utm_campaign', 'search_ai_kurs'], ['сторінка', 'alpi.example/ai-video']]], ['Facebook Ads', '26.10 19:02', [['utm_source', 'facebook'], ['utm_campaign', 'ai_content_webinar_oct'], ['сторінка', 'alpi.example/ai-content']]]];
  const overview = drow('вік угоди', '<span class="num">9</span> дн.') + drow('без руху', `<span class="num">${won || lost ? 0 : 1}</span> дн. <span class="meta">остання зміна ${won || lost ? '04.11' : '03.11'}</span>`)
    + drow('на етапі', `${PATH[D.cur]} <span class="meta">${DEAL_DAYS[D.cur]} дн.</span>`) + drow('створено', '<span class="num">26.10.2026 19:02</span>') + drow('джерело', 'Facebook Ads <span class="ctag">ai_content_webinar_oct</span>')
    + dgrp('Реєстрації', '2', regs.map(([src, d, rows]) => `<div class="sub-h" style="border:0;padding-top:6px;margin:0"><span>${src}</span><span class="meta" style="font-weight:400">${d}</span></div>${rows.map(([k, v]) => drow(k, /^utm/.test(k) ? `<span class="ctag">${v}</span>` : v)).join('')}`).join(''), false);
  return `<div class="d-side">
    ${dsec('sum', 'Підсумок', summary)}
    ${dsec('contact', 'Контакт', contact, { right: '2 угоди' })}
    ${dsec('org', 'Організація', org)}
    ${dsec('details', 'Деталі', details, { right: 'воронка ALPI' })}
    ${dsec('overview', 'Огляд', overview)}
  </div>`;
}

function dealComposer(arch) {
  const dis = arch ? 'disabled' : '';
  const tab = (t, label, icn, on) => `<button type="button" class="tab" role="tab" aria-selected="${on}" data-act="ctab" data-t="${t}">${ic(icn, 14)}${label}</button>`;
  const soon = (label, icn) => `<button type="button" class="tab" role="tab" aria-selected="false" disabled title="З’явиться в наступній версії">${ic(icn, 14)}${label}<span class="soon">скоро</span></button>`;
  return `<section class="panel d-comp" aria-label="Додати до угоди">
    <div class="tabs" role="tablist" aria-label="Що додати">${tab('note', 'Нотатка', 'note', true)}${tab('task', 'Задача', 'task', false)}${tab('file', 'Файл', 'clip', false)}${soon('Дзвінок', 'phone')}${soon('Рахунок', 'pay')}</div>
    <div class="cpane" data-pane="note" role="tabpanel"><label class="vh" for="nt">Нотатка</label><textarea id="nt" class="textarea" placeholder="${arch ? 'Угода в архіві: нотатки не додаються' : 'Що важливо знати про клієнта'}" ${dis}></textarea>
      <div class="foot"><span class="meta-prose">бачать усі, хто має доступ до угоди</span><button type="button" class="btn primary sm" data-act="note" ${dis}>Зберегти <kbd aria-hidden="true">Ctrl ↵</kbd></button></div></div>
    <div class="cpane" data-pane="task" role="tabpanel" hidden><div class="task-f">
      ${field('ct1', 'Тип', sel('ct1', ['Дзвінок', 'Очікую оплату', 'Дожим', 'Консультація'], 'Дзвінок'))}${field('ct2', 'Дата', inp('ct2', '05.11.2026', { cls: 'num' }))}${field('ct3', 'Час', inp('ct3', '11:00', { cls: 'num' }))}
      <div class="wide">${field('ct4', 'Тема', inp('ct4', '', { ph: 'Наприклад: нагадати про залишок 490 €' }))}</div></div>
      <div class="foot"><span class="meta-prose">виконавець: Олена Коваль</span><button type="button" class="btn primary sm" data-act="ctask" ${dis}>Створити задачу</button></div></div>
    <div class="cpane" data-pane="file" role="tabpanel" hidden><div class="drop">${ic('clip', 18)}<span>Перетягніть файл сюди або <button type="button" class="link-a" data-act="cfile" ${dis}>виберіть на комп’ютері</button></span><span class="meta-prose">PDF, зображення, документи до 25 МБ</span></div></div>
  </section>`;
}

const NEXT = [['over', 'mail', 'Надіслати програму модуля «AI-відео»', 'лист', 'вчора 18:00 · прострочено'], ['today', 'phone', 'Дізнатись рішення', 'дзвінок', 'сьогодні 12:00'], ['future', 'pay', 'Очікую оплату: рахунок 590 €', 'оплата', '06.11']];
const nxRow = ([tone, icn, t, kind, when], fresh) => `<div class="nx ${tone}${fresh ? ' fresh' : ''}" ${fresh ? 'style="animation:fresh 1.2s var(--ease) both"' : ''}><input type="checkbox" class="cb" aria-label="Виконано: ${esc(t)}" data-change="nx-done"><span class="ic" aria-hidden="true">${ic(icn, 12)}</span><div style="display:grid;gap:2px;min-width:0"><span class="ttl">${esc(t)}</span><span class="ml meta"><span>${kind}</span>${ME}</span></div><span class="when">${when}</span></div>`;
function dealNext(closed) {
  return `<section class="panel d-next" aria-labelledby="nx-t"><div class="sh"><h2 class="h2" id="nx-t">Що зробити далі</h2>${closed ? '' : `<button type="button" class="btn ghost sm" data-act="ctab" data-t="task">${ic('plus', 14)}Задача</button>`}</div>
    <div id="nx-list">${closed ? '<p class="meta-prose" style="padding:14px 16px 16px">Запланованих задач немає. Угода закрита.</p>' : NEXT.map((n) => nxRow(n)).join('')}</div></section>`;
}

function dealHistory(s) {
  const items = [];
  if (s === 'won') items.push(hItem('change', 'check', 'win', chg('Статус', 'відкрита', 'виграна'), `<span>сьогодні 10:05</span>${ME}`));
  if (s === 'lost') items.push(hItem('change', 'close', '', chg('Статус', 'відкрита', 'програна'), `<span>сьогодні 10:05</span>${ME}`, '<div class="note">Причина: АІ 2 · Після вебінару → Дорого. «Повернеться після Нового року».</div>'));
  if (s === 'archived') items.push(hItem('change', 'arch', '', 'Угоду перенесено в архів', `<span>сьогодні 10:05</span>${ME}`));
  items.push(
    hItem('call', 'phone', 'ask', '<b style="font-weight:500">Пропущений вхідний дзвінок</b> з +380 00 123 45 67', '<span>сьогодні 09:12</span><span>Unitalk</span>'),
    hItem('file', 'file', '', 'Файл додано', `<span>03.11 16:45</span>${ME}`, '<a class="file" href="#" onclick="return false"><span class="ext">PDF</span><span class="ellip">Договір-оферта_Мельник.pdf</span><span class="meta">214 КБ</span></a>'),
    hItem('task', 'task', '', 'Задача «Очікую оплату» на 06.11', `<span>03.11 16:41</span>${ME}`),
    hItem('pay', 'pay', 'acc', 'Виставлено рахунок <span class="money">590 €</span>', `<span>03.11 16:40</span>${ME}<span>WayForPay</span>`),
    hItem('change', 'edit', '', chg('Сума угоди', '1 290 €', '1 190 €'), `<span>02.11 10:20</span>${ME}`, '<span class="meta-prose">знижка на модуль «AI-відео» за домовленістю</span>'),
    hItem('note', 'note', '', 'Нотатка', `<span>01.11 12:15</span>${ME}`, '<div class="note">Доплатила 500 €. Залишок 590 € — чекає зарплату, обіцяла до 06.11.</div>'),
    hItem('pay', 'pay', 'acc', 'Платіж успішний: доплата <span class="money">500 €</span>', '<span>01.11 12:10</span><span>картка **** 4417</span>'),
    hItem('task', 'check', '', 'Задачу виконано: «Дзвінок після вебінару»', `<span>30.10 15:30</span>${ME}`),
    hItem('pay', 'pay', 'acc', 'Платіж успішний: бронь <span class="money">200 €</span>', '<span>30.10 14:03</span><span>картка **** 4417</span>'),
    hItem('change', 'stage', '', chg('Етап', 'Був на вебінарі', 'Приймає рішення'), `<span>29.10 11:24</span>${ME}`),
    hItem('call', 'phone', '', 'Вхідний дзвінок, 12:48', `<span>29.10 11:05</span>${ME}`, `<div class="player"><button type="button" class="play" aria-label="Прослухати запис">${ic('play', 12)}</button><span class="wave" aria-hidden="true"></span><span class="meta">4:52 / 12:48</span></div>`),
    hItem('change', 'edit', '', chg('Перегляд, %', '—', '86'), '<span>28.10 21:40</span><span>ключ API «Make: вебінари»</span>'),
    hItem('change', 'stage', '', chg('Етап', 'Новий лід', 'Був на вебінарі'), '<span>28.10 21:40</span><span>ключ API «Make: вебінари»</span>'),
    hItem('reg', 'reg', '', 'Угоду створено з реєстрації на вебінар «AI-контент з нуля»: Facebook Ads', '<span>26.10 19:02</span><span>лендинг ai-content</span>'),
  );
  const count = (k) => items.filter((h) => k === 'all' || h.startsWith(`<li data-k="${k}"`)).length;
  const chips = [['all', 'Усе'], ['note', 'Нотатки'], ['task', 'Задачі'], ['file', 'Файли'], ['change', 'Зміни']];
  return `<section class="panel d-hist" aria-labelledby="h-t"><div class="sh"><h2 class="h2" id="h-t">Історія</h2>
    <div class="hchips" role="group" aria-label="Фільтр історії">${chips.map(([k, l]) => `<button type="button" class="fchip nox" aria-pressed="${k === 'all'}" data-act="hfilter" data-k="${k}">${l} <span class="meta" data-n="${k}">${count(k)}</span></button>`).join('')}</div></div>
    <ul class="hist">${items.join('')}</ul></section>`;
}

function dealPage(s) {
  const won = s === 'won', lost = s === 'lost', arch = s === 'archived', dup = s === 'duplicate', val = s === 'validation';
  const amount = won ? 1290 : 1190;
  D.cur = won ? 7 : 5;
  return `${dealHeader(s, amount, D.cur)}
  ${arch || dup || lost || val ? `<div class="col" style="gap:10px;margin:-6px 0 18px">
    ${arch ? `<div class="notice">${ic('arch')}<span class="grow">Угода в архіві: не видна на канбані й у робочих списках, але є в пошуку та звітах. Нова реєстрація цієї людини створить нову угоду.</span></div>` : ''}
    ${dup ? `<div class="notice"><span class="grow"><b style="font-weight:500">Можливий дубль.</b> Телефон з нової реєстрації збігається з контактом «Ірина Мельник», email — з контактом «Iryna M.» (№ 3302). Об’єднайте їх, щоб історія була в одному місці.</span><button type="button" class="btn ghost sm" data-act="go" data-to="contact" data-st="duplicate">${ic('merge', 14)}Порівняти й об’єднати</button></div>` : ''}
    ${lost ? '<div class="notice calm" style="background:var(--raised);box-shadow:inset 2px 0 0 var(--danger)"><span class="grow">Причина програшу: <b style="font-weight:500">АІ 2 · Після вебінару → Дорого</b>. Коментар: «Повернеться після Нового року».</span></div>' : ''}
    ${val ? '<div class="notice" role="alert"><span class="grow">Угоду не перенесено на етап «Сплатив бронювання»: заповніть поля <b style="font-weight:500">Пакет</b> і <b style="font-weight:500">Тип закриття</b> (розділ «Деталі»). Ці правила діють і для людей, і для запитів API.</span></div>' : ''}
  </div>` : ''}
  <div class="deal">
    ${dealComposer(arch)}
    ${dealSide(s, amount)}
    ${dealNext(won || lost || arch)}
    ${dealHistory(s)}
  </div>`;
}

const dealLoading = () => `<div class="dh" aria-busy="true" style="margin-top:20px"><span class="sk" style="font-size:13px;width:220px"><span class="bar"></span></span><span class="sk" style="font-size:40px;width:min(560px,100%)"><span class="bar"></span></span><span class="sk" style="font-size:22px;width:min(420px,90%)"><span class="bar"></span></span><span class="bar" style="height:44px;border-radius:var(--r-inner)"></span></div>
  <div class="deal" aria-busy="true"><div class="panel d-comp" style="padding:16px"><span class="bar tall"></span></div>
    <div class="d-side">${[4, 4, 3, 5].map((n) => `<div class="dsec" style="padding:14px 16px"><span class="sk" style="font-size:15px"><span class="bar" style="--w:40%"></span>${Array.from({ length: n }, (_, i) => `<span class="bar" style="--w:${88 - (i % 3) * 14}%"></span>`).join('')}</span></div>`).join('')}</div>
    <div class="d-next">${generic('loading')}</div></div>`;

def('deal', {
  title: 'Картка угоди', group: '3. Угоди', nav: 'kanban', what: 'угоду',
  states: [['default', 'Відкрита'], ['won', 'Виграна'], ['lost', 'Програна'], ['archived', 'В архіві'], ['duplicate', 'Можливий дубль'], ['validation', 'Обов’язкові з етапу'], ['invoice', 'Рахунок: форма'], ['invoice-done', 'Рахунок створено'], ['loading', 'Завантаження'], ['error', 'Помилка'], ['forbidden', 'Немає доступу'], ['offline', 'Офлайн']],
  render(s) {
    if (s === 'loading') return dealLoading();
    if (s === 'forbidden') return `<section class="panel"><div class="empty"><p class="meta" style="margin-bottom:10px"><b>403</b></p><h2 class="t">Клієнт уже в роботі в Марії Бондар.</h2><p class="x">Угода № 4510 поза вашим охопленням «свої». Вміст угоди не показуємо. Якщо клієнт звернувся саме до вас, напишіть Марії або тімліду Дмитру Ткачу.</p><div class="a"><a class="btn ghost sm" href="#/kanban/default">До воронки</a></div></div></section>`;
    if (s === 'error') return null;
    return dealPage(s);
  },
  after(s) {
    const sb = $('.stagebar'), cur = $('.sg.cur');
    if (sb && cur && sb.scrollWidth > sb.clientWidth) sb.scrollLeft += cur.getBoundingClientRect().left - sb.getBoundingClientRect().left - 40;
    // on a phone the sections come as collapsed blocks under the composer; the one the state is about stays open
    const keep = { duplicate: 'contact', validation: 'details' }[s];
    if (innerWidth <= 860) $$('.dsec').forEach((d) => { d.open = d.dataset.sec === 'sum' || d.dataset.sec === keep; });
    $('#nt')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ACT.note(); } });
    if (s === 'invoice' || s === 'invoice-done') invoiceDialog(s === 'invoice-done');
    if (s === 'validation') requiredDialog(DEAL_T, STAGES[6], () => moveStage(6), true);
  },
});
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
    setTimeout(() => { $('#invb', d).innerHTML = invoiceDone(); $('.dlg-f', d).innerHTML = '<button class="btn primary sm" data-close>Готово</button>'; toast('Рахунок на 490 € створено.'); }, 900);
  });
}
const invoiceDone = () => `<div class="secret"><p class="secret-title">Рахунок на <span class="num">490</span> € створено</p><p class="ink2" style="font-size:14px">Надішліть посилання клієнтці. Воно дійсне до 07.11.2026 23:59.</p>
  <div class="copy-row"><input class="input mono" readonly value="https://secure.wayforpay.com/invoice/i7f2c9a41d" aria-label="Посилання на оплату"><button class="btn ghost sm" data-act="copy">${ic('copy', 14)}Скопіювати</button></div></div>`;
const closePops = () => { $$('.pop').forEach((p) => p.remove()); $$('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false')); };
function histAdd(k, icn, what, extra = '') {
  const ul = $('.hist');
  if (!ul) return;
  ul.insertAdjacentHTML('afterbegin', hItem(k, icn, '', what, `<span>щойно</span>${ME}`, extra, 'fresh'));
  $$('[data-n]').forEach((n) => { n.textContent = $$('.hist > li').filter((li) => n.dataset.n === 'all' || li.dataset.k === n.dataset.n).length; });
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
    const d = x.querySelector('.d');
    d.classList.toggle('hov', j > i);
    d.textContent = j > i ? 'перемістити' : j === i ? '0 дн.' : `${DEAL_DAYS[j]} дн.`;
  });
  const c = $('.sg.cur');
  setTimeout(() => { c.classList.add('landed'); }, Math.abs(i - from) * 45 + 120);
  histAdd('change', 'stage', chg('Етап', PATH[from], PATH[i]));
  toast(`Етап змінено на «${PATH[i]}».`, { action: 'Скасувати' });
}
Object.assign(ACT, {
  invoice: () => invoiceDialog(false),
  'apply-sum': () => {
    $('#d-amt').textContent = '1 290 €'; $('#d-sum').textContent = '1 290 €';
    $('.dh-amount .meta').textContent = `≈ ${fmt(1290 * RATES.EUR)} ₴`;
    $('#sumhint')?.remove();
    histAdd('change', 'edit', chg('Сума угоди', '1 190 €', '1 290 €'));
    toast('Суму угоди змінено на 1 290 €.', { action: 'Скасувати' });
  },
  path: (b) => { const i = +b.dataset.i; if (i === D.cur) return; if (i >= 6 && i > D.cur) { requiredDialog(DEAL_T, STAGES[6], () => moveStage(i)); return; } moveStage(i); },
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
  transfer: () => openDialog(`${dlgHead('Передати угоду')}<div class="dlg-b">${field('tr', 'Новий відповідальний', sel('tr', ['Андрій Шевчук', 'Ірина Лисенко', 'Без відповідального (загальна черга)'], 'Андрій Шевчук'))}</div><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-close data-act="copy">Передати</button></div>`),
  'edit-title': (b) => {
    const h = $('#d-title', b);
    if (h.isContentEditable) return;
    const before = h.textContent;
    b.classList.add('editing'); h.contentEditable = 'true'; h.focus();
    getSelection().selectAllChildren(h);
    const done = (save) => {
      h.contentEditable = 'false'; b.classList.remove('editing');
      const now = h.textContent.trim();
      if (!save || !now) { h.textContent = before; return; }
      if (now !== before) { histAdd('change', 'edit', chg('Назва', esc(before), esc(now))); toast('Назву угоди змінено.'); }
    };
    h.addEventListener('keydown', function k(e) { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); h.removeEventListener('keydown', k); done(e.key === 'Enter'); h.blur(); } });
    h.addEventListener('blur', () => { if (h.isContentEditable) done(true); }, { once: true });
  },
  'edit-amount': () => openDialog(`${dlgHead('Сума угоди', 'Сума по товарах: 1 290 €. Зміна потрапить в історію угоди.')}<div class="dlg-b"><div class="grid2">${field('ea', 'Сума', inp('ea', $('#d-amt').textContent.replace(/[^\d]/g, ''), { cls: 'num' }))}${field('ec', 'Валюта', sel('ec', ['EUR', 'UAH', 'USD'], 'EUR'))}</div></div><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="ea-ok">Зберегти</button></div>`),
  'ea-ok': () => {
    const v = +$('#ea').value.replace(/\D/g, ''), was = $('#d-amt').textContent;
    closeDialogs();
    if (!v || `${fmt(v)} €` === was) return;
    $('#d-amt').textContent = `${fmt(v)} €`; $('#d-sum').textContent = `${fmt(v)} €`; $('.dh-amount .meta').textContent = `≈ ${fmt(v * RATES.EUR)} ₴`;
    if (v === 1290) $('#sumhint')?.remove();
    histAdd('change', 'edit', chg('Сума угоди', was, `${fmt(v)} €`));
    toast(`Суму угоди змінено на ${fmt(v)} €.`);
  },
  'add-label': (b) => togglePop(b, `<div class="glabel meta">Мітки угоди</div>${[['VIP', 'acc'], ['Розстрочка', ''], ['Партнер', 'ask']].map(([l, c]) => `<button class="opt" role="menuitem" data-act="pick-label" data-l="${l}" data-c="${c}"><span class="ltag" data-c="${c}"><i aria-hidden="true"></i>${l}</span></button>`).join('')}`),
  'pick-label': (b) => { closePops(); $('.dh .labels .me-wrap').insertAdjacentHTML('beforebegin', `<span class="ltag" data-c="${b.dataset.c}" style="animation:actum-lift var(--dur-base) var(--ease)"><i aria-hidden="true"></i>${b.dataset.l}</span>`); toast(`Мітку «${b.dataset.l}» додано.`); },
  ctab: (b) => {
    const t = b.dataset.t;
    $$('.d-comp .tab[data-t]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.t === t)));
    $$('.d-comp .cpane').forEach((p) => { p.hidden = p.dataset.pane !== t; });
    const pane = $(`.d-comp .cpane[data-pane="${t}"]`);
    pane.style.animation = 'none'; void pane.offsetWidth; pane.style.animation = 'actum-fade var(--dur-base) var(--ease)';
    if (!b.closest('.d-comp')) { $('.d-comp').scrollIntoView({ behavior: S.calm ? 'auto' : 'smooth', block: 'center' }); setTimeout(() => $('#ct4')?.focus(), 300); }
  },
  note: () => { const t = $('#nt'); if (!t.value.trim()) { t.setAttribute('aria-invalid', 'true'); toast('Нотатка порожня.', { tone: 'error' }); return; } t.removeAttribute('aria-invalid'); histAdd('note', 'note', 'Нотатка', `<div class="note">${esc(t.value)}</div>`); t.value = ''; toast('Нотатку збережено.'); },
  ctask: () => {
    const subj = $('#ct4').value.trim() || $('#ct1').value, when = `${$('#ct2').value.slice(0, 5)} ${$('#ct3').value}`.trim();
    $('#nx-list').insertAdjacentHTML('beforeend', nxRow(['future', 'task', subj, $('#ct1').value.toLowerCase(), when], true));
    histAdd('task', 'task', `Задача «${esc(subj)}» на ${esc(when)}`);
    $('#ct4').value = ''; toast('Задачу створено.');
  },
  cfile: () => { histAdd('file', 'file', 'Файл додано', '<a class="file" href="#" onclick="return false"><span class="ext">PDF</span><span class="ellip">Програма_AI-відео.pdf</span><span class="meta">1,2 МБ</span></a>'); toast('Файл «Програма_AI-відео.pdf» додано.'); },
  'nx-done': (b) => {
    const row = b.closest('.nx'); row.classList.toggle('done', b.checked);
    if (!b.checked) return;
    histAdd('task', 'check', `Задачу виконано: «${esc(row.querySelector('.ttl').textContent)}»`);
    $('.d-next .strip')?.remove();
    $('#nx-list').insertAdjacentHTML('afterend', `<div class="strip"><p>Задачу виконано. Запланувати наступну?</p><div class="actions"><button type="button" class="btn primary sm" data-act="ctab" data-t="task">Запланувати</button><button type="button" class="btn quiet sm" onclick="this.closest('.strip').remove()">Ні, дякую</button></div></div>`);
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
