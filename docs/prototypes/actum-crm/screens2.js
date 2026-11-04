/* ПРОТОТИП — throwaway. Экраны, часть 2: задачи и календарь, «Сьогодні», отчёт, настройки проекта. */
'use strict';

/* ================= TASKS ================= */
const TASKS = {
  overdue: [['Дізнатись рішення', 'дзвінок', 'Дарина Лук’яненко', 'прострочено 4 дні', 'ok'], ['Нагадати про бронь', 'месенджер', 'Тетяна Гнатюк', 'прострочено 2 дні', 'ok'], ['Передзвонити', 'дзвінок', 'Олег Бойко', 'прострочено 1 день', 'ok']],
  today: [['Дізнатись рішення', 'дзвінок', 'Ірина Мельник — AI-контент PRO', '12:00', 'ok'], ['Консультація після вебінару', 'консультація', 'Максим Бойко', '14:00', 'ok'], ['Дожим: залишок 490 €', 'оплата', 'Наталія Шевченко', '16:30', 'ok'], ['Зв’язатися з новими з вебінару', 'дзвінок', '12 угод', 'на день', 'ok'], ['Надіслати запис вебінару', 'месенджер', 'Людмила Харченко', 'на день', 'ok']],
  future: [['Очікую оплату: рахунок 590 €', 'оплата', 'Ірина Мельник — AI-контент PRO', '06.11', 'ok'], ['Друга консультація', 'консультація', 'Віктор Мельничук', '07.11 11:00', 'ok'], ['Повернутися після відпустки', 'дзвінок', 'Денис Литвиненко', '01.12', 'ok']],
};
const taskRow = (t, tone, done) => `<div class="task-row ${done ? 'done' : ''}"><input type="checkbox" class="cb" aria-label="Виконано: ${t[0]}" ${done ? 'checked' : ''} data-change="tdone"><div style="display:grid;gap:2px;min-width:0"><span class="ttl">${t[0]}</span><span class="ml meta"><span>${t[1]}</span><a href="#/deal/default">${t[2]}</a><span>Олена Коваль</span></span></div>${st(tone, t[3])}</div>`;
const tasksHead = (s) => `${ph('Задачі', { meta: '<span>середа, 4 листопада</span><span>виконавець: Олена Коваль</span>', actions: `<div class="tabs bare" role="tablist">${[['list', 'Список'], ['day', 'День'], ['week', 'Тиждень']].map(([k, l]) => `<a class="tab" href="#/tasks/${k}" ${(s === k || (k === 'list' && !['day', 'week'].includes(s))) ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</div><button class="btn primary sm" data-act="new-task">${ic('plus', 14)}Задача</button>` })}
  <div class="toolbar"><select class="select sm" style="width:auto" aria-label="Виконавець"><option>Я</option><option>Команда Лисенко</option></select>${['дзвінок', 'консультація', 'оплата', 'месенджер'].map((t) => `<button class="fchip nox" aria-pressed="false">${t}</button>`).join('')}</div>`;
const HOURS = Array.from({ length: 13 }, (_, i) => 8 + i);
function calendar(days) {
  const dnames = days === 1 ? [['ср', '04.11', 1]] : [['пн', '02.11'], ['вт', '03.11'], ['ср', '04.11', 1], ['чт', '05.11'], ['пт', '06.11'], ['сб', '07.11'], ['нд', '08.11']];
  const ev = { '04.11': [[12, 1, 'Дізнатись рішення', 'Ірина Мельник'], [14, 1, 'Консультація', 'Максим Бойко'], [16.5, .75, 'Дожим: залишок 490 €', 'Наталія Шевченко'], [9.25, .5, 'Дзвінок', 'Олег Бойко', 'done']], '02.11': [[10, 1, 'Консультація', 'Роман Ковальчук', 'done'], [15, .5, 'Дзвінок', 'Ганна Руденко', 'done']], '03.11': [[11, 1.5, 'Розбір вебінару', 'команда'], [17, .5, 'Нагадати про бронь', 'Тетяна Гнатюк', 'overdue']], '05.11': [[10, 1, 'Друга консультація', 'Злата Петренко'], [13, .5, 'Дзвінок', 'Степан Іваненко']], '06.11': [[11, .5, 'Очікую оплату', 'Ірина Мельник']], '07.11': [[11, 1, 'Друга консультація', 'Віктор Мельничук']] };
  const allday = { '04.11': ['Зв’язатися з новими (12)', 'Надіслати запис'], '03.11': ['Передзвонити: Олег Бойко'], '06.11': ['Вебінар «AI-відео» 19:00'] };
  return `<section class="panel" aria-label="Календар"><div class="cal" style="--days:${days}">
    <div style="border-bottom:1px solid var(--line)"></div>${dnames.map(([d, dt, t], i) => `<div class="dh ${t ? 'today' : ''} ${!t && days > 1 ? 'wk-extra' : ''}"><span class="meta">${d} <b>${dt}</b></span>${t ? '<span class="meta-prose acc">сьогодні</span>' : ''}</div>`).join('')}
    <div class="meta" style="border-bottom:1px solid var(--line);padding:8px 8px 0 0;text-align:right">на день</div>${dnames.map(([, dt, t]) => `<div class="allday ${!t && days > 1 ? 'wk-extra' : ''}">${(allday[dt] || []).map((x) => `<span class="chipev">${x}</span>`).join('')}</div>`).join('')}
    <div>${HOURS.map((h) => `<div class="hr meta">${String(h).padStart(2, '0')}:00</div>`).join('')}</div>
    ${dnames.map(([, dt, t]) => `<div class="dcol ${t ? 'today' : ''} ${!t && days > 1 ? 'wk-extra' : ''}" style="height:${HOURS.length * 48}px">${t ? `<div class="nowline" style="top:${(11.7 - 8) * 48}px" aria-label="Зараз 11:42"></div>` : ''}${(ev[dt] || []).map(([h, d, a, b, x]) => `<div class="ev ${x || ''} ${d < 1 ? 'short' : ''}" style="top:${(h - 8) * 48 + 2}px;height:${d * 48 - 4}px" tabindex="0"><b style="font-weight:500" class="ellip">${a}</b>${d >= 1 ? `<span class="meta ellip">${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? String(Math.round(h % 1 * 60)).padStart(2, '0') : '00'} ${b}</span>` : ''}</div>`).join('')}</div>`).join('')}
  </div></section>`;
}
def('tasks', {
  title: 'Задачі й календар', group: '5. Задачі', what: 'задачі',
  states: [['list', 'Список'], ['day', 'День'], ['week', 'Тиждень'], ['done-next', 'Виконано: наступна?'], ['empty', 'Порожньо'], ['loading', 'Завантаження'], ['error', 'Помилка'], ['offline', 'Офлайн']],
  render(s) {
    const head = tasksHead(s);
    if (s === 'day') return head + calendar(1);
    if (s === 'week') return head + calendar(7);
    if (s === 'empty') return head + emptyBox('Задач немає.', 'На сьогодні все виконано. Нові задачі з’являться, коли їх поставите ви, тімлід або автоматизація.', `<button class="btn ghost sm" data-act="new-task">${ic('plus', 14)}Задача</button>`);
    if (s === 'loading') return head + `<section class="panel" aria-busy="true">${skRows(7, 80)}</section>`;
    if (s === 'error') return head + generic('error', 'задачі');
    const grp = (title, n, tone, list, firstDone) => `<div class="grp-h"><span class="h2" style="font-size:15px">${title}</span><span class="meta${tone === 'overdue' ? ' ask' : ''}">${n}</span></div>${list.map((t, i) => taskRow(t, tone === 'today' && /:/.test(t[3]) ? 'today' : tone === 'today' ? 'today' : tone, firstDone && i === 0)).join('')}`;
    const dn = s === 'done-next';
    return `${head}<section class="panel" aria-label="Список задач">${grp('Прострочені', 3, 'overdue', TASKS.overdue)}${grp('Сьогодні', 5, 'today', TASKS.today, dn)}${dn ? `<div style="padding:0 18px 14px"><div class="strip"><p>«Дізнатись рішення» виконано. Запланувати наступну задачу по угоді «Ірина Мельник — AI-контент PRO»?</p><div class="actions"><button class="btn primary sm" data-act="new-task">Запланувати</button><button class="btn quiet sm" data-act="go" data-to="tasks" data-st="list">Ні, дякую</button></div></div></div>` : ''}${grp('Пізніше', 3, 'future', TASKS.future)}</section>`;
  },
});
ACT.tdone = (cb) => { const row = cb.closest('.task-row'); row.classList.toggle('done', cb.checked); if (cb.checked) { $$('.strip').forEach((x) => x.remove()); row.insertAdjacentHTML('afterend', `<div style="padding:0 18px 14px"><div class="strip"><p>Задачу виконано. Запланувати наступну по цій угоді?</p><div class="actions"><button class="btn primary sm" data-act="new-task">Запланувати</button><button class="btn quiet sm" onclick="this.closest('.strip').parentElement.remove()">Ні, дякую</button></div></div></div>`); } };

/* ================= DASHBOARD ================= */
def('dashboard', {
  title: 'Сьогодні (панель менеджера)', group: '6. Аналітика', what: 'панель',
  states: [['default', 'Звичайний'], ['empty', 'Все виконано'], ['loading', 'Завантаження'], ['error', 'Помилка']],
  render(s) {
    const head = ph('Сьогодні', { meta: '<span>середа, 4 листопада</span><span>оновлено 11:42</span>', lead: 'Ваші задачі, прострочене й нові угоди в загальній черзі проєкту ALPI.' });
    if (s === 'loading') return `${head}<section class="panel" aria-busy="true"><div class="tiles">${Array.from({ length: 4 }, () => '<div class="tile"><span class="sk" style="font-size:13px"><span class="bar" style="--w:60%"></span></span><span class="sk" style="font-size:34px"><span class="bar" style="--w:40%"></span></span></div>').join('')}</div></section><div class="split" style="margin-top:20px">${generic('loading')}${generic('loading')}</div>`;
    if (s === 'error') return head + generic('error', 'панель');
    const e = s === 'empty';
    const tiles = [['задач на сьогодні', e ? 0 : 7, e ? 'усе виконано' : '2 з часом до 14:00'], ['прострочені', e ? 0 : 3, e ? 'немає' : 'найстаріша 4 дні', e ? '' : 'ask'], ['нові в загальній черзі', 48, '+12 за ранок'], ['мої відкриті угоди', 64, '≈ 1 212 400 ₴']];
    return `${head}<section class="panel" aria-label="Підсумки"><div class="tiles">${tiles.map(([l, v, d, t], i) => `<div class="tile rise" style="--i:${i}"><span class="meta">${l}</span><span class="v ${t || ''}">${v}</span><span class="meta d">${d}</span></div>`).join('')}</div></section>
      <div class="split" style="margin-top:20px"><div class="col">
        ${e ? emptyBox('На сьогодні все.', 'Задачі на сьогодні виконані, прострочених немає. Можна взяти угоди із загальної черги.') : `<section class="panel" aria-label="Задачі на сьогодні"><div class="sh"><h2 class="h2">Задачі на сьогодні</h2><a class="link-a" href="#/tasks/list" style="font-size:13px">Усі задачі</a></div>${TASKS.overdue.slice(0, 2).map((t) => taskRow(t, 'overdue')).join('')}${TASKS.today.map((t) => taskRow(t, 'today')).join('')}</section>`}
      </div><div class="col">
        <section class="panel" aria-label="Загальна черга"><div class="sh"><h2 class="h2">Загальна черга</h2><div class="ml meta"><span>Новий лід, без відповідального</span></div></div>${CARDS.s1.slice(0, 4).map((c) => `<div class="line-item"><div style="min-width:0"><div class="ellip">${c.t}</div><div class="ml meta"><span>№ ${c.id}</span><span>${c.src}</span><span>сьогодні</span></div></div><button class="btn pill" data-act="take-q">Взяти</button></div>`).join('')}<div class="line-item" style="background:var(--raised)"><span class="meta">ще 44</span><a class="link-a" href="#/kanban/default" style="font-size:13px">Відкрити воронку</a></div></section>
        <section class="panel" aria-label="Мої оплати"><div class="sh"><h2 class="h2">Мої оплати</h2><div class="ml meta"><span>14 днів</span><span>≈ 186 300 ₴</span></div></div><div class="sb"><div class="spark" role="img" aria-label="Оплати по днях за 14 днів, найбільше 03.11: 48 100 ₴">${[12, 0, 30, 8, 22, 0, 0, 18, 40, 9, 26, 0, 100, 34].map((v, i) => `<i style="height:${Math.max(v, 3)}%" class="${[5, 6, 11].includes(i) ? 'wk' : ''}" title="${v ? fmt(v * 481) + ' ₴' : 'немає'}"></i>`).join('')}</div><div class="kv"><span class="meta">22.10</span><span class="meta">04.11</span></div></div></section>
      </div></div>`;
  },
});
ACT['take-q'] = (b) => { const li = b.closest('.line-item'); li.style.animation = 'fresh 1.2s var(--ease) both'; b.outerHTML = '<span class="meta">ваша</span>'; toast('Угоду взято в роботу.'); };

/* ================= REPORT ================= */
const FUNNEL = [['Новий лід', 2418, 0, '0,4'], ['Передано в роботу', 1209, 50, '1,2'], ['Був на вебінарі', 702, 58.1, '2,8'], ['Дивиться запис вебінару', 214, 30.5, '3,1'], ['Приймає рішення', 168, 78.5, '4,6'], ['Сплатив бронювання', 80, 47.6, '6,2'], ['Виставили рахунок', 66, 82.5, '3,9'], ['Виграно', 61, 92.4, '—']];
def('reports', {
  title: 'Звіт «Воронка»', group: '6. Аналітика', what: 'звіти',
  states: [['default', 'Звичайний'], ['table', 'Таблиця'], ['empty', 'Немає даних'], ['loading', 'Завантаження'], ['forbidden', 'Немає права'], ['error', 'Помилка']],
  render(s) {
    const head = `${ph('Звіти', { meta: '<span>проєкт ALPI</span><span>суми в ₴ за курсом НБУ на дату закриття</span>', actions: `<button class="btn ghost sm" disabled title="Немає права «Вивантаження у файл»">${ic('down', 14)}CSV</button>` })}
      <div class="tabs bare" style="margin-bottom:12px" role="tablist">${['Воронка', 'Менеджери', 'Джерела й реклама', 'Вебінари', 'Гроші', 'Допродажі', 'Причини програшу'].map((t, i) => `<button class="tab" role="tab" aria-selected="${i === 0}">${t}</button>`).join('')}</div>
      <div class="toolbar"><select class="select sm" style="width:auto" aria-label="Період"><option>01.10.2026 – 31.10.2026</option></select><select class="select sm" style="width:auto" aria-label="Воронка"><option>ALPI</option></select><select class="select sm" style="width:auto" aria-label="Команда"><option>Усі команди</option></select><select class="select sm" style="width:auto" aria-label="Джерело"><option>Джерело: перша реєстрація</option><option>Джерело: остання реєстрація</option></select><span class="sp"></span><div class="track"><div class="options"><button class="option" aria-pressed="true">у ₴</button><button class="option" aria-pressed="false">у валюті угоди</button></div></div></div>`;
    if (s === 'forbidden') return `${ph('Звіти')}${generic('forbidden', 'звіти. Для менеджера є панель «Сьогодні»')}`;
    if (s === 'loading') return `${head}<section class="panel" aria-busy="true"><div class="tiles">${Array.from({ length: 4 }, () => '<div class="tile"><span class="sk" style="font-size:34px"><span class="bar" style="--w:50%"></span></span></div>').join('')}</div></section><section class="panel" style="margin-top:20px" aria-busy="true"><div class="sb">${FUNNEL.map((_, i) => `<span class="sk" style="font-size:22px"><span class="bar" style="--w:${92 - i * 11}%"></span></span>`).join('')}</div></section>`;
    if (s === 'empty') return head + emptyBox('За жовтень угод у воронці немає.', 'Можливо, вибрано не ту воронку або період. Звіт будується з історії зміни етапів.');
    if (s === 'error') return head + generic('error', 'звіт');
    const max = FUNNEL[0][1];
    const chart = s === 'table'
      ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Етап</th><th class="r">Угод</th><th class="r">Конверсія з попереднього</th><th class="r">Сер. днів на етапі</th></tr></thead><tbody>${FUNNEL.map(([n, v, c, d]) => `<tr><td>${n}</td><td class="r num">${fmt(v)}</td><td class="r num">${c ? String(c).replace('.', ',') + ' %' : '—'}</td><td class="r num">${d}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="funnel" role="img" aria-label="Воронка за жовтень: від 2 418 нових угод до 61 виграної">${FUNNEL.map(([n, v, c, d], i) => `<div class="frow"><span class="lbl ellip">${n}</span><div class="track2"><div class="fill" style="--w:${Math.max(v / max * 100, .8)}%;--i:${i}"></div></div><span class="meta" style="text-align:right"><b>${fmt(v)}</b></span><span class="meta conv">${c ? String(c).replace('.', ',') + ' %' : ''}</span><span class="tip" style="--w:${v / max * 100}%">${n}: ${fmt(v)} угод, ${d} дн. на етапі</span></div>`).join('')}</div>`;
    return `${head}<section class="panel" aria-label="Підсумки"><div class="tiles">${[['нових угод', '2 418', '+8 % до вересня'], ['конверсія в бронь', '3,3 %', '80 з 2 418'], ['виграно', '61', 'сер. цикл 11 днів'], ['сума оплат', '2 954 300 ₴', 'брони й доплати']].map(([l, v, d], i) => `<div class="tile rise" style="--i:${i}"><span class="meta">${l}</span><span class="v" style="${i === 3 ? 'font-size:26px' : ''}">${v}</span><span class="meta d">${d}</span></div>`).join('')}</div></section>
      <section class="panel" style="margin-top:20px" aria-labelledby="fr-t"><div class="sh"><h2 class="h2" id="fr-t">Воронка за жовтень</h2><div class="ml meta"><span>угод, що дійшли до етапу</span><span>конверсія з попереднього</span><a class="link-a" href="#/reports/${s === 'table' ? 'default' : 'table'}" style="font-size:13px">${s === 'table' ? 'Графік' : 'Таблиця'}</a></div></div>${chart}</section>`;
  },
});

/* ================= SETTINGS ================= */
const RES = ['Угоди', 'Контакти', 'Організації', 'Задачі', 'Платежі', 'Товари', 'Звіти', 'Воронки й етапи', 'Поля', 'Користувачі й ролі', 'Інтеграції', 'Кошик'];
const SCOPED = ['Угоди', 'Контакти', 'Задачі', 'Платежі'];
const ROLE_M = { // view create edit delete
  'Менеджер': { 'Угоди': [1, 1, 1, 0], 'Контакти': [1, 1, 1, 0], 'Організації': [1, 1, 1, 0], 'Задачі': [1, 1, 1, 0], 'Платежі': [1, 1, 1, 0], 'Товари': [1, 0, 0, 0], 'Звіти': [0, 0, 0, 0], 'Воронки й етапи': [0, 0, 0, 0], 'Поля': [0, 0, 0, 0], 'Користувачі й ролі': [0, 0, 0, 0], 'Інтеграції': [0, 0, 0, 0], 'Кошик': [0, 0, 0, 0] },
};
function rolesPage(s) {
  const admin = s === 'admin', dirty = s === 'dirty';
  const role = admin ? 'Адміністратор' : 'Менеджер';
  const m = (r) => (admin ? [1, 1, 1, 1] : ROLE_M['Менеджер'][r]);
  const cb = (on, label, dis) => `<input type="checkbox" class="cb" aria-label="${label}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}>`;
  const scope = (r, k, v) => SCOPED.includes(r) ? `<select class="select sm" aria-label="${r}: охоплення ${k}" ${admin ? 'disabled' : ''}>${['свої', 'своєї команди', 'усі в проєкті'].map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>` : '<span class="meta">—</span>';
  return `${ph('Ролі і права', { meta: '<span>проєкт ALPI</span><span>права діють тільки в цьому проєкті</span>', actions: `<button class="btn ghost sm">Копіювати роль</button><button class="btn primary sm">${ic('plus', 14)}Нова роль</button>` })}
  <section class="panel" aria-label="Роль ${role}">
    <div class="tabs" role="tablist">${[['Адміністратор', 1], ['Керівник', 2], ['Тімлід', 2], ['Менеджер', 5], ['Маркетолог', 1], ['Автоматизація', '2 ключі']].map(([n, c]) => `<a class="tab" role="tab" href="#/roles/${n === 'Адміністратор' ? 'admin' : 'default'}" aria-selected="${n === role}">${n}<span class="count">${c}</span></a>`).join('')}</div>
    <div class="sb" style="gap:14px">
      ${admin ? `<div class="notice calm">${ic('lock')}<span class="grow">Роль «Адміністратор» не змінюється й не урізається: у проєкті завжди є хоча б один адміністратор. Можна скопіювати її в нову роль.</span></div>` : `<div class="ml meta"><span>шаблон <b>Менеджер</b></span><span>5 користувачів</span><span>змінено 28.10.2026, Тарас Левченко</span></div>`}
    </div>
    <div class="tbl-wrap"><table class="tbl matrix"><thead><tr><th>Частина системи</th><th class="cb-cell">Перегляд</th><th class="cb-cell">Створення</th><th class="cb-cell">Зміна</th><th class="cb-cell">Видалення</th><th>Охоплення: бачить</th><th>Охоплення: змінює</th></tr></thead>
    <tbody>${RES.map((r) => { const v = m(r); const dr = dirty && r === 'Угоди'; return `<tr ${dr ? 'aria-selected="true"' : ''}><td>${r}</td>${['перегляд', 'створення', 'зміна', 'видалення'].map((k, i) => `<td>${cb(dr && i === 3 ? 1 : v[i], `${r}: ${k}`, admin)}</td>`).join('')}<td>${scope(r, 'перегляду', admin ? 'усі в проєкті' : r === 'Задачі' ? 'своєї команди' : 'свої')}</td><td>${scope(r, 'зміни', admin ? 'усі в проєкті' : 'свої')}</td></tr>`; }).join('')}</tbody></table></div>
  </section>
  <div class="split even" style="margin-top:20px">
    ${sec('Окремі права', [['Вивантаження у файл', 0], ['Масові операції', 0], ['Передача угод іншому', 0], ['Доступ до налаштувань проєкту', 0], ['Спільні фільтри для команди й проєкту', 0]].map(([t, on]) => `<label class="check"><input type="checkbox" ${admin || on ? 'checked' : ''} ${admin ? 'disabled' : ''}><span>${t}</span></label>`).join(''))}
    ${sec('Групи полів', `<div class="tbl-wrap"><table class="tbl"><tbody>${[['Кваліфікація', 'видно й можна змінювати'], ['Вебінар', 'видно й можна змінювати'], ['Закриття', 'видно й можна змінювати'], ['Службове', 'тільки перегляд']].map(([g, v]) => `<tr><td style="padding-left:0">${g}</td><td style="padding-right:0" class="r"><select class="select sm" aria-label="${g}" ${admin ? 'disabled' : ''}>${['видно й можна змінювати', 'тільки перегляд', 'приховано'].map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>`, { flush: false })}
  </div>
  ${dirty ? `<div class="savebar" role="region" aria-label="Незбережені зміни"><span class="grow">Незбережені зміни: <b style="font-weight:500">Угоди → видалення</b>. Менеджери зможуть видаляти свої угоди.</span><button class="btn quiet sm" data-act="go" data-to="roles" data-st="default">Скасувати</button><button class="btn primary sm" data-act="go" data-to="roles" data-st="saved">Зберегти роль</button></div>` : ''}`;
}
def('roles', {
  title: 'Ролі й матриця прав', group: '7. Налаштування', what: 'налаштування ролей',
  states: [['default', 'Менеджер'], ['admin', 'Адміністратор (тільки читання)'], ['dirty', 'Незбережено'], ['saved', 'Збережено'], ['loading', 'Завантаження'], ['forbidden', 'Немає доступу']],
  toast: 'Роль «Менеджер» збережено. Права оновляться в користувачів за хвилину.',
  render(s) { if (s === 'loading' || s === 'forbidden') return null; return rolesPage(s === 'saved' ? 'default' : s); },
  after(s) { if (s === 'saved') toast(SCREENS.roles.toast); $$('.matrix input, .matrix select').forEach((el) => el.addEventListener('change', () => { if (!$('.savebar')) go('roles', 'dirty'); })); },
});

/* users */
function usersPage() {
  const rows = Object.values(USERS).map((u) => `<tr><td><div style="display:grid;gap:1px"><span class="t1" style="font-weight:500">${u.n}</span><span class="meta">${u.email}</span></div></td><td>${u.role}</td><td class="ink2">${u.team}</td><td>${u.st === 'ok' ? st('ok', 'активний') : u.st === 'pending' ? st('wait', 'чекає першого входу') : st('muted', 'вимкнений')}</td><td class="meta">${u.last}</td><td class="r"><button class="btn quiet sm" ${u.st === 'off' ? 'disabled' : ''} data-act="u-off" data-n="${u.n}">${u.st === 'off' ? 'Вимкнений' : 'Вимкнути'}</button></td></tr>`).join('');
  return `${ph('Користувачі', { meta: '<span>проєкт ALPI</span><span>9 облікових записів</span>', actions: `<button class="btn primary sm" data-act="u-new">${ic('plus', 14)}Додати користувача</button>` })}
    <div class="toolbar"><input class="input sm" style="max-width:260px" placeholder="Ім’я або email" aria-label="Пошук користувача"><select class="select sm" style="width:auto" aria-label="Роль"><option>Усі ролі</option></select><select class="select sm" style="width:auto" aria-label="Стан"><option>Усі стани</option></select></div>
    <section class="panel" aria-label="Користувачі"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Користувач</th><th>Роль</th><th>Команда</th><th>Стан</th><th>Остання активність</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function userForm(err) {
  return `${dlgHead('Новий користувач', 'Обліковий запис один на всю CRM. Роль і команда задаються для проєкту ALPI.')}<form class="dlg-b" novalidate>
    <div class="grid2">${field('un', 'Ім’я та прізвище', inp('un', err ? '' : 'Назар Остапчук', { err }), { err: err ? 'Вкажіть ім’я.' : '' })}${field('ue', 'Email', inp('ue', 'mariia.bondar@example.com', { type: 'email', err }), { err: err ? 'Користувач з таким email уже є: Марія Бондар.' : '' })}</div>
    <div class="grid2">${field('ur', 'Роль', sel('ur', ['Менеджер', 'Тімлід', 'Керівник', 'Маркетолог', 'Адміністратор'], 'Менеджер'))}${field('ut', 'Команда', sel('ut', ['Команда Ткача', 'Команда Лисенко', 'Без команди'], 'Команда Ткача'))}</div>
    <label class="check"><input type="checkbox" checked><span>Приймає нові угоди<span class="hint">Позначка для вашої автоматизації розподілу. CRM сама угоди не роздає.</span></span></label>
    <p class="meta-prose">Після створення покажемо тимчасовий пароль один раз. Під час першого входу система попросить змінити його й увімкнути двофакторний вхід.</p></form>
    <div class="dlg-f">${err ? '<p class="error err-line" role="alert">Перевірте поля у формі.</p>' : ''}<button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="u-create">Створити</button></div>`;
}
const userCreated = () => `${dlgHead('Користувача створено')}<div class="dlg-b"><div class="secret"><p class="secret-title">Тимчасовий пароль для Назара Остапчука</p>
  <div class="copy-row"><input class="input mono" readonly value="mK4q-tR9p-x2Lw-8vNe" aria-label="Тимчасовий пароль"><button class="btn ghost sm" data-act="copy">${ic('copy', 14)}Скопіювати</button></div>
  <p class="ink2" style="font-size:14px">Показуємо один раз: після закриття вікна побачити його вже не можна, тільки створити новий. Передайте пароль окремо від листа з email, наприклад голосом.</p></div>
  <dl class="facts tight"><dt class="meta">email</dt><dd>nazar.ostapchuk@example.com</dd><dt class="meta">роль</dt><dd>Менеджер</dd><dt class="meta">команда</dt><dd>Команда Ткача</dd><dt class="meta">діє до</dt><dd class="num">11.11.2026</dd></dl></div>
  <div class="dlg-f"><button class="btn primary sm" data-close>Я передав пароль</button></div>`;
