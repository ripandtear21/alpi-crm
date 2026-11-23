import type { ProductSummary } from '@alpi/shared'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { Field, Input, Select } from '../../ui/field.tsx'
import './deal-products.css'

// Товары сделки (тикеты crm-deals/06 и 13): строки — товар, количество, цена, итог строки;
// добавить, изменить, убрать. «Сума по товарах» сумму сделки не меняет (ответ владельца
// 13.0.4): если они расходятся, кнопка «Підставити» ставит сумму строк в сумму сделки.

/** Наибольшее количество в строке — как в API (MAX_QUANTITY в apps/api/src/deals/lines.ts). */
const MAX_QUANTITY = 1_000_000

/** Деньги в валюте: «1 200,50 €» по языку интерфейса. */
export function formatMoney(value: number, currency: string, language: string): string {
  return new Intl.NumberFormat(language, { style: 'currency', currency }).format(value)
}

export interface ProductLine {
  id: string
  productId: string
  name: string
  quantity: number
  unitPrice: number
  total: number
}

export interface DealProductsProps {
  lines: ProductLine[]
  /** «Сума по товарах»: сумма строк в валюте сделки. */
  productsTotal: number
  /** Сумма сделки. */
  amount: number
  currency: 'EUR' | 'UAH' | 'USD'
  canEdit: boolean
  /** Каталог проекта для новой строки; undefined — ещё загружается. */
  catalogue: ProductSummary[] | undefined
  onAdd: (input: { productId: string; quantity: number; unitPrice?: number }) => Promise<unknown>
  onUpdate: (lineId: string, change: { quantity?: number; unitPrice?: number }) => Promise<unknown>
  onRemove: (lineId: string) => Promise<unknown>
  onApplyTotal: () => Promise<unknown>
  errorText: (error: unknown) => string
}

/** Цена в поле ввода → число с копейками; пусто или не число — undefined. */
function readPrice(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const price = Number(value.replace(',', '.'))
  return Number.isFinite(price) && price >= 0 ? Math.round(price * 100) / 100 : undefined
}

function readQuantity(value: string): number | undefined {
  const quantity = Number(value)
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY
    ? quantity
    : undefined
}

export function DealProducts(props: DealProductsProps) {
  const { t, i18n } = useTranslation('deal-card')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const money = (value: number) => formatMoney(value, props.currency, i18n.language)

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setError(null)
    setBusy(true)
    try {
      await action()
      return true
    } catch (failure) {
      setError(props.errorText(failure))
      return false
    } finally {
      setBusy(false)
    }
  }

  const differs = props.lines.length > 0 && props.productsTotal !== props.amount

  return (
    <div className="deal-products">
      {props.lines.length === 0 ? (
        <p className="deal-products__empty">{t('products.empty')}</p>
      ) : (
        <ul className="deal-products__lines">
          {props.lines.map((line) => (
            <LineItem
              key={`${line.id}|${line.quantity}|${line.unitPrice}`}
              line={line}
              money={money}
              canEdit={props.canEdit}
              busy={busy}
              onSave={(change) => run(() => props.onUpdate(line.id, change))}
              onRemove={() => run(() => props.onRemove(line.id))}
            />
          ))}
        </ul>
      )}
      <p className="deal-products__total">
        <span>{t('products.total')}</span>
        <b data-testid="products-total">{money(props.productsTotal)}</b>
      </p>
      {differs && props.canEdit && (
        <p className="deal-products__differs">
          <span>{t('products.differs', { amount: money(props.amount) })}</span>
          <Button size="sm" busy={busy} onClick={() => run(props.onApplyTotal)}>
            {t('products.apply')}
          </Button>
        </p>
      )}
      {error && (
        <p className="ui-notice" role="alert">
          {error}
        </p>
      )}
      {props.canEdit && (
        <NewLine
          catalogue={props.catalogue}
          currency={props.currency}
          busy={busy}
          onAdd={(input) => run(() => props.onAdd(input))}
        />
      )}
    </div>
  )
}

