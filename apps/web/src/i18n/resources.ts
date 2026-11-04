import ruAudit from '../locales/ru/audit.json'
import ruAuth from '../locales/ru/auth.json'
import ruCommon from '../locales/ru/common.json'
import ruDeals from '../locales/ru/deals.json'
import ruHome from '../locales/ru/home.json'
import ruLayout from '../locales/ru/layout.json'
import ruSettings from '../locales/ru/settings.json'
import ukAudit from '../locales/uk/audit.json'
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
  audit: ukAudit,
}

// Русский обязан повторять структуру украинского: пропущенный ключ — ошибка typecheck.
const ru: typeof uk = {
  common: ruCommon,
  layout: ruLayout,
  home: ruHome,
  deals: ruDeals,
  auth: ruAuth,
  settings: ruSettings,
  audit: ruAudit,
}

export const resources = { uk, ru }

export const defaultNS = 'common'

export const namespaces = Object.keys(uk) as (keyof typeof uk)[]
