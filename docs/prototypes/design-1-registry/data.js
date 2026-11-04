/* ПРОТОТИП, дизайн-напрям 1 «Інженерний реєстр». Усі дані вигадані, живуть у пам'яті. */
(function () {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const RATES = { UAH: 1, EUR: 48.2, USD: 41.6 }; // курс НБУ на сьогодні (вигаданий)

  const FN_UK = ['Тарас', 'Оксана', 'Богдана', 'Віталій', 'Ярослава', 'Назар', 'Людмила', 'Роман', 'Христина', 'Максим', 'Софія', 'Ігор', 'Віра', 'Степан', 'Аліна', 'Олег', 'Юлія', 'Денис', 'Галина', 'Артем', 'Мирослава', 'Петро', 'Злата', 'Євген'];
  const LN_UK = ['Гнатюк', 'Мельничук', 'Савчук', 'Кравчук', 'Дорош', 'Петрук', 'Остапенко', 'Зінченко', 'Левчук', 'Гайовий', 'Литвин', 'Пономар', 'Климченко', 'Кузьмич', 'Руденко', 'Тарасюк', 'Мартинюк', 'Ковтун', 'Яремчук', 'Білоус', 'Головко', 'Стасюк'];
  const FN_RU = ['Алексей', 'Наталья', 'Игорь', 'Светлана', 'Павел', 'Евгения', 'Константин', 'Марина', 'Денис', 'Ольга', 'Глеб', 'Вера'];
  const LN_RU = ['Ветров', 'Соколова', 'Лаптев', 'Гордеева', 'Осипов', 'Чернова', 'Рябов', 'Тихонова', 'Зуев', 'Крылова', 'Ларин', 'Фомина'];
  const ORGS = ['ТОВ «Кавова лінія»', 'ФОП Ларін — пекарні', 'ТОВ «Фітнес Квартал»', 'Мережа «Чиста хата»', 'ТОВ «Смарт Дент»', 'Студія «Бровар»', 'ТОВ «Мийка 24»', 'Школа англійської «Speak Up»'];

  const PRODUCTS = {
    alpi: [
      { id: 'p1', name: 'AI-контент PRO · тариф «Базовий»', UAH: 24000, EUR: 520, USD: 580 },
      { id: 'p2', name: 'AI-контент PRO · тариф «Преміум»', UAH: 48000, EUR: 1020, USD: 1150 },
      { id: 'p3', name: 'Менторський супровід, 3 міс.', UAH: 18000, EUR: 390, USD: 430 },
      { id: 'p4', name: 'Нейромережі для бізнесу · інтенсив', UAH: 9600, EUR: 210, USD: 230 },
    ],
    franch: [
      { id: 'f1', name: 'Упаковка франшизи · «Старт»', UAH: 180000, EUR: 3900, USD: 4300 },
      { id: 'f2', name: 'Упаковка франшизи · «Під ключ»', UAH: 420000, EUR: 9000, USD: 9900 },
      { id: 'f3', name: 'Аудит бізнес-моделі', UAH: 36000, EUR: 780, USD: 860 },
    ],
  };

  const USERS = {
    alpi: [
      { id: 'ok', n: 'Олена Коваль', i: 'ОК' },
      { id: 'as', n: 'Андрій Шевчук', i: 'АШ' },
      { id: 'mb', n: 'Марія Бондар', i: 'МБ' },
      { id: 'dt', n: 'Дмитро Ткач', i: 'ДТ' },
      { id: 'il', n: 'Ірина Лисенко', i: 'ІЛ' },
    ],
    franch: [
      { id: 'ok', n: 'Олена Коваль', i: 'ОК' },
      { id: 'sm', n: 'Сергій Мороз', i: 'СМ' },
      { id: 'ab', n: 'Анна Білова', i: 'АБ' },
    ],
  };

  // [назва, всього угод, показати карток, суми {UAH,EUR,USD}]
  const PIPES = {
    alpi: {
      name: 'ALPI',
      stages: [
        ['Новий лід', 84332, 5, null],
        ['Передано в роботу', 46, 5, null],
        ['Був на вебінарі', 890, 5, { UAH: 0 }],
        ['Не вийшов на зв’язок', 325, 4, null],
        ['Дивиться запис вебінару', 60, 4, { UAH: 96000 }],
        ['Приймає рішення', 130, 6, { UAH: 1254000, EUR: 4160, USD: 1730 }],
        ['Сплатив бронювання', 80, 5, { UAH: 3381000, EUR: 12480, USD: 2900 }],
        ['Виставили рахунок', 30, 4, { UAH: 1270500, EUR: 3120 }],
        ['Відкладений попит', 500, 4, { UAH: 2102000, USD: 1150 }],
      ],
    },
    franch: {
      name: 'Франч',
      stages: [
        ['Новый лид', 1300, 4, null],
        ['Первый контакт', 200, 4, null],
        ['Прошёл квалификацию', 20, 3, null],
        ['Назначена встреча', 55, 4, { UAH: 720000 }],
        ['Встреча проведена', 210, 4, { UAH: 1850000, EUR: 7800 }],
        ['Вторая встреча', 100, 3, { UAH: 1420000 }],
        ['Подписание договора', 10, 3, { UAH: 920000, USD: 9900 }],
      ],
    },
  };

  const taskStates = ['overdue', 'today', 'future', 'future', 'none', 'today'];
  const TODAY = new Date(2026, 10, 4);

  function genDeals(pkey) {
    const P = PIPES[pkey];
    const isF = pkey === 'franch';
    const deals = [];
    let num = isF ? 3120 : 10420;
    P.stages.forEach((s, si) => {
      for (let k = 0; k < s[2]; k++) {
        const fn = pick(isF ? FN_RU : FN_UK);
        let ln = pick(isF ? LN_RU : LN_UK);
        if (isF && /[ая]$/.test(fn)) ln += 'а';
        const prod = pick(PRODUCTS[pkey]);
        const cur = si < 3 ? 'UAH' : pick(['UAH', 'UAH', 'UAH', 'EUR', 'USD']);
        const hasAmount = isF ? si >= 3 : si >= 4;
        const queue = (si === 0 && k < 3) || (si === 1 && k === 0);
        const ts = queue ? 'none' : pick(taskStates);
        const owner = queue ? null : pick(USERS[pkey]).id;
        let task = null;
        if (ts === 'overdue') task = { state: 'overdue', label: rint(1, 4) + ' лист.', type: isF ? 'Звонок' : 'Зв’язатися' };
        if (ts === 'today') task = { state: 'today', label: 'сьогодні ' + pick(['10:30', '12:00', '14:15', '16:40', '18:00']), type: isF ? 'Встреча' : 'Дожим' };
        if (ts === 'future') task = { state: 'future', label: rint(5, 28) + ' лист.', type: isF ? 'Фоллоу-ап' : 'Очікую оплату' };
        if (ts === 'none') task = { state: 'none', label: 'немає задачі' };
        deals.push({
          id: 'd' + num, num: num++, stage: si,
          title: isF ? pick(ORGS) + ' — франшиза' : fn + ' ' + ln + ' — ' + prod.name.split(' · ')[0],
          contact: fn + ' ' + ln,
          owner,
          amount: hasAmount ? prod[cur] : 0,
          cur,
          task,
          rot: !queue && si > 2 && rnd() < 0.18 ? rint(9, 21) : 0,
          created: rint(1, 28) + '.' + pick(['08', '09', '10']) + '.2026',
          status: 'open',
        });
      }
    });
    return deals;
  }

  window.DATA = {
    RATES, PRODUCTS, USERS, PIPES, TODAY,
    deals: { alpi: genDeals('alpi'), franch: genDeals('franch') },
  };
})();
