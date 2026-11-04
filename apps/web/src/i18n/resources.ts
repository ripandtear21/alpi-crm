import ruAuth from '../locales/ru/auth.json'
import ruCommon from '../locales/ru/common.json'
import ruDeals from '../locales/ru/deals.json'
import ruHome from '../locales/ru/home.json'
import ruLayout from '../locales/ru/layout.json'
import ruSettings from '../locales/ru/settings.json'
import ukAuth from '../locales/uk/auth.json'
import ukCommon from '../locales/uk/common.json'
import ukDeals from '../locales/uk/deals.json'
import ukHome from '../locales/uk/home.json'
import ukLayout from '../locales/uk/layout.json'
import ukSettings from '../locales/uk/settings.json'

// Переводы разложены по разделам интерфейса (namespace i18next): один файл — один раздел.
const uk = {
  common: ukCommon,
  layout: ukLayout,
  home: ukHome,
  deals: ukDeals,
  auth: ukAuth,
  settings: ukSettings,
}

// Русский обязан повторять структуру украинского: пропущенный ключ — ошибка typecheck.
const ru: typeof uk = {
  common: ruCommon,
  layout: ruLayout,
  home: ruHome,
  deals: ruDeals,
  auth: ruAuth,
  settings: ruSettings,
}

export const resources = { uk, ru }

export const defaultNS = 'common'

export const namespaces = Object.keys(uk) as (keyof typeof uk)[]
