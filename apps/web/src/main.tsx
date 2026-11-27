// Общие стили — первыми: стили экранов, которые подключает маршрутизатор, идут после них и уточняют их.
import './styles/tokens.css'
import './styles/base.css'
import './ui/ui.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from './i18n/index.ts'
import { applyTheme, readStoredTheme } from './layout/theme.ts'
import { createWebhookAlertsApi } from './layout/webhook-alerts-api.ts'
import { createAppRouter } from './router.tsx'
import { createDuplicatesApi } from './routes/duplicates/duplicates-api.ts'

// Тема ставится до первой отрисовки, чтобы экран не мигнул чужой темой.
applyTheme(readStoredTheme())

const queryClient = new QueryClient()
const i18n = createI18n()
// Предупреждение в шапке об отключённых адресах событий (тикет crm-api/06); счётчик дублей в
// шапке и пункт меню «Дублі» (тикет crm-intake/05) — тем же клиентом, что экран.
const duplicates = createDuplicatesApi()
const router = createAppRouter({
  queryClient,
  webhookAlerts: createWebhookAlertsApi(),
  duplicates,
  duplicatesCounter: duplicates,
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Нет элемента #root в index.html')
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
)
