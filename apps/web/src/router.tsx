import type { ProjectSummary } from '@alpi/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  redirect,
  useRouterState,
} from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { type ContactsApi, createContactsApi } from './components/contact-form/contacts-api.ts'
import {
  CurrentProjectProvider,
  pickProject,
  projectHref,
  readStoredProjectId,
  useCurrentProject,
} from './components/project-switcher/current-project.tsx'
import { createProjectsApi, type ProjectsApi } from './components/project-switcher/projects-api.ts'
import { createSearchApi, type SearchApi } from './components/search-bar/search-api.ts'
import { createTimelineApi, type TimelineApi } from './components/timeline/timeline-api.ts'
import { HomePage } from './home-page.tsx'
import { AppLayout } from './layout/app-layout.tsx'
import { DelayedNoAccess, NoAccess } from './layout/no-access.tsx'
import { SectionPlaceholder } from './layout/section-placeholder.tsx'
import type { WebhookAlertsApi } from './layout/webhook-alerts-api.ts'
import { type AuthApi, createAuthApi } from './routes/auth/auth-api.ts'
import { ChangePasswordPage } from './routes/auth/change-password-page.tsx'
import { SignInPage } from './routes/auth/sign-in-page.tsx'
import { TwoFactorPage } from './routes/auth/two-factor-page.tsx'
import { TwoFactorSetupPage } from './routes/auth/two-factor-setup-page.tsx'
import { ContactCardPage } from './routes/contacts/$contactId/contact-card-page.tsx'
import { ContactsListPage } from './routes/contacts/contacts-list-page.tsx'
import { createDealCardApi, type DealCardApi } from './routes/deals/$dealId/deal-card-api.ts'
import { DealCardPage } from './routes/deals/$dealId/deal-card-page.tsx'
import { createDealsApi, type DealsApi } from './routes/deals/deals-api.ts'
import { KanbanPage } from './routes/deals/kanban-page.tsx'
import { DealsListPage, type DealsListSearch } from './routes/deals/list/deals-list-page.tsx'
import { createListsApi, type ListsApi } from './routes/deals/list/lists-api.ts'
import { OrganizationCardPage } from './routes/organizations/$organizationId/organization-card-page.tsx'
import { OrganizationsListPage } from './routes/organizations/organizations-list-page.tsx'
import { type ApiKeysApi, createApiKeysApi } from './routes/settings/api-keys-api.ts'
import { ApiKeysPage } from './routes/settings/api-keys-page.tsx'
import { type AuditApi, createAuditApi } from './routes/settings/audit-api.ts'
import { AuditPage } from './routes/settings/audit-page.tsx'
import {
  createFieldsSettingsApi,
  type FieldsSettingsApi,
} from './routes/settings/fields/fields-api.ts'
import { FieldsPage } from './routes/settings/fields/fields-page.tsx'
import { LostReasonsPage } from './routes/settings/lost-reasons-page.tsx'
import { createMembersApi, type MembersApi } from './routes/settings/members-api.ts'
import { MembersPage } from './routes/settings/members-page.tsx'
import { createPipelinesApi, type PipelinesApi } from './routes/settings/pipelines-api.ts'
import { PipelinesPage } from './routes/settings/pipelines-page.tsx'
import { createProductsApi, type ProductsApi } from './routes/settings/products-api.ts'
import { ProductsPage } from './routes/settings/products-page.tsx'
import { createRolesApi, type RolesApi } from './routes/settings/roles-api.ts'
import { RolesPage } from './routes/settings/roles-page.tsx'
import { SettingsPage } from './routes/settings/settings-page.tsx'
import { TeamsPage } from './routes/settings/teams-page.tsx'
import { TrashPage } from './routes/settings/trash-page.tsx'
import { createWebhooksApi, type WebhooksApi } from './routes/settings/webhooks/webhooks-api.ts'
import { WebhooksPage } from './routes/settings/webhooks/webhooks-page.tsx'
import { ToastProvider } from './ui/toast.tsx'