const userOff = (n = 'Віктор Кравець') => `${dlgHead(`Вимкнути: ${n}?`, 'Вимкнений не зможе увійти, його сесії завершаться одразу. В історії він залишиться.')}<form class="dlg-b" novalidate>
  <div class="notice"><span class="grow">У користувача <b style="font-weight:500">17 відкритих угод</b> і 9 невиконаних задач. Вимкнути можна тільки після передачі.</span></div>
  <fieldset class="group"><legend>Кому передати угоди</legend>
    <label class="check"><input type="radio" name="tr" checked><span>Рівномірно по команді «Команда Ткача»<span class="hint">Марія Бондар, Назар Остапчук, Дмитро Ткач: по 5–6 угод.</span></span></label>
    <label class="check"><input type="radio" name="tr"><span>Одному менеджеру</span></label>
    <select class="select" aria-label="Менеджер" disabled style="margin-left:26px;width:calc(100% - 26px)"><option>Марія Бондар</option></select></fieldset></form>
  <div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="u-off-ok">Передати й вимкнути</button></div>`;
def('users', {
  title: 'Користувачі', group: '7. Налаштування', what: 'користувачів',
  states: [['default', 'Список'], ['create', 'Додати'], ['validation', 'Помилки'], ['created', 'Тимчасовий пароль'], ['disable', 'Вимкнути з передачею'], ['loading', 'Завантаження'], ['forbidden', 'Немає доступу']],
  render(s) { if (s === 'loading' || s === 'forbidden') return null; return usersPage(); },
  after(s) { if (s === 'create') openDialog(userForm(false)); if (s === 'validation') openDialog(userForm(true)); if (s === 'created') openDialog(userCreated()); if (s === 'disable') openDialog(userOff()); },
});
Object.assign(ACT, {
  'u-new': () => openDialog(userForm(false)),
  'u-create': (b) => { b.disabled = true; b.setAttribute('aria-busy', 'true'); b.textContent = 'Створюємо…'; setTimeout(() => openDialog(userCreated()), 700); },
  'u-off': (b) => openDialog(userOff(b.dataset.n)),
  'u-off-ok': () => { closeDialogs(); toast('17 угод передано, користувача вимкнено. Сесії завершено.'); },
});

