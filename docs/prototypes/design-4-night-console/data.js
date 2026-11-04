/* ПРОТОТИП · вигадані дані. Жодних реальних людей: телефони +380 00…, пошта @example.com. */
(function () {
  'use strict';

  let seed = 20261104;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const TODAY = '2026-11-04';
  const RATES = { EUR: 45.20, USD: 41.45, UAH: 1 };

  const FIRST_UK = ['Ірина', 'Олег', 'Тетяна', 'Максим', 'Наталія', 'Богдана', 'Віталій', 'Юлія', 'Роман', 'Катерина', 'Денис', 'Світлана', 'Артем', 'Оксана', 'Павло', 'Ганна', 'Євген', 'Аліна', 'Тарас', 'Вікторія', 'Ігор', 'Марина', 'Сергій', 'Лілія', 'Дарина', 'Василь', 'Софія', 'Назар', 'Христина', 'Ярослав'];
  const LAST_UK = ['Мельник', 'Гнатюк', 'Савчук', 'Литвин', 'Кравчук', 'Руденко', 'Пономаренко', 'Ткаченко', 'Захарченко', 'Онищенко', 'Мороз', 'Гуменюк', 'Яковенко', 'Левченко', 'Сидоренко', 'Білик', 'Костенко', 'Дячук', 'Остапчук', 'Нестеренко', 'Федорук', 'Гайова', 'Довгань', 'Кушнір', 'Пилипенко', 'Вовк', 'Шаповал', 'Бойко', 'Чумак', 'Олійник'];
  const FIRST_RU = ['Алексей', 'Марина', 'Игорь', 'Светлана', 'Дмитрий', 'Елена', 'Константин', 'Юлия', 'Олег', 'Наталья', 'Павел', 'Ирина', 'Роман', 'Татьяна'];
  const LAST_RU = ['Соколов', 'Гриценко', 'Лебедев', 'Остапенко', 'Ковальчук', 'Зайцев', 'Демченко', 'Тарасов', 'Сорокин', 'Литвиненко', 'Белый', 'Карпенко'];
  const ORGS_RU = ['Кофейни «Зерно и Пар»', 'Пекарни «Бретцель»', 'Барбершопы «Лезвие»', 'Детский центр «Кубик»', 'Студии «Пилатес Плюс»', 'Химчистки «Белый лист»', 'Кафе «Вареничная №1»', 'Автомойки «Блеск»', 'Цветочные «Пион»', 'Сеть «Суши Мастер»', 'Языковая школа «Лингво»', 'Фитнес «Атлет»'];

  const translit = (s) => s.toLowerCase().replace(/[ʼ']/g, '').split('').map((c) => ({ а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e', ъ: '' }[c] ?? c)).join('');
  const phone = () => `+380 00 ${rint(100, 999)} ${rint(10, 99)} ${rint(10, 99)}`;
  const person = (ru) => {
    const f = ru ? pick(FIRST_RU) : pick(FIRST_UK);
    const l = ru ? pick(LAST_RU) : pick(LAST_UK);
    return { name: `${f} ${l}`, phone: phone(), email: `${translit(f)}.${translit(l)}@example.com` };
  };
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  const PROJECTS = {
    alpi: {
      key: 'alpi', short: 'ALPI', name: 'AI-школа ALPI', role: 'Менеджер', me: 'ok',
      users: [
        { id: 'ok', n: 'Олена Коваль' }, { id: 'as', n: 'Андрій Шевчук' }, { id: 'mb', n: 'Марія Бондар' },
        { id: 'dt', n: 'Дмитро Ткач' }, { id: 'il', n: 'Ірина Лисенко' }
      ],
      pipeline: 'ALPI',
      pipelines: ['ALPI', 'Платформа (допродаж)'],
      stages: [
        { n: 'Новий лід', total: 84332 },
        { n: 'Передано в роботу', total: 412 },
        { n: 'Був на вебінарі', total: 890 },
        { n: 'Не вийшов на звʼязок', total: 325 },
        { n: 'Дивиться запис вебінару', total: 60 },
        { n: 'Приймає рішення', total: 130 },
        { n: 'Сплатив бронювання', total: 80 },
        { n: 'Виставили рахунок', total: 30 },
        { n: 'Відкладений попит', total: 500 }
      ],
      products: [
        { n: 'AI-контент START', EUR: 690, UAH: 31200, USD: 750 },
        { n: 'AI-контент PRO', EUR: 1190, UAH: 53800, USD: 1290 },
        { n: 'AI-контент MAX', EUR: 1890, UAH: 85400, USD: 2050 },
        { n: 'Модуль «AI-відео»', EUR: 100, UAH: 4500, USD: 110 }
      ],
      lost: {
        'АІ 1 · До вебінару': ['Невірний номер', 'Не виходить на звʼязок', 'Не цільовий (без доходу / неповнолітній)', 'Не памʼятає реєстрацію'],
        'АІ 2 · Після вебінару': ['Дорого', 'Немає часу зараз', 'Не вірить у результат', 'Обрав інший курс'],
        'АІ 3 · Після броні': ['Повернення броні', 'Фінансові обставини', 'Не погодила родина']
      },
      taskTypes: ['Звʼязатися', 'Консультація', 'Дожим', 'Дізнатись рішення', 'Очікую оплату', 'Доплата', 'Передзвонити']
    },
    franch: {
      key: 'franch', short: 'Франч', name: '«Франч»', role: 'Керівник', me: 'ok',
      users: [
        { id: 'ok', n: 'Олена Коваль' }, { id: 'sm', n: 'Сергей Морозов' }, { id: 'ab', n: 'Анна Белова' }, { id: 'vk', n: 'Виктор Кравец' }
      ],
      pipeline: 'Франч',
      pipelines: ['Франч'],
      stages: [
        { n: 'Новый лид', total: 1300 },
        { n: 'Первый контакт', total: 200 },
        { n: 'Не вышел на контакт', total: 240 },
        { n: 'Прошёл квалификацию', total: 20 },
        { n: 'Назначена встреча', total: 55 },
        { n: 'Встреча проведена', total: 210 },
        { n: 'Вторая встреча', total: 100 },
        { n: 'Подписание договора', total: 10 }
      ],
      products: [
        { n: 'Упаковка франшизы START 2.0', EUR: 4900, UAH: 221500, USD: 5300 },
        { n: 'Упаковка франшизы PRO 2.0', EUR: 8900, UAH: 402300, USD: 9650 },
        { n: 'Упаковка франшизы MAX 2.0', EUR: 14500, UAH: 655400, USD: 15700 }
      ],
      lost: {
        'Квалификация': ['Нецелевой (покупатель франшизы)', 'Нет действующего бизнеса', 'Одна точка, нет системы'],
        'После встречи': ['Дорого', 'Не готов сейчас', 'Ушёл к конкуренту'],
        'Договор': ['Не согласовали условия', 'Юридические вопросы']
      },
      taskTypes: ['Звонок', '1-я встреча', '2-я встреча', 'Фоллоу-ап', 'Перезвонить']
    }
  };

  const TASK_KINDS = ['overdue', 'today', 'future', 'future', 'none'];

  function makeDeal(P, num, si, opts) {
    const ru = P.key === 'franch';
    const c = person(ru);
    const org = ru ? pick(ORGS_RU) : null;
    const amountFrom = ru ? 3 : 2;
    let cur = ru ? 'EUR' : pick(['EUR', 'EUR', 'EUR', 'UAH', 'USD']);
    let amount = 0;
    const prod = pick(P.products);
    if (si >= amountFrom) amount = prod[cur];
    const kind = pick(TASK_KINDS);
    const task = kind === 'none' ? null : {
      kind,
      type: pick(P.taskTypes),
      date: kind === 'overdue' ? addDays(TODAY, -rint(1, 6)) : kind === 'today' ? TODAY : addDays(TODAY, rint(1, 9)),
      time: rnd() > .45 ? pick(['10:00', '11:30', '13:00', '15:00', '16:30', '18:00']) : null
    };
    const owner = pick(P.users).id;
    return Object.assign({
      id: P.key + num, num, stage: si, title: ru ? `${org} — франшиза` : c.name,
      contact: c, org, amount, cur, owner, status: 'open', archived: false,
      task, rot: rnd() > .88, created: addDays(TODAY, -rint(1, 40)),
      products: amount ? [{ n: prod.n, qty: 1, price: amount }] : []
    }, opts || {});
  }

  function build(P) {
    let num = P.key === 'alpi' ? 48210 : 12070;
    const deals = [];
    P.stages.forEach((s, si) => {
      const n = si === 0 ? 7 : rint(3, 6);
      for (let i = 0; i < n; i++) deals.push(makeDeal(P, ++num, si));
    });
    // Картка загальної черги — без відповідального
    const q1 = makeDeal(P, ++num, 1, { owner: null, task: null, rot: false });
    const q2 = makeDeal(P, ++num, 0, { owner: null, task: null, rot: false });
    deals.splice(0, 0, q2);
    deals.splice(8, 0, q1);
    // Додаткові рядки лише для списку
    for (let i = 0; i < 46; i++) deals.push(makeDeal(P, ++num, rint(0, P.stages.length - 1), { listOnly: true }));
    P.deals = deals;
    P.nextNum = num + 1;

    // Суми етапів «з сервера»: окремо по валютах
    P.stages.forEach((s, si) => {
      const vis = deals.filter((d) => d.stage === si && !d.listOnly);
      const sums = { EUR: 0, UAH: 0, USD: 0 };
      if (si >= (P.key === 'franch' ? 3 : 2)) {
        const k = s.total;
        sums.EUR = Math.round(k * (P.key === 'franch' ? 7600 : 820) / 10) * 10;
        sums.UAH = P.key === 'franch' ? 0 : Math.round(k * 9200 / 100) * 100;
        sums.USD = P.key === 'franch' ? Math.round(k * 900 / 10) * 10 : Math.round(k * 140 / 10) * 10;
      }
      s.sums = sums;
      s.shown = vis.length;
    });
  }

  build(PROJECTS.alpi);
  build(PROJECTS.franch);

  // Показова угода з повною карткою
  const A = PROJECTS.alpi;
  const demo = {
    id: 'alpi48173', num: 48173, stage: 6, title: 'Ірина Мельник — AI-контент PRO',
    contact: { name: 'Ірина Мельник', phone: '+380 00 123 45 67', email: 'iryna.melnyk@example.com', city: 'Львів' },
    org: null, amount: 1190, cur: 'EUR', owner: 'ok', status: 'open', archived: false,
    task: { kind: 'today', type: 'Доплата', date: TODAY, time: '16:30', subj: 'Нагадати про доплату 990 € до старту потоку' },
    rot: false, created: '2026-10-26', demo: true,
    products: [{ n: 'AI-контент PRO', qty: 1, price: 1190 }, { n: 'Модуль «AI-відео»', qty: 1, price: 100 }],
    payments: [
      { kind: 'Бронь', amount: 200, status: 'ok', uah: 9040, rate: 45.20, date: '2026-10-30' },
      { kind: 'Доплата', amount: 990, status: 'wait', uah: null, rate: null, date: '2026-11-04' }
    ],
    participants: [{ n: 'Тарас Мельник', role: 'Платник', phone: '+380 00 765 43 21' }],
    regs: [
      { at: '2026-10-26 19:02', title: 'AI-контент з нуля · вебінар 28.10', src: 'Facebook Ads', utm: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'ai_content_webinar_oct', utm_content: 'video_v3', fbclid: 'IwAR2xQk7Lm0pZ3vRt9sYbN4' }, page: 'alpi.example/webinar/ai-content', watch: '19:03 → 20:41 · 86 %' },
      { at: '2026-10-31 18:30', title: 'AI-відео: Sora, Kling, Runway · вебінар 02.11', src: 'Google Ads', utm: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'search_ai_kurs', utm_term: 'ai відео курс', gclid: 'Cj0KCQjw8kTqLzN2' }, page: 'alpi.example/webinar/ai-video', watch: 'не дивилась' }
    ],
    feed: [
      { t: 'note', at: '2026-11-04 10:12', who: 'Олена Коваль', text: 'Домовились: доплату внесе до пʼятниці з картки чоловіка. Рахунок надіслати на пошту, не в месенджер.' },
      { t: 'call', at: '2026-11-04 10:05', who: 'Олена Коваль', dir: 'out', dur: '6:42', line: 'Лінія відділу продажів' },
      { t: 'task', at: '2026-11-03 17:40', who: 'Олена Коваль', text: 'Задачу виконано: Дізнатись рішення' },
      { t: 'call', at: '2026-11-03 12:18', who: 'Ringostat', dir: 'missed', dur: null, line: 'Лінія відділу продажів', auto: 'Створено задачу «Передзвонити» на 03.11' },
      { t: 'pay', at: '2026-10-30 14:51', who: 'WayForPay', kind: 'Бронь', amount: '200 €', uah: '9 040 ₴', status: 'ok' },
      { t: 'stage', at: '2026-10-30 14:52', who: 'Зовнішня автоматизація', from: 'Приймає рішення', to: 'Сплатив бронювання' },
      { t: 'stage', at: '2026-10-29 11:20', who: 'Олена Коваль', from: 'Був на вебінарі', to: 'Приймає рішення' },
      { t: 'reg', at: '2026-10-26 19:02', who: 'Форма вебінару', text: 'Реєстрація 1 з 2 · AI-контент з нуля · Facebook Ads' }
    ]
  };
  A.deals.splice(30, 0, demo);
  A.demoId = demo.id;
  PROJECTS.franch.demoId = PROJECTS.franch.deals.find((d) => d.stage === 5 && d.owner).id;

  const NOTIFS = [
    { ic: 'phone-missed', t: 'Пропущений дзвінок · Ірина Мельник', s: 'Створено задачу «Передзвонити»', at: '10:41' },
    { ic: 'inbox', t: 'Нова угода в загальній черзі', s: 'Воронка ALPI · Передано в роботу', at: '09:58' },
    { ic: 'alarm-clock', t: '3 задачі прострочено', s: 'Найстаріша — 29.10, Дожим', at: '09:00' },
    { ic: 'credit-card', t: 'Оплата 200 € пройшла', s: 'Богдана Руденко · Бронь · WayForPay', at: 'вчора' }
  ];

  window.CRM = { PROJECTS, RATES, TODAY, NOTIFS, addDays };
})();
