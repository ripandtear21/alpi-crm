import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
} from '@tanstack/react-router'
import { HomePage } from './home-page.tsx'
import { AppLayout } from './layout/app-layout.tsx'
import { SectionPlaceholder } from './layout/section-placeholder.tsx'

const rootRoute = createRootRoute({
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
})

// Разделы левого меню; пока у каждого временная страница-заглушка.
const dealsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/deals',
  component: () => <SectionPlaceholder title="nav.deals" />,
})

const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contacts',
  component: () => <SectionPlaceholder title="nav.contacts" />,
})

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  component: () => <SectionPlaceholder title="nav.tasks" />,
})

const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  component: () => <SectionPlaceholder title="nav.reports" />,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: () => <SectionPlaceholder title="nav.settings" />,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  dealsRoute,
  contactsRoute,
  tasksRoute,
  reportsRoute,
  settingsRoute,
])

// История передаётся снаружи только в тестах (в памяти); в браузере — обычная история.
export function createAppRouter(history?: RouterHistory) {
  return createRouter(history ? { routeTree, history } : { routeTree })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
