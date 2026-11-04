/* ПРОТОТИП · Напрям 4 «Нічна консоль». Усе в памʼяті; перезавантаження = скидання. */
(function () {
  'use strict';
  const { PROJECTS, RATES, TODAY, NOTIFS } = window.CRM;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const app = $('#app');

  /* ---------------- Стан ---------------- */
  const qs = new URLSearchParams(location.search);
  const S = {
    proj: qs.get('proj') === 'franch' ? 'franch' : 'alpi',
    screen: qs.get('screen') || 'kanban',
    state: qs.get('state') || 'normal',
    theme: qs.get('theme') === 'light' ? 'light' : 'dark',
    lang: qs.get('lang') === 'ru' ? 'ru' : 'uk',
    w390: qs.get('w') === '390',
    bar: qs.get('bar') !== '0',
    dealId: null,
    listTab: 'open',
    sel: new Set(),
    kbRow: -1,
    kbCard: null,
    mStage: 0,
    queueOnly: false,
    feedFilter: 'all',
    roleTab: 'Тімлід',
    roleEdits: {},
    signinStep: 2,
    overlay: null,     // 'palette' | 'notif' | 'proj' | 'pipe' | 'stage' | 'more' | 'owner'
    dialog: null,      // {type, ...}
    toasts: [],
    drawer: false,
    playing: false,
    amountOverride: {}
  };
  const P = () => PROJECTS[S.proj];
  PROJECTS.alpi.role = 'Керівник';
  PROJECTS.franch.role = 'Адміністратор';

  /* ---------------- Тексти оболонки UK / RU ---------------- */
  const T = {
    uk: {
      search: 'Пошук: імʼя, телефон, email, угода…', work: 'Робота', kanban: 'Канбан угод', list: 'Список угод',
      contacts: 'Контакти', orgs: 'Організації', tasks: 'Задачі й календар', dash: 'Панель на сьогодні',
      settings: 'Налаштування', roles: 'Ролі та права', pipes: 'Воронки та етапи', fields: 'Поля', products: 'Товари',
      reasons: 'Причини програшу', ttypes: 'Типи задач', integr: 'Інтеграції', trash: 'Кошик', deals: 'Угоди',
      newDeal: 'Нова угода', won: 'Виграна', lost: 'Програна', archive: 'В архів', take: 'Взяти в роботу',
      notifs: 'Сповіщення', keys: 'Клавіші', queue: 'Загальна черга', mine: 'Мої', all: 'Усі відкриті',
      overdue: 'Прострочені', task: 'Задача', transfer: 'Передати', reopen: 'Відкрити знову', signout: 'Вийти',
      dropWon: 'Виграна', dropLost: 'Програна', dropArch: 'В архів', reason: 'попросимо причину',
      users: 'Користувачі', teams: 'Команди', theme: 'Тема', lang: 'Мова'
    },
    ru: {
      search: 'Поиск: имя, телефон, email, сделка…', work: 'Работа', kanban: 'Канбан сделок', list: 'Список сделок',
      contacts: 'Контакты', orgs: 'Организации', tasks: 'Задачи и календарь', dash: 'Панель на сегодня',
      settings: 'Настройки', roles: 'Роли и права', pipes: 'Воронки и этапы', fields: 'Поля', products: 'Товары',
      reasons: 'Причины проигрыша', ttypes: 'Типы задач', integr: 'Интеграции', trash: 'Корзина', deals: 'Сделки',
      newDeal: 'Новая сделка', won: 'Выиграна', lost: 'Проиграна', archive: 'В архив', take: 'Взять в работу',
      notifs: 'Уведомления', keys: 'Клавиши', queue: 'Общая очередь', mine: 'Мои', all: 'Все открытые',
      overdue: 'Просроченные', task: 'Задача', transfer: 'Передать', reopen: 'Открыть заново', signout: 'Выйти',
      dropWon: 'Выиграна', dropLost: 'Проиграна', dropArch: 'В архив', reason: 'спросим причину',
      users: 'Пользователи', teams: 'Команды', theme: 'Тема', lang: 'Язык'
    }
  };
  const t = (k) => T[S.lang][k] || T.uk[k] || k;

  /* ---------------- Допоміжні ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const SYM = { EUR: '€', UAH: '₴', USD: '$' };
  const money = (n, cur) => `${fmtN(n)} ${SYM[cur]}`;
  const dm = (iso) => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '';
  const dmy = (iso) => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';
  const at = (s) => `${dm(s.slice(0, 10))} ${s.slice(11)}`;
  const ic = (n, cls = '') => `<i data-lucide="${n}" class="${cls}"></i>`;
  const kbd = (...ks) => ks.map((k) => `<span class="kbd">${esc(k)}</span>`).join('');
  const initials = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2);
  const userById = (id) => P().users.find((u) => u.id === id);
  const avatar = (id, lg) => {
    const u = userById(id);
    return u ? `<span class="avatar${lg ? ' lg' : ''}" title="${esc(u.n)}">${esc(initials(u.n))}</span>` : `<span class="avatar none${lg ? ' lg' : ''}" title="Без відповідального"></span>`;
  };
  const stIcon = (d) => {
    const k = d.archived ? 'arch' : d.status === 'won' ? 'won' : d.status === 'lost' ? 'lost' : 'open';
    const label = { arch: 'В архіві', won: 'Виграна', lost: 'Програна', open: 'Відкрита' }[k];
    const inner = k === 'won' ? '<path d="M4.4 7.2l1.8 1.8 3.5-3.7"/>' : k === 'lost' ? '<path d="M5.2 5.2l3.6 3.6M8.8 5.2l-3.6 3.6"/>' : '';
    return `<svg class="st ${k}" viewBox="0 0 14 14" role="img" aria-label="${label}"><title>${label}</title><circle cx="7" cy="7" r="6"/>${inner}</svg>`;
  };
  const taskInd = (d) => {
    const tk = d.task;
    if (d.status !== 'open') return '';
    if (!tk) return `<span class="task none" title="Немає запланованих задач">${ic('calendar-off', 'ic-12')}немає</span>`;
    if (tk.kind === 'overdue') return `<span class="task overdue" title="Прострочено: ${esc(tk.type)}, ${dm(tk.date)}">${ic('alarm-clock', 'ic-12')}${dm(tk.date)}</span>`;
    if (tk.kind === 'today') return `<span class="task today" title="Сьогодні: ${esc(tk.type)}">${ic('clock', 'ic-12')}${tk.time || 'сьогодні'}</span>`;
    return `<span class="task future" title="${esc(tk.type)}, ${dm(tk.date)}">${dm(tk.date)}</span>`;
  };
  const dealById = (id) => P().deals.find((d) => d.id === id);
  const boardDeals = () => P().deals.filter((d) => !d.listOnly && d.status === 'open' && !d.archived && (!S.queueOnly || !d.owner));
  const total = (d) => (d.products || []).reduce((a, p) => a + p.qty * p.price, 0);
  const uah = (n, cur) => n * RATES[cur];

  /* ---------------- Оболонка ---------------- */
  function header() {
    const p = P();
    const unread = NOTIFS.length;
    return `<header class="hdr">
      <button class="btn ghost icon only-m" data-act="drawer" aria-label="Меню">${ic('menu')}</button>
      <button class="proj" data-act="ov" data-ov="proj" aria-haspopup="menu" aria-expanded="${S.overlay === 'proj'}" data-tip="Перемкнути проєкт">
        <span class="mark">${p.key === 'alpi' ? 'A' : 'Ф'}</span>
        <span class="pname">${esc(p.short)}</span><span class="prole">· ${esc(p.role)}</span>
        <span class="grow"></span>${ic('chevrons-up-down', 'ic-14 ink3')}
      </button>
      <button class="search only-d" data-act="palette" data-q="">${ic('search', 'ic-14')}<span class="grow">${esc(t('search'))}</span>${kbd('Ctrl', 'K')}</button>
      <span class="sp"></span>
      <button class="btn ghost icon only-m" data-act="palette" aria-label="Пошук">${ic('search')}</button>
      <div class="seg only-d" role="group" aria-label="${t('lang')}">
        <button aria-pressed="${S.lang === 'uk'}" data-act="lang" data-v="uk">UK</button><button aria-pressed="${S.lang === 'ru'}" data-act="lang" data-v="ru">RU</button>
      </div>
      <button class="btn ghost icon only-d" data-act="theme" data-tip="${t('theme')}" data-key="Shift T" aria-label="${t('theme')}">${ic(S.theme === 'dark' ? 'sun' : 'moon')}</button>
      <button class="btn ghost icon bell" data-act="ov" data-ov="notif" aria-label="${t('notifs')}" data-tip="${t('notifs')}">${ic('bell')}<span class="dot">${unread}</span></button>
      <span class="me only-d">${avatar('ok', true)}</span>
    </header>`;
  }

  function nav() {
    const cur = S.screen;
    const a = (scr, icon, label, key, cnt) => `<a href="#" data-act="go" data-scr="${scr}" ${cur === scr ? 'aria-current="page"' : ''}>${ic(icon)}<span>${esc(label)}</span>${cnt ? `<span class="cnt">${cnt}</span>` : key ? kbd(...key) : ''}</a>`;
    const dead = (icon, label) => `<a href="#" data-act="stub">${ic(icon)}<span>${esc(label)}</span></a>`;
    return `<nav class="nav" aria-label="Основна навігація">
      ${a('dash', 'layout-dashboard', t('dash'), null, '')}
      ${dead('inbox', t('queue'))}
      <h6>${t('deals')}</h6>
      ${a('kanban', 'square-kanban', t('kanban'), ['G', 'K'])}
      ${a('list', 'list', t('list'), ['G', 'L'])}
      ${dead('users', t('contacts'))}
      ${dead('building-2', t('orgs'))}
      ${dead('calendar', t('tasks'))}
      <h6>${t('settings')}</h6>
      ${a('roles', 'shield', t('roles'), ['G', 'R'])}
      ${dead('workflow', t('pipes'))}
      ${dead('plug', t('integr'))}
      <div class="foot">${kbd('?')} ${t('keys')}</div>
    </nav>`;
  }

  /* ---------------- Канбан ---------------- */
  function viewKanban() {
    const p = P();
    const deals = boardDeals();
    const toolbar = `<div class="bar">
      <h1>${t('deals')}</h1>
      <button class="btn xs" data-act="ov" data-ov="pipe">${ic('workflow', 'ic-14')}${esc(p.pipeline)}${ic('chevron-down', 'ic-12 ink3')}</button>
      <div class="seg hide-m" role="group" aria-label="Вигляд"><button aria-pressed="true">${ic('square-kanban', 'ic-14')}</button><button aria-pressed="false" data-act="go" data-scr="list">${ic('list', 'ic-14')}</button></div>
      <span class="chip"><span>Відповідальний</span><b>усі в охопленні</b><button aria-label="Змінити">${ic('chevron-down', 'ic-12')}</button></span>
      <button class="chip add" data-act="queueOnly" aria-pressed="${S.queueOnly}" style="${S.queueOnly ? 'border-style:solid;color:var(--ink)' : ''}">${ic('inbox', 'ic-12')}Без відповідального${S.queueOnly ? ' ×' : ''}</button>
      <span class="grow"></span>
      <span class="ink3 hide-m mono" style="font-size:12px" title="Курс НБУ на ${dmy(TODAY)} (вигаданий)">1 € = ${RATES.EUR.toFixed(2)} ₴ · 1 $ = ${RATES.USD.toFixed(2)} ₴</span>
      <button class="btn primary" data-act="newDeal" data-tip="${t('newDeal')}" data-key="C">${ic('plus', 'ic-14')}<span class="hide-m">${t('newDeal')}</span>${kbd('C')}</button>
    </div>`;

    if (S.state === 'loading') return toolbar + skelBoard();
    if (S.state === 'empty') return toolbar + blank('square-kanban', `У воронці ${p.pipeline} ще немає угод`, 'Угоди зʼявляться з реєстрацій сайту й вебінарів або після імпорту з Pipedrive. Можна створити першу вручну.', `<button class="btn primary" data-act="newDeal">${ic('plus', 'ic-14')}${t('newDeal')} ${kbd('C')}</button><button class="btn">${ic('download', 'ic-14')}Імпорт з Pipedrive</button>`);
    if (S.state === 'error') return toolbar + errorBlank(`Не вдалося завантажити воронку ${p.pipeline}`, '503 · /api/deals/aggregate · 14:02:11 · запит 7f3a9c', `<button class="btn primary" data-act="retry">${ic('refresh-cw', 'ic-14')}Спробувати знову ${kbd('R')}</button><button class="btn" data-act="go" data-scr="list">Відкрити списком</button>`);
    if (S.state === 'forbidden') return toolbar + forbidden('Немає доступу до воронки', `Роль «Менеджер» у проєкті ${p.name} бачить лише воронку «ALPI». Воронка «Платформа (допродаж)» відкривається з правом «Угоди: перегляд» у цій воронці.`);

    const stabs = `<div class="stabs" role="tablist" aria-label="Етапи">${p.stages.map((s, i) => `<button role="tab" aria-selected="${S.mStage === i}" data-act="mstage" data-i="${i}">${esc(s.n)} <span class="n">${fmtN(s.total)}</span></button>`).join('')}</div>`;

    const cols = p.stages.map((s, si) => {
      const cards = deals.filter((d) => d.stage === si);
      const sums = ['EUR', 'UAH', 'USD'].filter((c) => s.sums[c]).map((c) => `<span>${money(s.sums[c], c)}</span>`).join('');
      const totalUah = ['EUR', 'UAH', 'USD'].reduce((a, c) => a + uah(s.sums[c], c), 0);
      const hidden = s.total - cards.length;
      return `<section class="col${S.mStage === si ? ' mcur' : ''}" data-stage="${si}" aria-label="${esc(s.n)}">
        <div class="col-h">
          <div class="t"><span class="name trunc">${esc(s.n)}</span><span class="n">${fmtN(s.total)}</span>
            <button class="btn ghost xs icon" data-act="newDeal" aria-label="Нова угода на етапі" data-tip="Нова угода на етапі">${ic('plus', 'ic-14')}</button></div>
          <div class="sums" title="${totalUah ? 'Разом ≈ ' + money(totalUah, 'UAH') + ' за курсом НБУ' : ''}">${sums || '<span class="z" style="font-family:var(--font)">сум ще немає</span>'}</div>
        </div>
        <div class="col-b">
          ${cards.map(cardHtml).join('')}
          ${!cards.length ? '<div class="emptycol">Порожньо — перетягніть сюди</div>' : ''}
          ${hidden > 0 && si === 0 ? `<a class="more" href="#" data-act="go" data-scr="list">ще ${fmtN(hidden)} — відкрити списком ${ic('arrow-right', 'ic-12')}</a>` : hidden > 0 ? `<a class="more" href="#" data-act="stub">ще ${fmtN(hidden)}</a>` : ''}
        </div>
      </section>`;
    }).join('');
    const dz = S.state === 'drag' ? dropzones() : '';
    return toolbar + stabs + `<div class="board" id="board">${cols}</div>` + dz;
  }

  function cardHtml(d) {
    const kb = S.kbCard === d.id ? ' kb' : '';
    if (!d.owner) {
      return `<article class="card queue${kb}" data-id="${d.id}" tabindex="0" aria-label="${esc(d.title)}, загальна черга">
        <div class="r1">${stIcon(d)}<span class="title trunc">${esc(d.title)}</span></div>
        <div class="r2"><span class="avatar none"></span><span class="trunc grow">черга · ${dm(d.created)}</span>
          <button class="btn xs" data-act="take" data-id="${d.id}" data-tip="${t('take')}" data-key="Shift Enter">${ic('hand', 'ic-12')}${t('take')}</button></div>
      </article>`;
    }
    const sub = d.org ? d.contact.name : d.contact.phone;
    return `<article class="card${kb}" data-id="${d.id}" tabindex="0" aria-label="${esc(d.title)}">
      <div class="r1">${stIcon(d)}<span class="title trunc">${esc(d.title)}</span>${d.rot ? `<span class="rot" title="Угода стоїть на етапі понад 14 днів">${ic('hourglass', 'ic-12')}</span>` : ''}${taskInd(d)}</div>
      <div class="r2"><span class="trunc grow ${d.org ? '' : 'mono'}">${esc(sub)}</span><span class="amt${d.amount ? '' : ' zero'}">${d.amount ? money(d.amount, d.cur) : '—'}</span>${avatar(d.owner)}</div>
    </article>`;
  }

  function dropzones() {
    return `<div class="dropzones" id="dz">
      <div class="dz won" data-drop="won">${stIcon({ status: 'won' })}${t('dropWon')}</div>
      <div class="dz lost" data-drop="lost">${stIcon({ status: 'lost' })}${t('dropLost')} <small>· ${t('reason')}</small></div>
      <div class="dz arch" data-drop="arch">${stIcon({ archived: true })}${t('dropArch')}</div>
    </div>`;
  }

  function skelBoard() {
    const c = (n) => Array.from({ length: n }, () => '<div class="sk-card"><div class="sk" style="width:80%"></div><div class="sk"></div></div>').join('');
    return `<div class="stabs"><button aria-selected="true"><span class="sk" style="width:90px;height:10px;display:block"></span></button><button><span class="sk" style="width:70px;height:10px;display:block"></span></button></div>
    <div class="board" aria-busy="true">${[5, 3, 4, 2, 4, 3].map((n, i) => `<section class="col${i === 0 ? ' mcur' : ''}"><div class="col-h"><div class="t"><span class="sk" style="width:120px;height:10px"></span></div><div class="sums"><span class="sk" style="width:90px;height:8px;margin-top:4px"></span></div></div><div class="col-b">${c(n)}</div></section>`).join('')}</div>`;
  }

  function blank(icon, h, p, btns, cls = '') {
    return `<div class="blank"><div class="blank-b"><div class="ico ${cls}">${ic(icon)}</div><h2>${esc(h)}</h2><p>${esc(p)}</p>${btns ? `<div class="row">${btns}</div>` : ''}</div></div>`;
  }
  function errorBlank(h, code, btns) {
    return `<div class="blank" role="alert"><div class="blank-b"><div class="ico lost">${ic('circle-alert')}</div><h2>${esc(h)}</h2><p>Сервер не відповів вчасно. Дані не змінено — можна повторити запит.</p><div class="code">${esc(code)}</div><div class="row">${btns}</div></div></div>`;
  }
  function forbidden(h, p) {
    return `<div class="blank"><div class="blank-b"><div class="ico">${ic('lock')}</div><h2>${esc(h)}</h2><p>${esc(p)}</p><div class="code">403 · недостатньо прав у проєкті ${esc(P().name)}</div><div class="row"><button class="btn" data-act="go" data-scr="kanban">${ic('arrow-left', 'ic-14')}До канбану</button><button class="btn ghost">Попросити доступ в адміністратора</button></div></div></div>`;
  }

  /* ---------------- Картка угоди ---------------- */
  function enrich(d) {
    if (d.feed) return d;
    const p = P();
    d.payments = d.payments || [];
    d.participants = d.participants || [];
    d.regs = d.regs || [{ at: d.created + ' 19:10', title: p.key === 'franch' ? 'Заявка на консультацію' : 'AI-контент з нуля · вебінар', src: 'Instagram Stories', utm: { utm_source: 'instagram', utm_medium: 'stories', utm_campaign: p.key === 'franch' ? 'franch_consult_q4' : 'ai_video_nov' }, page: p.key === 'franch' ? 'franch.example/konsultaciya' : 'alpi.example/webinar/ai-video', watch: '—' }];
    d.feed = [
      ...(d.stage > 0 ? [{ t: 'stage', at: CRM.addDays(d.created, 1) + ' 11:20', who: userById(d.owner)?.n || 'Система', from: p.stages[Math.max(0, d.stage - 1)].n, to: p.stages[d.stage].n }] : []),
      { t: 'reg', at: d.created + ' 19:10', who: 'Форма сайту', text: `Реєстрація 1 з 1 · ${d.regs[0].src}` }
    ];
    return d;
  }

  function viewDeal() {
    const p = P();
    let d = dealById(S.dealId) || dealById(p.demoId);
    S.dealId = d.id;
    d = enrich(d);
    const crumb = `<div class="bar">
      <div class="crumb"><a href="#" data-act="go" data-scr="kanban">${t('deals')}</a>${ic('chevron-right', 'ic-12')}<a href="#" data-act="go" data-scr="kanban">${esc(p.pipeline)}</a>${ic('chevron-right', 'ic-12')}<span class="mono">#${d.num}</span></div>
      <span class="grow"></span>
      <button class="btn ghost xs icon" data-act="dealNav" data-dir="-1" data-tip="Попередня угода" data-key="K" aria-label="Попередня">${ic('chevron-up', 'ic-14')}</button>
      <button class="btn ghost xs icon" data-act="dealNav" data-dir="1" data-tip="Наступна угода" data-key="J" aria-label="Наступна">${ic('chevron-down', 'ic-14')}</button>
      <button class="btn ghost xs icon" data-act="go" data-scr="kanban" data-tip="Закрити" data-key="Esc" aria-label="Закрити">${ic('x', 'ic-14')}</button>
    </div>`;
    if (S.state === 'loading') return crumb + skelDeal();
    if (S.state === 'empty') return crumb + blank('file-x', 'Угоду не знайдено', `Угоду #${d.num} видалено. Вона лежить у кошику ще 30 днів — звідти її може відновити адміністратор або керівник.`, `<button class="btn">${ic('trash-2', 'ic-14')}Відкрити кошик</button><button class="btn ghost" data-act="go" data-scr="kanban">До канбану</button>`);
    if (S.state === 'error') return crumb + errorBlank('Не вдалося завантажити угоду', `500 · /api/deals/${d.num} · 14:02:11`, `<button class="btn primary" data-act="retry">${ic('refresh-cw', 'ic-14')}Спробувати знову ${kbd('R')}</button>`);
    if (S.state === 'forbidden') return crumb + forbidden('Угода поза вашим охопленням', `Клієнт уже в роботі в менеджера Андрій Шевчук. Ваша роль бачить лише свої угоди, тому вміст угоди прихований.`);

    const n = p.stages.length;
    const paid = d.payments.filter((x) => x.status === 'ok').reduce((a, x) => a + x.amount, 0);
    const owner = userById(d.owner);
    const statusTxt = d.archived ? 'В архіві' : d.status === 'won' ? 'Виграна' : d.status === 'lost' ? 'Програна' : 'Відкрита';
    const ps = total(d);
    const showDiff = ps && ps !== d.amount;

    const actions = d.status === 'open' ? `
      <button class="btn primary" data-act="won" data-tip="Позначити виграною" data-key="W">${ic('circle-check', 'ic-14')}${t('won')}${kbd('W')}</button>
      <button class="btn" data-act="lost" data-tip="Позначити програною" data-key="L">${t('lost')}${kbd('L')}</button>
      <button class="btn ghost" data-act="archive" data-tip="Сховати з канбану і списків" data-key="E">${ic('archive', 'ic-14')}${t('archive')}</button>
      <button class="btn ghost icon" data-act="ov" data-ov="more" aria-label="Ще дії" data-tip="Ще дії">${ic('ellipsis')}</button>` : `
      <button class="btn" data-act="reopen">${ic('rotate-ccw', 'ic-14')}${t('reopen')}</button>
      ${d.status === 'won' ? `<button class="btn">${ic('plus', 'ic-14')}Створити допродаж</button>` : ''}`;

    const head = `<div class="deal-h">
      <div>
        <h2>${stIcon(d)}<span>${esc(d.title)}</span><span class="no">#${d.num}</span></h2>
        <div class="path">
          <button class="bars" data-act="ov" data-ov="stage" aria-label="Змінити етап" data-tip="Змінити етап" data-key="S">${p.stages.map((s, i) => `<i class="${i < d.stage ? 'done' : i === d.stage ? 'cur' : ''}"></i>`).join('')}</button>
          <button class="stagebtn" data-act="ov" data-ov="stage">${esc(p.stages[d.stage].n)} ${ic('chevron-down', 'ic-12')}</button>
          <span class="mono ink3" style="font-size:12px">${d.stage + 1}/${n}</span>
          <span class="ink3 dotsep">·</span><span class="${d.status === 'won' ? 'won' : d.status === 'lost' ? 'lost' : 'ink2'}">${statusTxt}${d.lostReason ? ' · ' + esc(d.lostReason) : ''}</span>
          ${d.archived ? '<span class="tag">архів</span>' : ''}
        </div>
        <dl class="dmeta">
          <div><dt>Сума</dt><dd class="mono">${d.amount ? money(d.amount, d.cur) : '—'}${d.cur !== 'UAH' && d.amount ? `<span class="ink3" style="font-size:12px">≈ ${money(uah(d.amount, d.cur), 'UAH')}</span>` : ''}</dd></div>
          <div><dt>Сплачено</dt><dd class="mono">${money(paid, d.cur)}<span class="ink3" style="font-size:12px">з ${money(d.amount || 0, d.cur)}</span></dd></div>
          <div><dt>Відповідальний</dt><dd><button class="btn ghost xs" data-act="ov" data-ov="owner" style="margin-left:-8px" data-tip="Передати" data-key="P">${avatar(d.owner)}${esc(owner ? owner.n : 'Немає')}</button></dd></div>
          <div><dt>Створено</dt><dd class="mono">${dmy(d.created)}</dd></div>
        </dl>
      </div>
      <div class="acts">${actions}</div>
    </div>`;

    const tk = d.task;
    const next = `<section class="sec"><div class="sec-h"><h3>Що зробити далі</h3><button class="btn xs" data-act="newTask" data-tip="Нова задача" data-key="T">${ic('plus', 'ic-12')}${t('task')}${kbd('T')}</button></div>
      ${tk ? `<div class="next"><input type="checkbox" class="check" data-act="doneTask" aria-label="Виконано">
        <div class="grow"><div><b>${esc(tk.type)}</b>${tk.subj ? ' — ' + esc(tk.subj) : ''}</div><div>${taskInd(d)} · ${esc(owner ? owner.n : '—')}</div></div></div>`
      : `<div class="next"><span class="task none">${ic('calendar-off', 'ic-14')}</span><div class="grow"><div><b>Немає запланованих задач</b></div><div>Угода нікуди не рухається — заплануйте наступний крок.</div></div></div>`}
    </section>`;

    const products = `<section class="sec"><div class="sec-h"><h3>Товари</h3><span class="n">${d.products.length}</span><button class="btn xs ghost">${ic('plus', 'ic-12')}Товар</button></div>
      ${d.products.length ? `<table class="t products"><thead><tr><th>Товар</th><th class="r">К-сть</th><th class="r">Ціна</th><th class="r">Сума</th></tr></thead><tbody>
        ${d.products.map((x) => `<tr><td>${esc(x.n)}</td><td class="r mono">${x.qty}</td><td class="r mono">${money(x.price, d.cur)}</td><td class="r mono">${money(x.qty * x.price, d.cur)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Сума по товарах</td><td></td><td></td><td class="r mono" style="color:var(--ink)">${money(ps, d.cur)}</td></tr></tfoot></table>
      ${showDiff ? `<div class="diff">${ic('info', 'ic-14')}<span class="grow">Сума угоди <b class="mono">${money(d.amount, d.cur)}</b> не збігається із сумою по товарах <b class="mono">${money(ps, d.cur)}</b></span><button class="btn xs" data-act="applySum">Підставити</button></div>` : ''}`
      : '<div class="ink3">Товарів немає. Сума угоди вводиться вручну.</div>'}
    </section>`;

    const pays = `<section class="sec"><div class="sec-h"><h3>Платежі</h3><span class="n">WayForPay</span><button class="btn xs">${ic('receipt', 'ic-12')}Виставити рахунок</button></div>
      ${d.payments.length ? `<table class="t pays"><thead><tr><th>Тип</th><th class="r">Сума</th><th class="r">Списано</th><th class="r">Курс WFP</th><th>Статус</th><th class="r">Дата</th></tr></thead><tbody>
      ${d.payments.map((x) => `<tr><td>${esc(x.kind)}</td><td class="r mono">${money(x.amount, d.cur)}</td><td class="r mono">${x.uah ? money(x.uah, 'UAH') : '—'}</td><td class="r mono">${x.rate ? x.rate.toFixed(2) : '—'}</td><td>${x.status === 'ok' ? '<span class="pay-ok">успішно</span>' : '<span class="pay-wait">очікує оплати</span>'}</td><td class="r mono">${dm(x.date)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="ink3">Платежів ще немає.</div>'}
    </section>`;

    const FF = [['all', 'Усе'], ['note', 'Нотатки'], ['call', 'Дзвінки'], ['pay', 'Платежі'], ['stage', 'Етапи'], ['task', 'Задачі'], ['reg', 'Реєстрації']];
    const feedItems = d.feed.filter((e) => S.feedFilter === 'all' || e.t === S.feedFilter);
    const feed = `<section class="sec"><div class="sec-h"><h3>Стрічка</h3><span class="n">${d.feed.length}</span></div>
      <div class="feed-f seg" role="tablist">${FF.map(([k, l]) => `<button role="tab" aria-pressed="${S.feedFilter === k}" data-act="feedF" data-v="${k}">${l}${k !== 'all' ? ` <span class="mono ink3">${d.feed.filter((e) => e.t === k).length}</span>` : ''}</button>`).join('')}</div>
      <div class="composer"><textarea id="note" placeholder="Нотатка… (N — сюди, Ctrl Enter — зберегти)" aria-label="Нотатка"></textarea>
        <div class="row">${ic('paperclip', 'ic-14')}<span>Файл</span><span class="grow"></span><button class="btn xs primary" data-act="saveNote">Зберегти ${kbd('Ctrl', 'Enter')}</button></div></div>
      <ol class="feed">${feedItems.map(feedItem).join('') || '<li class="ink3" style="padding-left:34px">Подій цього типу немає</li>'}</ol>
    </section>`;

    const c = d.contact;
    const contact = `<section class="sec"><div class="sec-h"><h3>Контакт</h3><button class="btn xs ghost">${ic('external-link', 'ic-12')}Картка</button></div>
      <div class="contact-n">${ic('user', 'ic-14 ink3')}${esc(c.name)}</div>
      <dl class="kv"><dt>Телефон</dt><dd class="mono"><a class="accent" href="#" style="text-decoration:none">${esc(c.phone)}</a></dd><dt>Email</dt><dd>${esc(c.email)}</dd>${c.city ? `<dt>Місто</dt><dd>${esc(c.city)}</dd>` : ''}${d.org ? `<dt>Організація</dt><dd>${esc(d.org)}</dd>` : ''}</dl>
      ${d.demo ? `<div class="flag">${ic('triangle-alert', 'ic-14')}<span>Є відкрита угода в Pipedrive · #PD-30418. Перевірте, щоб не вести клієнта двічі.</span></div>` : ''}
    </section>
    <section class="sec"><div class="sec-h"><h3>Учасники</h3><span class="n">${d.participants.length}</span><button class="btn xs ghost">${ic('plus', 'ic-12')}Учасник</button></div>
      ${d.participants.length ? `<dl class="kv">${d.participants.map((x) => `<dt>${esc(x.role)}</dt><dd>${esc(x.n)} · <span class="mono ink3">${esc(x.phone)}</span></dd>`).join('')}</dl>` : '<div class="ink3">Лише основний контакт.</div>'}
    </section>`;

    const regs = `<section class="sec"><div class="sec-h"><h3>Реєстрації</h3><span class="n">${d.regs.length}</span></div>
      <div class="regs">${d.regs.map((r, i) => `<details class="reg"${i === 0 ? ' open' : ''}><summary>${ic('chevron-right', 'ic-14 chev')}<span class="grow trunc">${esc(r.title)}</span>${i === 0 ? '<span class="tag">перша</span>' : i === d.regs.length - 1 ? '<span class="tag">остання</span>' : ''}<span class="mono ink3" style="font-size:12px">${at(r.at)}</span></summary>
        <dl class="kv"><dt>Джерело</dt><dd>${esc(r.src)}</dd>${Object.entries(r.utm).map(([k, v]) => `<dt class="mono">${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join('')}<dt>Сторінка</dt><dd class="mono">${esc(r.page)}</dd><dt>Перегляд</dt><dd class="mono">${esc(r.watch)}</dd></dl></details>`).join('')}</div>
    </section>`;

    const fields = `<section class="sec"><div class="sec-h"><h3>Поля</h3></div>
      <div class="fg"><h4>Кваліфікація</h4><dl class="kv"><dt>Тип клієнта</dt><dd>Підприємець</dd><dt>Професія</dt><dd>SMM-спеціаліст</dd><dt>Мотив</dt><dd>Додатковий дохід</dd></dl></div>
      <div class="fg"><h4>Закриття ${ic('lock', 'ic-12')} <span style="font-weight:400">тільки читання</span></h4><dl class="kv"><dt>Пакет</dt><dd>PRO</dd><dt>Тип закриття</dt><dd>Бронь + доплата</dd></dl></div>
    </section>`;

    const mbar = d.status === 'open' ? `<div class="mbar"><button class="btn primary" data-act="won">${t('won')}</button><button class="btn" data-act="lost">${t('lost')}</button><button class="btn icon" data-act="ov" data-ov="more" aria-label="Ще дії">${ic('ellipsis')}</button></div>` : '';
    return crumb + `<div class="deal${S.dealEnter ? ' enter' : ''}" id="deal">${head}<div class="deal-b"><div class="deal-main">${next}${products}${pays}${feed}</div><aside class="deal-side">${contact}${regs}${fields}</aside></div></div>` + mbar;
  }

  function feedItem(e) {
    const hd = (icon, cls, title, extra = '') => `<li class="fe"><span class="dot ${cls}">${ic(icon)}</span><div><div class="hd">${title}<span class="at">${at(e.at)}</span></div>${extra}</div></li>`;
    switch (e.t) {
      case 'note': return hd('sticky-note', '', `<span>Нотатка</span><span class="ink3">· ${esc(e.who)}</span>`, `<div class="bd note">${esc(e.text)}</div>`);
      case 'call': return e.dir === 'missed'
        ? hd('phone-missed', 'missed', `<span>Пропущений вхідний</span><span class="ink3">· ${esc(e.line)}</span>`, `<div class="sub">${esc(e.auto)}</div>`)
        : hd('phone-outgoing', '', `<span>Вихідний дзвінок</span><span class="mono ink2">${esc(e.dur)}</span><span class="ink3">· ${esc(e.who)}</span>`,
          `<div class="player"><button class="btn xs" data-act="play">${ic(S.playing ? 'pause' : 'play', 'ic-12')}${S.playing ? 'Пауза' : 'Запис'}</button><span class="trk"><i style="width:${S.playing ? 18 : 0}%"></i></span><span class="mono">${S.playing ? '1:12' : '0:00'} / ${esc(e.dur)}</span></div>`);
      case 'pay': return hd('credit-card', 'ok', `<span>Оплата · ${esc(e.kind)}</span><span class="mono">${esc(e.amount)}</span><span class="ink3">· ${esc(e.who)}</span>`, `<div class="sub">Списано <span class="mono">${esc(e.uah)}</span> · <span class="won">успішно</span></div>`);
      case 'stage': return hd('arrow-right-left', '', `<span>Етап</span><span class="ink3">· ${esc(e.who)}</span>`, `<div class="bd"><span class="ink2">${esc(e.from)}</span> → ${esc(e.to)}</div>`);
      case 'task': return hd('square-check', '', `<span>${esc(e.text)}</span><span class="ink3">· ${esc(e.who)}</span>`);
      case 'reg': return hd('log-in', '', `<span>${esc(e.text)}</span><span class="ink3">· ${esc(e.who)}</span>`);
      default: return '';
    }
  }

  function skelDeal() {
    const l = (w, h = 10) => `<div class="sk" style="width:${w};height:${h}px;margin:8px 0"></div>`;
    return `<div class="deal" aria-busy="true"><div class="deal-h"><div>${l('320px', 18)}${l('200px', 4)}${l('420px')}</div><div class="acts">${l('240px', 28)}</div></div>
    <div class="deal-b"><div class="deal-main"><div class="sec">${l('140px')}${l('100%', 40)}</div><div class="sec">${l('100px')}${l('100%')}${l('100%')}${l('60%')}</div><div class="sec">${l('80px')}${l('100%', 48)}${l('90%')}${l('70%')}</div></div><aside class="deal-side"><div class="sec">${l('80px')}${l('60%')}${l('80%')}</div><div class="sec">${l('80px')}${l('100%')}</div></aside></div></div>`;
  }

  /* ---------------- Список ---------------- */
  function listRows() {
    const p = P();
    let r = p.deals.filter((d) => !d.archived);
    if (S.listTab === 'open') r = r.filter((d) => d.status === 'open');
    if (S.listTab === 'mine') r = r.filter((d) => d.owner === 'ok');
    if (S.listTab === 'queue') r = r.filter((d) => !d.owner);
    if (S.listTab === 'overdue') r = r.filter((d) => d.task && d.task.kind === 'overdue');
    return r.slice().sort((a, b) => b.num - a.num);
  }
  function viewList() {
    const p = P();
    const rows = S.state === 'empty' ? [] : listRows();
    const all = p.deals;
    const cnt = { open: '≈ 86 412', mine: fmtN(all.filter((d) => d.owner === 'ok').length), queue: fmtN(all.filter((d) => !d.owner).length), overdue: fmtN(all.filter((d) => d.task && d.task.kind === 'overdue').length) };
    const tabs = [['open', t('all')], ['mine', t('mine')], ['queue', t('queue')], ['overdue', t('overdue')]];
    const toolbar = `<div class="bar">
      <h1 class="hide-m">${t('deals')}</h1>
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${S.listTab === k}" data-act="tab" data-v="${k}">${esc(l)} <span class="n">${cnt[k]}</span></button>`).join('')}</div>
      <span class="grow hide-m"></span>
      <button class="btn xs hide-m">${ic('columns-3', 'ic-14')}Колонки</button>
      <button class="btn xs hide-m" data-tip="Вивантаження у файл" data-key="Shift E">${ic('download', 'ic-14')}CSV</button>
      <button class="btn primary" data-act="newDeal" data-tip="${t('newDeal')}" data-key="C">${ic('plus', 'ic-14')}<span class="hide-m">${t('newDeal')}</span></button>
    </div>
    <div class="bar" style="min-height:40px;padding-top:6px;padding-bottom:6px">
      <span class="chip"><span>Воронка</span><b>${esc(p.pipeline)}</b><button aria-label="Змінити">${ic('chevron-down', 'ic-12')}</button></span>
      <span class="chip"><span>Архів</span><b>без архівних</b><button aria-label="Прибрати">${ic('x', 'ic-12')}</button></span>
      ${S.state === 'empty' ? `<span class="chip"><span>Етап</span><b>Новий лід</b><button>${ic('x', 'ic-12')}</button></span><span class="chip"><span>Створено</span><b>до 01.09.2026</b><button>${ic('x', 'ic-12')}</button></span><span class="chip"><span>Джерело</span><b>TikTok Ads</b><button>${ic('x', 'ic-12')}</button></span>` : ''}
      <button class="chip add" data-tip="Додати умову" data-key="F">${ic('list-filter', 'ic-12')}Фільтр</button>
      <span class="grow"></span>
      <span class="ink3 mono hide-m" style="font-size:12px">${S.listTab === 'open' ? '≈ 86 412 угод · показано ' + rows.length : rows.length + ' угод'}</span>
      <button class="btn xs ghost hide-m">${ic('bookmark', 'ic-14')}Зберегти фільтр</button>
    </div>`;
    if (S.state === 'loading') return toolbar + skelList();
    if (S.state === 'error') return toolbar + errorBlank('Список не завантажився', '504 · /api/deals?cursor=… · 14:02:11', `<button class="btn primary" data-act="retry">${ic('refresh-cw', 'ic-14')}Спробувати знову ${kbd('R')}</button>`);
    if (S.state === 'forbidden') return toolbar + forbidden('Немає права на вивантаження', 'Вивантаження у CSV за замовчуванням є лише в адміністратора проєкту. Вашій ролі «Керівник» доступні перегляд, масові операції та передача угод.');
    if (!rows.length) return toolbar + blank('search-x', 'За цим фільтром угод немає', 'Умови: етап «Новий лід», створено до 01.09.2026, джерело TikTok Ads. Спробуйте прибрати одну з умов.', `<button class="btn" data-act="retry">Скинути фільтри</button>`);

    const allSel = rows.every((d) => S.sel.has(d.id));
    const someSel = rows.some((d) => S.sel.has(d.id));
    const tr = rows.map((d, i) => {
      const s = p.stages[d.stage];
      const u = userById(d.owner);
      return `<tr data-id="${d.id}" data-i="${i}" class="${S.sel.has(d.id) ? 'sel' : ''}${S.kbRow === i ? ' kb' : ''}">
        <td><input type="checkbox" class="check" data-act="selRow" data-id="${d.id}" ${S.sel.has(d.id) ? 'checked' : ''} aria-label="Вибрати ${esc(d.title)}"></td>
        <td class="mono meta c-num">${d.num}</td>
        <td class="c-title"><span class="tl">${stIcon(d)}<a href="#" data-act="open" data-id="${d.id}">${esc(d.title)}</a>${d.rot ? `<span class="rot">${ic('hourglass', 'ic-12')}</span>` : ''}</span></td>
        <td class="meta c-contact">${d.org ? esc(d.contact.name) : `<span class="mono">${esc(d.contact.phone)}</span>`}</td>
        <td class="c-stage">${esc(s.n)} <span class="mono meta" style="font-size:12px">${d.stage + 1}/${p.stages.length}</span></td>
        <td class="r mono c-amt">${d.amount ? money(d.amount, d.cur) : '<span class="ink3">—</span>'}</td>
        <td class="c-owner">${u ? `<span class="own">${avatar(d.owner)}${esc(u.n)}</span>` : `<span class="own ink3">${avatar(null)}${t('queue')}</span>`}</td>
        <td class="c-task">${taskInd(d) || '<span class="ink3">—</span>'}</td>
        <td class="mono meta c-created">${dmy(d.created)}</td>
      </tr>`;
    }).join('');
    const bulk = S.sel.size ? `<div class="bulk" role="toolbar" aria-label="Масові дії">
      <span class="cnt">${S.sel.size} <span class="lbl-d">вибрано</span></span>
      <button class="btn xs ghost" data-act="ov" data-ov="owner">${ic('user-round-plus', 'ic-14')}${t('transfer')} ${kbd('P')}</button>
      <button class="btn xs ghost" data-act="ov" data-ov="stage">${ic('arrow-right-left', 'ic-14')}Етап ${kbd('S')}</button>
      <button class="btn xs ghost" data-act="bulkArchive">${ic('archive', 'ic-14')}${t('archive')} ${kbd('E')}</button>
      <button class="btn xs ghost danger" data-act="bulkDelete">${ic('trash-2', 'ic-14')}<span class="lbl-d">Видалити</span></button>
      <span class="sep"></span>
      <button class="btn xs ghost" data-act="selNone" aria-label="Зняти вибір">${kbd('Esc')}</button>
    </div>` : '';
    return toolbar + `<div class="list-wrap" id="listwrap"><table class="grid"><thead><tr>
      <th><input type="checkbox" class="check" data-act="selAll" ${allSel ? 'checked' : ''} aria-label="Вибрати всі на сторінці"></th>
      <th>№</th><th class="sorted">Назва ${ic('arrow-down', 'ic-12')}</th><th>Контакт</th><th>Етап</th><th class="r">Сума</th><th>Відповідальний</th><th>Наступна задача</th><th>Створено</th>
    </tr></thead><tbody>${tr}</tbody></table>
    <div class="list-foot"><button class="btn xs">Завантажити ще 50</button><span>курсорна підвантажка · ${kbd('J')} ${kbd('K')} рядки · ${kbd('X')} вибрати · ${kbd('Enter')} відкрити</span></div></div>${bulk}`
      .replace('data-act="selAll" ', `data-act="selAll" ${!allSel && someSel ? 'data-ind="1" ' : ''}`);
  }
  function skelList() {
    return `<div class="list-wrap" aria-busy="true"><table class="grid"><thead><tr><th></th><th>№</th><th>Назва</th><th>Контакт</th><th>Етап</th><th class="r">Сума</th><th>Відповідальний</th><th>Наступна задача</th><th>Створено</th></tr></thead><tbody>
    ${Array.from({ length: 16 }, (_, i) => `<tr><td><span class="sk" style="display:block;width:14px;height:14px"></span></td>${[40, 160 + (i * 37) % 80, 110, 120, 60, 100, 50, 70].map((w, j) => `<td class="${['c-num', 'c-title', 'c-contact', 'c-stage', 'c-amt', 'c-owner', 'c-task', 'c-created'][j]}"><span class="sk" style="display:block;width:${w}px;height:8px"></span></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  }

  /* ---------------- Налаштування → ролі ---------------- */
  const RES = [
    ['g', 'Робота з клієнтами'],
    ['deals', 'Угоди', true], ['contacts', 'Контакти', true], ['orgs', 'Організації'], ['tasks', 'Задачі', true], ['pays', 'Платежі', true],
    ['g', 'Довідники та звіти'],
    ['products', 'Товари'], ['reasons', 'Причини програшу'], ['ttypes', 'Типи задач'], ['reports', 'Звіти'],
    ['g', 'Налаштування проєкту'],
    ['pipes', 'Воронки та етапи'], ['fields', 'Поля'], ['users', 'Користувачі та ролі'], ['integr', 'Інтеграції'], ['trash', 'Кошик']
  ];
  const ROLES = ['Адміністратор', 'Керівник', 'Тімлід', 'Менеджер'];
  const ROLE_USERS = { 'Адміністратор': 2, 'Керівник': 1, 'Тімлід': 3, 'Менеджер': 14 };
  function roleDefaults(role) {
    const m = {};
    const set = (k, v, c, e, d, rs, es) => { m[k] = { v, c, e, d, rs, es }; };
    const client = ['deals', 'contacts', 'tasks', 'pays'];
    if (role === 'Адміністратор') {
      RES.forEach(([k, , sc]) => k !== 'g' && set(k, 1, 1, 1, 1, sc ? 'all' : null, sc ? 'all' : null));
      return { m, extra: { export: 1, bulk: 1, transfer: 'all', filters: 'all', settings: 1 } };
    }
    if (role === 'Керівник') {
      client.forEach((k) => set(k, 1, 1, 1, 1, 'all', 'all')); set('orgs', 1, 1, 1, 1);
      ['products', 'reasons', 'ttypes', 'reports'].forEach((k) => set(k, 1, 0, 0, 0));
      ['pipes', 'fields', 'users', 'integr'].forEach((k) => set(k, 0, 0, 0, 0)); set('trash', 1, 0, 1, 0);
      return { m, extra: { export: 0, bulk: 1, transfer: 'all', filters: 'all', settings: 0 } };
    }
    if (role === 'Тімлід') {
      client.forEach((k) => set(k, 1, 1, 1, 0, 'team', 'team')); set('orgs', 1, 1, 1, 0);
      ['products', 'reasons', 'ttypes', 'reports'].forEach((k) => set(k, 1, 0, 0, 0));
      ['pipes', 'fields', 'users', 'integr', 'trash'].forEach((k) => set(k, 0, 0, 0, 0));
      return { m, extra: { export: 0, bulk: 0, transfer: 'team', filters: 'team', settings: 0 } };
    }
    client.forEach((k) => set(k, 1, 1, 1, 0, 'own', 'own')); set('orgs', 1, 1, 1, 0);
    ['products', 'reasons', 'ttypes'].forEach((k) => set(k, 1, 0, 0, 0));
    ['reports', 'pipes', 'fields', 'users', 'integr', 'trash'].forEach((k) => set(k, 0, 0, 0, 0));
    return { m, extra: { export: 0, bulk: 0, transfer: 'none', filters: 'none', settings: 0 } };
  }
  const SCOPES = [['own', 'Свої'], ['team', 'Своєї команди'], ['all', 'Усі в проєкті']];
  function viewRoles() {
    const snav = `<nav class="snav" aria-label="Налаштування">
      ${[['workflow', t('pipes')], ['text-cursor-input', t('fields')], ['shield', t('roles'), 1], ['users', t('users')], ['users-round', t('teams')], ['package', t('products')], ['circle-x', t('reasons')], ['list-checks', t('ttypes')], ['plug', t('integr')], ['trash-2', t('trash')]]
        .map(([i, l, cur]) => `<a href="#" ${cur ? 'aria-current="page"' : 'data-act="stub"'}>${ic(i)}${esc(l)}</a>`).join('')}
    </nav>`;
    const bar = `<div class="bar"><div class="crumb"><span>${t('settings')}</span>${ic('chevron-right', 'ic-12')}<span style="color:var(--ink)">${t('roles')}</span></div><span class="grow"></span><span class="ink3 hide-m" style="font-size:12px">Проєкт ${esc(P().name)}</span></div>`;
    let body;
    if (S.state === 'loading') body = `<div class="scontent" aria-busy="true"><div class="sk" style="width:220px;height:20px;margin-bottom:24px"></div>${Array.from({ length: 12 }, () => '<div class="sk" style="height:10px;margin:14px 0"></div>').join('')}</div>`;
    else if (S.state === 'error') body = `<div class="scontent">${errorBlank('Не вдалося завантажити ролі', '500 · /api/roles · 14:02:11', `<button class="btn primary" data-act="retry">${ic('refresh-cw', 'ic-14')}Спробувати знову ${kbd('R')}</button>`)}</div>`;
    else if (S.state === 'forbidden') body = `<div class="scontent">${forbidden('Розділ лише для адміністратора проєкту', 'Ролі та права змінює адміністратор проєкту. Ваша роль «Керівник» бачить налаштування лише для читання товарів і причин програшу.')}</div>`;
    else if (S.state === 'empty') body = `<div class="scontent">${blank('shield', 'Власних ролей ще немає', 'У проєкті є чотири шаблони: Адміністратор, Керівник, Тімлід, Менеджер. Скопіюйте шаблон, щоб зробити свою роль, наприклад «Стажер».', `<button class="btn primary">${ic('copy', 'ic-14')}Копіювати шаблон</button>`)}</div>`;
    else body = rolesMatrix();
    return bar + `<div class="settings">${snav}${body}</div>`;
  }
  function rolesMatrix() {
    const role = S.roleTab;
    const base = roleDefaults(role);
    const ed = S.roleEdits[role] || {};
    const val = (k, f) => (ed[k + '.' + f] !== undefined ? ed[k + '.' + f] : (k === 'x' ? base.extra[f] : base.m[k][f]));
    const ch = (k, f) => ed[k + '.' + f] !== undefined ? ' changed' : '';
    const locked = role === 'Адміністратор';
    const rows = RES.map(([k, l, sc]) => {
      if (k === 'g') return `<tr class="grp"><td colspan="7">${esc(l)}</td></tr>`;
      const cb = (f) => `<td class="${ch(k, f)}"><input type="checkbox" class="check" data-act="rc" data-k="${k}" data-f="${f}" ${val(k, f) ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="${esc(l)}: ${f}"></td>`;
      const sel = (f) => sc ? `<td class="${ch(k, f)}"><select class="field" data-act="rs" data-k="${k}" data-f="${f}" ${locked ? 'disabled' : ''} aria-label="${esc(l)}: охоплення">${SCOPES.map(([v, n]) => `<option value="${v}" ${val(k, f) === v ? 'selected' : ''}>${n}</option>`).join('')}</select></td>` : '<td class="na">—</td>';
      return `<tr><td>${esc(l)}</td>${cb('v')}${cb('c')}${cb('e')}${cb('d')}${sel('rs')}${sel('es')}</tr>`;
    }).join('');
    const xr = (f, l, opts) => {
      const v = val('x', f);
      const ctl = opts ? `<select class="field" data-act="rs" data-k="x" data-f="${f}" ${locked ? 'disabled' : ''}>${opts.map(([o, n]) => `<option value="${o}" ${v === o ? 'selected' : ''}>${n}</option>`).join('')}</select>`
        : `<input type="checkbox" class="check" data-act="rc" data-k="x" data-f="${f}" ${v ? 'checked' : ''} ${locked ? 'disabled' : ''}>`;
      return `<tr><td>${esc(l)}</td><td colspan="4" class="${ch('x', f)}" style="text-align:left">${ctl}</td><td colspan="2"></td></tr>`;
    };
    const nEd = Object.keys(ed).length;
    return `<div class="scontent" id="scontent">
      <div class="page-h"><div><h1>${t('roles')}</h1><p>Роль — таблиця «частина системи × дія». Охоплення для угод, контактів, задач і платежів задається окремо для читання і для зміни.</p></div></div>
      <div class="roles-tabs"><div class="seg" role="tablist">${ROLES.map((r) => `<button role="tab" aria-pressed="${role === r}" data-act="roleTab" data-v="${r}">${r} <span class="mono ink3">${ROLE_USERS[r]}</span></button>`).join('')}</div>
        <button class="btn xs ghost">${ic('plus', 'ic-12')}Нова роль</button><span class="grow"></span><button class="btn xs">${ic('copy', 'ic-12')}Копіювати</button></div>
      ${locked ? `<div class="flag" style="margin:0 0 12px">${ic('lock', 'ic-14')}<span>Шаблон «Адміністратор» має всі права і не змінюється — так у проєкті завжди лишається хтось, хто може керувати доступом.</span></div>` : ''}
      <div class="mx-wrap"><table class="matrix"><thead><tr><th>Частина системи</th><th>Перегляд</th><th>Створення</th><th>Зміна</th><th>Видалення</th><th>Охоплення · читання</th><th>Охоплення · зміна</th></tr></thead>
      <tbody>${rows}
        <tr class="grp"><td colspan="7">Окремі права</td></tr>
        ${xr('export', 'Вивантаження у файл')}${xr('bulk', 'Масові операції')}
        ${xr('transfer', 'Передача угод іншому', [['none', 'Ні'], ['team', 'У своїй команді'], ['all', 'Будь-кому в проєкті']])}
        ${xr('filters', 'Спільні фільтри', [['none', 'Ні'], ['team', 'Для команди'], ['all', 'Для проєкту']])}
        ${xr('settings', 'Доступ до налаштувань проєкту')}
      </tbody></table></div>
    </div>${nEd ? `<div class="savebar"><span>${nEd} ${nEd === 1 ? 'зміна' : nEd < 5 ? 'зміни' : 'змін'} · роль «${esc(role)}», ${ROLE_USERS[role]} корист.</span><button class="btn xs ghost" data-act="roleReset">Скасувати</button><button class="btn xs primary" data-act="roleSave">Зберегти ${kbd('Ctrl', 'S')}</button></div>` : ''}`;
  }

  /* ---------------- Вхід ---------------- */
  function viewSignin() {
    const err = S.state === 'validation';
    const steps = `<div class="steps"><i class="${S.signinStep === 1 ? 'cur' : 'done'}"></i><i class="${S.signinStep === 2 ? 'cur' : ''}"></i></div>`;
    let box;
    if (S.state === 'loading') box = `<div class="sk" style="height:20px;width:120px;margin-bottom:32px"></div><div class="sk" style="height:24px;width:200px;margin-bottom:24px"></div><div class="sk" style="height:44px;margin-bottom:12px"></div><div class="sk" style="height:32px"></div>`;
    else if (S.state === 'error') box = errorBlank('Сервер входу недоступний', '502 · /api/auth/sign-in · 14:02:11', `<button class="btn" data-act="retry">Спробувати знову</button>`).replace('class="blank"', 'class=""');
    else if (S.state === 'forbidden') box = `<div class="brand"><span class="mark">a</span>Alpi CRM</div><h1>Обліковий запис вимкнено</h1><p class="sub">Адміністратор вимкнув доступ для olena.koval@example.com. Усі сесії відкликано. Якщо це помилка — зверніться до адміністратора проєкту.</p><div class="code mono ink3" style="font-size:12px">403 · account_disabled</div>`;
    else if (S.signinStep === 1) box = `<div class="brand"><span class="mark">a</span>Alpi CRM</div>${steps}<h1>Вхід</h1><p class="sub">Реєстрації немає — обліковий запис створює адміністратор.</p>
      <form data-form="signin1"><div class="fld"><label class="lbl" for="em">Email</label><input class="field" id="em" type="email" value="olena.koval@example.com" autocomplete="username"></div>
      <div class="fld"><label class="lbl" for="pw">Пароль</label><input class="field" id="pw" type="password" value="примерпароля" autocomplete="current-password"></div>
      <button class="btn primary" type="submit">Далі ${kbd('Enter')}</button></form>
      <div class="alt"><a href="#">Забули пароль?</a><span class="seg"><button aria-pressed="${S.lang === 'uk'}" data-act="lang" data-v="uk">UK</button><button aria-pressed="${S.lang === 'ru'}" data-act="lang" data-v="ru">RU</button></span></div>`;
    else box = `<div class="brand"><span class="mark">a</span>Alpi CRM</div>${steps}<h1>Код підтвердження</h1>
      <p class="sub">Введіть 6 цифр із застосунку автентифікації для <span style="color:var(--ink)">olena.koval@example.com</span>.</p>
      <form data-form="signin2"><label class="lbl" id="otpl">Код 2FA</label>
      <div class="otp" role="group" aria-labelledby="otpl">${(err ? '481920' : '4819  ').split('').map((c, i) => `<input class="field${err ? ' invalid' : ''}" inputmode="numeric" maxlength="1" value="${c.trim()}" aria-label="Цифра ${i + 1}" data-otp="${i}">`).join('')}</div>
      ${err ? `<div class="err-text" role="alert">${ic('circle-alert', 'ic-12')}Код не підходить. Залишилось 4 спроби, потім вхід блокується на 15 хвилин.</div>` : ''}
      <button class="btn primary" type="submit">Підтвердити ${kbd('Enter')}</button></form>
      <div class="alt"><a href="#" data-act="signinBack">← Інший обліковий запис</a><a href="#">Код відновлення</a></div>
      <div class="legal">Сесія — 12 годин на цьому пристрої. Вхід записується в журнал.</div>`;
    return `<div class="signin"><div class="signin-box">${box}</div></div>`;
  }

  /* ---------------- Панель на сьогодні (заглушка) ---------------- */
  function viewDash() {
    return `<div class="bar"><h1>${t('dash')}</h1></div>` + blank('layout-dashboard', 'Панель — поза цим прототипом', 'Порівнюються шість екранів: канбан, картка угоди, список, ролі, вхід і оболонка з палітрою команд.', `<button class="btn" data-act="go" data-scr="kanban">До канбану ${kbd('G', 'K')}</button>`);
  }

  /* ---------------- Оверлеї ---------------- */
  function overlays() {
    let h = '';
    const ov = S.overlay;
    if (ov === 'proj') h += `<div class="menu float" style="top:40px;left:8px;width:260px" role="menu">
      <div class="mh">Проєкт</div>
      ${['alpi', 'franch'].map((k) => `<button class="mi" role="menuitemradio" aria-checked="${S.proj === k}" data-act="proj" data-v="${k}"><span class="mark" style="width:16px;height:16px;border-radius:4px;display:grid;place-items:center;background:var(--primary);color:var(--on-primary);font:600 9px/1 var(--mono)">${k === 'alpi' ? 'A' : 'Ф'}</span>${esc(PROJECTS[k].name)}<span class="ink3">${esc(PROJECTS[k].role)}</span>${S.proj === k ? ic('check', 'ic-14') : ''}</button>`).join('')}
      <hr><div class="mh" style="font-weight:400">Дані проєктів не перетинаються. Фільтри й вибір скидаються.</div></div>`;
    if (ov === 'notif') h += `<div class="menu float notif" style="top:40px;right:12px" role="dialog" aria-label="${t('notifs')}"><div class="mh" style="display:flex">${t('notifs')}<span class="grow"></span><a href="#" class="accent" style="text-decoration:none;font-weight:400">Позначити прочитаними</a></div>
      ${NOTIFS.map((n) => `<div class="ni">${ic(n.ic, 'ic-14 ' + (n.ic === 'phone-missed' ? 'lost' : 'ink2'))}<div><b>${esc(n.t)}</b><span>${esc(n.s)}</span></div><span class="mono">${esc(n.at)}</span></div>`).join('')}</div>`;
    if (ov === 'pipe') h += `<div class="menu float" style="top:84px;left:${S.screen === 'kanban' ? 290 : 80}px" role="menu"><div class="mh">Воронки ${esc(P().name)}</div>${P().pipelines.map((x, i) => `<button class="mi" data-act="close">${ic(i ? 'lock' : 'workflow', 'ic-14')}${esc(x)}${i === 0 ? ic('check', 'ic-14') : '<span class="ink3">немає доступу</span>'}</button>`).join('')}</div>`;
    if (ov === 'stage') {
      const d = dealById(S.dealId);
      h += `<div class="menu float" style="top:${S.screen === 'list' ? 'auto' : '150px'};${S.screen === 'list' ? 'bottom:72px;left:50%;margin-left:-110px' : 'left:24px'}" role="menu"><div class="mh">Перемістити на етап</div>
        ${P().stages.map((s, i) => `<button class="mi" data-act="setStage" data-i="${i}">${S.screen !== 'list' && d && i === d.stage ? ic('check', 'ic-14') : `<span style="width:16px"></span>`}${esc(s.n)}<span class="ink3">${i + 1}</span></button>`).join('')}</div>`;
    }
    if (ov === 'owner') h += `<div class="menu float" style="${S.screen === 'list' ? 'bottom:72px;left:50%;margin-left:-160px' : 'top:200px;left:300px'}" role="menu"><div class="mh">Передати угоду</div>
      ${P().users.map((u) => `<button class="mi" data-act="setOwner" data-v="${u.id}">${avatar(u.id)}${esc(u.n)}<span class="ink3">${u.id === 'ok' ? 'ви' : ''}</span></button>`).join('')}<hr><button class="mi" data-act="setOwner" data-v="">${avatar(null)}У загальну чергу</button></div>`;
    if (ov === 'more') h += `<div class="menu float" style="top:96px;right:24px" role="menu">
      <button class="mi" data-act="newTask">${ic('calendar-plus', 'ic-14')}Нова задача${kbd('T')}</button>
      <button class="mi" data-act="ov" data-ov="owner">${ic('user-round-plus', 'ic-14')}${t('transfer')}${kbd('P')}</button>
      <button class="mi" data-act="ov" data-ov="stage">${ic('arrow-right-left', 'ic-14')}Змінити етап${kbd('S')}</button>
      <button class="mi" data-act="archive">${ic('archive', 'ic-14')}${t('archive')}${kbd('E')}</button>
      <hr><button class="mi" data-act="copyLink">${ic('link', 'ic-14')}Копіювати посилання</button><button class="mi danger" style="color:var(--lost)" data-act="delDeal">${ic('trash-2', 'ic-14')}Видалити в кошик</button></div>`;
    if (S.overlay === 'palette') h += `<div class="scrim" data-act="close" style="background:transparent"></div>` + paletteHtml();
    if (S.dialog) h += `<div class="scrim" data-act="closeDlg"></div>` + dialogHtml();
    if (S.drawer) h += `<div class="drawer-scrim" data-act="drawer"></div>`;
    h += `<div class="toasts" aria-live="polite">${S.toasts.map((x) => `<div class="toast float" data-tid="${x.id}">${x.icon ? ic(x.icon, 'ic-14 ' + (x.icon === 'circle-check' ? 'won' : 'ink2')) : ''}<span class="grow">${x.html}</span>${x.undo ? `<button class="btn xs ghost" data-act="undo" data-tid="${x.id}">Скасувати ${kbd('Ctrl', 'Z')}</button>` : ''}<button class="btn xs ghost icon" data-act="toastX" data-tid="${x.id}" aria-label="Закрити">${ic('x', 'ic-12')}</button></div>`).join('')}</div>`;
    return h;
  }

  /* ---------------- Палітра команд ---------------- */
  function commands() {
    const p = P();
    const inDeal = S.screen === 'deal';
    const c = [
      { g: 'Дії', i: 'plus', t: t('newDeal'), k: ['C'], run: () => openDlg({ type: 'newDeal' }) },
      { g: 'Дії', i: 'circle-check', t: 'Позначити виграною', k: ['W'], hint: inDeal ? '' : 'у картці угоди', run: () => act.won() },
      { g: 'Дії', i: 'circle-x', t: 'Позначити програною', k: ['L'], hint: inDeal ? '' : 'у картці угоди', run: () => act.lost() },
      { g: 'Дії', i: 'calendar-plus', t: 'Нова задача', k: ['T'], run: () => act.newTask() },
      { g: 'Дії', i: 'user-round-plus', t: 'Передати угоду', k: ['P'], run: () => { goDealIfNeeded(); S.overlay = 'owner'; render(); } },
      { g: 'Дії', i: 'archive', t: 'Архівувати угоду', k: ['E'], run: () => act.archive() },
      { g: 'Перейти', i: 'square-kanban', t: t('kanban'), k: ['G', 'K'], run: () => go('kanban') },
      { g: 'Перейти', i: 'list', t: t('list'), k: ['G', 'L'], run: () => go('list') },
      { g: 'Перейти', i: 'shield', t: t('settings') + ' → ' + t('roles'), k: ['G', 'R'], run: () => go('roles') },
      { g: 'Перейти', i: 'inbox', t: t('queue'), hint: 'список без відповідального', run: () => { S.listTab = 'queue'; go('list'); } },
      { g: 'Перейти', i: 'log-in', t: 'Екран входу (2FA)', run: () => go('signin') },
      { g: 'Проєкт', i: 'repeat', t: `Перейти в ${S.proj === 'alpi' ? '«Франч»' : 'AI-школу ALPI'}`, run: () => switchProj(S.proj === 'alpi' ? 'franch' : 'alpi') },
      { g: 'Вигляд', i: S.theme === 'dark' ? 'sun' : 'moon', t: S.theme === 'dark' ? 'Світла тема' : 'Темна тема', k: ['Shift', 'T'], run: () => setTheme(S.theme === 'dark' ? 'light' : 'dark') },
      { g: 'Вигляд', i: 'languages', t: S.lang === 'uk' ? 'Мова оболонки: RU' : 'Мова оболонки: UK', run: () => { S.lang = S.lang === 'uk' ? 'ru' : 'uk'; render(); } },
      { g: 'Вигляд', i: 'keyboard', t: 'Усі клавіші', k: ['?'], run: () => openDlg({ type: 'keys' }) }
    ];
    return c;
  }
  let palQ = '', palI = 0, palItems = [];
  function paletteItems() {
    const q = palQ.trim().toLowerCase();
    let items = commands().filter((c) => !q || c.t.toLowerCase().includes(q) || c.g.toLowerCase().includes(q));
    if (q) {
      const digits = q.replace(/\D/g, '');
      const deals = P().deals.filter((d) => d.title.toLowerCase().includes(q) || d.contact.name.toLowerCase().includes(q) || (digits.length >= 3 && (d.contact.phone.replace(/\D/g, '').includes(digits) || String(d.num).includes(digits)))).slice(0, 6);
      items = items.concat(deals.map((d) => ({ g: 'Угоди', st: d, t: d.title, hint: `#${d.num} · ${P().stages[d.stage].n}`, run: () => openDeal(d.id) })));
    } else {
      const recent = [dealById(P().demoId), ...P().deals.filter((d) => !d.listOnly).slice(3, 5)];
      items = items.slice(0, 6).concat(recent.map((d) => ({ g: 'Нещодавні угоди', st: d, t: d.title, hint: `#${d.num} · ${P().stages[d.stage].n}`, run: () => openDeal(d.id) }))).concat(items.slice(6));
    }
    return items;
  }
  function paletteHtml() {
    return `<div class="palette float" role="dialog" aria-label="Палітра команд">
      <div class="pin">${ic('search')}<input id="palin" placeholder="Команда, угода, телефон…" value="${esc(palQ)}" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="pall"><span class="kbd">Esc</span></div>
      <div class="pl" id="pall" role="listbox">${paletteList()}</div>
      <div class="pf"><span>${kbd('↑')}${kbd('↓')} вибір</span><span>${kbd('Enter')} виконати</span><span>${kbd('Ctrl', 'K')} закрити</span><span class="grow"></span><span>Проєкт ${esc(P().short)}</span></div>
    </div>`;
  }
  function paletteList() {
    palItems = paletteItems();
    if (palI >= palItems.length) palI = Math.max(0, palItems.length - 1);
    if (!palItems.length) return `<div class="none">Нічого не знайдено в проєкті ${esc(P().short)}. Телефон можна вводити в будь-якому форматі.</div>`;
    let g = '', h = '';
    palItems.forEach((c, i) => {
      if (c.g !== g) { g = c.g; h += `<div class="pg">${esc(g)}</div>`; }
      h += `<div class="po${i === palI ? ' act' : ''}" role="option" aria-selected="${i === palI}" data-pi="${i}">${c.st ? stIcon(c.st) : ic(c.i, 'ic-14')}<span class="grow trunc">${esc(c.t)}</span>${c.hint ? `<span class="hint">${esc(c.hint)}</span>` : ''}${c.k ? `<span class="kbds">${kbd(...c.k)}</span>` : ''}</div>`;
    });
    return h;
  }
  function refreshPalette() {
    const l = $('#pall'); if (!l) return;
    l.innerHTML = paletteList(); icons(l);
    const a = l.querySelector('.po.act'); if (a) a.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- Діалоги ---------------- */
  function dialogHtml() {
    const D = S.dialog;
    const p = P();
    if (D.type === 'keys') {
      const K = [['Палітра команд', ['Ctrl', 'K']], ['Пошук', ['/']], ['Канбан / список / ролі', ['G', 'K / L / R']], ['Наступний / попередній рядок', ['J', 'K']], ['Колонка ліворуч / праворуч', ['←', '→']], ['Відкрити', ['Enter']], ['Вибрати рядок', ['X']], ['Нова угода', ['C']], ['Виграна / програна', ['W', 'L']], ['В архів', ['E']], ['Нова задача', ['T']], ['Передати', ['P']], ['Змінити етап', ['S']], ['Нотатка', ['N']], ['Тема', ['Shift', 'T']], ['Закрити / назад', ['Esc']]];
      return `<div class="dialog float" role="dialog" aria-modal="true" aria-labelledby="dlgh"><div class="dh"><h2 id="dlgh">Клавіші</h2></div><div class="db"><div class="keys">${K.map(([l, k]) => `<span>${l}</span><span class="kbds">${kbd(...k)}</span>`).join('')}</div></div><div class="df"><button class="btn" data-act="closeDlg">Закрити ${kbd('Esc')}</button></div></div>`;
    }
    if (D.type === 'confirm') {
      return `<div class="dialog float" role="alertdialog" aria-modal="true" aria-labelledby="dlgh"><div class="dh"><h2 id="dlgh">${esc(D.title)}</h2><p>${D.body}</p></div>
        <div class="df"><span class="left">${kbd('Enter')} підтвердити</span><button class="btn" data-act="closeDlg">Скасувати</button><button class="btn ${D.danger ? 'danger' : 'primary'}" data-act="confirmOk" autofocus>${esc(D.ok)}</button></div></div>`;
    }
    if (D.type === 'lost') {
      const groups = Object.keys(p.lost);
      const errG = D.err && !D.g, errR = D.err && !D.r;
      return `<div class="dialog float" role="dialog" aria-modal="true" aria-labelledby="dlgh"><div class="dh"><h2 id="dlgh">Програна: ${esc(D.title)}</h2><p>Причина обовʼязкова: спершу група, потім причина з довідника проєкту.</p></div>
        <form class="db" data-form="lost">
          <div><label class="lbl" for="lg">Група</label><select class="field${errG ? ' invalid' : ''}" id="lg" data-act="lostG"><option value="">Оберіть групу</option>${groups.map((g) => `<option ${D.g === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>${errG ? `<div class="err-text">${ic('circle-alert', 'ic-12')}Оберіть групу</div>` : ''}</div>
          <div><label class="lbl" for="lr">Причина</label><select class="field${errR ? ' invalid' : ''}" id="lr" data-act="lostR" ${D.g ? '' : 'disabled'}><option value="">${D.g ? 'Оберіть причину' : 'Спершу оберіть групу'}</option>${D.g ? p.lost[D.g].map((r) => `<option ${D.r === r ? 'selected' : ''}>${esc(r)}</option>`).join('') : ''}</select>${errR ? `<div class="err-text">${ic('circle-alert', 'ic-12')}Оберіть причину</div>` : ''}</div>
          <div><label class="lbl" for="lc">Коментар · необовʼязково</label><textarea class="field" id="lc" rows="2"></textarea></div>
        </form>
        <div class="df"><span class="left">${kbd('Ctrl', 'Enter')} зберегти</span><button class="btn" data-act="closeDlg">Скасувати</button><button class="btn primary" data-act="lostOk">Позначити програною</button></div></div>`;
    }
    if (D.type === 'required') {
      const e = D.err;
      return `<div class="dialog float" role="dialog" aria-modal="true" aria-labelledby="dlgh"><div class="dh"><h2 id="dlgh">Перехід на етап «${esc(p.stages[D.to].n)}»</h2><p>З цього етапу поля нижче обовʼязкові. Заповніть їх, щоб перемістити угоду «${esc(D.title)}».</p></div>
        <form class="db" data-form="required">
          ${e ? `<div class="form-err" role="alert">${ic('circle-alert', 'ic-14')}<span>Не заповнено 2 обовʼязкові поля. Угода лишилась на етапі «${esc(p.stages[D.from].n)}».</span></div>` : ''}
          <div><label class="lbl" for="rq1">Пакет</label><select class="field${e ? ' invalid' : ''}" id="rq1" aria-invalid="${!!e}"><option value="">Оберіть пакет</option><option>START</option><option>PRO</option><option>MAX</option></select>${e ? `<div class="err-text">${ic('circle-alert', 'ic-12')}Обовʼязкове поле з етапу «${esc(p.stages[D.to].n)}»</div>` : ''}</div>
          <div><label class="lbl" for="rq2">Тип закриття</label><select class="field${e ? ' invalid' : ''}" id="rq2" aria-invalid="${!!e}"><option value="">Оберіть тип</option><option>Бронь + доплата</option><option>Повна оплата</option><option>Розстрочка</option></select>${e ? `<div class="err-text">${ic('circle-alert', 'ic-12')}Обовʼязкове поле</div>` : ''}</div>
          <div><label class="lbl" for="rq3">Дата броні · необовʼязково</label><input class="field mono" id="rq3" value="30.10.2026"></div>
        </form>
        <div class="df"><span class="left">${kbd('Ctrl', 'Enter')} зберегти</span><button class="btn" data-act="closeDlg">Скасувати</button><button class="btn primary" data-act="reqOk">Зберегти і перемістити</button></div></div>`;
    }
    if (D.type === 'newDeal') {
      const e = D.err;
      return `<div class="dialog float" role="dialog" aria-modal="true" aria-labelledby="dlgh"><div class="dh"><h2 id="dlgh">${t('newDeal')}</h2><p>Воронка ${esc(p.pipeline)} · етап «${esc(p.stages[0].n)}». Телефон перевіряється на дубль у проєкті.</p></div>
        <form class="db" data-form="newDeal">
          ${e ? `<div class="form-err" role="alert">${ic('circle-alert', 'ic-14')}<span>Виправте 2 поля, щоб створити угоду.</span></div>` : ''}
          <div><label class="lbl" for="nd1">Контакт · імʼя</label><input class="field" id="nd1" value="${e ? 'Марта Кузьменко' : ''}" placeholder="Імʼя та прізвище"></div>
          <div><label class="lbl" for="nd2">Телефон</label><input class="field mono${e ? ' invalid' : ''}" id="nd2" value="${e ? '+380 00 12' : ''}" placeholder="+380 00 000 00 00" aria-invalid="${!!e}">${e ? `<div class="err-text">${ic('circle-alert', 'ic-12')}Номер закороткий: потрібно 12 цифр разом із кодом країни</div>` : ''}</div>
          <div style="display:grid;grid-template-columns:1fr 96px;gap:8px"><div><label class="lbl" for="nd3">Сума</label><input class="field mono${e ? ' invalid' : ''}" id="nd3" value="${e ? '-200' : ''}" placeholder="0">${e ? `<div class="err-text">${ic('circle-alert', 'ic-12')}Сума не може бути відʼємною</div>` : ''}</div>
          <div><label class="lbl" for="nd4">Валюта</label><select class="field" id="nd4"><option>EUR</option><option>UAH</option><option>USD</option></select></div></div>
        </form>
        <div class="df"><span class="left">${kbd('Ctrl', 'Enter')} створити</span><button class="btn" data-act="closeDlg">Скасувати</button><button class="btn primary" data-act="newDealOk">Створити</button></div></div>`;
    }
    if (D.type === 'task') {
      return `<div class="dialog float" role="dialog" aria-modal="true" aria-labelledby="dlgh"><div class="dh"><h2 id="dlgh">Нова задача</h2></div>
        <form class="db" data-form="task"><div><label class="lbl" for="tk1">Тип</label><select class="field" id="tk1">${p.taskTypes.map((x) => `<option>${esc(x)}</option>`).join('')}</select></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label class="lbl" for="tk2">Дата</label><input class="field mono" id="tk2" value="05.11.2026"></div><div><label class="lbl" for="tk3">Час · необовʼязково</label><input class="field mono" id="tk3" value="11:00"></div></div>
        <div class="seg"><button type="button" aria-pressed="false">сьогодні</button><button type="button" aria-pressed="true">завтра</button><button type="button" aria-pressed="false">за 3 дні</button><button type="button" aria-pressed="false">за тиждень</button></div></form>
        <div class="df"><button class="btn" data-act="closeDlg">Скасувати</button><button class="btn primary" data-act="taskOk">Створити ${kbd('Ctrl', 'Enter')}</button></div></div>`;
    }
    return '';
  }
  function openDlg(d) { S.dialog = d; S.overlay = null; render(); const f = $('.dialog [autofocus], .dialog select, .dialog input, .dialog .btn.primary'); if (f) f.focus(); }
  function closeDlg() { S.dialog = null; render(); }

  /* ---------------- Тости ---------------- */
  let tid = 0;
  function toast(html, opts = {}) {
    const x = { id: ++tid, html, undo: opts.undo, icon: opts.icon || 'info' };
    S.toasts.push(x);
    if (S.toasts.length > 3) S.toasts.shift();
    if (!opts.sticky) setTimeout(() => { S.toasts = S.toasts.filter((y) => y !== x); renderOverlaysOnly(); }, 6000);
    renderOverlaysOnly();
  }

  /* ---------------- Дії ---------------- */
  function go(scr) { S.screen = scr; S.overlay = null; S.dialog = null; S.drawer = false; S.kbRow = -1; S.dealEnter = scr === 'deal'; render(); S.dealEnter = false; }
  function openDeal(id) { S.dealId = id; S.feedFilter = 'all'; go('deal'); }
  function goDealIfNeeded() { if (S.screen !== 'deal' && S.screen !== 'list') { S.dealId = S.kbCard || P().demoId; go('deal'); } }
  function switchProj(k) { S.proj = k; S.sel.clear(); S.dealId = null; S.kbCard = null; S.mStage = 0; S.overlay = null; S.queueOnly = false; render(); toast(`Проєкт: ${esc(PROJECTS[k].name)}. Фільтри та вибір скинуто.`, { icon: 'repeat' }); }
  function setTheme(th) { S.theme = th; document.documentElement.dataset.theme = th; render(); }
  function curDeal() { return S.screen === 'deal' ? dealById(S.dealId) : S.kbCard ? dealById(S.kbCard) : null; }
  function moveStage(d, to, silent) {
    const p = P(); const from = d.stage; if (from === to) return;
    p.stages[from].total--; p.stages[to].total++; d.stage = to;
    if (d.feed) d.feed.unshift({ t: 'stage', at: `${TODAY} 14:0${tid % 10}`, who: 'Олена Коваль', from: p.stages[from].n, to: p.stages[to].n });
    if (!silent) toast(`«${esc(d.title)}»: ${esc(p.stages[from].n)} → <b>${esc(p.stages[to].n)}</b>`, { undo: () => moveStage(d, from, true), icon: 'arrow-right-left' });
  }
  function needsFields(to) { return P().key === 'alpi' && to === 7; }
  function tryStage(d, to) {
    if (needsFields(to)) { openDlg({ type: 'required', id: d.id, title: d.title, from: d.stage, to }); return; }
    moveStage(d, to); render();
  }

  const act = {
    won(el) {
      const d = curDeal(); if (!d) { toast('Відкрийте угоду або виберіть картку (J/K), щоб позначити її виграною.'); return; }
      const prev = { ...d }; d.status = 'won'; d.task = null;
      render();
      toast(`«${esc(d.title)}» — <span class="won">виграна</span>. Зовнішня автоматизація поставить задачу на доплату.`, { undo: () => Object.assign(d, prev), icon: 'circle-check' });
    },
    lost() {
      const d = curDeal(); if (!d) { toast('Відкрийте угоду або виберіть картку (J/K), щоб позначити її програною.'); return; }
      openDlg({ type: 'lost', id: d.id, title: d.title });
    },
    archive() {
      const d = curDeal(); if (!d) return;
      openDlg({ type: 'confirm', title: 'Архівувати угоду?', body: `«${esc(d.title)}» зникне з канбану і робочих списків, але лишиться в пошуку і звітах. Статус «${d.status === 'open' ? 'відкрита' : d.status}» не зміниться.`, ok: 'Архівувати', run: () => { d.archived = true; toast(`«${esc(d.title)}» в архіві.`, { undo: () => { d.archived = false; }, icon: 'archive' }); } });
    },
    newTask() { openDlg({ type: 'task' }); },
    newDeal() { openDlg({ type: 'newDeal' }); }
  };

  function bulkConfirm(kind) {
    const n = S.sel.size;
    openDlg({
      type: 'confirm', danger: kind === 'delete',
      title: kind === 'delete' ? `Видалити ${n} угод${n === 1 ? 'у' : n < 5 ? 'и' : ''}?` : `Архівувати ${n} угод${n === 1 ? 'у' : n < 5 ? 'и' : ''}?`,
      body: kind === 'delete' ? 'Угоди перейдуть у кошик і лежатимуть там 30 днів. Операція виконується у фоні, журнал буде в «Масових операціях».' : 'Угоди зникнуть з канбану і робочих списків, але лишаться в пошуку і звітах. Операція виконується у фоні з журналом.',
      ok: kind === 'delete' ? `Видалити ${n}` : `Архівувати ${n}`,
      run: () => {
        const ids = [...S.sel];
        ids.forEach((id) => { const d = dealById(id); if (kind === 'delete') d.archived = true; else d.archived = true; });
        S.sel.clear();
        toast(`${kind === 'delete' ? 'Видалено в кошик' : 'Архівовано'}: <b class="mono">${ids.length}</b> угод. Фонова задача №2291 завершена.`, { undo: () => ids.forEach((id) => { dealById(id).archived = false; }), icon: kind === 'delete' ? 'trash-2' : 'archive' });
      }
    });
  }

  /* ---------------- Рендер ---------------- */
  const SCROLLS = ['#board', '#listwrap', '#deal', '#scontent'];
  function icons(root) {
    if (window.lucide) window.lucide.createIcons({ icons: window.lucide.icons, attrs: { 'stroke-width': 1.5 }, root: root || app });
  }
  function render() {
    const sc = {}; SCROLLS.forEach((s) => { const e = $(s); if (e) sc[s] = [e.scrollLeft, e.scrollTop]; });
    const signin = S.screen === 'signin';
    let main;
    switch (S.screen) {
      case 'deal': main = viewDeal(); break;
      case 'list': main = viewList(); break;
      case 'roles': main = viewRoles(); break;
      case 'signin': main = viewSignin(); break;
      case 'dash': main = viewDash(); break;
      default: S.screen = 'kanban'; main = viewKanban();
    }
    app.className = 'app' + (S.drawer ? ' drawer' : '');
    app.innerHTML = `<div class="shell${signin ? ' no-shell' : ''}">` + (signin ? '' : header() + nav()) + `<main class="main" id="main">${main}</main></div>` + `<div id="ovl">${overlays()}</div>`;
    SCROLLS.forEach((s) => { const e = $(s); if (e && sc[s]) { e.scrollLeft = sc[s][0]; e.scrollTop = sc[s][1]; } });
    $$('[data-ind]').forEach((e) => { e.indeterminate = true; });
    icons();
    renderBar();
    if (S.overlay === 'palette') { const i = $('#palin'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
    if (S.state === 'drag' && S.screen === 'kanban') frozenDrag();
    const k = S.kbCard && $(`.card[data-id="${S.kbCard}"]`); if (k && document.activeElement === document.body) k.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function renderOverlaysOnly() {
    const o = $('#ovl'); if (!o) return render();
    const pal = S.overlay === 'palette';
    if (pal) { const t0 = $('.toasts'); if (t0) { t0.outerHTML = overlays().match(/<div class="toasts"[\s\S]*$/)[0]; icons(o); } return; }
    o.innerHTML = overlays(); icons(o);
  }

  /* Застиглий стан перетягування */
  function frozenDrag() {
    const board = $('#board'); if (!board) return;
    const mobile = app.offsetWidth < 640;
    const src = $(`.col[data-stage="${mobile ? S.mStage : 1}"] .card:not(.queue)`);
    const tgtCol = mobile ? $(`.col[data-stage="${S.mStage}"]`) : $('.col[data-stage="2"]');
    if (!src || !tgtCol) return;
    const ghost = src.cloneNode(true);
    src.classList.add('placeholder');
    tgtCol.classList.add('drop-target');
    const r = tgtCol.querySelector('.col-b').getBoundingClientRect();
    ghost.classList.add('ghost');
    if (!mobile) tgtCol.classList.add('drop-target'); else tgtCol.classList.remove('drop-target');
    ghost.style.left = (r.left + 22) + 'px';
    ghost.style.top = (r.top + 128) + 'px';
    if (mobile) { const dz = $('.dz.won'); const zr = dz.getBoundingClientRect(); dz.classList.add('over'); ghost.style.left = (zr.left + 30) + 'px'; ghost.style.top = (zr.top - 40) + 'px'; ghost.style.width = (r.width - 40) + 'px'; }
    app.appendChild(ghost);
  }

  /* ---------------- Живе перетягування (миша) ---------------- */
  let drag = null;
  app.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.card');
    if (!card || e.button !== 0 || e.target.closest('button') || S.screen !== 'kanban' || S.state !== 'normal') return;
    if (e.pointerType !== 'mouse' && app.offsetWidth < 640) return;
    const r = card.getBoundingClientRect();
    drag = { id: card.dataset.id, card, sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, on: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.on) {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 5) return;
      drag.on = true;
      drag.ghost = drag.card.cloneNode(true);
      drag.ghost.classList.add('ghost'); drag.ghost.style.width = drag.w + 'px';
      app.appendChild(drag.ghost);
      drag.card.classList.add('placeholder');
      $('#main').insertAdjacentHTML('beforeend', dropzones()); icons($('#dz'));
      document.body.style.cursor = 'grabbing';
    }
    drag.ghost.style.left = (e.clientX - drag.ox) + 'px';
    drag.ghost.style.top = (e.clientY - drag.oy) + 'px';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    $$('.col.drop-target').forEach((c) => c.classList.remove('drop-target'));
    $$('.dz.over').forEach((c) => c.classList.remove('over'));
    const dz = el && el.closest('.dz');
    const col = el && el.closest('.col');
    if (dz) dz.classList.add('over');
    else if (col && +col.dataset.stage !== dealById(drag.id).stage) col.classList.add('drop-target');
    const b = $('#board'); if (b) { const br = b.getBoundingClientRect(); if (e.clientX > br.right - 60) b.scrollLeft += 14; else if (e.clientX < br.left + 60) b.scrollLeft -= 14; }
  });
  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const dd = drag; drag = null; document.body.style.cursor = '';
    if (!dd.on) { openDeal(dd.id); return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    dd.ghost.remove();
    const d = dealById(dd.id);
    const dz = el && el.closest('.dz');
    const col = el && el.closest('.col');
    S.kbCard = d.id;
    if (dz) {
      const k = dz.dataset.drop;
      if (k === 'won') { const prev = { ...d }; d.status = 'won'; render(); toast(`«${esc(d.title)}» — <span class="won">виграна</span>.`, { undo: () => Object.assign(d, prev), icon: 'circle-check' }); }
      else if (k === 'lost') { render(); openDlg({ type: 'lost', id: d.id, title: d.title }); }
      else { d.archived = true; render(); toast(`«${esc(d.title)}» в архіві.`, { undo: () => { d.archived = false; }, icon: 'archive' }); }
      return;
    }
    if (col) { const to = +col.dataset.stage; if (to !== d.stage) { tryStage(d, to); return; } }
    render();
  });

  /* ---------------- Кліки ---------------- */
  document.addEventListener('click', (e) => {
    const po = e.target.closest('.po');
    if (po) { const c = palItems[+po.dataset.pi]; S.overlay = null; palQ = ''; c.run(); if (S.overlay !== 'owner' && !S.dialog) render(); return; }
    const el = e.target.closest('[data-act]');
    if (!el) {
      if (S.overlay && S.overlay !== 'palette' && !e.target.closest('.menu')) { S.overlay = null; render(); }
      return;
    }
    const a = el.dataset.act;
    if (el.tagName === 'A' || a !== 'selRow' && a !== 'selAll' && a !== 'rc' && a !== 'doneTask') e.preventDefault();
    const d = curDeal();
    switch (a) {
      case 'go': go(el.dataset.scr); break;
      case 'stub': toast('Цей розділ не входить у прототип порівняння напрямів.'); break;
      case 'ov': S.overlay = S.overlay === el.dataset.ov ? null : el.dataset.ov; render(); break;
      case 'close': S.overlay = null; render(); break;
      case 'palette': palQ = ''; palI = 0; S.overlay = 'palette'; render(); break;
      case 'drawer': S.drawer = !S.drawer; render(); break;
      case 'lang': S.lang = el.dataset.v; render(); break;
      case 'theme': setTheme(S.theme === 'dark' ? 'light' : 'dark'); break;
      case 'proj': switchProj(el.dataset.v); break;
      case 'mstage': S.mStage = +el.dataset.i; render(); { const tb = $(`.stabs [data-i="${S.mStage}"]`); if (tb) tb.scrollIntoView({ inline: 'center', block: 'nearest' }); } break;
      case 'queueOnly': S.queueOnly = !S.queueOnly; render(); break;
      case 'take': { const x = dealById(el.dataset.id); x.owner = 'ok'; x.task = { kind: 'today', type: P().taskTypes[0], date: TODAY, time: null }; render(); toast(`«${esc(x.title)}» тепер ваша. Задачу «${esc(P().taskTypes[0])}» поставлено на сьогодні.`, { undo: () => { x.owner = null; x.task = null; }, icon: 'hand' }); break; }
      case 'newDeal': act.newDeal(); break;
      case 'retry': S.state = 'normal'; render(); break;
      case 'won': act.won(); break;
      case 'lost': act.lost(); break;
      case 'archive': act.archive(); break;
      case 'reopen': d.status = 'open'; d.archived = false; d.lostReason = null; render(); toast(`«${esc(d.title)}» знову відкрита.`, { icon: 'rotate-ccw' }); break;
      case 'newTask': act.newTask(); break;
      case 'dealNav': dealNav(+el.dataset.dir); break;
      case 'setStage': {
        S.overlay = null;
        if (S.screen === 'list') { const ids = [...S.sel]; ids.forEach((id) => moveStage(dealById(id), +el.dataset.i, true)); S.sel.clear(); render(); toast(`Етап змінено для <b class="mono">${ids.length}</b> угод: «${esc(P().stages[+el.dataset.i].n)}».`, { icon: 'arrow-right-left' }); }
        else tryStage(d, +el.dataset.i);
        break;
      }
      case 'setOwner': {
        S.overlay = null; const v = el.dataset.v || null; const u = userById(v);
        if (S.screen === 'list') { const n = S.sel.size; S.sel.forEach((id) => { dealById(id).owner = v; }); S.sel.clear(); render(); toast(`Передано <b class="mono">${n}</b> угод: ${u ? esc(u.n) : 'у загальну чергу'}.`, { icon: 'user-round-plus' }); }
        else if (d) { const prev = d.owner; d.owner = v; render(); toast(`Відповідальний: ${u ? esc(u.n) : 'загальна черга'}.`, { undo: () => { d.owner = prev; }, icon: 'user-round-plus' }); }
        break;
      }
      case 'applySum': { const prev = d.amount; d.amount = total(d); render(); toast(`Сума угоди: <span class="mono">${money(prev, d.cur)}</span> → <span class="mono">${money(d.amount, d.cur)}</span>`, { undo: () => { d.amount = prev; }, icon: 'check' }); break; }
      case 'feedF': S.feedFilter = el.dataset.v; render(); break;
      case 'saveNote': saveNote(); break;
      case 'play': S.playing = !S.playing; render(); break;
      case 'doneTask': setTimeout(() => { d.task = null; d.feed && d.feed.unshift({ t: 'task', at: `${TODAY} 14:05`, who: 'Олена Коваль', text: 'Задачу виконано: Доплата' }); render(); toast('Задачу виконано. Запланувати наступну?', { icon: 'square-check' }); }, 120); break;
      case 'copyLink': S.overlay = null; render(); toast('Посилання на угоду скопійовано.', { icon: 'link' }); break;
      case 'delDeal': S.overlay = null; openDlg({ type: 'confirm', danger: true, title: 'Видалити угоду в кошик?', body: `«${esc(d.title)}» лежатиме в кошику 30 днів. Відновити може адміністратор або керівник.`, ok: 'Видалити', run: () => { d.archived = true; go('kanban'); toast('Угоду переміщено в кошик.', { icon: 'trash-2' }); } }); break;
      case 'tab': S.listTab = el.dataset.v; S.sel.clear(); S.kbRow = -1; render(); break;
      case 'open': openDeal(el.dataset.id); break;
      case 'selRow': { const id = el.dataset.id; S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); render(); break; }
      case 'selAll': { const rows = listRows(); const all = rows.every((x) => S.sel.has(x.id)); rows.forEach((x) => all ? S.sel.delete(x.id) : S.sel.add(x.id)); render(); break; }
      case 'selNone': S.sel.clear(); render(); break;
      case 'bulkArchive': bulkConfirm('archive'); break;
      case 'bulkDelete': bulkConfirm('delete'); break;
      case 'roleTab': S.roleTab = el.dataset.v; render(); break;
      case 'rc': { const ed = S.roleEdits[S.roleTab] = S.roleEdits[S.roleTab] || {}; const key = el.dataset.k + '.' + el.dataset.f; const base = roleDefaults(S.roleTab); const bv = el.dataset.k === 'x' ? base.extra[el.dataset.f] : base.m[el.dataset.k][el.dataset.f]; const nv = el.checked ? 1 : 0; if (nv === (bv ? 1 : 0)) delete ed[key]; else ed[key] = nv; render(); break; }
      case 'roleReset': S.roleEdits[S.roleTab] = {}; render(); break;
      case 'roleSave': saveRole(); break;
      case 'signinBack': S.signinStep = 1; S.state = 'normal'; render(); break;
      case 'closeDlg': closeDlg(); break;
      case 'confirmOk': { const r = S.dialog.run; S.dialog = null; r && r(); render(); break; }
      case 'lostOk': lostOk(); break;
      case 'reqOk': reqOk(); break;
      case 'newDealOk': newDealOk(); break;
      case 'taskOk': { const tp = $('#tk1').value; S.dialog = null; if (d) d.task = { kind: 'future', type: tp, date: '2026-11-05', time: '11:00' }; render(); toast(`Задачу «${esc(tp)}» поставлено на 05.11 11:00.`, { icon: 'calendar-plus' }); break; }
      case 'undo': { const x = S.toasts.find((y) => y.id === +el.dataset.tid); if (x && x.undo) x.undo(); S.toasts = S.toasts.filter((y) => y !== x); render(); break; }
      case 'toastX': S.toasts = S.toasts.filter((y) => y.id !== +el.dataset.tid); renderOverlaysOnly(); break;
    }
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.act === 'rs') {
      const ed = S.roleEdits[S.roleTab] = S.roleEdits[S.roleTab] || {}; const key = el.dataset.k + '.' + el.dataset.f;
      const base = roleDefaults(S.roleTab); const bv = el.dataset.k === 'x' ? base.extra[el.dataset.f] : base.m[el.dataset.k][el.dataset.f];
      if (el.value === bv) delete ed[key]; else ed[key] = el.value; render();
    }
    if (el.dataset.act === 'lostG') { S.dialog.g = el.value; S.dialog.r = ''; render(); $('#lr') && $('#lr').focus(); }
    if (el.dataset.act === 'lostR') { S.dialog.r = el.value; }
  });
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.dataset.form;
    if (f === 'signin1') { S.signinStep = 2; render(); const o = $('[data-otp="0"]'); o && o.focus(); }
    if (f === 'signin2') { const code = $$('[data-otp]').map((i) => i.value).join(''); if (code.length < 6 || S.state === 'validation') { S.state = 'validation'; render(); } else { S.state = 'normal'; go('kanban'); toast('Вхід виконано. Сесія — 12 годин.', { icon: 'log-in' }); } }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'palin') { palQ = e.target.value; palI = 0; refreshPalette(); }
    if (e.target.dataset.otp !== undefined && e.target.value) { const n = $(`[data-otp="${+e.target.dataset.otp + 1}"]`); n && n.focus(); }
  });

  function saveNote() {
    const ta = $('#note'); const d = curDeal(); if (!ta || !d) return;
    if (!ta.value.trim()) { ta.focus(); toast('Нотатка порожня — нема чого зберігати.'); return; }
    d.feed.unshift({ t: 'note', at: `${TODAY} 14:0${tid % 10}`, who: 'Олена Коваль', text: ta.value.trim() });
    render(); toast('Нотатку збережено в стрічці.', { icon: 'sticky-note' });
  }
  function saveRole() {
    const n = Object.keys(S.roleEdits[S.roleTab] || {}).length; if (!n) return;
    openDlg({ type: 'confirm', title: `Зберегти роль «${S.roleTab}»?`, body: `${n} змін торкнуться ${ROLE_USERS[S.roleTab]} користувачів у проєкті ${esc(P().name)}. Нові права діють з наступного запиту, без повторного входу.`, ok: 'Зберегти', run: () => { S.roleEdits[S.roleTab] = {}; toast(`Роль «${esc(S.roleTab)}» збережено. Запис у журналі дій.`, { icon: 'shield-check' }); } });
  }
  function lostOk() {
    const D = S.dialog; if (!D.g || !D.r) { D.err = true; render(); return; }
    const d = dealById(D.id); const prev = { ...d }; d.status = 'lost'; d.lostReason = D.r; d.task = null; S.dialog = null; render();
    toast(`«${esc(d.title)}» — <span class="lost">програна</span> · ${esc(D.r)}.`, { undo: () => Object.assign(d, prev), icon: 'circle-x' });
  }
  function reqOk() {
    const D = S.dialog; if (!$('#rq1').value || !$('#rq2').value) { D.err = true; render(); return; }
    const d = dealById(D.id); S.dialog = null; moveStage(d, D.to); render();
  }
  function newDealOk() {
    const D = S.dialog; const ph = $('#nd2').value.replace(/\D/g, ''); const sum = $('#nd3').value;
    if (ph.length !== 12 || (sum && +sum < 0)) { D.err = true; render(); return; }
    S.dialog = null; render(); toast('Угоду створено на етапі «' + esc(P().stages[0].n) + '».', { icon: 'plus' });
  }
  function dealNav(dir) {
    const list = P().deals.filter((d) => !d.listOnly && d.status === 'open' && !d.archived);
    const i = list.findIndex((d) => d.id === S.dealId);
    const n = list[(i + dir + list.length) % list.length]; S.dealId = n.id; render();
  }

  /* ---------------- Клавіатура ---------------- */
  let chord = null, chordT = 0;
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'k') { e.preventDefault(); if (S.overlay === 'palette') { S.overlay = null; render(); } else { palQ = ''; palI = 0; S.overlay = 'palette'; render(); } return; }
    if (S.overlay === 'palette') {
      if (k === 'Escape') { S.overlay = null; render(); }
      else if (k === 'ArrowDown') { e.preventDefault(); palI = Math.min(palItems.length - 1, palI + 1); refreshPalette(); }
      else if (k === 'ArrowUp') { e.preventDefault(); palI = Math.max(0, palI - 1); refreshPalette(); }
      else if (k === 'Enter') { e.preventDefault(); const c = palItems[palI]; if (c) { S.overlay = null; palQ = ''; c.run(); if (S.overlay !== 'owner' && !S.dialog) render(); } }
      return;
    }
    if (S.dialog) {
      if (k === 'Escape') closeDlg();
      else if (k === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ({ lost: lostOk, required: reqOk, newDeal: newDealOk, confirm: () => $('[data-act="confirmOk"]').click(), task: () => $('[data-act="taskOk"]').click() }[S.dialog.type] || closeDlg)(); }
      else if (k === 'Enter' && S.dialog.type === 'confirm' && !typing) { e.preventDefault(); $('[data-act="confirmOk"]').click(); }
      return;
    }
    if (k === 'Escape') {
      if (typing) { e.target.blur(); return; }
      if (S.overlay || S.drawer) { S.overlay = null; S.drawer = false; render(); return; }
      if (S.screen === 'deal') { go('kanban'); return; }
      if (S.sel.size) { S.sel.clear(); render(); return; }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 's' && S.screen === 'roles') { e.preventDefault(); saveRole(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z' && !typing) { const x = [...S.toasts].reverse().find((y) => y.undo); if (x) { e.preventDefault(); x.undo(); S.toasts = S.toasts.filter((y) => y !== x); render(); } return; }
    if ((e.ctrlKey || e.metaKey) && k === 'Enter' && e.target.id === 'note') { e.preventDefault(); saveNote(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (S.screen === 'signin') return;

    const lk = k.toLowerCase();
    if (chord === 'g' && Date.now() - chordT < 900) {
      chord = null;
      if (lk === 'k') return go('kanban');
      if (lk === 'l') return go('list');
      if (lk === 'r') return go('roles');
      if (lk === 'd') return go('dash');
      return;
    }
    if (lk === 'g') { chord = 'g'; chordT = Date.now(); return; }
    if (k === '/') { e.preventDefault(); palQ = ''; palI = 0; S.overlay = 'palette'; render(); return; }
    if (k === '?') { openDlg({ type: 'keys' }); return; }
    if (k === 'T' && e.shiftKey) { setTheme(S.theme === 'dark' ? 'light' : 'dark'); return; }
    if (lk === 'c' && !e.shiftKey) { act.newDeal(); return; }
    if (lk === 'r' && S.state !== 'normal' && S.state !== 'drag') { S.state = 'normal'; render(); return; }

    if (S.screen === 'kanban') return kanbanKeys(e, lk);
    if (S.screen === 'list') return listKeys(e, lk);
    if (S.screen === 'deal') {
      if (lk === 'w') act.won();
      else if (lk === 'l') act.lost();
      else if (lk === 'e') act.archive();
      else if (lk === 't') act.newTask();
      else if (lk === 'p') { S.overlay = 'owner'; render(); }
      else if (lk === 's') { S.overlay = 'stage'; render(); }
      else if (lk === 'n') { e.preventDefault(); const n = $('#note'); n && n.focus(); }
      else if (lk === 'j') dealNav(1);
      else if (lk === 'k') dealNav(-1);
    }
  });
  function kanbanKeys(e, lk) {
    const deals = boardDeals(); const p = P();
    let d = S.kbCard && dealById(S.kbCard);
    const inCol = (si) => deals.filter((x) => x.stage === si);
    if (!d && /^(j|k|arrowdown|arrowup|arrowleft|arrowright)$/.test(lk)) { const f = deals[0]; if (f) { S.kbCard = f.id; render(); } return; }
    if (!d) return;
    if (lk === 'j' || lk === 'arrowdown' || lk === 'k' || lk === 'arrowup') {
      e.preventDefault(); const c = inCol(d.stage); const i = c.indexOf(d); const n = c[i + (lk === 'j' || lk === 'arrowdown' ? 1 : -1)]; if (n) { S.kbCard = n.id; render(); }
    } else if (lk === 'arrowright' || lk === 'arrowleft') {
      e.preventDefault(); let si = d.stage; const dir = lk === 'arrowright' ? 1 : -1;
      do { si += dir; } while (si >= 0 && si < p.stages.length && !inCol(si).length);
      if (si >= 0 && si < p.stages.length) { S.kbCard = inCol(si)[0].id; S.mStage = si; render(); }
    } else if (lk === 'enter') openDeal(d.id);
    else if (lk === 'w') act.won();
    else if (lk === 'l') act.lost();
    else if (lk === 'e') act.archive();
  }
  function listKeys(e, lk) {
    const rows = listRows();
    if (lk === 'j' || lk === 'arrowdown') { e.preventDefault(); S.kbRow = Math.min(rows.length - 1, S.kbRow + 1); render(); scrollRow(); }
    else if (lk === 'k' || lk === 'arrowup') { e.preventDefault(); S.kbRow = Math.max(0, S.kbRow - 1); render(); scrollRow(); }
    else if (lk === 'x' && rows[S.kbRow]) { const id = rows[S.kbRow].id; S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); render(); }
    else if (lk === 'enter' && rows[S.kbRow]) openDeal(rows[S.kbRow].id);
    else if (lk === 'e' && S.sel.size) bulkConfirm('archive');
    else if (lk === 'p' && S.sel.size) { S.overlay = 'owner'; render(); }
    else if (lk === 's' && S.sel.size) { S.overlay = 'stage'; render(); }
  }
  function scrollRow() { const r = $('.grid tr.kb'); if (r) r.scrollIntoView({ block: 'nearest' }); }

  /* ---------------- Підказки з клавішею ---------------- */
  let tipT = 0, tipEl = null;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el === tipEl) return;
    clearTimeout(tipT); $('.tip') && $('.tip').remove(); tipEl = el;
    if (!el || drag) return;
    tipT = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'tooltip');
      tip.innerHTML = esc(el.dataset.tip) + (el.dataset.key ? ' ' + el.dataset.key.split(' ').map((x) => `<span class="kbd">${esc(x)}</span>`).join('') : '');
      document.body.appendChild(tip);
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(4, Math.min(innerWidth - tw - 4, r.left + r.width / 2 - tw / 2)) + 'px';
      tip.style.top = (r.bottom + 6 + 24 > innerHeight ? r.top - 30 : r.bottom + 6) + 'px';
    }, 350);
  });

  /* ---------------- Панель прототипу ---------------- */
  const SCREENS = [['kanban', '1·2 Оболонка і канбан'], ['deal', '3 Картка угоди'], ['list', '4 Список угод'], ['roles', '5 Ролі'], ['signin', '6 Вхід з 2FA']];
  const STATES = [['normal', 'Звичайний'], ['loading', 'Завантаження'], ['empty', 'Порожньо'], ['error', 'Помилка'], ['forbidden', '403'], ['validation', 'Помилка введення'], ['toast', 'Тост'], ['confirm', 'Підтвердження'], ['drag', 'Перетягування']];
  function renderBar() {
    const b = $('#protobar');
    b.hidden = !S.bar;
    b.innerHTML = `<b>ПРОТОТИП · НАПРЯМ 4</b>
      <select aria-label="Екран" data-pb="screen">${SCREENS.map(([v, l]) => `<option value="${v}" ${S.screen === v || (v === 'kanban' && S.screen === 'dash') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select aria-label="Стан" data-pb="state">${STATES.map(([v, l]) => `<option value="${v}" ${S.state === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="seg"><button aria-pressed="${S.theme === 'dark'}" data-pb="dark">Темна</button><button aria-pressed="${S.theme === 'light'}" data-pb="light">Світла</button></span>
      <span class="seg"><button aria-pressed="${!S.w390}" data-pb="w1440">Широко</button><button aria-pressed="${S.w390}" data-pb="w390">390 px</button></span>
      <button class="btn xs ghost" data-pb="pal">${kbd('Ctrl', 'K')}</button>`;
  }
  $('#protobar').addEventListener('change', (e) => {
    const k = e.target.dataset.pb;
    if (k === 'screen') { S.screen = e.target.value; if (S.screen === 'signin') S.signinStep = 2; applyState(); }
    if (k === 'state') { S.state = e.target.value; applyState(); }
    syncUrl();
  });
  $('#protobar').addEventListener('click', (e) => {
    const k = e.target.closest('[data-pb]') && e.target.closest('[data-pb]').dataset.pb;
    if (k === 'dark' || k === 'light') setTheme(k);
    if (k === 'w390' || k === 'w1440') { S.w390 = k === 'w390'; document.body.classList.toggle('frame390', S.w390); render(); }
    if (k === 'pal') { palQ = ''; palI = 0; S.overlay = 'palette'; render(); }
    syncUrl();
  });
  function syncUrl() {
    const u = new URLSearchParams();
    u.set('screen', S.screen); if (S.state !== 'normal') u.set('state', S.state); if (S.theme !== 'dark') u.set('theme', S.theme); if (S.w390) u.set('w', '390'); if (S.proj !== 'alpi') u.set('proj', S.proj);
    history.replaceState(null, '', '?' + u.toString());
  }

  /* Стан із перемикача → що показати */
  function applyState() {
    S.dialog = null; S.overlay = null; S.toasts = [];
    const st = S.state;
    if (st === 'drag' && S.screen !== 'kanban') S.screen = 'kanban';
    if (S.screen === 'deal' && !S.dealId) S.dealId = P().demoId;
    if (st === 'confirm' && S.screen === 'list' && !S.sel.size) listRows().slice(1, 4).forEach((d) => S.sel.add(d.id));
    S.dealEnter = false;
    render();
    if (st === 'validation' && S.screen !== 'signin') {
      if (S.screen === 'deal') { const d = dealById(S.dealId); openDlg({ type: 'required', id: d.id, title: d.title, from: d.stage, to: 7, err: true }); }
      else openDlg({ type: 'newDeal', err: true });
    }
    if (st === 'toast') {
      const d = dealById(P().demoId);
      toast(`«${esc(d.title)}»: Приймає рішення → <b>${esc(P().stages[d.stage].n)}</b>`, { undo: () => {}, icon: 'arrow-right-left', sticky: true });
      toast(`Оплата <span class="mono">200 €</span> пройшла · WayForPay`, { icon: 'circle-check', sticky: true });
    }
    if (st === 'confirm') {
      if (S.screen === 'list') bulkConfirm('archive');
      else if (S.screen === 'roles') { S.roleEdits['Тімлід'] = { 'deals.d': 1 }; S.roleTab = 'Тімлід'; render(); saveRole(); }
      else if (S.screen === 'signin') { S.screen = 'kanban'; render(); S.kbCard = P().demoId; act.archive(); }
      else { S.kbCard = S.screen === 'deal' ? S.dealId : P().demoId; if (S.screen !== 'deal') S.dealId = S.kbCard; act.archive(); }
    }
  }

  /* ---------------- Старт ---------------- */
  document.documentElement.dataset.theme = S.theme;
  document.body.classList.toggle('frame390', S.w390);
  if (S.screen === 'deal') S.dealId = qs.get('deal') || P().demoId;
  if (qs.get('step') === '1') S.signinStep = 1;
  if (qs.get('palette') === '1') S.overlay = 'palette';
  applyState();
  if (qs.get('palette') === '1') { S.overlay = 'palette'; render(); }
  addEventListener('resize', () => { if (S.state === 'drag') render(); });
})();
