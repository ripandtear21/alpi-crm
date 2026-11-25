import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import type { WebhookAttemptError } from '@alpi/shared'
import type { ResolvedAddress } from './ssrf.ts'

// Одна попытка отправки события (тикет crm-api/06): `POST` тела события на адрес автоматизации.
//
// - Соединение идёт на заранее проверенный IP (events/ssrf.ts): своя функция разрешения имени
//   отдаёт только его, повторного запроса в DNS нет. Для https имя остаётся в SNI и в проверке
//   сертификата — подмена IP не проходит проверку TLS.
// - Редиректы не выполняются: http.request их не делает, 3xx — неудача (решает deliver.ts).
// - Таймаут на всю попытку (по умолчанию 15 с); тело ответа читается не больше 64 КБ, хранятся
//   первые 1 КБ.
// - Своё соединение на каждую попытку (agent: false): сокет к одному IP не переиспользуется для
//   адреса, проверенного на другой IP.

/** Наибольшая длительность попытки, мс. */
export const WEBHOOK_TIMEOUT_MS = 15_000

/** Сколько байт тела ответа читается. */
export const RESPONSE_READ_LIMIT = 64 * 1024

/** Сколько байт тела ответа хранится в попытке. */
export const RESPONSE_STORE_LIMIT = 1024

export interface SendRequest {
  url: URL
  address: ResolvedAddress
  headers: Record<string, string>
  body: string
  timeoutMs?: number
  /** Остановка процесса: попытка обрывается как ошибка сети. */
  signal?: AbortSignal
}

/** Итог попытки: код ответа или ошибка без ответа. */
export interface SendResult {
  statusCode: number | null
  error: WebhookAttemptError | null
  durationMs: number
  responseBody: string | null
}

/** Ошибки TLS по коду Node и OpenSSL. */
function isTlsError(code: string): boolean {
  return (
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('CERT_') ||
    code.includes('CERT') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'EPROTO'
  )
}

/** Первые 1 КБ тела ответа строкой UTF-8 без NUL (их не примет столбец text). */
export function storedResponseBody(chunks: readonly Buffer[]): string | null {
  const head = Buffer.concat(chunks).subarray(0, RESPONSE_STORE_LIMIT)
  if (head.length === 0) return null
  let text = head.toString('utf8').replaceAll('\u0000', '')
  // Обрезанный посреди символ превращается в U+FFFD (3 байта) — укорачиваем до предела.
  while (Buffer.byteLength(text, 'utf8') > RESPONSE_STORE_LIMIT) text = text.slice(0, -1)
  return text
}

/** Отправляет одну попытку; ошибок не бросает — всё в SendResult. */
export function sendWebhook(input: SendRequest): Promise<SendResult> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const pinned: LookupFunction = (_hostname, options, callback) => {
    const { address, family } = input.address
    if (typeof options === 'object' && options !== null && options.all) {
      ;(callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address, family },
      ])
    } else {
      callback(null, address, family)
    }
  }
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    let read = 0
    function finish(result: Omit<SendResult, 'durationMs'>) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      resolve({ ...result, durationMs: elapsed() })
    }
    const send = input.url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(input.url, {
      method: 'POST',
      headers: { ...input.headers, 'content-length': String(Buffer.byteLength(input.body)) },
      lookup: pinned,
      agent: false,
    })
    const timer = setTimeout(() => {
      req.destroy()
      finish({ statusCode: null, error: 'timeout', responseBody: null })
    }, input.timeoutMs ?? WEBHOOK_TIMEOUT_MS)
    function onAbort() {
      req.destroy()
      finish({ statusCode: null, error: 'network', responseBody: null })
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? ''
      finish({
        statusCode: null,
        error: isTlsError(code) ? 'tls' : code === 'ENOTFOUND' ? 'dns' : 'network',
        responseBody: null,
      })
    })
    req.on('response', (res: IncomingMessage) => {
      const statusCode = res.statusCode ?? 0
      const done = () =>
        finish({ statusCode, error: null, responseBody: storedResponseBody(chunks) })
      res.on('data', (chunk: Buffer) => {
        if (read < RESPONSE_STORE_LIMIT) chunks.push(chunk)
        read += chunk.length
        if (read >= RESPONSE_READ_LIMIT) {
          // Больше 64 КБ не читаем: ответ уже получен, соединение закрываем.
          res.destroy()
          done()
        }
      })
      res.on('end', done)
      res.on('error', done)
      res.on('close', done)
    })
    if (input.signal?.aborted) onAbort()
    else req.end(input.body)
  })
}
