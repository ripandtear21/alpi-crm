/* ПРОТОТИП — throwaway. Все данные выдуманы: имена собраны из частых имён и фамилий, телефоны с несуществующим
   кодом +380 00, почта @example.com. Курсы НБУ условные. */
'use strict';

const TODAY = '04.11.2026';
const RATES = { UAH: 1, EUR: 48.12, USD: 41.62 };
const SYM = { UAH: '₴', EUR: '€', USD: '$' };

const USERS = {
  ok: { n: 'Олена Коваль', ini: 'ОК', email: 'olena.koval@example.com', role: 'Менеджер', team: 'Команда Лисенко', st: 'ok', last: 'сьогодні 09:41' },
  as: { n: 'Андрій Шевчук', ini: 'АШ', email: 'andrii.shevchuk@example.com', role: 'Менеджер', team: 'Команда Лисенко', st: 'ok', last: 'сьогодні 08:57' },
  mb: { n: 'Марія Бондар', ini: 'МБ', email: 'mariia.bondar@example.com', role: 'Менеджер', team: 'Команда Ткача', st: 'ok', last: 'вчора 19:12' },
  dt: { n: 'Дмитро Ткач', ini: 'ДТ', email: 'dmytro.tkach@example.com', role: 'Тімлід', team: 'Команда Ткача', st: 'ok', last: 'сьогодні 10:02' },
  il: { n: 'Ірина Лисенко', ini: 'ІЛ', email: 'iryna.lysenko@example.com', role: 'Тімлід', team: 'Команда Лисенко', st: 'ok', last: 'сьогодні 09:15' },
  no: { n: 'Назар Остапчук', ini: 'НО', email: 'nazar.ostapchuk@example.com', role: 'Менеджер', team: 'Команда Ткача', st: 'pending', last: 'ще не входив' },
  sh: { n: 'Софія Гнатюк', ini: 'СГ', email: 'sofiia.hnatiuk@example.com', role: 'Керівник', team: '—', st: 'ok', last: 'сьогодні 07:58' },
  tl: { n: 'Тарас Левченко', ini: 'ТЛ', email: 'taras.levchenko@example.com', role: 'Адміністратор', team: '—', st: 'ok', last: 'сьогодні 10:20' },
  vk: { n: 'Віктор Кравець', ini: 'ВК', email: 'viktor.kravets@example.com', role: 'Менеджер', team: 'Команда Ткача', st: 'off', last: '12.09.2026' },
};

const PROJECTS = {
  alpi: { code: 'ALPI', name: 'AI-школа ALPI', role: 'Менеджер', pipeline: 'ALPI' },
  franch: { code: 'Франч', name: '«Франч»', role: 'Керівник', pipeline: 'Франч' },
};

/* stages: count is the real number from the aggregate query; sums per currency; cards are the first loaded ones */
const STAGES = [
  { id: 's1', name: 'Новий лід', count: 84332, sums: {}, queue: true },
  { id: 's2', name: 'Передано в роботу', count: 412, sums: { EUR: 9480 } },
  { id: 's3', name: 'Був на вебінарі', count: 890, sums: { EUR: 18960, UAH: 62000 } },
  { id: 's4', name: 'Не вийшов на зв’язок', count: 325, sums: {} },
  { id: 's5', name: 'Дивиться запис вебінару', count: 60, sums: { EUR: 4130 } },
  { id: 's6', name: 'Приймає рішення', count: 130, sums: { EUR: 61870, USD: 9030, UAH: 186000 } },
  { id: 's7', name: 'Сплатив бронювання', count: 80, sums: { EUR: 70280, USD: 6450 }, required: ['Пакет', 'Тип закриття'] },
  { id: 's8', name: 'Виставили рахунок', count: 30, sums: { EUR: 26410, UAH: 89500 } },
  { id: 's9', name: 'Відкладений попит', count: 500, sums: { EUR: 43690 } },
];
const FRANCH_STAGES = ['Новий лід', 'Перший контакт', 'Пройшов кваліфікацію', 'Призначено зустріч', 'Зустріч проведена', 'Друга зустріч', 'Підписання договору'];

