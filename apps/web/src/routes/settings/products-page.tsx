import {
  MAX_PRODUCT_NAME_LENGTH,
  PRODUCT_CURRENCIES,
  type ProductPrices,
  type ProductSummary,
} from '@alpi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FormEvent } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  projectQueryKey,
  useCurrentProject,
} from '../../components/project-switcher/current-project.tsx'
import { ArchiveButton, type Notice, NoticeLine } from './directory-controls.tsx'
import type { ProductChange, ProductInput, ProductsApi } from './products-api.ts'
import { RolesApiError } from './roles-api.ts'

// Настройки → Товари (тикет crm-deals/06): каталог проекта — название и цены в EUR, UAH и USD
// (любая может быть пустой), создать, изменить, отправить в архив и вернуть. Товары не
// удаляются: архивный не добавляется в новые строки сделок, но остаётся в старых. Смотреть —
// право «товари: бачити», менять — «створювати» и «змінювати».

export function ProductsPage({ api }: { api: ProductsApi }) {
  const { t } = useTranslation('settings')
  const { current } = useCurrentProject()
  if (!current) {
    return (
      <section>
        <h1>{t('products.title')}</h1>
        <p>{t('products.noProject')}</p>
      </section>
    )
  }
  return <ProductsEditor key={current.id} api={api} projectId={current.id} />
}

function useProductErrorText() {
  const { t } = useTranslation('settings')
  return (error: unknown) => {
    const code = error instanceof RolesApiError ? error.code : ''
    return t(`products.errors.${code}`, { defaultValue: t('roles.errors.unknown') })
  }
}

function ProductsEditor({ api, projectId }: { api: ProductsApi; projectId: string }) {
  const { t } = useTranslation('settings')
  const errorText = useProductErrorText()
  const queryClient = useQueryClient()
  const key = projectQueryKey(projectId, 'products')
  const products = useQuery({
    queryKey: key,
    queryFn: () => api.list(projectId),
    retry: false,
  })
  const [notice, setNotice] = useState<Notice>(null)

  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => setNotice({ kind: 'status', text: t('directory.saved') }),
    onError: (error) => setNotice({ kind: 'alert', text: errorText(error) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })

  if (products.isPending) return <p>{t('products.loading')}</p>
  if (products.isError) {
    const denied = products.error instanceof RolesApiError && products.error.status === 403
    return (
      <section>
        <h1>{t('products.title')}</h1>
        <p role="alert">{denied ? t('products.noAccess') : t('roles.errors.unknown')}</p>
      </section>
    )
  }

  /** Выполняет изменение; true — API принял его (форма создания очищается только тогда). */
  const run = (action: () => Promise<unknown>): Promise<boolean> => {
    setNotice(null)
    return change.mutateAsync(action).then(
      () => true,
      // Отказ уже показан сообщением (onError).
      () => false,
    )
  }
  const update = (id: string, value: ProductChange) => run(() => api.update(projectId, id, value))

  return (
    <section className="directory">
      <h1>{t('products.title')}</h1>
      <p className="directory__hint">{t('products.hint')}</p>
      <NoticeLine notice={notice} />
      {products.data.length === 0 && <p>{t('products.empty')}</p>}
      {products.data.map((product) => (
        <ProductCard
          // Новое название или цены с сервера — поля формы заново.
          key={`${product.id}|${product.name}|${JSON.stringify(product.prices)}`}
          product={product}
          pending={change.isPending}
          onChange={(value) => update(product.id, value)}
        />
      ))}
      <article className="directory__card">
        <h2>{t('products.new')}</h2>
        <ProductForm
          label={t('products.new')}
          submitLabel={t('products.create')}
          pending={change.isPending}
          onSubmit={(input) => run(() => api.create(projectId, input))}
          resetOnSuccess
        />
      </article>
    </section>
  )
}

function ProductCard({
  product,
  pending,
  onChange,
}: {
  product: ProductSummary
  pending: boolean
  onChange: (change: ProductChange) => Promise<boolean>
}) {
  const { t } = useTranslation('settings')
  const archived = product.archivedAt !== null
  return (
    <article
      className={archived ? 'directory__card directory__card--archived' : 'directory__card'}
      aria-label={product.name}
    >
      <h2>
        {product.name}
        {archived && <span className="directory__mark"> · {t('directory.archivedMark')}</span>}
      </h2>
      <ProductForm
        label={t('products.editOf', { name: product.name })}
        product={product}
        submitLabel={t('directory.save')}
        pending={pending}
        onSubmit={onChange}
      />
      <div className="directory__row">
        <ArchiveButton
          archived={archived}
          pending={pending}
          onChange={(value) => onChange({ archived: value })}
        />
      </div>
    </article>
  )
}

/** Цена из поля: пусто — цены нет (null); иначе число (поле type="number" не пропустит текст). */
function readPrice(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? '').trim()
  return text === '' ? null : Number(text)
}

function ProductForm({
  label,
  product,
  submitLabel,
  pending,
  onSubmit,
  resetOnSuccess = false,
}: {
  label: string
  product?: ProductSummary
  submitLabel: string
  pending: boolean
  onSubmit: (input: ProductInput) => Promise<boolean>
  resetOnSuccess?: boolean
}) {
  const { t } = useTranslation('settings')
  return (
    <form
      className="directory__settings"
      aria-label={label}
      onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        const element = event.currentTarget
        const data = new FormData(element)
        const name = String(data.get('name') ?? '').trim()
        if (name === '') return
        const prices = Object.fromEntries(
          PRODUCT_CURRENCIES.map((currency) => [currency, readPrice(data.get(currency))]),
        ) as ProductPrices
        // Очищается только после ответа API: при отказе введённое остаётся.
        if ((await onSubmit({ name, prices })) && resetOnSuccess) element.reset()
      }}
    >
      <label>
        {t('products.name')}{' '}
        <input
          name="name"
          defaultValue={product?.name}
          maxLength={MAX_PRODUCT_NAME_LENGTH}
          required
        />
      </label>
      {PRODUCT_CURRENCIES.map((currency) => (
        <label key={currency}>
          {t('products.price', { currency })}{' '}
          <input
            name={currency}
            type="number"
            inputMode="decimal"
            min={0}
            // Не 0.01: в happy-dom (тесты) проверка шага двоичными дробями отвергает и 12.5.
            // Копейки (не больше двух знаков) проверяет API — ответ INVALID_PRODUCT.
            step="any"
            defaultValue={product?.prices[currency] ?? ''}
          />
        </label>
      ))}
      <button type="submit" disabled={pending}>
        {submitLabel}
      </button>
    </form>
  )
}
