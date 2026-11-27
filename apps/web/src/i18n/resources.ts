import ruAudit from '../locales/ru/audit.json'
import ruAuth from '../locales/ru/auth.json'
import ruCommon from '../locales/ru/common.json'
import ruContactCard from '../locales/ru/contact-card.json'
import ruCustomFields from '../locales/ru/custom-fields.json'
import ruDealCard from '../locales/ru/deal-card.json'
import ruDeals from '../locales/ru/deals.json'
import ruDuplicates from '../locales/ru/duplicates.json'
import ruFieldsSettings from '../locales/ru/fields-settings.json'
import ruHome from '../locales/ru/home.json'
import ruIntakeSources from '../locales/ru/intake-sources.json'
import ruLayout from '../locales/ru/layout.json'
import ruLists from '../locales/ru/lists.json'
import ruOrganizationCard from '../locales/ru/organization-card.json'
import ruSettings from '../locales/ru/settings.json'
import ruTimeline from '../locales/ru/timeline.json'
import ruWebhooks from '../locales/ru/webhooks.json'
import ukAudit from '../locales/uk/audit.json'
import ukAuth from '../locales/uk/auth.json'
import ukCommon from '../locales/uk/common.json'
import ukContactCard from '../locales/uk/contact-card.json'
import ukCustomFields from '../locales/uk/custom-fields.json'
import ukDealCard from '../locales/uk/deal-card.json'
import ukDeals from '../locales/uk/deals.json'
import ukDuplicates from '../locales/uk/duplicates.json'
import ukFieldsSettings from '../locales/uk/fields-settings.json'
import ukHome from '../locales/uk/home.json'
import ukIntakeSources from '../locales/uk/intake-sources.json'
import ukLayout from '../locales/uk/layout.json'
import ukLists from '../locales/uk/lists.json'
import ukOrganizationCard from '../locales/uk/organization-card.json'
import ukSettings from '../locales/uk/settings.json'
import ukTimeline from '../locales/uk/timeline.json'
import ukWebhooks from '../locales/uk/webhooks.json'

// Переводы разложены по разделам интерфейса (namespace i18next): один файл — один раздел.
const uk = {
  common: ukCommon,
  layout: ukLayout,
  home: ukHome,
  deals: ukDeals,
  auth: ukAuth,
  settings: ukSettings,
  audit: ukAudit,
  'deal-card': ukDealCard,
  timeline: ukTimeline,
  'contact-card': ukContactCard,
  'organization-card': ukOrganizationCard,
  lists: ukLists,
  'custom-fields': ukCustomFields,
  'fields-settings': ukFieldsSettings,
  webhooks: ukWebhooks,
  duplicates: ukDuplicates,
  'intake-sources': ukIntakeSources,
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
  'deal-card': ruDealCard,
  timeline: ruTimeline,
  'contact-card': ruContactCard,
  'organization-card': ruOrganizationCard,
  lists: ruLists,
  'custom-fields': ruCustomFields,
  'fields-settings': ruFieldsSettings,
  webhooks: ruWebhooks,
  duplicates: ruDuplicates,
  'intake-sources': ruIntakeSources,
}

export const resources = { uk, ru }

export const defaultNS = 'common'

export const namespaces = Object.keys(uk) as (keyof typeof uk)[]