/* teams */
def('teams', {
  title: 'Команди', group: '7. Налаштування', what: 'команди',
  states: [['default', 'Звичайний'], ['edit', 'Редагування'], ['empty', 'Порожньо'], ['loading', 'Завантаження']],
  render(s) {
    if (s === 'loading') return null;
    const head = ph('Команди', { meta: '<span>проєкт ALPI</span><span>менеджер — рівно в одній команді</span>', actions: `<button class="btn primary sm" data-act="t-edit">${ic('plus', 14)}Нова команда</button>` });
    if (s === 'empty') return head + emptyBox('Команд ще немає.', 'Команда — це тімлід і його менеджери. Тімлід бачить угоди своєї команди, якщо так налаштована його роль.', `<button class="btn primary sm" data-act="t-edit">${ic('plus', 14)}Нова команда</button>`);
    const team = (name, lead, members) => `<section class="panel"><div class="sh"><h2 class="h2">${name}</h2><div class="ml meta"><span>тімлід <b>${lead}</b></span><button class="btn quiet sm" data-act="t-edit">Змінити</button></div></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Менеджер</th><th class="r">Відкриті угоди</th><th>Приймає нові угоди</th></tr></thead><tbody>${members.map(([n, d, on]) => `<tr><td>${n}</td><td class="r num">${d}</td><td><label class="check"><input type="checkbox" ${on ? 'checked' : ''}><span class="${on ? '' : 'ink3'}">${on ? 'так' : 'ні'}</span></label></td></tr>`).join('')}</tbody></table></div></section>`;
    return `${head}<div class="split even">${team('Команда Лисенко', 'Ірина Лисенко', [['Олена Коваль', 64, 1], ['Андрій Шевчук', 51, 1], ['Ірина Лисенко', 12, 0]])}${team('Команда Ткача', 'Дмитро Ткач', [['Марія Бондар', 58, 1], ['Назар Остапчук', 0, 1], ['Дмитро Ткач', 9, 0]])}</div>`;
  },
  after(s) { if (s === 'edit') ACT['t-edit'](); },
});
ACT['t-edit'] = () => openDialog(`${dlgHead('Команда Лисенко')}<form class="dlg-b" novalidate>${field('tn', 'Назва', inp('tn', 'Команда Лисенко'))}${field('tld', 'Тімлід', sel('tld', ['Ірина Лисенко', 'Олена Коваль'], 'Ірина Лисенко'), { hint: 'Один тимлід на команду. Тимлід теж може вести угоди.' })}
  <fieldset class="group"><legend>Менеджери</legend>${['Олена Коваль', 'Андрій Шевчук', 'Назар Остапчук'].map((n, i) => `<label class="check"><input type="checkbox" ${i < 2 ? 'checked' : ''}><span>${n}${i === 2 ? '<span class="hint">Зараз у «Команді Ткача». Додавання перенесе його сюди.</span>' : ''}</span></label>`).join('')}</fieldset></form>
  <div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-close data-act="saved">Зберегти</button></div>`);
