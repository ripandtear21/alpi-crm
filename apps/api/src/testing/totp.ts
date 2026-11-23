import { createHmac } from 'node:crypto'

// Для тестов и тестовых данных (pnpm seed, apps/api/src/seed/users.ts), не для API: код 2FA
// так же, как его считает приложение на телефоне.

/** Код TOTP (RFC 6238: SHA-1, 6 цифр, 30 с). */
export function totp(base32Secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const hmac = createHmac('sha1', base32Decode(base32Secret)).update(counter).digest()
  const offset = (hmac.at(-1) ?? 0) & 0x0f
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 1_000_000).padStart(6, '0')
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char)
    if (value < 0) throw new Error(`Не base32: ${char}`)
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}
