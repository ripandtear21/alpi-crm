import type { Page } from '@alpi/shared'
import { createContext, type ReactNode, useContext, useState } from 'react'
import { projectHeaders } from '../../../../components/project-switcher/projects-api.ts'

// Регистрации сделки и контакта (тикет crm-intake/09) из API (apps/api/src/registrations):
// страница регистраций, новые сверху, по курсору. В контексте текущего проекта, по сессии.
//
// Клиент берётся из RegistrationsApiProvider (тесты подставляют свой); без провайдера —
// настоящий, поэтому дерево маршрутов (router.tsx) о регистрациях не знает.

/** Просмотр вебинара (RegistrationView в apps/api/src/registrations/openapi.ts). */
export interface RegistrationWatch {
  startedAt: string | null
  finishedAt: string | null
  minutes: number | null
  extra: Record<string, unknown> | null
  updatedAt: string
}

/** Регистрация (Registration в apps/api/src/registrations/openapi.ts). */
export interface Registration {
  id: string
  sourceId: string
  sourceName: string
  contactId: string
  dealId: string | null
  dealTitle: string | null
  eventId: string
  createdAt: string
  registeredAt: string | null
  /** Имя, телефон и email — null, если контакт вне охвата пользователя. */
  name: string | null
  phone: string | null
  phoneRaw: string | null
  dialCode: string | null
  email: string | null
  form: string | null
  webinar: string | null
  planName: string | null
  pageUrl: string | null
  referrer: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmTerm: string | null
  utmContent: string | null
  adId: string | null
  gclid: string | null
  gbraid: string | null
  wbraid: string | null
  fbclid: string | null
  fbp: string | null
  fbc: string | null
  userAgent: string | null
  extra: Record<string, unknown>
  view: RegistrationWatch | null
}

/** Чьи регистрации: сделки или контакта (по всем его сделкам). */
export interface RegistrationsOwner {
  kind: 'deal' | 'contact'
  id: string
}

export interface RegistrationsApi {
  /** Страница регистраций, новые сверху; `cursor` — `next_cursor` предыдущей. */
  list(
    projectId: string,
    owner: RegistrationsOwner,
    cursor: string | null,
  ): Promise<Page<Registration>>
}

export class RegistrationsApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`API регистраций ответил ${status} ${code}`)
    this.name = 'RegistrationsApiError'
    this.status = status
    this.code = code
  }
}

/** Размер страницы в карточке. */
export const REGISTRATIONS_PAGE_SIZE = 20

export function createRegistrationsApi(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): RegistrationsApi {
  return {
    async list(projectId, owner, cursor) {
      const query = new URLSearchParams({ limit: String(REGISTRATIONS_PAGE_SIZE) })
      if (cursor !== null) query.set('cursor', cursor)
      const section = owner.kind === 'deal' ? 'deals' : 'contacts'
      const res = await fetchImpl(`/api/v1/${section}/${owner.id}/registrations?${query}`, {
        headers: projectHeaders(projectId),
        credentials: 'same-origin',
      })
      const payload = (await res.json().catch(() => null)) as unknown
      if (!res.ok) {
        const code = (payload as { code?: unknown } | null)?.code
        throw new RegistrationsApiError(res.status, typeof code === 'string' ? code : '')
      }
      return payload as Page<Registration>
    },
  }
}

const RegistrationsApiContext = createContext<RegistrationsApi | null>(null)

export function RegistrationsApiProvider({
  api,
  children,
}: {
  api: RegistrationsApi
  children: ReactNode
}) {
  return <RegistrationsApiContext.Provider value={api}>{children}</RegistrationsApiContext.Provider>
}

/** Клиент регистраций: из провайдера или настоящий. */
export function useRegistrationsApi(): RegistrationsApi {
  const provided = useContext(RegistrationsApiContext)
  const [real] = useState(createRegistrationsApi)
  return provided ?? real
}
