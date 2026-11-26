import { describe, expect, it } from 'vitest'
import { checkWebhookUrl, type HostLookup, ipv6Bytes, isForbiddenAddress } from './ssrf.ts'

// Защита адресов событий от запросов во внутреннюю сеть (тикет crm-api/06): какие адреса и IP
// отклоняются. Разрешение имён — подставная таблица, без настоящего DNS.

const names: Record<string, string[]> = {
  'hooks.example.test': ['93.184.216.34'],
  'v6.example.test': ['2606:4700::6810:84e5'],
  'internal.example.test': ['10.0.0.5'],
  'mixed.example.test': ['93.184.216.34', '192.168.1.10'],
  'metadata.example.test': ['169.254.169.254'],
  'mapped.example.test': ['::ffff:127.0.0.1'],
  localhost: ['127.0.0.1', '::1'],
}

const lookup: HostLookup = async (host) => {
  const addresses = names[host]
  if (!addresses) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

const strict = { allowInsecure: false, lookup }
const insecure = { allowInsecure: true, lookup }

async function problem(url: unknown, policy = strict) {
  const result = await checkWebhookUrl(url, policy)
  return result.ok ? 'ok' : result.problem
}

describe('адрес события: SSRF', () => {
  it('публичный https-адрес годится, соединение — на проверенный IP', async () => {
    const result = await checkWebhookUrl('https://hooks.example.test/crm?x=1', strict)
    expect(result).toEqual({
      ok: true,
      value: {
        url: new URL('https://hooks.example.test/crm?x=1'),
        addresses: [{ address: '93.184.216.34', family: 4 }],
      },
    })
    expect(await problem('https://v6.example.test/')).toBe('ok')
    expect(await problem('https://93.184.216.34:8443/hook')).toBe('ok')
  })

  it('http://, внутренние IP, метаданные облака, loopback IPv6 и имена во внутреннюю сеть — отклоняются', async () => {
    expect(await problem('http://hooks.example.test/')).toBe('not_https')
    expect(await problem('ftp://hooks.example.test/')).toBe('not_https')
    for (const url of [
      'https://127.0.0.1/',
      'https://10.0.0.5/',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/',
      'https://[::ffff:10.0.0.1]/',
      'https://0.0.0.0/',
      'https://100.64.0.1/',
      'https://172.16.5.4/',
      'https://192.168.0.1/',
      'https://224.0.0.1/',
      'https://[fe80::1]/',
      'https://[fc00::1]/',
      'https://[::]/',
      'https://internal.example.test/',
      'https://mixed.example.test/',
      'https://metadata.example.test/',
      'https://mapped.example.test/',
      'https://localhost/',
    ]) {
      expect([url, await problem(url)]).toEqual([url, 'forbidden_address'])
    }
    expect(await problem('https://missing.example.test/')).toBe('unresolvable')
  })

  it('форма: не строка, пусто, учётные данные, фрагмент, длиннее 2048 — invalid', async () => {
    for (const url of [
      null,
      42,
      '',
      'не адрес',
      'https://user:pass@hooks.example.test/',
      'https://hooks.example.test/#x',
      `https://hooks.example.test/${'a'.repeat(2048)}`,
    ]) {
      expect(await problem(url)).toBe('invalid')
    }
  })

  it('переменная для тестов разрешает http:// и loopback, но не остальные внутренние сети', async () => {
    expect(await problem('http://localhost:4000/hook')).toBe('not_https')
    expect(await problem('http://localhost:4000/hook', insecure)).toBe('ok')
    expect(await problem('http://127.0.0.1:4000/hook', insecure)).toBe('ok')
    expect(await problem('http://[::1]:4000/hook', insecure)).toBe('ok')
    expect(await problem('http://10.0.0.5/', insecure)).toBe('forbidden_address')
    expect(await problem('https://169.254.169.254/', insecure)).toBe('forbidden_address')
  })

  it('IPv6: только глобальные 2000::/3 без служебных подсетей', () => {
    expect(ipv6Bytes('::ffff:10.0.0.1').slice(10)).toEqual([0xff, 0xff, 10, 0, 0, 1])
    expect(ipv6Bytes('2001:db8::1')).toHaveLength(16)
    expect(isForbiddenAddress('2606:4700::6810:84e5')).toBe(false)
    for (const address of [
      '2001:db8::1',
      '2001::1',
      '2002:a00:1::1',
      'ff02::1',
      '::ffff:a00:1',
      '64:ff9b::a00:1',
      '3fff::1',
    ]) {
      expect([address, isForbiddenAddress(address)]).toEqual([address, true])
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect([address, isForbiddenAddress(address)]).toEqual([address, false])
    }
    expect(isForbiddenAddress('255.255.255.255')).toBe(true)
    expect(isForbiddenAddress('198.18.0.1')).toBe(true)
  })
})
