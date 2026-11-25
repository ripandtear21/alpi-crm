import { randomBytes } from 'node:crypto'
import { Webhook, WebhookVerificationError } from 'standardwebhooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decryptWebhookSecret, encryptWebhookSecret, generateWebhookSecret } from './secret.ts'
import { webhookHeaders, webhookSignature } from './sign.ts'

// Подпись Standard Webhooks v1 и секрет адреса (тикет crm-api/06). Совместимость — официальной
// библиотекой `standardwebhooks` (dev-зависимость): её verify() принимает нашу подпись и
// отклоняет изменённое тело, чужой секрет и время старше 5 минут.

const BODY = JSON.stringify({
  type: 'deal.won',
  timestamp: '2026-11-25T10:00:00.000Z',
  data: { event_id: 'evt_00000000-0000-4000-8000-000000000001', deal_id: 'x' },
})
const ID = 'evt_00000000-0000-4000-8000-000000000001'

const nowSeconds = () => Math.floor(Date.now() / 1000)

describe('подпись Standard Webhooks', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('verify() пакета standardwebhooks принимает нашу подпись', () => {
    const secret = generateWebhookSecret()
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    const headers = webhookHeaders({
      id: ID,
      timestamp: nowSeconds(),
      body: BODY,
      secrets: [secret],
    })
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/)
    expect(new Webhook(secret).verify(BODY, headers)).toEqual(JSON.parse(BODY))
  })

  it('изменённое тело, чужой секрет и время старше 5 минут — отклоняются', () => {
    const secret = generateWebhookSecret()
    const headers = webhookHeaders({
      id: ID,
      timestamp: nowSeconds(),
      body: BODY,
      secrets: [secret],
    })
    expect(() => new Webhook(secret).verify(`${BODY} `, headers)).toThrow(WebhookVerificationError)
    expect(() => new Webhook(generateWebhookSecret()).verify(BODY, headers)).toThrow(
      WebhookVerificationError,
    )
    const old = webhookHeaders({
      id: ID,
      timestamp: nowSeconds() - 6 * 60,
      body: BODY,
      secrets: [secret],
    })
    expect(() => new Webhook(secret).verify(BODY, old)).toThrow(/too old/i)
    // Подпись другого id (webhook-id входит в подпись) — тоже отклоняется.
    expect(() => new Webhook(secret).verify(BODY, { ...headers, 'webhook-id': `${ID}x` })).toThrow(
      WebhookVerificationError,
    )
  })

  it('две подписи через пробел: принимается и старый, и новый секрет', () => {
    const fresh = generateWebhookSecret()
    const previous = generateWebhookSecret()
    const headers = webhookHeaders({
      id: ID,
      timestamp: nowSeconds(),
      body: BODY,
      secrets: [fresh, previous],
    })
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2)
    expect(new Webhook(fresh).verify(BODY, headers)).toBeTruthy()
    expect(new Webhook(previous).verify(BODY, headers)).toBeTruthy()
    expect(() => new Webhook(generateWebhookSecret()).verify(BODY, headers)).toThrow(
      WebhookVerificationError,
    )
  })

  it('подпись — base64 HMAC-SHA256 строки «id.timestamp.тело» ключом из байт секрета', () => {
    // Пример из спецификации Standard Webhooks (libraries/javascript, тесты пакета).
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
    expect(
      webhookSignature({
        id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
        timestamp: 1614265330,
        body: '{"test": 2432232314}',
        secrets: [secret],
      }),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
  })
})

describe('секрет адреса в базе', () => {
  const owner = {
    projectId: '00000000-0000-4000-8000-00000000000a',
    endpointId: '00000000-0000-4000-8000-00000000000b',
  }

  it('шифруется AES-256-GCM: открытого текста нет, расшифровывается тем же ключом', () => {
    const key = randomBytes(32)
    const secret = generateWebhookSecret()
    const stored = encryptWebhookSecret(key, owner, secret)
    expect(stored).not.toContain(secret)
    expect(stored).not.toContain(secret.slice('whsec_'.length))
    expect(stored).toMatch(/^v1\./)
    // Новый iv на каждое шифрование.
    expect(encryptWebhookSecret(key, owner, secret)).not.toBe(stored)
    expect(decryptWebhookSecret(key, owner, stored)).toBe(secret)
  })

  it('чужой ключ, чужой адрес или проект — не расшифровывается, секрета в ошибке нет', () => {
    const key = randomBytes(32)
    const secret = generateWebhookSecret()
    const stored = encryptWebhookSecret(key, owner, secret)
    const attempts = [
      () => decryptWebhookSecret(randomBytes(32), owner, stored),
      () => decryptWebhookSecret(key, { ...owner, endpointId: owner.projectId }, stored),
      () => decryptWebhookSecret(key, { ...owner, projectId: owner.endpointId }, stored),
    ]
    for (const attempt of attempts) {
      expect(attempt).toThrow(/не расшифрован/)
      try {
        attempt()
      } catch (error) {
        expect(String(error)).not.toContain(secret)
        expect(String(error)).not.toContain(stored)
      }
    }
  })
})