ACT.saved = () => toast('Збережено.');

/* audit */
const AUDIT = [['04.11 11:40', 'Олена Коваль', 'вхід', '2FA, Chrome на Windows', '93.184.216.34'], ['04.11 11:02', 'ключ «Make: оплати»', 'зміна етапу', 'угода № 4430 → Сплатив бронювання', '203.0.113.10'], ['04.11 10:20', 'Тарас Левченко', 'зміна ролі', 'роль «Менеджер»: зняв «Вивантаження у файл»', '198.51.100.7'], ['04.11 09:58', 'невідомо', 'невдалий вхід', 'viktor.kravets@example.com, вимкнений', '192.0.2.44'], ['03.11 18:40', 'Софія Гнатюк', 'масова операція', 'архів 61 240 угод за фільтром', '198.51.100.12'], ['03.11 17:12', 'Тарас Левченко', 'створено ключ API', '«n8n: вебінари», роль «Автоматизація»', '198.51.100.7'], ['03.11 16:05', 'Тарас Левченко', 'вивантаження', 'угоди, 1 518 рядків, CSV', '198.51.100.7'], ['03.11 12:30', 'Софія Гнатюк', 'видалення', 'угода № 2011 у кошик', '198.51.100.12'], ['02.11 20:14', 'Назар Остапчук', 'тимчасовий пароль', 'створено адміністратором', '198.51.100.7']];
const auditRows = (rows) => rows.map(([t, w, a, o, ip]) => `<tr><td class="meta">${t}</td><td>${/ключ/.test(w) ? `<span style="display:inline-flex;gap:6px;align-items:center">${ic('key', 14)}${w}</span>` : w}</td><td>${/невдалий/.test(a) ? st('warn', a) : a}</td><td class="ink2" style="white-space:normal;min-width:260px">${o}</td><td class="mono ink3">${ip}</td></tr>`).join('');
def('audit', {
  title: 'Журнал дій', group: '7. Налаштування', what: 'журнал дій',
  states: [['default', 'Звичайний'], ['more', 'Показати ще: завантаження'], ['end', 'Кінець списку'], ['empty', 'Нічого не знайдено'], ['loading', 'Завантаження'], ['forbidden', 'Немає доступу']],
  render(s) {
    if (s === 'loading' || s === 'forbidden') return null;
    const head = `${ph('Журнал дій', { meta: '<span>входи й небезпечні дії</span><span>тільки додавання, змінити записи не можна</span>' })}
      <div class="toolbar"><select class="select sm" style="width:auto" aria-label="Хто"><option>Усі: люди й ключі API</option></select><select class="select sm" style="width:auto" aria-label="Дія"><option>Усі дії</option><option>Вхід і невдалий вхід</option><option>Зміна ролі</option><option>Вивантаження</option><option>Масові операції</option></select><select class="select sm" style="width:auto" aria-label="Період"><option>Останні 7 днів</option></select>${s === 'empty' ? '<button class="fchip">дія: видалення організації<span class="x" aria-hidden="true">×</span></button>' : ''}</div>`;
    if (s === 'empty') return head + emptyBox('За цими умовами записів немає.', 'За останні 7 днів ніхто не видаляв організацій.');
    const extra = s === 'end' ? AUDIT.slice(0, 4).map((r) => [r[0].replace('04.11', '29.10').replace('03.11', '28.10'), ...r.slice(1)]) : [];
    return `${head}<section class="panel" aria-label="Записи журналу"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Час</th><th>Хто</th><th>Дія</th><th>Об’єкт</th><th>IP</th></tr></thead><tbody>${auditRows(AUDIT)}${auditRows(extra)}${s === 'more' ? Array.from({ length: 3 }, () => `<tr aria-hidden="true">${[30, 60, 40, 80, 40].map((w) => `<td><span class="sk" style="font-size:14px"><span class="bar" style="--w:${w + 20}%"></span></span></td>`).join('')}</tr>`).join('') : ''}</tbody></table></div>
      <div class="sh" style="border-top:1px solid var(--line);border-bottom:0;justify-content:center">${s === 'end' ? '<span class="meta-prose">Це всі записи за 7 днів.</span>' : `<button class="btn ghost sm" data-act="more" ${s === 'more' ? 'disabled aria-busy="true"' : ''}>${s === 'more' ? 'Завантажуємо…' : 'Показати ще'}</button>`}</div></section>`;
  },
});
ACT.more = () => { go('audit', 'more'); setTimeout(() => go('audit', 'end'), 1100); };