export interface RouterContext {
  auth: AuthApi
  projects: ProjectsApi
  roles: RolesApi
  audit: AuditApi
  members: MembersApi
  pipelines: PipelinesApi
  products: ProductsApi
  deals: DealsApi
  dealCard: DealCardApi
  timeline: TimelineApi
  contacts: ContactsApi
  lists: ListsApi
  search: SearchApi
  /** Конструктор полей в настройках (тикет crm-fields/05). */
  fields: FieldsSettingsApi
  /** Ключи API проекта в настройках (тикет crm-api/01). */
  apiKeys: ApiKeysApi
  /** Вебхуки проекта в настройках (тикет crm-api/07). */
  webhooks: WebhooksApi
  /**
   * Предупреждение в шапке об отключённых адресах событий (тикет crm-api/06). Нет — нет и
   * предупреждения: тестам маршрутов оно не нужно, браузеру его передаёт main.tsx.
   */
  webhookAlerts?: WebhookAlertsApi | undefined
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

// Первый вход с временным паролем: сначала смена пароля, потом настройка 2FA.
const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/change-password',
  beforeLoad: async ({ context }) => {
    const session = await context.auth.getSession()
    if (!session) throw redirect({ to: '/sign-in' })
    if (!session.user.mustChangePassword) throw redirect({ to: '/' })
  },
  component: ChangePasswordPage,
})

const twoFactorSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/two-factor-setup',
  beforeLoad: async ({ context }) => {
    const session = await context.auth.getSession()
    if (!session) throw redirect({ to: '/sign-in' })
    if (session.user.mustChangePassword) throw redirect({ to: '/change-password' })
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
    if (session.user.mustChangePassword) throw redirect({ to: '/change-password' })
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
  const { projects, queryClient, search, webhookAlerts } = appRoute.useRouteContext()
  // Код проекта — из адреса (`/p/<код>/…`); шапке он нужен так же, как экрану.
  const code = useRouterState({
    select: (state) =>
      (
        state.matches.find((match) => match.routeId === projectRoute.id)?.params as
          | { code?: string }
          | undefined
      )?.code,
  })
  // Провайдер кэша — тот же клиент, что в main.tsx: каркас (строка поиска) работает и там,
  // где выше провайдера нет (тесты маршрутов).
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <CurrentProjectProvider projects={projects} code={code} queryClient={queryClient}>
          <AppLayout search={search} webhookAlerts={webhookAlerts}>
            <Outlet />
          </AppLayout>
        </CurrentProjectProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}

// Адрес без проекта (старые ссылки, «/» после входа) — тот же экран в проекте, открытом
// в прошлый раз, или в первом доступном. Адрес `/p/…`, которому нет экрана, остаётся:
// показывается «немає доступу».
function toProjectAddress({
  context,
  location,
}: {
  context: { projects: ProjectSummary[] }
  location: { pathname: string; searchStr: string; hash: string }
}) {
  if (location.pathname === '/p' || location.pathname.startsWith('/p/')) return
  const project = pickProject(context.projects, readStoredProjectId())
  if (!project) return
  const path = location.pathname === '/' ? '' : location.pathname
  const hash = location.hash ? `#${location.hash}` : ''
  throw redirect({
    href: projectHref(project.code, `${path}${location.searchStr}${hash}`),
    replace: true,
  })
}

const legacyIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: toProjectAddress,
  component: NoProjectsPage,
})

const legacyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '$',
  beforeLoad: toProjectAddress,
  component: NoProjectsPage,
})

/** Сюда приводит адрес без проекта, когда проектов нет, или `/p/…` без экрана. */
function NoProjectsPage() {
  const { t } = useTranslation('layout')
  const { projects } = useCurrentProject()
  if (projects.length > 0) return <NoAccess />
  return (
    <section>
      <h1>{t('project.none')}</h1>
      <p>{t('project.noneHint')}</p>
    </section>
  )
}

// Экраны проекта: `/p/<код проекта>/…`. Код, которого нет среди проектов пользователя (не
// участник или такого проекта нет), — нейтральный экран «немає доступу».
const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/p/$code',
  component: function ProjectScreen() {
    const { current } = useCurrentProject()
    return current ? <Outlet /> : <DelayedNoAccess />
  },
})

const indexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  component: HomePage,
})

// Разделы левого меню; у кого ещё нет экрана — временная страница-заглушка.
const dealsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'deals',
  // Воронка канбана — в адресе: ссылка открывает ту же воронку.
  validateSearch: (search: Record<string, unknown>): { pipeline?: string } =>
    typeof search.pipeline === 'string' ? { pipeline: search.pipeline } : {},
  component: function DealsRoute() {
    const { deals, session, queryClient } = dealsRoute.useRouteContext()
    const { pipeline } = dealsRoute.useSearch()
    const navigate = dealsRoute.useNavigate()
    return (
      <KanbanPage
        api={deals}
        userId={session.user.id}
        queryClient={queryClient}
        pipelineId={pipeline}
        onPipelineChange={(id) => void navigate({ search: { pipeline: id }, replace: true })}
      />
    )
  },
})

