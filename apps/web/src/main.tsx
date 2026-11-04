import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from './i18n/index.ts'
import { createAppRouter } from './router.tsx'

const queryClient = new QueryClient()
const i18n = createI18n()
const router = createAppRouter({ queryClient })

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