/* api keys */
const KEYS = [['Make: оплати й етапи', 'Автоматизація', '12.10.2026', 'сьогодні 11:02', 'ok'], ['n8n: вебінари', 'Автоматизація', '03.11.2026', 'сьогодні 10:40', 'ok'], ['Лендинг ai-content: реєстрації', 'Джерело реєстрацій', '01.09.2026', 'сьогодні 11:38', 'ok'], ['Zapier (старий)', 'Автоматизація', '14.05.2026', '02.10.2026', 'off']];
def('apikeys', {
  title: 'Ключі API', group: '7. Налаштування', what: 'ключі API',
  states: [['default', 'Список'], ['create', 'Новий ключ'], ['created', 'Ключ показано один раз'], ['revoke', 'Відкликати'], ['empty', 'Порожньо'], ['loading', 'Завантаження'], ['forbidden', 'Немає доступу']],
  render(s) {
    if (s === 'loading' || s === 'forbidden') return null;
    const head = ph('Ключі API', { meta: '<span>проєкт ALPI</span>', lead: 'Через ключі ваша автоматизація рухає угоди, ставить задачі й призначає відповідальних. CRM сама нічого не змінює. Ключ може те, що дозволяє його роль, і працює тільки в цьому проєкті.', actions: `<button class="btn primary sm" data-act="k-new">${ic('plus', 14)}Новий ключ</button>` });
    if (s === 'empty') return head + emptyBox('Ключів ще немає.', 'Створіть ключ для Make, n8n або лендинга. Кожна дія за ключем потрапить у журнал під його назвою.', `<button class="btn primary sm" data-act="k-new">${ic('plus', 14)}Новий ключ</button>`);
    return `${head}<section class="panel" aria-label="Ключі"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Назва</th><th>Роль</th><th>Ключ</th><th>Створено</th><th>Остання дія</th><th>Стан</th><th></th></tr></thead><tbody>${KEYS.map(([n, r, c, l, x], i) => `<tr><td class="t1">${n}</td><td>${r}</td><td><span class="ctag">alpi_live_…${['7Hq2', 'b91x', 'Lz4m', 'p0Qe'][i]}</span></td><td class="meta">${c}</td><td class="meta">${l}</td><td>${x === 'ok' ? st('ok', 'активний') : st('muted', 'відкликаний')}</td><td class="r">${x === 'ok' ? `<button class="btn quiet sm" data-act="k-revoke" aria-expanded="${s === 'revoke' && i === 0}">Відкликати</button>` : ''}</td></tr>${s === 'revoke' && i === 0 ? `<tr><td colspan="7" style="white-space:normal;background:var(--raised)"><div class="strip" role="group" style="justify-content:space-between"><p>Make перестане працювати з CRM одразу: оплати не рухатимуть угоди. Відкликати «Make: оплати й етапи»?</p><div class="actions"><button class="btn primary sm" data-act="k-revoke-ok">Так, відкликати</button><button class="btn quiet sm" data-act="go" data-to="apikeys">Залишити</button></div></div></td></tr>` : ''}`).join('')}</tbody></table></div></section>`;
  },
  after(s) { if (s === 'create') ACT['k-new'](); if (s === 'created') openDialog(keyCreated()); if (s === 'revoke') $('[data-act="k-revoke-ok"]')?.focus(); },
});
const keyCreated = () => `${dlgHead('Ключ створено')}<div class="dlg-b"><div class="secret"><p class="secret-title">«n8n: вебінари 2»</p><div class="copy-row"><input class="input mono" readonly value="alpi_live_r8Kx2Vq9TmZ4wLb7Ne1yHc6Jd3Pf" aria-label="Ключ API"><button class="btn ghost sm" data-act="copy">${ic('copy', 14)}Скопіювати</button></div><p class="ink2" style="font-size:14px">Показуємо ключ один раз. Збережіть його в налаштуваннях n8n. Якщо загубите, відкличте й створіть новий.</p></div><pre class="code">curl https://crm.alpi.example/api/v1/deals \\
  -H "Authorization: Bearer alpi_live_r8Kx…"</pre></div><div class="dlg-f"><button class="btn primary sm" data-close>Готово</button></div>`;