// Списки сделок, контактов и организаций (тикет crm-deals/12).
const dealsListRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'deals/list',
  validateSearch: (search: Record<string, unknown>): DealsListSearch => ({
    ...(typeof search.pipeline === 'string' ? { pipeline: search.pipeline } : {}),
    ...(typeof search.stage === 'string' ? { stage: search.stage } : {}),
    // Роутер сам разбирает JSON в адресе: фильтр приходит объектом — вернём ему вид строки.
    ...(typeof search.filter === 'string'
      ? { filter: search.filter }
      : typeof search.filter === 'object' && search.filter !== null
        ? { filter: JSON.stringify(search.filter) }
        : {}),
  }),
  component: function DealsListRoute() {
    const { lists, session, queryClient } = dealsListRoute.useRouteContext()
    const search = dealsListRoute.useSearch()
    return (
      <DealsListPage
        api={lists}
        userId={session.user.id}
        queryClient={queryClient}
        search={search}
      />
    )
  },
})

const contactsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'contacts',
  component: function ContactsRoute() {
    const { lists, session, queryClient } = contactsRoute.useRouteContext()
    return <ContactsListPage api={lists} userId={session.user.id} queryClient={queryClient} />
  },
})

const organizationsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'organizations',
  component: function OrganizationsRoute() {
    const { lists, session, queryClient } = organizationsRoute.useRouteContext()
    return <OrganizationsListPage api={lists} userId={session.user.id} queryClient={queryClient} />
  },
})

const tasksRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'tasks',
  component: () => <SectionPlaceholder title="nav.tasks" />,
})

const reportsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'reports',
  component: () => <SectionPlaceholder title="nav.reports" />,
})

const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings',
  component: function SettingsRoute() {
    const { fields } = settingsRoute.useRouteContext()
    return <SettingsPage access={fields.access} />
  },
})

const rolesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/roles',
  component: function RolesRoute() {
    const { roles } = rolesRoute.useRouteContext()
    return <RolesPage api={roles} />
  },
})

const auditRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/audit',
  component: function AuditRoute() {
    const { audit } = auditRoute.useRouteContext()
    return <AuditPage api={audit} />
  },
})

const membersRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/users',
  component: function MembersRoute() {
    const { members, roles } = membersRoute.useRouteContext()
    return <MembersPage api={members} roles={roles} />
  },
})

const teamsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/teams',
  component: function TeamsRoute() {
    const { members } = teamsRoute.useRouteContext()
    return <TeamsPage api={members} />
  },
})

const pipelinesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/pipelines',
  component: function PipelinesRoute() {
    const { pipelines } = pipelinesRoute.useRouteContext()
    return <PipelinesPage api={pipelines} />
  },
})

const lostReasonsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/lost-reasons',
  component: function LostReasonsRoute() {
    const { pipelines } = lostReasonsRoute.useRouteContext()
    return <LostReasonsPage api={pipelines} />
  },
})

const productsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/products',
  component: function ProductsRoute() {
    const { products } = productsRoute.useRouteContext()
    return <ProductsPage api={products} />
  },
})

// Налаштування → Ключі API (тикет crm-api/01).
const apiKeysRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/api-keys',
  component: function ApiKeysRoute() {
    const { apiKeys } = apiKeysRoute.useRouteContext()
    return <ApiKeysPage api={apiKeys} />
  },
})

// Налаштування → Вебхуки (тикет crm-api/07).
const webhooksRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/webhooks',
  component: function WebhooksRoute() {
    const { webhooks } = webhooksRoute.useRouteContext()
    return <WebhooksPage api={webhooks} />
  },
})

// Налаштування → Поля (тикет crm-fields/05).
const fieldsSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/fields',
  component: function FieldsSettingsRoute() {
    const { fields } = fieldsSettingsRoute.useRouteContext()
    return <FieldsPage api={fields} />
  },
})

const trashRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'settings/trash',
  component: function TrashRoute() {
    const { lists, queryClient } = trashRoute.useRouteContext()
    return <TrashPage api={lists} queryClient={queryClient} />
  },
})

// Карточка сделки (тикет crm-deals/13).
const dealCardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'deals/$dealId',
  component: function DealCardRoute() {
    const { dealCard, timeline, session } = dealCardRoute.useRouteContext()
    const { dealId } = dealCardRoute.useParams()
    return <DealCardPage api={dealCard} timeline={timeline} dealId={dealId} user={session.user} />
  },
})