/* t = next task: overdue | today | future | none */
const CARDS = {
  s1: [
    { id: 4821, t: 'Оксана Савченко', c: 'Оксана Савченко', a: 0, cur: 'EUR', r: null, task: ['none'], src: 'Facebook Ads' },
    { id: 4820, t: 'Богдан Кравченко', c: 'Богдан Кравченко', a: 0, cur: 'EUR', r: null, task: ['none'], src: 'Instagram' },
    { id: 4818, t: 'Юлія Поліщук', c: 'Юлія Поліщук', a: 0, cur: 'EUR', r: null, task: ['today', 'сьогодні'], src: 'Google Ads' },
    { id: 4815, t: 'Артем Олійник', c: 'Артем Олійник', a: 0, cur: 'EUR', r: null, task: ['none'], src: 'ManyChat' },
    { id: 4811, t: 'Віра Мороз', c: 'Віра Мороз', a: 0, cur: 'EUR', r: 'as', task: ['future', '06.11'], src: 'Facebook Ads' },
  ],
  s2: [
    { id: 4790, t: 'Максим Бойко', c: 'Максим Бойко', a: 690, cur: 'EUR', r: 'ok', task: ['today', 'сьогодні 14:00'] },
    { id: 4782, t: 'Тетяна Гнатюк', c: 'Тетяна Гнатюк', a: 0, cur: 'EUR', r: 'as', task: ['overdue', 'прострочено 2 дні'] },
    { id: 4777, t: 'Віктор Мельничук', c: 'Віктор Мельничук', a: 0, cur: 'EUR', r: 'mb', task: ['future', '07.11 11:00'] },
  ],
  s3: [
    { id: 4702, t: 'Наталія Шевченко', c: 'Наталія Шевченко', a: 1190, cur: 'EUR', r: 'ok', task: ['today', 'сьогодні 16:30'] },
    { id: 4699, t: 'Олег Бойко', c: 'Олег Бойко', a: 31000, cur: 'UAH', r: 'dt', task: ['overdue', 'прострочено 1 день'] },
    { id: 4690, t: 'Ганна Руденко', c: 'Ганна Руденко', a: 0, cur: 'EUR', r: 'as', task: ['none'] },
    { id: 4688, t: 'Роман Ковальчук', c: 'Роман Ковальчук', a: 690, cur: 'EUR', r: 'mb', task: ['future', '09.11'] },
  ],
  s4: [
    { id: 4650, t: 'Дарина Лук’яненко', c: 'Дарина Лук’яненко', a: 0, cur: 'EUR', r: 'ok', task: ['overdue', 'прострочено 4 дні'] },
    { id: 4641, t: 'Степан Іваненко', c: 'Степан Іваненко', a: 0, cur: 'EUR', r: 'dt', task: ['future', '08.11'] },
  ],
  s5: [
    { id: 4602, t: 'Людмила Харченко', c: 'Людмила Харченко', a: 690, cur: 'EUR', r: 'il', task: ['today', 'сьогодні'] },
  ],
  s6: [
    { id: 4517, t: 'Ірина Мельник — AI-контент PRO', c: 'Ірина Мельник', a: 1290, cur: 'EUR', r: 'ok', task: ['today', 'сьогодні 12:00'] },
    { id: 4510, t: 'Павло Сидоренко', c: 'Павло Сидоренко', a: 2150, cur: 'USD', r: 'mb', task: ['overdue', 'прострочено 3 дні'] },
    { id: 4506, t: 'Злата Петренко', c: 'Злата Петренко', a: 53500, cur: 'UAH', r: 'as', task: ['future', '10.11 18:00'] },
  ],
  s7: [
    { id: 4430, t: 'Катерина Дорошенко', c: 'Катерина Дорошенко', a: 1990, cur: 'EUR', r: 'ok', task: ['future', '12.11'] },
    { id: 4422, t: 'Ярослав Ткаченко', c: 'Ярослав Ткаченко', a: 1290, cur: 'USD', r: 'il', task: ['none'] },
  ],
  s8: [
    { id: 4391, t: 'Марта Гаврилюк', c: 'Марта Гаврилюк', a: 89500, cur: 'UAH', r: 'dt', task: ['today', 'сьогодні 18:00'] },
  ],
  s9: [
    { id: 4120, t: 'Денис Литвиненко', c: 'Денис Литвиненко', a: 1190, cur: 'EUR', r: 'as', task: ['future', '01.12'] },
    { id: 4102, t: 'Аліна Зінченко', c: 'Аліна Зінченко', a: 690, cur: 'EUR', r: 'mb', task: ['future', '15.12'] },
  ],
};