function LineItem({
  line,
  money,
  canEdit,
  busy,
  onSave,
  onRemove,
}: {
  line: ProductLine
  money: (value: number) => string
  canEdit: boolean
  busy: boolean
  onSave: (change: { quantity?: number; unitPrice?: number }) => Promise<boolean>
  onRemove: () => void
}) {
  const { t } = useTranslation('deal-card')
  const [quantity, setQuantity] = useState(String(line.quantity))
  const [price, setPrice] = useState(String(line.unitPrice))
  const changed = quantity !== String(line.quantity) || price !== String(line.unitPrice)

  if (!canEdit) {
    return (
      <li className="deal-products__line">
        <span className="deal-products__name">{line.name}</span>
        <span className="deal-products__calc">
          {line.quantity} × {money(line.unitPrice)}
        </span>
        <b className="deal-products__sum">{money(line.total)}</b>
      </li>
    )
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    const nextQuantity = readQuantity(quantity)
    const nextPrice = readPrice(price)
    if (nextQuantity === undefined || nextPrice === undefined) return
    onSave({
      ...(nextQuantity === line.quantity ? {} : { quantity: nextQuantity }),
      ...(nextPrice === line.unitPrice ? {} : { unitPrice: nextPrice }),
    })
  }

  return (
    <li className="deal-products__line">
      <form
        className="deal-products__line-form"
        aria-label={t('products.line', { name: line.name })}
        onSubmit={save}
      >
        <span className="deal-products__name">{line.name}</span>
        <Input
          size="sm"
          type="number"
          min={1}
          max={MAX_QUANTITY}
          step={1}
          aria-label={t('products.quantity')}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
        <Input
          size="sm"
          type="number"
          min={0}
          step="0.01"
          aria-label={t('products.unitPrice')}
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
        <b className="deal-products__sum">{money(line.total)}</b>
        {changed && (
          <Button type="submit" size="sm" busy={busy}>
            {t('products.save')}
          </Button>
        )}
        <Button
          size="sm"
          variant="quiet"
          busy={busy}
          aria-label={t('products.remove', { name: line.name })}
          title={t('products.remove', { name: line.name })}
          onClick={onRemove}
        >
          <span aria-hidden="true">✕</span>
        </Button>
      </form>
    </li>
  )
}

function NewLine({
  catalogue,
  currency,
  busy,
  onAdd,
}: {
  catalogue: ProductSummary[] | undefined
  currency: DealProductsProps['currency']
  busy: boolean
  onAdd: (input: { productId: string; quantity: number; unitPrice?: number }) => Promise<boolean>
}) {
  const { t } = useTranslation('deal-card')
  const [productId, setProductId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [price, setPrice] = useState('')
  // Архивный товар в новую строку не ставится (API ответит 422) — его и не предлагаем.
  const active = (catalogue ?? []).filter((product) => product.archivedAt === null)
  const chosen = active.find((product) => product.id === productId)
  const catalogPrice = chosen?.prices[currency] ?? null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const count = readQuantity(quantity)
    const unitPrice = readPrice(price)
    if (!chosen || count === undefined) return
    const added = await onAdd({
      productId: chosen.id,
      quantity: count,
      ...(unitPrice === undefined ? {} : { unitPrice }),
    })
    if (added) {
      setProductId('')
      setQuantity('1')
      setPrice('')
    }
  }

  return (
    <form className="deal-products__new" aria-label={t('products.add')} onSubmit={submit}>
      <Field label={t('products.product')}>
        <Select
          size="sm"
          value={productId}
          onChange={(event) => setProductId(event.target.value)}
          disabled={catalogue === undefined}
        >
          <option value="">{t('products.choose')}</option>
          {active.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('products.quantity')}>
        <Input
          size="sm"
          type="number"
          min={1}
          max={MAX_QUANTITY}
          step={1}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
      </Field>
      <Field
        label={t('products.unitPrice')}
        hint={
          chosen && catalogPrice === null
            ? t('products.noCatalogPrice', { currency })
            : t('products.priceHint')
        }
      >
        <Input
          size="sm"
          type="number"
          min={0}
          step="0.01"
          placeholder={catalogPrice === null ? '' : String(catalogPrice)}
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </Field>
      <div>
        <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!chosen}>
          {t('products.addButton')}
        </Button>
      </div>
    </form>
  )
}
