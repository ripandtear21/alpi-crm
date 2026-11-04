import ruCommon from '../locales/ru/common.json'
import ruDeals from '../locales/ru/deals.json'
import ruHome from '../locales/ru/home.json'
import ruLayout from '../locales/ru/layout.json'
import ukCommon from '../locales/uk/common.json'
import ukDeals from '../locales/uk/deals.json'
import ukHome from '../locales/uk/home.json'
import ukLayout from '../locales/uk/layout.json'

// Переводы разложены по разделам интерфейса (namespace i18next): один файл — один раздел.
const uk = { common: ukCommon, layout: ukLayout, home: ukHome, deals: ukDeals }

// Русский обязан повторять структуру украинского: пропущенный ключ — ошибка typecheck.
const ru: typeof uk = { common: ruCommon, layout: ruLayout, home: ruHome, deals: ruDeals }

export const resources = { uk, ru }

export const defaultNS = 'common'

export const namespaces = Object.keys(uk) as (keyof typeof uk)[]