// Карточки контакта и организации (тикет crm-deals/14).
const contactCardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'contacts/$contactId',
  component: function ContactCardRoute() {
    const { contacts, deals, timeline, session } = contactCardRoute.useRouteContext()
    const { contactId } = contactCardRoute.useParams()
    return (
      <ContactCardPage
        api={contacts}
        deals={deals}
        timeline={timeline}
        contactId={contactId}
        user={session.user}
      />
    )
  },
})

const organizationCardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'organizations/$organizationId',
  component: function OrganizationCardRoute() {
    const { contacts, timeline, session } = organizationCardRoute.useRouteContext()
    const { organizationId } = organizationCardRoute.useParams()
    return (
      <OrganizationCardPage
        api={contacts}
        timeline={timeline}
        organizationId={organizationId}
        user={session.user}
      />
    )
  },
})

const routeTree = rootRoute.addChildren([
  signInRoute,
  twoFactorRoute,
  twoFactorSetupRoute,
  changePasswordRoute,
  appRoute.addChildren([
    legacyIndexRoute,
    legacyRoute,
    projectRoute.addChildren([
      indexRoute,
      dealsRoute,
      dealsListRoute,
      contactsRoute,
      organizationsRoute,
      tasksRoute,
      reportsRoute,
      settingsRoute,
      rolesRoute,
      auditRoute,
      membersRoute,
      teamsRoute,
      pipelinesRoute,
      lostReasonsRoute,
      productsRoute,
      fieldsSettingsRoute,
      apiKeysRoute,
      webhooksRoute,
      trashRoute,
      dealCardRoute,
      contactCardRoute,
      organizationCardRoute,
    ]),
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
  /** Только в тестах: подставной клиент участников и команд. В браузере — запросы к API. */
  members?: MembersApi
  /** Только в тестах: подставной клиент воронок и причин проигрыша. В браузере — запросы к API. */
  pipelines?: PipelinesApi
  /** Только в тестах: подставной клиент каталога товаров. В браузере — запросы к API. */
  products?: ProductsApi
  /** Только в тестах: подставной клиент канбана сделок. В браузере — запросы к API. */
  deals?: DealsApi
  /** Только в тестах: подставной клиент карточки сделки. В браузере — запросы к API. */
  dealCard?: DealCardApi
  /** Только в тестах: подставной клиент ленты записи. В браузере — запросы к API. */
  timeline?: TimelineApi
  /** Только в тестах: подставной клиент карточек контакта и организации. В браузере — запросы к API. */
  contacts?: ContactsApi
  /** Только в тестах: подставной клиент списков, массовых действий и корзины. В браузере — запросы к API. */
  lists?: ListsApi
  /** Только в тестах: подставной клиент быстрого поиска. В браузере — запросы к API. */
  search?: SearchApi
  /** Только в тестах: подставной клиент конструктора полей. В браузере — запросы к API. */
  fields?: FieldsSettingsApi
  /** Только в тестах: подставной клиент ключей API. В браузере — запросы к API. */
  apiKeys?: ApiKeysApi
  /** Только в тестах: подставной клиент вебхуков. В браузере — запросы к API. */
  webhooks?: WebhooksApi
  /** Предупреждение об отключённых адресах событий; в тестах маршрутов — нет. */
  webhookAlerts?: WebhookAlertsApi
  /** В браузере — кэш из main.tsx; в тестах — новый на каждый роутер. */
  queryClient?: QueryClient
}

export function createAppRouter({
  history,
  auth = createAuthApi(),
  projects = createProjectsApi(),
  roles = createRolesApi(),
  audit = createAuditApi(),
  members = createMembersApi(),
  pipelines = createPipelinesApi(),
  products = createProductsApi(),
  deals = createDealsApi(),
  dealCard = createDealCardApi(),
  timeline = createTimelineApi(),
  contacts = createContactsApi(),
  lists = createListsApi(),
  search = createSearchApi(),
  fields = createFieldsSettingsApi(),
  apiKeys = createApiKeysApi(),
  webhooks = createWebhooksApi(),
  webhookAlerts,
  queryClient = new QueryClient(),
}: AppRouterOptions = {}) {
  const context: RouterContext = {
    auth,
    projects,
    roles,
    audit,
    members,
    pipelines,
    products,
    deals,
    dealCard,
    timeline,
    contacts,
    lists,
    search,
    fields,
    apiKeys,
    webhooks,
    webhookAlerts,
    queryClient,
  }
  return createRouter(history ? { routeTree, context, history } : { routeTree, context })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
