import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router'
import { HomePage } from './home-page.tsx'
import { AppLayout } from './layout/app-layout.tsx'
import { SectionPlaceholder } from './layout/section-placeholder.tsx'
import { type AuthApi, createAuthApi } from './routes/auth/auth-api.ts'
import { SignInPage } from './routes/auth/sign-in-page.tsx'
import { TwoFactorPage } from './routes/auth/two-factor-page.tsx'
import { TwoFactorSetupPage } from './routes/auth/two-factor-setup-page.tsx'

export interface RouterContext {
  auth: AuthApi
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
})

// Экраны входа — без каркаса интерфейса.
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  component: SignInPage,
})

const twoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in/two-factor',
  component: TwoFactorPage,
})

const twoFactorSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/two-factor-setup',
  beforeLoad: async ({ context }) => {
    const session = await context.auth.getSession()
    if (!session) throw redirect({ to: '/sign-in' })
    // Уже включена — на главную; сессию без второго фактора оттуда отправят на вход.
    if (session.user.twoFactorEnabled) throw redirect({ to: '/' })
  },
  component: TwoFactorSetupPage,
})

// Всё остальное — в каркасе и только после входа с 2FA: без сессии — на экран входа,
// с сессией без 2FA — на её настройку (API без 2FA всё равно отвечает 403). Сессия, открытая
// по одному паролю до включения 2FA, — как без входа: API отвечает ей 401.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context }) => {
    const session = await context.auth.getSession()
    if (!session) throw redirect({ to: '/sign-in' })
    if (!session.user.twoFactorEnabled) throw redirect({ to: '/two-factor-setup' })
    if (!session.session.twoFactorVerified) throw redirect({ to: '/sign-in' })
    return { session }
  },
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: HomePage,
})

// Разделы левого меню; пока у каждого временная страница-заглушка.
const dealsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/deals',
  component: () => <SectionPlaceholder title="nav.deals" />,
})

const contactsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/contacts',
  component: () => <SectionPlaceholder title="nav.contacts" />,
})

const tasksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/tasks',
  component: () => <SectionPlaceholder title="nav.tasks" />,
})

const reportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports',
  component: () => <SectionPlaceholder title="nav.reports" />,
})

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: () => <SectionPlaceholder title="nav.settings" />,
})

const routeTree = rootRoute.addChildren([
  signInRoute,
  twoFactorRoute,
  twoFactorSetupRoute,
  appRoute.addChildren([
    indexRoute,
    dealsRoute,
    contactsRoute,
    tasksRoute,
    reportsRoute,
    settingsRoute,
  ]),
])

export interface AppRouterOptions {
  /** Только в тестах: история в памяти. В браузере — обычная история. */
  history?: RouterHistory
  /** Только в тестах: подставной клиент входа. В браузере — запросы к API. */
  auth?: AuthApi
}

export function createAppRouter({ history, auth = createAuthApi() }: AppRouterOptions = {}) {
  const context: RouterContext = { auth }
  return createRouter(history ? { routeTree, context, history } : { routeTree, context })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
