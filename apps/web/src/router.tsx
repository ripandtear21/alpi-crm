import { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router'
import { CurrentProjectProvider } from './components/project-switcher/current-project.tsx'
import { createProjectsApi, type ProjectsApi } from './components/project-switcher/projects-api.ts'
import { HomePage } from './home-page.tsx'
import { AppLayout } from './layout/app-layout.tsx'
import { SectionPlaceholder } from './layout/section-placeholder.tsx'
import { type AuthApi, createAuthApi } from './routes/auth/auth-api.ts'
import { SignInPage } from './routes/auth/sign-in-page.tsx'
import { TwoFactorPage } from './routes/auth/two-factor-page.tsx'
import { TwoFactorSetupPage } from './routes/auth/two-factor-setup-page.tsx'
import { type AuditApi, createAuditApi } from './routes/settings/audit-api.ts'
import { AuditPage } from './routes/settings/audit-page.tsx'
import { createRolesApi, type RolesApi } from './routes/settings/roles-api.ts'
import { RolesPage } from './routes/settings/roles-page.tsx'
import { SettingsPage } from './routes/settings/settings-page.tsx'

export interface RouterContext {
  auth: AuthApi
  projects: ProjectsApi
  roles: RolesApi
  audit: AuditApi
  /** Кэш TanStack Query приложения: тот же, что в QueryClientProvider (main.tsx). */
  queryClient: QueryClient
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
    // Проекты пользователя — для переключателя в шапке. В ключе id пользователя: после
    // выхода и входа другим пользователем в той же вкладке чужой список не покажется.
    const projects = await context.queryClient.ensureQueryData({
      queryKey: ['projects', session.user.id],
      queryFn: () => context.projects.list(),
    })
    return { session, projects }
  },
  component: AppShell,
})

function AppShell() {
  const { projects, queryClient } = appRoute.useRouteContext()
  return (
    <CurrentProjectProvider projects={projects} queryClient={queryClient}>
      <AppLayout>
        <Outlet />
      </AppLayout>
    </CurrentProjectProvider>
  )
}

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
  component: SettingsPage,
})

const rolesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/roles',
  component: function RolesRoute() {
    const { roles } = rolesRoute.useRouteContext()
    return <RolesPage api={roles} />
  },
})

const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/audit',
  component: function AuditRoute() {
    const { audit } = auditRoute.useRouteContext()
    return <AuditPage api={audit} />
  },
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
    rolesRoute,
    auditRoute,
  ]),
])

export interface AppRouterOptions {
  /** Только в тестах: история в памяти. В браузере — обычная история. */
  history?: RouterHistory
  /** Только в тестах: подставной клиент входа. В браузере — запросы к API. */
  auth?: AuthApi
  /** Только в тестах: подставной клиент проектов. В браузере — запросы к API. */
  projects?: ProjectsApi
  /** Только в тестах: подставной клиент ролей. В браузере — запросы к API. */
  roles?: RolesApi
  /** Только в тестах: подставной клиент журнала. В браузере — запросы к API. */
  audit?: AuditApi
  /** В браузере — кэш из main.tsx; в тестах — новый на каждый роутер. */
  queryClient?: QueryClient
}

export function createAppRouter({
  history,
  auth = createAuthApi(),
  projects = createProjectsApi(),
  roles = createRolesApi(),
  audit = createAuditApi(),
  queryClient = new QueryClient(),
}: AppRouterOptions = {}) {
  const context: RouterContext = { auth, projects, roles, audit, queryClient }
  return createRouter(history ? { routeTree, context, history } : { routeTree, context })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