const LIST_ROWS = [
  [4821, 'Оксана Савченко', 'Оксана Савченко', 'Новий лід', 0, 'EUR', null, ['none', 'немає задачі'], '02.11.2026', 'Facebook Ads', 'ai_content_webinar_oct'],
  [4820, 'Богдан Кравченко', 'Богдан Кравченко', 'Новий лід', 0, 'EUR', null, ['none', 'немає задачі'], '02.11.2026', 'Instagram', 'ai_video_nov'],
  [4790, 'Максим Бойко', 'Максим Бойко', 'Передано в роботу', 690, 'EUR', 'ok', ['today', 'сьогодні 14:00'], '28.10.2026', 'Google Ads', 'search_ai_kurs'],
  [4702, 'Наталія Шевченко', 'Наталія Шевченко', 'Був на вебінарі', 1190, 'EUR', 'ok', ['today', 'сьогодні 16:30'], '26.10.2026', 'Facebook Ads', 'ai_content_webinar_oct'],
  [4699, 'Олег Бойко', 'Олег Бойко', 'Був на вебінарі', 31000, 'UAH', 'dt', ['overdue', 'прострочено 1 день'], '25.10.2026', 'YouTube', 'yt_ai_shorts'],
  [4650, 'Дарина Лук’яненко', 'Дарина Лук’яненко', 'Не вийшов на зв’язок', 0, 'EUR', 'ok', ['overdue', 'прострочено 4 дні'], '21.10.2026', 'ManyChat', 'mc_bot_oct'],
  [4517, 'Ірина Мельник — AI-контент PRO', 'Ірина Мельник', 'Приймає рішення', 1290, 'EUR', 'ok', ['today', 'сьогодні 12:00'], '26.10.2026', 'Facebook Ads', 'ai_content_webinar_oct'],
  [4510, 'Павло Сидоренко', 'Павло Сидоренко', 'Приймає рішення', 2150, 'USD', 'mb', ['overdue', 'прострочено 3 дні'], '19.10.2026', 'Google Ads', 'search_ai_kurs'],
  [4430, 'Катерина Дорошенко', 'Катерина Дорошенко', 'Сплатив бронювання', 1990, 'EUR', 'ok', ['future', '12.11'], '12.10.2026', 'Facebook Ads', 'ai_content_webinar_sep'],
  [4391, 'Марта Гаврилюк', 'Марта Гаврилюк', 'Виставили рахунок', 89500, 'UAH', 'dt', ['today', 'сьогодні 18:00'], '08.10.2026', 'Instagram', 'ai_video_oct'],
  [4120, 'Денис Литвиненко', 'Денис Литвиненко', 'Відкладений попит', 1190, 'EUR', 'as', ['future', '01.12'], '14.09.2026', 'Facebook Ads', 'ai_content_webinar_sep'],
  [3990, 'Аліна Зінченко', 'Аліна Зінченко', 'Відкладений попит', 690, 'EUR', 'mb', ['future', '15.12'], '02.09.2026', 'Google Ads', 'search_ai_kurs'],
];

const SEARCH = {
  deals: [['4517', 'Ірина Мельник — AI-контент PRO', 'Приймає рішення'], ['3302', 'Ірина Мельник', 'в архіві з 12.08']],
  contacts: [['Ірина Мельник', '+380 00 123 45 67'], ['Андрій Мельник', 'учасник угоди 4517']],
  orgs: [['ФОП Мельник І. В.', 'Київ']],
};
