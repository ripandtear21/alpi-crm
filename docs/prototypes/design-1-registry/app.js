/* ПРОТОТИП · напрям 1 «Інженерний реєстр». Викидний код: без збереження, без тестів. */
(function () {
  const D = window.DATA;
  const $app = document.getElementById('app');
  const qs = new URLSearchParams(location.search);

  const S = {
    screen: qs.get('screen') || 'kanban',
    state: qs.get('state') || 'default',
    theme: qs.get('theme') || 'light',
    vp: qs.get('vp') || 'auto',
    motion: qs.get('motion') || 'on',
    bar: qs.get('bar') !== '0',
    proj: qs.get('proj') || 'alpi',
    lang: 'uk',
    mStage: 0,
    sel: new Set(),
    density: 'std',
    role: 'manager',
    tl: 'all',
    navOpen: false,
    pop: null,
    toasts: [],
    modal: null,
    queueOnly: false,
    dealAmount: 48000,
    deals: JSON.parse(JSON.stringify(D.deals)),
  };

  /* ---------- утиліти ---------- */
  const ic = (n, cls = '') => {
    const d = window.ICONS[n];
    if (!d) return '';
    return `<svg class="i ${cls}" viewBox="${d[0]}" aria-hidden="true" focusable="false">${d[1]}</svg>`;
  };
  const L = (uk, ru) => (S.lang === 'ru' ? ru : uk);
  const SYM = { UAH: '₴', EUR: '€', USD: '$' };
  const money = (n, cur = 'UAH') => Math.round(n).toLocaleString('uk-UA') + ' ' + SYM[cur];
  const sums = (o) => o ? Object.entries(o).filter(([, v]) => v > 0).map(([c, v]) => money(v, c)).join(' · ') : '';
  const approx = (o) => o ? Object.entries(o).reduce((a, [c, v]) => a + v * D.RATES[c], 0) : 0;
  const nf = (n) => n.toLocaleString('uk-UA');
  const user = (id) => D.USERS[S.proj].find((u) => u.id === id);
  const shortName = (u) => { const [f, l] = u.n.split(' '); return f + ' ' + l[0] + '.'; };
  const pipe = () => D.PIPES[S.proj];
  const deals = () => S.deals[S.proj];

  function ntHTML(t) {
    if (!t) return '';
    if (t.state === 'overdue') return `<span class="nt overdue">${ic('time')}${t.label} · прострочено</span>`;
    if (t.state === 'today') return `<span class="nt today">${ic('time')}${t.label}</span>`;
    if (t.state === 'future') return `<span class="nt future">${ic('calendar')}${t.label}</span>`;
    return `<span class="nt none">${ic('incomplete')}немає задачі</span>`;
  }
  const LZ = {
    open: () => `<span class="lz open">${ic('circle-dash')}Відкрита</span>`,
    won: () => `<span class="lz won">${ic('checkmark--outline')}Виграна</span>`,
    lost: () => `<span class="lz lost">${ic('misuse--outline')}Програна</span>`,
    arch: () => `<span class="lz arch">${ic('archive')}В архіві</span>`,
  };

  /* ---------- шапка й навігація ---------- */
  function header() {
    const pj = S.proj === 'alpi' ? 'ALPI' : 'Франч';
    return `<header class="hdr">
      <button class="hbtn hdr-menu" data-act="menu" aria-label="${L('Меню', 'Меню')}" aria-expanded="${S.navOpen}">${ic(S.navOpen ? 'close' : 'menu', 'i20')}</button>
      <div class="brand"><b>Alpi</b><span class="crm">CRM</span></div>
      <button class="proj" data-act="pop:proj" aria-haspopup="menu" aria-expanded="${S.pop?.type === 'proj'}">
        <span class="lbl">${L('Проєкт', 'Проект')}</span><span class="val">${pj}</span>${ic('chevron--down')}
      </button>
      <div class="hsearch" role="search">${ic('search')}
        <input type="search" aria-label="${L('Швидкий пошук', 'Быстрый поиск')}" placeholder="${L('Пошук: ім’я, телефон, email, угода, організація', 'Поиск: имя, телефон, email, сделка, организация')}">
      </div>
      <div class="hsp"></div>
      <button class="hbtn hsearch-btn" aria-label="Пошук">${ic('search', 'i20')}</button>
      <div class="lang" role="group" aria-label="Мова інтерфейсу">
        <button data-act="lang:uk" aria-pressed="${S.lang === 'uk'}">UK</button><button data-act="lang:ru" aria-pressed="${S.lang === 'ru'}">RU</button>
      </div>
      <button class="hbtn" data-act="pop:ntf" aria-label="${L('Сповіщення: 3 нових', 'Уведомления: 3 новых')}" aria-expanded="${S.pop?.type === 'ntf'}">${ic('notification', 'i20')}<span class="cnt">3</span></button>
      <button class="hbtn user" aria-label="Олена Коваль"><span class="avatar">ОК</span></button>
    </header>`;
  }

  function nav() {
    const cur = { kanban: 'deals', list: 'deals', deal: 'deals', roles: 'settings' }[S.screen];
    const items = [
      ['deals', 'list', L('Угоди', 'Сделки'), 'kanban'],
      ['contacts', 'user', L('Контакти', 'Контакты')],
      ['orgs', 'enterprise', L('Організації', 'Организации')],
      ['tasks', 'task', L('Задачі', 'Задачи')],
      ['cal', 'calendar', L('Календар', 'Календарь')],
      ['reports', 'chart--bar', L('Звіти', 'Отчёты')],
      ['settings', 'settings', L('Налаштування', 'Настройки'), 'roles'],
    ];
    return `<nav class="nav ${S.navOpen ? 'open' : ''}" aria-label="Розділи">
      ${items.map(([k, i, t, go]) => `<a href="#" data-act="${go ? 'go:' + go : 'noop'}" ${cur === k ? 'aria-current="page"' : ''}>${ic(i)}${t}</a>`).join('')}
      <div class="grow"></div>
      <div class="sep"></div>
      <a href="#" data-act="noop">${ic('trash-can')}${L('Кошик', 'Корзина')}</a>
      <div class="navmeta">Олена Коваль<br>${S.proj === 'alpi' ? 'Адміністратор · ALPI' : 'Керівник · Франч'}</div>
    </nav>`;
  }

  function shell(content) {
    return header() + `<div class="body">${nav()}<main id="main">${content}</main></div>`;
  }

  /* ---------- блоки станів ---------- */
  function errorBlock(what, req) {
    return `<div class="inl err" role="alert">${ic('error--filled')}<div class="body2"><b>Не вдалося завантажити ${what}.</b> Сервер не відповів за 10 с. Дані на екрані не змінювались.</div></div>
      <div class="blank"><div class="ico">${ic('warning--alt')}</div><div class="big">Дані тимчасово недоступні</div>
      <p>Спробуйте ще раз за хвилину. Якщо помилка повторюється, передайте адміністратору код запиту нижче.</p>
      <div class="code">${req}</div><button class="btn pri" data-act="retry">${ic('renew')}Спробувати ще раз</button></div>`;
  }
  function forbidden(title, text) {
    return `<div class="blank" role="alert"><div class="ico">${ic('locked')}</div><div class="big">${title}</div><p>${text}</p>
      <div class="code">403 · право відсутнє в ролі</div><button class="btn ter" data-act="go:kanban">${ic('arrow--right')}До угод</button></div>`;
  }

  /* ---------- 1–2. Канбан ---------- */
  function toolbar(view) {
    return `<div class="toolbar">
      <button class="tsel"><span class="lbl">${L('Воронка', 'Воронка')}</span>${pipe().name}${ic('chevron--down')}</button>
      <button class="tsel" data-act="go:kanban" aria-pressed="${view === 'kanban'}">${ic('data-table')}<span class="hide-m">${L('Канбан', 'Канбан')}</span></button>
      <button class="tsel" data-act="go:list" aria-pressed="${view === 'list'}">${ic('list')}<span class="hide-m">${L('Список', 'Список')}</span></button>
      <button class="tsel hide-m"><span class="lbl">Відповідальний</span>${S.state === 'empty' ? 'Ірина Лисенко' : 'усі'}${ic('chevron--down')}</button>
      <button class="tsel hide-m"><span class="lbl">Наступна задача</span>будь-яка${ic('chevron--down')}</button>
      <button class="tsel" data-act="queue" aria-pressed="${S.queueOnly}">${ic('group')}<span class="hide-m">Загальна черга</span><span class="n">4</span></button>
      <div class="sp"></div>
      <button class="btn tbar ghost plain hide-m" aria-label="Фільтри">${ic('filter')}</button>
      <button class="btn pri tbar">${L('Угода', 'Сделка')}${ic('add')}</button>
    </div>`;
  }

  function cardHTML(d) {
    const u = d.owner && user(d.owner);
    const amt = d.amount ? `<span class="amt num">${money(d.amount, d.cur)}</span>` : `<span class="amt zero">без суми</span>`;
    return `<div class="card ${d.rot ? 'rot' : ''} ${u ? '' : 'queue'}" data-id="${d.id}" tabindex="0" role="button" aria-label="${d.title}">
      <div class="ttl">${d.title}</div>
      <div class="r2"><span class="ct">${d.contact}</span>${u ? `<span class="ow">${ic('user')}${shortName(u)}</span>` : `<span class="ow">без відповідального</span>`}</div>
      <div class="r3">${ntHTML(d.task)}${amt}</div>
      ${d.rot ? `<div class="rotl">${ic('warning--alt')}без руху ${d.rot} дн.</div>` : ''}
      ${u ? '' : `<div class="q"><span class="meta">У черзі ${['12 хв', '40 хв', '2 год', '3 год'][d.num % 4]} тому</span><button class="btn sm ghost" data-act="take:${d.id}">Взяти в роботу</button></div>`}
    </div>`;
  }

  function kanban() {
    const st = S.state;
    const P = pipe();
    let head = `<div class="ph"><div><h1>${L('Угоди', 'Сделки')}</h1><div class="sub">Воронка ${P.name} · канбан</div></div></div>${toolbar('kanban')}`;
    if (st === 'error') return head + `<div style="height:16px"></div>` + errorBlock('канбан воронки', 'GET /api/deals/board?pipeline=alpi · 503 · запит 7f3a-91c2');
    if (st === '403') return head + `<div style="height:16px"></div>` + forbidden('Немає доступу до воронки', 'Ваша роль «Менеджер» не має права «Угоди: перегляд» у воронці «Платформа (допродаж)». Зверніться до адміністратора проєкту ALPI.');

    const totals = {};
    let count = 0;
    P.stages.forEach((s) => { count += s[1]; if (s[3]) Object.entries(s[3]).forEach(([c, v]) => (totals[c] = (totals[c] || 0) + v)); });
    const sum = st === 'loading' ? `<div class="kb-sum"><span class="sk t" style="width:360px;max-width:100%"></span></div>` : st === 'empty'
      ? `<div class="kb-sum"><span>Угод за фільтром: <b>0</b></span></div>`
      : `<div class="kb-sum"><span>Відкритих угод <b>${nf(count)}</b></span><span>У воронці <b>${sums(totals)}</b></span><span class="hide-m">≈ <b>${money(approx(totals))}</b> за курсом НБУ на 04.11.2026</span></div>`;

    const tabs = `<div class="stabs" role="tablist" aria-label="Етапи">${P.stages.map((s, i) =>
      `<button role="tab" data-act="stab:${i}" data-stage="${i}" aria-selected="${S.mStage === i}">${s[0]}<small>${st === 'empty' ? 0 : nf(s[1])}</small></button>`).join('')}</div>`;

    const cols = P.stages.map((s, i) => {
      let body;
      if (st === 'loading') {
        body = Array.from({ length: 3 + (i % 3) }, () => `<div class="skcard"><span class="sk t" style="width:80%"></span><span class="sk s" style="width:55%"></span><span class="sk s" style="width:30%;margin-top:auto"></span></div>`).join('');
      } else if (st === 'empty') {
        body = `<div class="colempty">Немає угод</div>`;
      } else {
        let ds = deals().filter((d) => d.stage === i && d.status === 'open');
        if (S.queueOnly) ds = ds.filter((d) => !d.owner);
        body = ds.map(cardHTML).join('') + (s[1] > ds.length && !S.queueOnly ? `<div class="col-more">${i === 0 ? `ще ${nf(s[1] - ds.length)} — <a href="#" data-act="go:list">відкрити списком</a>` : `ще ${nf(s[1] - ds.length)} · підвантажуються під час прокрутки`}</div>` : '');
      }
      const head = st === 'loading'
        ? `<div class="col-h"><div class="t"><span>${s[0]}</span></div><span class="sk s" style="width:60%"></span></div>`
        : `<div class="col-h"><div class="t"><span title="${s[0]}">${s[0]}</span><span class="c">${st === 'empty' ? 0 : nf(s[1])}</span></div>
          ${st !== 'empty' && s[3] && approx(s[3]) > 0 ? `<div class="s">${sums(s[3])}</div><div class="tot">≈ ${money(approx(s[3]))}</div>` : `<div class="s none">суми не вказано</div><div class="tot">&nbsp;</div>`}</div>`;
      return `<section class="col ${S.mStage === i ? 'm-on' : ''}" data-stage="${i}" aria-label="${s[0]}">${head}<div class="col-b">${body}</div></section>`;
    }).join('');

    const empty = st === 'empty' ? `<div class="inl info" style="margin-top:16px;margin-bottom:0">${ic('information')}<div class="body2"><b>За фільтром «Відповідальний: Ірина Лисенко» угод немає.</b> Можливо, угоди в архіві: архівні в канбані не показуються. <a href="#" data-act="retry">Скинути фільтр</a></div></div>` : '';

    return head + empty + sum + `<div class="kb-wrap">${tabs}<div class="kb" id="kb">${cols}</div></div>
      <div class="dropbar ${st === 'drag' ? 'on' : ''}" id="dropbar" aria-hidden="${st !== 'drag'}">
        <div class="dz won" data-drop="won">${ic('checkmark--outline', 'i20')}Виграна<span class="meta hide-m">· відпустіть, щоб закрити угоду</span></div>
        <div class="dz lost" data-drop="lost">${ic('misuse--outline', 'i20')}Програна<span class="meta hide-m">· потрібна причина</span></div>
      </div>`;
  }

  /* ---------- 3. Картка угоди ---------- */
  function dealModel() {
    if (S.proj === 'franch') {
      return {
        num: 3141, title: 'ТОВ «Кавова лінія» — франшиза', stage: 4, contact: 'Алексей Ветров', phone: '+380 50 000 18 62', email: 'a.vetrov@example.com',
        org: 'ТОВ «Кавова лінія»', products: [['f2', 1, 420000, 0], ['f3', 1, 36000, 36000]], cur: 'UAH', paid: 0, owner: 'sm',
      };
    }
    return {
      num: 10512, title: 'Христина Левчук — AI-контент PRO', stage: 6, contact: 'Христина Левчук', phone: '+380 67 000 41 27', email: 'kh.levchuk@example.com',
      org: '—', products: [['p2', 1, 48000, 0], ['p3', 1, 18000, 6000]], cur: 'UAH', paid: 12000, owner: 'ok',
    };
  }

  function deal() {
    const st = S.state;
    const m = dealModel();
    const P = pipe();
    const crumbs = `<div class="crumbs"><a href="#" data-act="go:kanban">Угоди</a><span>/</span><span>${P.name}</span><span>/</span><span>№ ${m.num}</span></div>`;
    if (st === 'loading') {
      return `<div class="deal"><div class="dh">${crumbs}<span class="sk t" style="width:320px;height:20px;margin:4px 0 8px"></span><span class="sk s" style="width:200px"></span>
        <div class="kv">${'<div><span class="sk s" style="width:80px"></span><span class="sk t" style="width:120px"></span></div>'.repeat(4)}</div><span class="sk" style="height:8px;margin-bottom:36px"></span></div>
        <div class="dgrid"><div>${[1, 2].map(() => `<div class="panel"><div class="panel-h"><span class="sk t" style="width:140px"></span></div><div class="panel-b">${'<span class="sk t"></span><span class="sk s" style="width:70%"></span>'.repeat(3)}</div></div>`).join('')}</div>
        <div><div class="panel"><div class="panel-h"><span class="sk t" style="width:100px"></span></div><div class="panel-b">${'<span class="sk t"></span>'.repeat(5)}</div></div></div></div></div>`;
    }
    if (st === 'error') return `<div class="ph"><div>${crumbs}<h1>Угода № ${m.num}</h1></div></div>` + errorBlock('угоду', 'GET /api/deals/10512 · 503 · запит 2c81-4e0d');
    if (st === '403') return `<div class="ph"><div>${crumbs}<h1>Угода № ${m.num}</h1></div></div>` + forbidden('Клієнт уже в роботі в іншого менеджера', 'Угода «Христина Левчук — AI-контент PRO» поза вашим охватом: відповідальний — Андрій Шевчук. Вміст угоди приховано. Щоб передати угоду вам, зверніться до тимлида.');

    const empty = st === 'empty';
    const u = user(m.owner);
    const prodRows = m.products.map(([pid, q, price, disc]) => {
      const p = D.PRODUCTS[S.proj].find((x) => x.id === pid);
      return `<tr><td>${p.name}</td><td class="num hide-m">${q}</td><td class="num hide-m">${money(price)}</td><td class="num hide-m">${disc ? '−' + money(disc) : '—'}</td><td class="num">${money(price * q - disc)}</td></tr>`;
    }).join('');
    const prodSum = m.products.reduce((a, [, q, p, d]) => a + p * q - d, 0);
    const amount = S.proj === 'alpi' ? S.dealAmount : 420000;
    const n = P.stages.length;

    const tlItems = [
      ['note', `<div class="hd"><b>Нотатка</b><span>Олена Коваль</span><span class="meta">сьогодні, 09:42</span></div><div class="bd"><div class="note">Клієнтка просить розбити доплату на дві частини. Погоджено з керівником: 18 000 ₴ до 10.11 і 18 000 ₴ до 01.12.</div></div>`, 'chat', ''],
      ['call', `<div class="hd"><b>Вихідний дзвінок</b><span>Олена Коваль → <span class="mono">${m.phone}</span></span><span class="meta">вчора, 17:05</span></div><div class="bd"><div class="player"><button class="btn icon sm" aria-label="Прослухати запис" style="width:24px">${ic('play--filled--alt')}</button><div class="bar"><i></i></div><span class="meta mono">2:06 / 6:12</span></div></div>`, 'phone', ''],
      ['pay', `<div class="hd"><b>Платіж успішний · ${money(12000)}</b><span class="meta">14.10.2026, 11:20</span></div><div class="bd ink2">WayForPay · бронювання · замовлення <span class="mono">ALPI-10512-1</span></div>`, 'receipt', 'pay'],
      ['stage', `<div class="hd"><b>Етап змінено</b><span class="meta">14.10.2026, 11:20</span></div><div class="bd"><span class="arrow">Приймає рішення ${ic('arrow--right')} <b>Сплатив бронювання</b></span><div class="meta">Зовнішня автоматизація · ключ API «n8n-оплати»</div></div>`, 'flow', 'stage'],
      ['call', `<div class="hd"><b>Пропущений вхідний</b><span class="mono">${m.phone}</span><span class="meta">13.10.2026, 20:14</span></div><div class="bd ink2">Ringostat · загальна лінія · задачу «Передзвонити» поставила автоматизація</div>`, 'phone', ''],
      ['stage', `<div class="hd"><b>Етап змінено</b><span>Олена Коваль</span><span class="meta">03.10.2026, 10:02</span></div><div class="bd"><span class="arrow">Був на вебінарі ${ic('arrow--right')} <b>Приймає рішення</b></span></div>`, 'flow', 'stage'],
      ['reg', `<div class="hd"><b>Реєстрація</b><span>вебінар «AI-контент за 7 днів»</span><span class="meta">02.10.2026, 19:04</span></div><div class="bd meta mono">utm_source=instagram · utm_campaign=ai_content_oct</div>`, 'events', ''],
    ];
    const tlMap = { all: null, note: 'note', call: 'call', pay: 'pay', stage: 'stage', reg: 'reg' };
    const shown = tlItems.filter((x) => !tlMap[S.tl] || x[0] === tlMap[S.tl]);
    const tlTabs = [['all', 'Усе', 7], ['note', 'Нотатки', 1], ['call', 'Дзвінки', 2], ['pay', 'Платежі', 1], ['stage', 'Етапи', 2], ['reg', 'Реєстрації', 1]];

    return `<div class="deal">
      <div class="dh">${crumbs}
        <div class="dh-top">
          <div style="min-width:0"><h1>${m.title}</h1>
            <div class="idrow">${LZ.open()}<span class="meta">№ ${m.num}</span><span class="meta">створена 12.09.2026 · оновлена сьогодні о 09:42</span></div></div>
          <div class="acts">
            <button class="btn ter" data-act="won">${ic('checkmark--outline', 'won-i')}Виграна</button>
            <button class="btn ter" data-act="lost">${ic('misuse--outline', 'lost-i')}Програна</button>
            <button class="btn ghost plain" data-act="archive">${ic('archive')}В архів</button>
            <button class="btn icon ghost plain" aria-label="Ще дії">${ic('overflow-menu--horizontal')}</button>
          </div>
        </div>
        <div class="kv">
          <div><span class="k">Сума угоди</span><span class="v big num">${money(amount, m.cur)}</span></div>
          <div><span class="k">Оплачено</span><span class="v big">${money(m.paid)}<span class="meta">з ${money(amount)}</span></span></div>
          <div><span class="k">Відповідальний</span><span class="v"><span class="avatar">${u.i}</span>${u.n}</span></div>
          <div><span class="k">Наступна задача</span><span class="v">${empty ? ntHTML({ state: 'none' }) : ntHTML({ state: 'today', label: 'сьогодні 16:40' })}</span></div>
        </div>
        <div class="path" aria-label="Етап воронки">
          <div class="pathcap"><span class="k">Етап ${m.stage + 1} з ${n}</span><b>${P.stages[m.stage][0]}</b><span class="meta">21 дн. на етапі · воронка ${P.name}</span></div>
          <div class="segs" style="grid-template-columns:repeat(${n},1fr)">${P.stages.map((s, i) => `<button class="seg ${i < m.stage ? 'past' : ''} ${i === m.stage ? 'cur' : ''}" data-act="stagepick:${i}" title="${s[0]}" aria-label="Етап ${i + 1}: ${s[0]}${i === m.stage ? ' (поточний)' : ''}"></button>`).join('')}</div>
          <div class="names" style="grid-template-columns:repeat(${n},1fr)">${P.stages.map((s, i) => `<span class="${i < m.stage ? 'past' : ''} ${i === m.stage ? 'cur' : ''}" title="${s[0]}">${s[0]}</span>`).join('')}</div>
        </div>
      </div>

      <div class="dgrid">
        <div>
          <section class="panel" aria-labelledby="h-next"><div class="panel-h"><h2 id="h-next">Що зробити далі</h2></div>
            ${empty ? `<div class="next"><div class="what">${ntHTML({ state: 'none' })}<span class="ink2">У відкритої угоди немає наступної задачі.</span></div><div class="sp"></div><button class="btn pri">${ic('add')}Нова задача</button></div>` :
            `<div class="next"><div class="what">${ntHTML({ state: 'today', label: 'Очікую оплату · сьогодні 16:40' })}<span>Нагадати про першу частину доплати, ${money(18000)} до 10.11</span></div><div class="sp"></div>
            <button class="btn ter">${ic('checkmark')}Виконано</button><button class="btn pri">${ic('add')}Нова задача</button></div>`}
          </section>

          <section class="panel" aria-labelledby="h-prod"><div class="panel-h"><h2 id="h-prod">Товари</h2><span class="meta">${empty ? 0 : m.products.length}</span><div class="sp"></div><button class="btn ghost">${ic('add')}Додати товар</button></div>
            ${empty ? `<div class="panel-b ink2">Товарів ще немає. Сума угоди вказана вручну.</div>` : `
            <div style="overflow-x:auto"><table class="dt"><thead><tr><th>Товар</th><th class="num hide-m">К-сть</th><th class="num hide-m">Ціна</th><th class="num hide-m">Знижка</th><th class="num">Сума</th></tr></thead><tbody>${prodRows}</tbody></table></div>
            <div class="prodsum"><span>Сума по товарах <b class="num">${money(prodSum)}</b></span><span class="ink2">Сума угоди ${money(amount)}</span>
              ${prodSum !== amount ? `<span class="diff">${ic('warning--alt')}розходиться на ${money(Math.abs(prodSum - amount))}</span><div class="sp"></div><button class="btn ter sm" data-act="substitute">Підставити в суму угоди</button>` : `<span class="diff" style="color:var(--won)">${ic('checkmark--outline')}збігається</span>`}
            </div>`}
          </section>

          <section class="panel" aria-labelledby="h-pay"><div class="panel-h"><h2 id="h-pay">Платежі</h2><span class="meta">${empty ? 0 : 2}</span><div class="sp"></div><button class="btn ghost">${ic('document')}Виставити рахунок</button></div>
            ${empty ? `<div class="panel-b ink2">Платежів немає.</div>` : `<div style="overflow-x:auto"><table class="dt"><thead><tr><th>Платіж</th><th class="num">Сума</th><th>Статус</th><th class="hide-m">Дата</th></tr></thead><tbody>
              <tr><td>Бронювання · <span class="mono">ALPI-10512-1</span></td><td class="num">${money(12000)}</td><td>${`<span class="lz won">${ic('checkmark--outline')}Сплачено</span>`}</td><td class="hide-m">14.10.2026</td></tr>
              <tr><td>Доплата 1/2 · <span class="mono">ALPI-10512-2</span></td><td class="num">${money(18000)}</td><td><span class="lz warn">${ic('time')}Очікує</span></td><td class="hide-m">до 10.11.2026</td></tr>
            </tbody></table></div>`}
          </section>

          <section class="panel" aria-labelledby="h-tl"><div class="panel-h"><h2 id="h-tl">Стрічка</h2></div>
            <div class="tl-filter" role="tablist">${tlTabs.map(([k, t, c]) => `<button role="tab" data-act="tl:${k}" aria-selected="${S.tl === k}">${t} <span class="meta">${empty ? 0 : c}</span></button>`).join('')}</div>
            <div class="composer"><label class="sr" for="note">Нотатка</label><textarea id="note" class="input" style="background:var(--bg)" placeholder="Нотатка до угоди…"></textarea><div class="row"><button class="btn ter">${ic('attachment')}Файл</button><button class="btn sec">Зберегти нотатку</button></div></div>
            ${empty ? `<div class="panel-b ink2">Подій ще немає. Тут з’являться нотатки, дзвінки, платежі, зміни етапу й реєстрації.</div>` :
            `<ol class="tl">${shown.map(([, body, icon, cls]) => `<li><span class="ic ${cls}">${ic(icon)}</span><div>${body}</div></li>`).join('')}</ol>`}
          </section>
        </div>

        <div>
          <section class="panel" aria-labelledby="h-ct"><div class="panel-h"><h2 id="h-ct">Контакт</h2><div class="sp"></div><button class="btn ghost sm">${ic('edit')}Змінити</button></div>
            <div class="panel-b">
              ${empty ? '' : `<div class="warnline">${ic('warning--alt')}<span><b>Можливий дубль.</b> Телефон збігається з контактом «Христина Левчук-Бойко», email — ні. <a href="#">Порівняти й об’єднати</a></span></div>`}
              <dl class="dl">
                <dt>Ім’я</dt><dd><a href="#">${m.contact}</a></dd>
                <dt>Телефон</dt><dd class="mono">${m.phone}</dd>
                <dt>Email</dt><dd>${m.email}</dd>
                <dt>Організація</dt><dd>${m.org}</dd>
                <dt>Учасники</dt><dd>${S.proj === 'alpi' ? 'Богдан Левчук <span class="tag">партнер</span>' : 'Марина Ветрова <span class="tag">ЛПР</span>'}</dd>
              </dl>
            </div>
          </section>
          <section class="panel" aria-labelledby="h-f"><div class="panel-h"><h2 id="h-f">Поля угоди</h2><span class="meta">Навчання</span></div>
            <div class="panel-b"><dl class="dl">
              <dt>Потік</dt><dd>№ 14 · старт 17.11.2026</dd>
              <dt>Формат</dt><dd>онлайн, з куратором</dd>
              <dt>Валюта</dt><dd>UAH</dd>
              <dt>Pipedrive</dt><dd><span class="ink2">є відкрита угода</span> <span class="mono meta">PD-48211</span></dd>
            </dl></div>
          </section>
          <section class="panel" aria-labelledby="h-reg"><div class="panel-h"><h2 id="h-reg">Реєстрації</h2><span class="meta">${empty ? 0 : 3}</span></div>
            ${empty ? `<div class="panel-b ink2">Угоду створено вручну, реєстрацій немає.</div>` : `<ol class="tl" style="padding-top:0">
              ${[
                ['02.10.2026, 19:04', 'Вебінар «AI-контент за 7 днів»', 'instagram / cpc · ai_content_oct', 'переглянула 47 хв з 92'],
                ['28.09.2026, 08:31', 'Лендинг «Безкоштовний урок»', 'facebook / cpc · lead_sep_v2', 'fbclid · сторінка /free-lesson'],
                ['11.09.2026, 22:47', 'Вебінар «Нейромережі для блогу»', 'tiktok / cpc · nn_blog', 'не прийшла на вебінар'],
              ].map(([t, w, utm, x]) => `<li><span class="ic">${ic('events')}</span><div><div class="hd"><b>${w}</b></div><div class="meta">${t}</div><div class="meta mono">${utm}</div><div class="meta">${x}</div></div></li>`).join('')}
            </ol>`}
          </section>
        </div>
      </div>
    </div>`;
  }

  /* ---------- 4. Список угод ---------- */
  const LIST_ROWS = (() => {
    const out = [];
    const names = ['Тарас Гнатюк', 'Оксана Мельничук', 'Богдана Савчук', 'Віталій Кравчук', 'Ярослава Дорош', 'Назар Петрук', 'Людмила Остапенко', 'Роман Зінченко', 'Христина Яремчук', 'Максим Гайовий', 'Софія Литвин', 'Ігор Пономар', 'Віра Климченко', 'Степан Кузьмич', 'Аліна Руденко', 'Олег Тарасюк', 'Юлія Мартинюк', 'Денис Ковтун'];
    const owners = [null, 'ok', 'as', null, 'mb', 'dt', null, 'il', 'as', 'ok', null, 'mb', 'dt', 'il', null, 'ok', 'as', 'mb'];
    const tasks = ['none', 'overdue', 'none', 'none', 'overdue', 'future', 'none', 'none', 'overdue', 'none', 'none', 'today', 'none', 'overdue', 'none', 'none', 'future', 'none'];
    names.forEach((n, i) => {
      out.push({
        id: 'L' + i, num: 9811 - i * 37, title: n + ' — реєстрація на вебінар', contact: n,
        owner: owners[i], task: { state: tasks[i], label: tasks[i] === 'today' ? 'сьогодні 15:00' : (3 + (i % 20)) + (tasks[i] === 'future' ? ' лист.' : ' жовт.') },
        created: String(2 + (i * 5) % 27).padStart(2, '0') + '.' + (i < 9 ? '08' : '09') + '.2026',
      });
    });
    return out;
  })();
  if (!qs.has('sel')) LIST_ROWS.slice(0, 6).forEach((r) => S.sel.add(r.id));

  function list() {
    const st = S.state;
    const head = `<div class="ph"><div><h1>${L('Угоди', 'Сделки')}</h1><div class="sub">Воронка ${pipe().name} · список</div></div></div>${toolbar('list')}`;
    const saved = `<div class="savedtabs" role="tablist" aria-label="Збережені фільтри">
      <button role="tab" aria-selected="false">Усі відкриті</button><button role="tab" aria-selected="false">Мої</button>
      <button role="tab" aria-selected="false">Загальна черга</button>
      <button role="tab" aria-selected="true">Новий лід старше 30 днів<span class="scope">· проєкт</span></button>
      <button role="tab" aria-selected="false">Архівні</button></div>`;
    const bad = st === 'validation';
    const filters = `<div class="filters" aria-label="Умови фільтра">
      <span class="cond"><span class="k">Етап</span><span class="op">дорівнює</span><span class="v">Новий лід</span><button aria-label="Прибрати умову">${ic('close')}</button></span>
      <span class="logic">І</span>
      <span class="cond ${bad ? 'bad' : ''}"><span class="k">Створена</span><span class="op">раніше</span><span class="v mono">${bad ? '31.13.2026' : '05.10.2026'}</span><button aria-label="Прибрати умову">${ic('close')}</button></span>
      <span class="logic">І</span>
      <span class="cond"><span class="k">Архів</span><span class="op">=</span><span class="v">ні</span><button aria-label="Прибрати умову">${ic('close')}</button></span>
      <button class="btn ghost sm">${ic('add')}Умова</button><button class="btn ghost sm hide-m">${ic('add')}Група «АБО»</button>
      <span style="flex:1"></span><button class="btn ter sm hide-m">Зберегти фільтр</button>
      ${bad ? `<div class="ferr" style="flex-basis:100%" role="alert">${ic('warning--filled')}Умова «Створена раніше»: дата 31.13.2026 не існує. Формат — ДД.ММ.РРРР, наприклад 05.10.2026.</div>` : ''}
    </div>`;
    if (st === 'error') return head + saved + filters + `<div style="height:16px"></div>` + errorBlock('список угод', 'POST /api/deals/search · 504 · запит a19e-0b77');
    if (st === '403') return head + `<div style="height:16px"></div>` + forbidden('Немає права на список угод', 'Ваша роль «Менеджер» бачить лише власну панель «На сьогодні». Список угод проєкту ALPI доступний ролям з правом «Угоди: перегляд».');

    const sel = S.sel;
    const nSel = st === 'empty' || st === 'loading' ? 0 : sel.size;
    const batch = nSel ? `<div class="batch" role="region" aria-label="Пакетні дії"><span class="n">Вибрано ${nSel} · <a href="#" data-act="selall">вибрати всі ≈ 84 120 за фільтром</a></span><span class="sp"></span>
      <button class="btn" data-act="bulkarchive">${ic('archive')}<span class="hide-m">Архівувати</span></button>
      <button class="btn hide-m">${ic('user')}Передати</button><button class="btn hide-m">${ic('flow')}Змінити етап</button>
      <button class="btn hide-m">${ic('trash-can')}Видалити</button><span class="div"></span><button class="btn" data-act="selnone">Скасувати</button></div>` : '';

    const dense = S.density === 'compact' ? 'compact' : '';
    const th = `<thead><tr><th class="chk"><input type="checkbox" class="cb" data-act="selpage" aria-label="Вибрати всі на сторінці" ${nSel === LIST_ROWS.length ? 'checked' : ''}></th>
      <th>Угода</th><th class="hide-m">Етап</th><th class="num hide-m">Сума</th><th class="hide-m">Відповідальний</th><th>Наступна задача</th><th class="hide-m"><span class="sort">Створена ${ic('chevron--down')}</span></th><th class="hide-m">Статус</th></tr></thead>`;
    let rows;
    if (st === 'loading') rows = Array.from({ length: 12 }, () => `<tr><td class="chk"><span class="sk" style="width:16px;height:16px"></span></td>${'<td><span class="sk t"></span></td>'.repeat(8)}</tr>`).join('');
    else if (st === 'empty') rows = '';
    else rows = LIST_ROWS.map((r) => {
      const u = r.owner && user(r.owner);
      return `<tr aria-selected="${sel.has(r.id)}"><td class="chk"><input type="checkbox" class="cb" data-act="sel:${r.id}" aria-label="Вибрати ${r.title}" ${sel.has(r.id) ? 'checked' : ''}></td>
        <td class="wrap-m"><a href="#" class="ttl" data-act="go:deal">${r.title}</a></td><td class="hide-m">Новий лід</td><td class="num ink2 hide-m">—</td>
        <td class="hide-m">${u ? u.n : '<span class="meta">загальна черга</span>'}</td><td>${ntHTML(r.task)}</td><td class="hide-m">${r.created}</td><td class="hide-m">${LZ.open()}</td></tr>`;
    }).join('');
    const emptyBlock = st === 'empty' ? `<div class="blank" style="max-width:none"><div class="ico">${ic('search')}</div><div class="big">Нічого не знайдено</div><p>Жодна угода не відповідає трьом умовам фільтра. Архівні угоди виключені умовою «Архів = ні».</p><button class="btn ter" data-act="retry">Скинути фільтр</button></div>` : '';

    return head + saved + filters + batch + `<div class="tbl-wrap"><table class="dt ${dense}">${th}<tbody>${rows}</tbody></table></div>` + emptyBlock +
      `<div class="tfoot"><span>${st === 'empty' ? 'Показано 0' : st === 'loading' ? 'Завантаження…' : `Показано ${LIST_ROWS.length} з ≈ 84 120`}</span><span class="sp"></span>
      <span class="hide-m">Рядки</span><span class="lang" style="margin:0;height:24px" role="group" aria-label="Щільність"><button data-act="density:std" aria-pressed="${S.density === 'std'}">32</button><button data-act="density:compact" aria-pressed="${S.density === 'compact'}">24</button></span>
      ${st === 'default' || st === 'toast' || st === 'confirm' || st === 'validation' ? '<button class="btn ghost sm">Завантажити ще</button>' : ''}</div>`;
  }

  /* ---------- 5. Налаштування → ролі ---------- */
  const RES = [
    ['Робота з клієнтами', [
      ['Угоди', [1, 1, 1, 0], 'own', 'own'], ['Контакти', [1, 1, 1, 0], 'own', 'own'], ['Організації', [1, 1, 1, 0], null, null],
      ['Задачі', [1, 1, 1, 0], 'own', 'own'], ['Платежі', [1, 0, 0, 0], 'own', null]]],
    ['Довідники', [['Товари', [1, 0, 0, 0], null, null], ['Причини програшу', [1, 0, 0, 0], null, null], ['Типи задач', [1, 0, 0, 0], null, null]]],
    ['Аналітика', [['Звіти', [0, 0, 0, 0], 'own', null]]],
    ['Адміністрування', [['Воронки й етапи', [0, 0, 0, 0], null, null], ['Поля', [0, 0, 0, 0], null, null], ['Користувачі й ролі', [0, 0, 0, 0], null, null], ['Інтеграції', [0, 0, 0, 0], null, null], ['Кошик', [0, 0, 0, 0], null, null]]],
  ];
  function roles() {
    const st = S.state;
    const crumbs = `<div class="crumbs"><span>Налаштування</span><span>/</span><span>Ролі та користувачі</span></div>`;
    const snav = `<nav class="snav" aria-label="Налаштування проєкту"><h2>ПРОЄКТ ${S.proj === 'alpi' ? 'ALPI' : 'ФРАНЧ'}</h2>
      ${['Воронки й етапи', 'Поля', 'Ролі та користувачі', 'Команди', 'Товари', 'Причини програшу', 'Типи задач', 'Інтеграції', 'Кошик'].map((t) => `<a href="#" ${t === 'Ролі та користувачі' ? 'aria-current="page"' : ''}>${t}</a>`).join('')}</nav>`;
    const head = `<div class="ph"><div>${crumbs}<h1>Ролі</h1><div class="sub">Права діють лише в проєкті ${S.proj === 'alpi' ? 'ALPI' : 'Франч'}. В іншому проєкті в тієї ж людини може бути інша роль.</div></div></div>`;
    if (st === 'error') return `<div class="settings">${snav}<div class="sbody">${head}${errorBlock('ролі', 'GET /api/roles · 500 · запит 55d0-a3f1')}</div></div>`;
    if (st === '403') return `<div class="settings">${snav}<div class="sbody">${head}${forbidden('Немає доступу до налаштувань', 'Ваша роль «Менеджер» не має права «Доступ до налаштувань проєкту». Ролі змінює адміністратор проєкту ALPI.')}</div></div>`;

    const tabs = `<div class="roletabs" role="tablist">${[['admin', 'Адміністратор', 2], ['head', 'Керівник', 1], ['lead', 'Тимлід', 3], ['manager', 'Менеджер', 11]].map(([k, t, c]) =>
      `<button role="tab" aria-selected="${S.state === 'empty' ? false : S.role === k}" data-act="role:${k}">${t}<small>${c} користувачів</small></button>`).join('')}
      ${S.state === 'empty' ? `<button role="tab" aria-selected="true">Нова роль<small>0 користувачів</small></button>` : `<button class="hide-m" style="color:var(--accent-text)">${ic('add')} Нова роль</button>`}</div>`;
    const bad = st === 'validation';
    const name = `<div class="rolename"><div class="field ${bad ? 'invalid' : ''}"><label for="rn">Назва ролі</label><input id="rn" class="input" value="${bad ? 'Адміністратор' : st === 'empty' ? '' : 'Менеджер'}" placeholder="Наприклад, «Менеджер допродажів»">
      ${bad ? `<div class="ferr" role="alert">${ic('warning--filled')}Роль «Адміністратор» уже є в проєкті ALPI. Назви ролей не повторюються.</div>` : `<div class="fhelp">Видно в списку користувачів і в журналі змін.</div>`}</div>
      <div class="field" style="width:240px"><label for="rt">Шаблон</label><div class="selwrap"><select id="rt" class="select"><option>${st === 'empty' ? 'Без шаблону' : 'Менеджер (стандартний)'}</option></select>${ic('chevron--down')}</div></div>
      <div class="field hide-m"><span class="flabel">&nbsp;</span><button class="btn ter">${ic('copy')}Копіювати роль</button></div></div>`;

    const scopeSel = (v, id) => v === null ? '<span class="na">—</span>' :
      `<div class="selwrap"><select class="select" aria-label="${id}">${[['own', 'Свої'], ['team', 'Своєї команди'], ['all', 'Усі в проєкті']].map(([k, t]) => `<option ${v === k ? 'selected' : ''}>${t}</option>`).join('')}</select>${ic('chevron--down')}</div>`;
    let body;
    if (st === 'loading') {
      body = Array.from({ length: 10 }, () => `<tr><td><span class="sk t" style="width:120px"></span></td>${'<td class="c"><span class="sk" style="width:16px;height:16px;margin:auto"></span></td>'.repeat(4)}<td class="scope"><span class="sk t"></span></td><td class="scope hide-m"><span class="sk t"></span></td></tr>`).join('');
    } else {
      body = RES.map(([g, rows]) => `<tr><th class="grp" colspan="7">${g}</th></tr>` + rows.map(([r, a, sv, se]) => {
        const changed = st !== 'empty' && (r === 'Організації' || r === 'Платежі');
        const vals = st === 'empty' ? [0, 0, 0, 0] : changed && r === 'Платежі' ? [1, 1, 0, 0] : a;
        return `<tr class="${changed ? 'changed' : ''}"><td>${r}</td>${vals.map((v, i) => `<td class="c"><input type="checkbox" class="cb" ${v ? 'checked' : ''} aria-label="${r}: ${['перегляд', 'створення', 'зміна', 'видалення'][i]}"></td>`).join('')}
          <td class="scope">${scopeSel(st === 'empty' && sv ? 'own' : sv, r + ': охват перегляду')}</td><td class="scope hide-m">${scopeSel(st === 'empty' && se ? 'own' : se, r + ': охват зміни')}</td></tr>`;
      }).join('')).join('');
    }
    const matrix = `<div class="tbl-wrap"><table class="dt mx"><thead><tr><th>Частина системи</th><th class="c">Перегляд</th><th class="c">Створення</th><th class="c">Зміна</th><th class="c">Видалення</th><th>Охват перегляду</th><th class="hide-m">Охват зміни</th></tr></thead><tbody>${body}</tbody></table></div>`;
    const extra = [['Вивантаження у файл', 'CSV зі списків і звітів', 0], ['Масові операції', 'архівувати, передати, змінити етап, видалити вибране', 0], ['Передача угод іншому', 'зміна відповідального', 0], ['Спільні фільтри', 'зберігати фільтри для команди й проєкту', 0], ['Доступ до налаштувань проєкту', 'розділ «Налаштування»', 0]];
    const extras = `<div class="ph" style="padding-top:32px;padding-bottom:12px"><div><h2 style="font-size:16px;line-height:22px;margin:0;font-weight:600">Окремі права</h2></div></div>
      <div class="tbl-wrap"><table class="dt"><tbody>${extra.map(([t, d, v]) => `<tr><td>${t} <span class="meta hide-m">· ${d}</span></td><td class="num"><label class="toggle"><input type="checkbox" ${v ? 'checked' : ''} aria-label="${t}">${v ? 'Так' : 'Ні'}</label></td></tr>`).join('')}</tbody></table></div>`;
    const save = st === 'loading' ? '' : `<div class="savebar"><span class="ink2 hide-m">${st === 'empty' ? 'Нова роль ще не збережена' : 'Змінено 2 права: «Організації: охват», «Платежі: створення»'}</span><span class="sp"></span><button class="btn sec" data-act="discard">Скасувати</button><button class="btn pri" data-act="saverole">Зберегти</button></div>`;
    return `<div class="settings">${snav}<div class="sbody">${head}${tabs}${name}${matrix}${extras}${save}<div style="height:32px"></div></div></div>`;
  }

  /* ---------- 6. Вхід з 2FA ---------- */
  function signin() {
    const st = S.state;
    const step1 = st === 'empty';
    const bad = st === 'validation';
    const loading = st === 'loading';
    let form;
    if (st === '403') {
      form = `<h1>Вхід недоступний</h1><div class="step">Обліковий запис вимкнено</div>
        <div class="inl err" style="margin:0 0 24px" role="alert">${ic('locked')}<div class="body2"><b>Обліковий запис olena.koval@alpi.example вимкнено.</b> Сесії відкликано. Увімкнути його може адміністратор проєкту.</div></div>`;
    } else if (step1) {
      form = `<h1>Вхід</h1><div class="step">Крок 1 з 2 · Email і пароль</div>
        <div class="field" style="margin-bottom:24px"><label for="em">Email</label><input id="em" class="input lg" style="background:var(--bg)" type="email" autocomplete="username" placeholder="name@alpi.example"></div>
        <div class="field"><label for="pw">Пароль</label><input id="pw" class="input lg" style="background:var(--bg)" type="password" autocomplete="current-password"></div>
        <div class="submit"><button class="btn pri" data-act="signin-next">Далі${ic('arrow--right')}</button></div>`;
    } else {
      form = `<h1>Вхід</h1><div class="step">Крок 2 з 2 · Двофакторна перевірка</div>
        <div class="who"><span class="avatar">ОК</span><span>olena.koval@alpi.example</span><span class="sp"></span><a href="#" data-act="signin-back">Змінити</a></div>
        ${st === 'error' ? `<div class="inl err" style="margin:0 0 24px" role="alert">${ic('error--filled')}<div class="body2"><b>Не вдалося перевірити код.</b> Сервер не відповідає. Код не витрачено, спробуйте ще раз.</div></div>` : ''}
        <div class="field"><label id="otpl">Код із застосунку автентифікації</label>
          <div class="otp ${bad ? 'invalid' : ''}" role="group" aria-labelledby="otpl">${['4', '8', '2', '', '9', '1', bad ? '7' : ''].map((v, i) => i === 3 ? '<span>–</span>' : `<input inputmode="numeric" maxlength="1" value="${v}" aria-label="Цифра ${i < 3 ? i + 1 : i}">`).join('')}</div>
          ${bad ? `<div class="ferr" role="alert">${ic('warning--filled')}Код не підходить. Залишилось 4 спроби, потім вхід блокується на 15 хвилин.</div>` : `<div class="fhelp">Шість цифр. Код оновлюється кожні 30 секунд.</div>`}
        </div>
        <p style="margin:24px 0 0;font-size:14px"><a href="#">Немає доступу до застосунку? Увійти кодом відновлення</a></p>
        <div class="submit"><button class="btn pri" data-act="signin-ok" ${loading ? 'aria-busy="true"' : ''}>${loading ? 'Перевіряємо код…' : 'Увійти'}${loading ? '<span class="spinner"></span>' : ic('arrow--right')}</button></div>`;
    }
    return `<div class="signin">
      <div class="side"><div class="brand"><b>Alpi</b>CRM</div>
        <div class="ledger"><span>Проєкти</span><b>ALPI · Франч</b><span>Вхід</span><b>email, пароль, код 2FA</b><span>Доступ</span><b>видає адміністратор проєкту</b><span>Підтримка</span><b>admin@alpi.example</b></div></div>
      <div class="form on-surface">${form}</div>
    </div>`;
  }

  /* ---------- спливні шари ---------- */
  function popHTML() {
    if (!S.pop) return '';
    const { type, x, y } = S.pop;
    if (type === 'proj') {
      return `<div class="pop" role="menu" style="left:${x}px;top:${y}px"><div class="ph2">Проєкт · дані не перетинаються</div>
        <button class="item" role="menuitemradio" aria-checked="${S.proj === 'alpi'}" data-act="proj:alpi"><b>ALPI</b><span class="meta">AI-школа</span></button>
        <button class="item" role="menuitemradio" aria-checked="${S.proj === 'franch'}" data-act="proj:franch"><b>Франч</b><span class="meta">франчайзинг-консалтинг</span></button></div>`;
    }
    if (type === 'ntf') {
      return `<div class="pop" role="dialog" aria-label="Сповіщення" style="right:${x}px;top:${y}px;width:360px;max-width:calc(100% - 16px)"><div class="ph2">Сповіщення · ALPI</div>
        <div class="ntf unread">${ic('time')}<span>Прострочено 3 задачі «Зв’язатися»</span><span class="meta">10 хв тому</span></div>
        <div class="ntf unread">${ic('receipt')}<span>Платіж ${money(18000)} · Христина Левчук — AI-контент PRO</span><span class="meta">32 хв тому</span></div>
        <div class="ntf unread">${ic('group')}<span>4 нові угоди в загальній черзі</span><span class="meta">1 год тому</span></div>
        <div class="ntf">${ic('phone')}<span>Пропущений дзвінок від +380 63 000 22 19</span><span class="meta">вчора, 20:14</span></div></div>`;
    }
    return '';
  }

  function modalHTML() {
    const m = S.modal;
    if (!m) return '';
    const sel = (id, label, opts, val, err) => `<div class="field ${err ? 'invalid' : ''}"><label for="${id}">${label}</label><div class="selwrap"><select id="${id}" class="select" style="background:var(--bg)">${opts.map((o) => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>${ic('chevron--down')}</div>${err ? `<div class="ferr">${ic('warning--filled')}${err}</div>` : ''}</div>`;
    const inp = (id, label, val, err, ph = '') => `<div class="field ${err ? 'invalid' : ''}"><label for="${id}">${label}</label><input id="${id}" class="input" style="background:var(--bg)" value="${val}" placeholder="${ph}">${err ? `<div class="ferr">${ic('warning--filled')}${err}</div>` : ''}</div>`;
    let lbl, h, b, cancel = 'Скасувати', ok, okCls = 'pri';
    if (m.type === 'lost') {
      lbl = m.title || 'Угода № 10441'; h = 'Позначити угоду програною';
      b = `<p>Причина обов’язкова: без неї угоду не можна закрити як програну. Угоду можна буде відкрити заново.</p>
        ${sel('lg', 'Група причин', ['АІ 2 · Після вебінару', 'АІ 1 · До вебінару', 'АІ 3 · Після броні'], 'АІ 2 · Після вебінару', m.err && null)}
        ${sel('lr', 'Причина', ['Оберіть причину', 'Дорого', 'Немає часу зараз', 'Не вірить у результат', 'Обрав інший курс'], m.err ? 'Оберіть причину' : 'Дорого', m.err ? 'Оберіть причину зі списку групи «АІ 2 · Після вебінару».' : '')}
        <div class="field"><label for="lc">Коментар · необов’язково</label><textarea id="lc" class="input" style="background:var(--bg)"></textarea></div>`;
      ok = 'Позначити програною'; okCls = 'danger';
    } else if (m.type === 'fields') {
      lbl = 'Перехід на етап «Сплатив бронювання»'; h = 'Заповніть обов’язкові поля етапу';
      b = `<p>Угода «${m.title || 'Тарас Гнатюк — AI-контент PRO'}» залишиться на етапі «Приймає рішення», доки поля нижче не заповнено.</p>
        ${inp('fa', 'Сума бронювання, ₴', '', 'Обов’язкове поле з етапу «Сплатив бронювання».', '0')}
        ${inp('fd', 'Дата оплати', '31.11.2026', 'Такої дати немає: у листопаді 30 днів.')}
        ${sel('fs', 'Потік навчання', ['№ 14 · старт 17.11.2026', '№ 15 · старт 08.12.2026'], '№ 14 · старт 17.11.2026')}`;
      ok = 'Зберегти й перемістити';
    } else if (m.type === 'archive') {
      lbl = 'Угода № 10512'; h = 'Перемістити угоду в архів?';
      b = `<p>Угода зникне з канбану й робочих списків, але залишиться в пошуку та звітах. Статус «Відкрита» не зміниться. Повернути з архіву можна в будь-який момент.</p>`;
      ok = 'В архів';
    } else if (m.type === 'bulkarchive') {
      lbl = 'Фільтр «Новий лід старше 30 днів»'; h = 'Архівувати ≈ 84 120 угод?';
      b = `<p>Операція виконується у фоні: прогрес і журнал будуть у сповіщеннях. Угоди залишаться в пошуку та звітах; нова реєстрація такої людини створить нову угоду.</p>
        <dl class="dl"><dt>Угод</dt><dd class="num" style="text-align:left">≈ 84 120</dd><dt>Умови</dt><dd>Етап = Новий лід · створена раніше 05.10.2026 · архів = ні</dd><dt>Право</dt><dd>Масові операції · є в ролі «Адміністратор»</dd></dl>`;
      ok = 'Архівувати';
    } else if (m.type === 'discard') {
      lbl = 'Роль «Менеджер»'; h = 'Скасувати незбережені зміни?';
      b = `<p>Дві зміни прав буде втрачено: «Організації: охват» і «Платежі: створення».</p>`;
      cancel = 'Залишитись'; ok = 'Скасувати зміни'; okCls = 'danger';
    }
    return `<div class="modal-scrim" data-act="modal-close-bg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mh">
      <div class="mh"><div class="lbl">${lbl}</div><h2 id="mh">${h}</h2><button class="x" data-act="modal-close" aria-label="Закрити">${ic('close', 'i20')}</button></div>
      <div class="mb">${b}</div>
      <div class="mf"><button class="btn sec" data-act="modal-close">${cancel}</button><button class="btn ${okCls}" data-act="modal-ok">${ok}</button></div></div></div>`;
  }

  function toastsHTML() {
    return `<div class="toasts" aria-live="polite">${S.toasts.map((t) => `<div class="toast" data-tid="${t.id}" role="status">${ic('checkmark--filled')}<div class="tb"><b>${t.title}</b><span class="meta">${t.text}</span>${t.link ? ` <a href="#" data-act="toast-close:${t.id}">${t.link}</a>` : ''}</div><button class="x" data-act="toast-close:${t.id}" aria-label="Закрити">${ic('close')}</button></div>`).join('')}</div>`;
  }
  let tid = 0;
  function toast(title, text, link, sticky) {
    const id = ++tid;
    S.toasts = [{ id, title, text, link }, ...S.toasts].slice(0, 3);
    paintToasts();
    if (!sticky) setTimeout(() => dismissToast(id), 5000);
  }
  function dismissToast(id) {
    const el = $app.querySelector(`.toast[data-tid="${id}"]`);
    const done = () => { S.toasts = S.toasts.filter((t) => t.id !== id); paintToasts(); };
    if (el) { el.classList.add('out'); setTimeout(done, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 110); } else done();
  }
  function paintToasts() {
    const box = $app.querySelector('.toasts');
    if (box) box.outerHTML = toastsHTML();
  }

  /* ---------- рендер ---------- */
  function applyChrome() {
    document.documentElement.dataset.theme = S.theme;
    document.documentElement.dataset.motion = S.motion;
    document.body.classList.toggle('vp390', S.vp === '390');
    document.documentElement.lang = S.lang === 'ru' ? 'ru' : 'uk';
  }

  function render() {
    applyChrome();
    let html;
    if (S.screen === 'signin') html = signin();
    else {
      const content = { kanban, deal, list, roles }[S.screen]();
      html = shell(content);
    }
    $app.innerHTML = html + popHTML() + modalHTML() + toastsHTML();
    if (S.screen === 'kanban' && S.state === 'drag') placeDragSnapshot();
    if (S.modal) $app.querySelector('.modal select, .modal input, .modal [data-act="modal-ok"]')?.focus({ preventScroll: true });
    syncBar();
  }

  /* Стан «перетягування»: статичний знімок для порівняння */
  function placeDragSnapshot() {
    requestAnimationFrame(() => {
      const narrow = $app.clientWidth <= 760;
      const srcStage = narrow ? S.mStage : 5;
      const src = $app.querySelector(`.col[data-stage="${srcStage}"] .card:not(.queue)`);
      if (!src) return;
      const target = $app.querySelector(`.col[data-stage="${srcStage + 1}"]`);
      const kb = $app.querySelector('#kb');
      if (!narrow && kb) kb.scrollLeft = $app.querySelector(`.col[data-stage="${srcStage - 1}"]`).offsetLeft - kb.offsetLeft;
      const ar = $app.getBoundingClientRect();
      const r = src.getBoundingClientRect();
      const clone = src.cloneNode(true);
      clone.classList.add('dragging');
      clone.style.width = r.width + 'px';
      if (narrow) {
        clone.style.left = (r.left - ar.left + 12) + 'px';
        clone.style.width = (r.width - 24) + 'px';
        clone.style.top = (r.top - ar.top - 64) + 'px';
        const tab = $app.querySelector(`.stabs button[data-stage="${srcStage + 1}"]`);
        if (tab) tab.style.background = 'var(--selected)';
      } else if (target) {
        const tr = target.getBoundingClientRect();
        target.classList.add('drop-target');
        clone.style.left = (tr.left - ar.left + 28) + 'px';
        clone.style.top = (tr.top - ar.top + 132) + 'px';
      }
      src.classList.add('ghost-slot');
      $app.appendChild(clone);
    });
  }

  /* ---------- справжнє перетягування ---------- */
  let drag = null;
  $app.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.card');
    if (!card || e.target.closest('button,a') || S.state === 'drag' || e.button !== 0) return;
    drag = { card, sx: e.clientX, sy: e.clientY, on: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      drag.on = true;
      const r = drag.card.getBoundingClientRect();
      drag.ox = e.clientX - r.left; drag.oy = e.clientY - r.top;
      drag.clone = drag.card.cloneNode(true);
      drag.clone.classList.add('dragging');
      drag.clone.style.width = r.width + 'px';
      $app.appendChild(drag.clone);
      drag.card.classList.add('ghost-slot');
      $app.querySelector('#dropbar')?.classList.add('on');
    }
    const ar = $app.getBoundingClientRect();
    drag.clone.style.left = (e.clientX - ar.left - drag.ox) + 'px';
    drag.clone.style.top = (e.clientY - ar.top - drag.oy) + 'px';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    $app.querySelectorAll('.drop-target,.over').forEach((x) => x.classList.remove('drop-target', 'over'));
    $app.querySelectorAll('.stabs button').forEach((b) => (b.style.background = ''));
    const dz = el && el.closest('.dz');
    const col = el && el.closest('.col');
    const tab = el && el.closest('.stabs button');
    drag.target = null;
    if (dz) { dz.classList.add('over'); drag.target = { drop: dz.dataset.drop }; }
    else if (tab) { tab.style.background = 'var(--selected)'; drag.target = { stage: +tab.dataset.stage }; }
    else if (col) { col.classList.add('drop-target'); drag.target = { stage: +col.dataset.stage }; }
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    const d0 = drag; drag = null;
    if (!d0.on) return;
    d0.clone.remove();
    const deal = deals().find((x) => x.id === d0.card.dataset.id);
    const t = d0.target;
    if (!t || (t.stage !== undefined && t.stage === deal.stage)) { render(); return; }
    if (t.drop === 'won') {
      deal.status = 'won'; render();
      toast('Угоду виграно', `«${deal.title}» закрито як виграну.`, 'Скасувати');
    } else if (t.drop === 'lost') {
      render(); S.modal = { type: 'lost', title: 'Угода № ' + deal.num, dealId: deal.id }; render();
    } else if (pipe().stages[t.stage] && (S.proj === 'alpi' && t.stage === 6)) {
      render(); S.modal = { type: 'fields', title: deal.title }; render();
    } else {
      const from = pipe().stages[deal.stage][0];
      deal.stage = t.stage; render();
      toast('Етап змінено', `«${deal.title}»: ${from} → ${pipe().stages[t.stage][0]}.`, 'Скасувати');
    }
  });

  /* ---------- дії ---------- */
  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (S.pop && !e.target.closest('.pop') && !(el && el.dataset.act.startsWith('pop:'))) { S.pop = null; render(); if (!el) return; }
    if (!el) return;
    const [act, arg] = el.dataset.act.split(/:(.*)/s);
    if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
    switch (act) {
      case 'noop': break;
      case 'go': S.screen = arg; S.state = 'default'; S.navOpen = false; S.modal = null; render(); $app.querySelector('main')?.scrollTo(0, 0); break;
      case 'menu': S.navOpen = !S.navOpen; render(); break;
      case 'pop': {
        if (S.pop?.type === arg) { S.pop = null; render(); break; }
        const ar = $app.getBoundingClientRect(), r = el.getBoundingClientRect();
        S.pop = arg === 'proj' ? { type: arg, x: Math.max(8, r.left - ar.left), y: r.bottom - ar.top } : { type: arg, x: Math.max(8, ar.right - r.right), y: r.bottom - ar.top };
        render(); break;
      }
      case 'proj': S.proj = arg; S.pop = null; S.mStage = 0; render(); toast('Проєкт змінено', arg === 'alpi' ? 'ALPI: AI-школа. Пошук, фільтри й права — лише в межах цього проєкту.' : 'Франч: франчайзинг-консалтинг. Пошук, фільтри й права — лише в межах цього проєкту.'); break;
      case 'lang': S.lang = arg; render(); break;
      case 'stab': S.mStage = +arg; render(); break;
      case 'queue': S.queueOnly = !S.queueOnly; render(); break;
      case 'take': {
        const d = deals().find((x) => x.id === arg);
        d.owner = 'ok'; d.task = { state: 'today', label: 'сьогодні 15:00', type: 'Зв’язатися' };
        render(); toast('Угоду взято в роботу', `«${d.title}»: відповідальна — Олена Коваль. Задачу «Зв’язатися» поставить автоматизація.`); break;
      }
      case 'won': S.dealStatusToast = true; toast('Угоду виграно', '«Христина Левчук — AI-контент PRO» закрито як виграну. Задачу «Допродаж» через 14 днів поставить автоматизація.', 'Відкрити заново'); break;
      case 'lost': S.modal = { type: 'lost', title: 'Угода № 10512' }; render(); break;
      case 'archive': S.modal = { type: 'archive' }; render(); break;
      case 'bulkarchive': S.modal = { type: 'bulkarchive' }; render(); break;
      case 'discard': S.modal = { type: 'discard' }; render(); break;
      case 'saverole': toast('Роль «Менеджер» збережено', 'Зміни діють з наступного запиту користувачів ролі. Запис додано в журнал.'); break;
      case 'modal-close-bg': if (e.target !== el) break; // клік поза діалогом
      // fallthrough
      case 'modal-close': S.modal = null; if (S.state === 'confirm' || S.state === 'validation') S.state = 'default'; render(); break;
      case 'modal-ok': {
        const m = S.modal;
        if (m.type === 'lost' && m.err) { m.err = false; render(); break; }
        S.modal = null; if (S.state === 'confirm' || S.state === 'validation') S.state = 'default';
        if (m.type === 'lost' && m.dealId) deals().find((x) => x.id === m.dealId).status = 'lost';
        render();
        const T = {
          lost: ['Угоду програно', 'Причина: АІ 2 · Після вебінару → Дорого.'],
          fields: ['Поля заповнено, етап змінено', 'Угода тепер на етапі «Сплатив бронювання».'],
          archive: ['Угоду переміщено в архів', 'Вона залишається в пошуку та звітах.'],
          bulkarchive: ['Архівування запущено', 'Фонова задача № 318 · ≈ 84 120 угод · прогрес у сповіщеннях.'],
          discard: ['Зміни скасовано', 'Роль «Менеджер» без змін.'],
        }[m.type];
        toast(T[0], T[1], m.type === 'archive' || m.type === 'lost' ? 'Скасувати' : null);
        break;
      }
      case 'substitute': S.dealAmount = 60000; render(); toast('Суму угоди оновлено', `${money(48000)} → ${money(60000)} за сумою товарів.`, 'Скасувати'); break;
      case 'tl': S.tl = arg; render(); break;
      case 'sel': S.sel.has(arg) ? S.sel.delete(arg) : S.sel.add(arg); render(); break;
      case 'selpage': if (S.sel.size === LIST_ROWS.length) S.sel.clear(); else LIST_ROWS.forEach((r) => S.sel.add(r.id)); render(); break;
      case 'selnone': S.sel.clear(); render(); break;
      case 'selall': LIST_ROWS.forEach((r) => S.sel.add(r.id)); render(); toast('Вибрано всі за фільтром', '≈ 84 120 угод. Дії виконуються фоновою задачею.'); break;
      case 'density': S.density = arg; render(); break;
      case 'role': S.role = arg; render(); break;
      case 'retry': S.state = 'default'; render(); break;
      case 'stagepick': toast('Етап змінено', `Угоду переміщено на етап «${pipe().stages[+arg][0]}».`, 'Скасувати'); break;
      case 'signin-next': S.state = 'default'; render(); break;
      case 'signin-back': S.state = 'empty'; render(); break;
      case 'signin-ok': S.state = 'loading'; render(); setTimeout(() => { S.screen = 'kanban'; S.state = 'default'; render(); }, 900); break;
      default: break;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (S.modal || S.pop)) { S.modal = null; S.pop = null; render(); }
    if (e.key === 'Enter' && e.target.classList.contains('card')) { S.screen = 'deal'; S.state = 'default'; render(); }
  });
  $app.addEventListener('dblclick', (e) => { if (e.target.closest('.card')) { S.screen = 'deal'; S.state = 'default'; render(); } });

  /* ---------- стани з перемикача ---------- */
  function applyState() {
    S.modal = null; S.toasts = [];
    const st = S.state;
    if (st === 'drag' && S.screen !== 'kanban') S.screen = 'kanban';
    if (st === 'toast') {
      const T = {
        kanban: ['Етап змінено', '«Тарас Гнатюк — AI-контент PRO»: Приймає рішення → Виставили рахунок.', 'Скасувати'],
        deal: ['Суму угоди оновлено', `${money(48000)} → ${money(60000)} за сумою товарів.`, 'Скасувати'],
        list: ['Архівування запущено', 'Фонова задача № 318 · ≈ 84 120 угод · прогрес у сповіщеннях.', 'Журнал'],
        roles: ['Роль «Менеджер» збережено', 'Зміни діють з наступного запиту користувачів ролі.', null],
        signin: ['Код відновлення використано', 'Залишилось 7 кодів. Нові можна створити в профілі.', null],
      }[S.screen];
      S.toasts = [{ id: ++tid, title: T[0], text: T[1], link: T[2] }];
    }
    if (st === 'confirm') S.modal = { kanban: { type: 'lost', title: 'Угода № 10441' }, deal: { type: 'archive' }, list: { type: 'bulkarchive' }, roles: { type: 'discard' } }[S.screen] || null;
    if (st === 'validation' && (S.screen === 'kanban' || S.screen === 'deal')) S.modal = { type: 'fields' };
  }

  /* ---------- панель прототипу ---------- */
  const bar = document.getElementById('protobar');
  function syncBar() {
    bar.querySelector('#pb-screen').value = S.screen;
    bar.querySelector('#pb-state').value = S.state;
    bar.querySelectorAll('[data-theme-btn]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.themeBtn === S.theme));
    bar.querySelectorAll('[data-vp]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.vp === S.vp));
    bar.querySelector('#pb-motion').setAttribute('aria-pressed', S.motion === 'off');
    const p = new URLSearchParams({ screen: S.screen, state: S.state, theme: S.theme, vp: S.vp });
    if (S.proj !== 'alpi') p.set('proj', S.proj);
    history.replaceState(null, '', '?' + p);
  }
  bar.addEventListener('change', (e) => {
    if (e.target.id === 'pb-screen') { S.screen = e.target.value; if (S.state === 'drag' && S.screen !== 'kanban') S.state = 'default'; }
    if (e.target.id === 'pb-state') S.state = e.target.value;
    S.pop = null; applyState(); render();
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.themeBtn) S.theme = b.dataset.themeBtn;
    if (b.dataset.vp) S.vp = b.dataset.vp;
    if (b.id === 'pb-motion') S.motion = S.motion === 'off' ? 'on' : 'off';
    if (b.id === 'pb-min') { bar.classList.toggle('min'); b.textContent = bar.classList.contains('min') ? 'Панель ▴' : '▾'; return; }
    render();
  });
  if (!S.bar) bar.style.display = 'none';

  applyState();
  render();
})();