Object.assign(ACT, {
  'k-new': () => openDialog(`${dlgHead('Новий ключ API')}<form class="dlg-b" novalidate>${field('kn', 'Назва', inp('kn', 'n8n: вебінари 2'), { hint: 'Так ключ підписуватиметься в журналі й стрічці угоди.' })}${field('kr', 'Роль', sel('kr', ['Автоматизація', 'Джерело реєстрацій', 'Менеджер'], 'Автоматизація'), { hint: 'Роль «Автоматизація»: угоди, контакти, задачі — усі в проєкті; без видалення й вивантаження.' })}</form><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="k-create">Створити ключ</button></div>`),
  'k-create': () => openDialog(keyCreated()),
  'k-revoke': () => go('apikeys', 'revoke'),
  'k-revoke-ok': () => { go('apikeys', 'default'); toast('Ключ «Make: оплати й етапи» відкликано.'); },
});

/* outgoing events / webhooks */
const EVENTS = ['угоду створено', 'етап змінено', 'угоду виграно', 'угоду програно', 'відповідального змінено', 'нова реєстрація', 'платіж успішний', 'платіж повернено', 'дзвінок відбувся', 'дзвінок пропущено', 'задачу виконано'];
const DELIV = [['11:41:08', 'платіж успішний', 'n8n', '500', 'err', '3 з 6', 'о 11:49'], ['11:38:52', 'нова реєстрація', 'Make', '200', 'ok', '1', ''], ['11:12:30', 'дзвінок пропущено', 'Make', '200', 'ok', '1', ''], ['11:02:11', 'етап змінено', 'Make', '200', 'ok', '2 з 6', ''], ['10:58:47', 'платіж успішний', 'n8n', 'таймаут 10 с', 'err', '6 з 6', 'спроби скінчилися'], ['10:40:02', 'угоду створено', 'Make', '200', 'ok', '1', '']];
def('webhooks', {
  title: 'Події (вебхуки)', group: '7. Налаштування', what: 'налаштування подій',
  states: [['default', 'Звичайний'], ['failed', 'Тільки збої'], ['add', 'Нова адреса: помилка'], ['empty', 'Порожньо'], ['loading', 'Завантаження']],
  render(s) {
    if (s === 'loading') return null;
    const head = ph('Події', { meta: '<span>проєкт ALPI</span><span>підпис HMAC-SHA256</span><span>повтори з паузою до 6 разів</span>', lead: 'CRM надсилає події на ваші адреси, а ваша автоматизація вирішує, що робити далі. Якщо події не доходять, угоди стоять на місці: дивіться журнал доставок.', actions: `<button class="btn ghost sm" data-act="saved">Надіслати тестову подію</button><button class="btn primary sm" data-act="wh-add">${ic('plus', 14)}Адреса</button>` });
    if (s === 'empty') return head + emptyBox('Адрес для подій ще немає.', 'Додайте адресу Make, n8n або свого сервісу. Тільки HTTPS.', `<button class="btn primary sm" data-act="wh-add">${ic('plus', 14)}Адреса</button>`);
    const rows = (s === 'failed' ? DELIV.filter((d) => d[4] === 'err') : DELIV);
    return `${head}<div class="split">
      <div class="col">${sec('Адреси', `<div class="row"><div class="kv"><span class="mono" style="font-size:13px;overflow-wrap:anywhere">https://hook.eu2.make.example/alpi-deals</span>${st('ok', 'доставляється')}</div><span class="meta">угоду створено, етап змінено, виграно, програно, нова реєстрація, дзвінок пропущено</span></div>
        <div class="row"><div class="kv"><span class="mono" style="font-size:13px;overflow-wrap:anywhere">https://n8n.alpi.example/webhook/payments</span>${st('err', 'збої: 2 з 20')}</div><span class="meta">платіж успішний, платіж повернено</span><div class="notice err" style="margin-top:6px"><span class="grow">Остання відповідь: <b class="num" style="font-weight:500">500</b> Internal Server Error, 11:41. Наступна спроба о 11:49.</span><button class="btn ghost sm" data-act="saved">${ic('retry', 14)}Повторити зараз</button></div></div>`, { flush: true, right: '<span>2</span>' })}
      <section class="panel" aria-label="Журнал доставок"><div class="sh"><h2 class="h2">Журнал доставок</h2><div class="tabs bare"><a class="tab" href="#/webhooks/default" ${s !== 'failed' ? 'aria-current="page"' : ''}>Усі</a><a class="tab" href="#/webhooks/failed" ${s === 'failed' ? 'aria-current="page"' : ''}>Збої<span class="count">2</span></a></div></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Час</th><th>Подія</th><th>Адреса</th><th>Відповідь</th><th>Спроба</th><th></th></tr></thead><tbody>${rows.map(([t, e, a, c, x, n, nx]) => `<tr><td class="meta">${t}</td><td>${e}</td><td>${a}</td><td>${st(x, c)}</td><td class="meta">${n}</td><td class="r">${x === 'err' ? `<span class="meta" style="margin-right:8px">${nx}</span><button class="btn quiet sm" data-act="saved">Повторити</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section></div>
      <div class="col">${sec('Секрет підпису', `<div class="copy-row"><input class="input mono" readonly value="whsec_••••••••••••••••Q7rT" aria-label="Секрет підпису"><button class="btn ghost sm">Показати</button></div><p class="hint">Заголовок <span class="ctag">X-Alpi-Signature</span>. Перевіряйте підпис, щоб чужі запити не рухали угоди.</p><button class="btn quiet sm" style="justify-self:start">Створити новий секрет</button>`)}
        ${sec('Що надсилати на make.example', EVENTS.map((e, i) => `<label class="check"><input type="checkbox" ${[0, 1, 2, 3, 5, 9].includes(i) ? 'checked' : ''}><span>${e}</span></label>`).join(''), { right: '<span>6 з 11</span>' })}</div></div>`;
  },
  after(s) { if (s === 'add') whAdd(true); },
});
function whAdd(err) {
  openDialog(`${dlgHead('Нова адреса для подій')}<form class="dlg-b" novalidate>${field('wu', 'URL', inp('wu', err ? 'http://192.168.0.12:5678/webhook' : '', { cls: 'mono', ph: 'https://…', err }), { err: err ? 'Тільки HTTPS і публічна адреса. Локальні адреси CRM не бачить.' : '', hint: err ? '' : 'Тільки HTTPS.' })}${field('wn', 'Назва', inp('wn', 'n8n: звіти'), { opt: true })}</form><div class="dlg-f"><button class="btn quiet sm" data-close>Скасувати</button><button class="btn primary sm" data-act="wh-ok">Додати</button></div>`);
}
ACT['wh-add'] = () => whAdd(false);
ACT['wh-ok'] = () => { const v = $('#wu').value; if (!/^https:\/\/[^/]+\.[a-z]{2,}/i.test(v)) { closeDialogs(); whAdd(true); return; } closeDialogs(); toast('Адресу додано. Надіслали тестову подію.'); };

/* custom fields builder */
const FG = [['Кваліфікація', [['Тип клієнта', 'client_type', 'список'], ['Професія', 'profession', 'список'], ['Дохід на місяць', 'income_uah', 'гроші']]], ['Закриття', [['Пакет', 'package', 'список', 'з етапу «Сплатив бронювання»', 1], ['Тип закриття', 'closing_type', 'список', 'з етапу «Сплатив бронювання»'], ['Дата оплати', 'paid_on', 'дата']]], ['Вебінар', [['Рівень прогріву', 'warmth', 'список'], ['Перегляд, %', 'watch_pct', 'число']]], ['Службове', [['Підрядник', 'contractor', 'текст'], ['Вартість реєстрації', 'reg_cost', 'гроші']]]];
const TYPES = ['Текст', 'Довгий текст', 'Число', 'Гроші', 'Дата', 'Час', 'Дата й час', 'Список', 'Множинний вибір', 'Так / ні', 'Телефон', 'Email', 'Посилання', 'Користувач', 'Адреса'];
function fieldsPage(s) {
  const nw = s === 'new';
  const list = FG.map(([g, fs]) => `<div class="grp-h" style="justify-content:space-between"><span style="font-weight:500;font-size:14px">${g}</span><span class="meta">${g === 'Службове' ? 'менеджер: тільки перегляд' : `${fs.length} поля`}</span></div>${fs.map(([n, c, t, req, cur]) => `<div class="fld" tabindex="0" ${cur && !nw ? 'aria-current="true"' : ''}><span class="grip" aria-hidden="true"></span><div style="display:grid;gap:2px;min-width:0"><span>${n}${req ? ` <span class="meta-prose ask">обов’язкове ${req}</span>` : ''}</span><span class="ml meta"><span class="mono" style="font-size:12px">${c}</span><span>${t}</span></span></div>${cur ? '<span class="meta">важливе</span>' : ''}</div>`).join('')}`).join('');
  const editor = `<section class="panel rise" aria-labelledby="fe-t"><div class="sh"><h2 class="h2" id="fe-t">${nw ? 'Нове поле' : 'Поле «Пакет»'}</h2><div class="ml meta">${nw ? '<span>угоди</span>' : '<span>2 418 угод із значенням</span>'}</div></div>
    <form class="sb" novalidate>
      <div class="grid2">${field('fn', 'Назва українською', inp('fn', nw ? '' : 'Пакет', { err: nw }), { err: nw ? 'Вкажіть назву.' : '' })}${field('fr', 'Назва російською', inp('fr', nw ? '' : 'Пакет'), { opt: true })}</div>
      ${field('fc', 'Код', nw ? inp('fc', 'package', { cls: 'mono', err: true }) : '<input id="fc" class="input mono" readonly value="package">', { err: nw ? 'Код «package» уже є в полі «Пакет». Код має бути унікальним.' : '', hint: nw ? 'Латиниця, цифри й «_». Код використовують API, імпорт і фільтри.' : `<span style="display:inline-flex;gap:6px;align-items:center">${ic('lock', 12)}Код не змінюється після першого значення.</span>` })}
      <div class="grid2">${field('ft', 'Тип', sel('ft', TYPES, 'Список', { err: false }))}${field('fg', 'Група', sel('fg', FG.map((x) => x[0]), 'Закриття'))}</div>
      <div class="field"><span class="label">Варіанти</span><div class="mini-list">${(nw ? ['', ''] : ['START', 'PRO', 'MAX']).map((o, i) => `<div class="opt-line"><span class="grip" aria-hidden="true"></span><input class="input sm" value="${o}" aria-label="Варіант ${i + 1}" ${nw && i === 0 ? 'aria-invalid="true"' : ''}><button type="button" class="icon-btn" style="width:30px;height:30px" aria-label="Прибрати варіант">${ic('close', 14)}</button></div>`).join('')}</div>${nw ? '<p class="error" role="alert">Додайте хоча б два варіанти.</p>' : ''}<button type="button" class="btn quiet sm" style="justify-self:start">${ic('plus', 14)}Варіант</button></div>
      <fieldset class="choices"><legend class="label" style="margin-bottom:8px">Обов’язкове</legend><label class="choice"><input type="radio" name="rq" ${nw ? 'checked' : ''}><span>ні</span></label><label class="choice"><input type="radio" name="rq"><span>завжди</span></label><label class="choice"><input type="radio" name="rq" ${nw ? '' : 'checked'}><span>з етапу</span></label>${nw ? '' : sel('fst', PATH, 'Сплатив бронювання', { cls: 'sm' }).replace('<select', '<select style="width:auto" aria-label="Етап"')}</fieldset>
      <fieldset class="group"><legend>Видно у воронках</legend><label class="check"><input type="checkbox" checked><span>ALPI</span></label><label class="check"><input type="checkbox"><span>Платформа (допродаж)</span></label></fieldset>
      <label class="check"><input type="checkbox" ${nw ? '' : 'checked'}><span>Важливе<span class="hint">Показується вгорі картки угоди й у списку колонок за замовчуванням.</span></span></label>
      <div class="actions"><button type="button" class="btn primary sm" data-act="${nw ? 'f-err' : 'saved'}">Зберегти поле</button>${nw ? '<p class="error" role="alert">Перевірте поля у формі.</p>' : '<button type="button" class="btn quiet sm">В архів</button>'}</div>
    </form></section>`;
  return `${ph('Поля', { meta: '<span>проєкт ALPI</span><span>15 типів, без формул</span>', actions: `<button class="btn ghost sm">Група</button><button class="btn primary sm" data-act="go" data-to="fields" data-st="new">${ic('plus', 14)}Поле</button>` })}
    <div class="tabs bare" style="margin-bottom:14px" role="tablist">${[['Угоди', 10], ['Контакти', 3], ['Організації', 4]].map(([t, n], i) => `<button class="tab" role="tab" aria-selected="${i === 0}">${t}<span class="count">${n}</span></button>`).join('')}</div>
    <div class="split rev"><section class="panel fld-list" aria-label="Поля угод">${list}</section>${editor}</div>`;
}
def('fields', {
  title: 'Конструктор полів', group: '7. Налаштування', what: 'конструктор полів',
  states: [['default', 'Редагування поля'], ['new', 'Нове поле: помилки'], ['saved', 'Збережено'], ['loading', 'Завантаження'], ['forbidden', 'Немає доступу']],
  toast: 'Поле «Пакет» збережено.',
  render(s) { if (s === 'loading' || s === 'forbidden') return null; return fieldsPage(s === 'saved' ? 'default' : s); },
  after(s) { if (s === 'saved') toast(SCREENS.fields.toast); },
});
ACT['f-err'] = () => toast('Не вдалося зберегти: перевірте поля у формі.', { tone: 'error' });
