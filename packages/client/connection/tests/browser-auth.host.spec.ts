/** Browser launch-token and persistent-cookie behavior. */

import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { BrowserPairingPolicy } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

function signedCookie(store: RecordCredentials, name: string, payload: unknown): string {
  const body = typeof payload === 'string'
    ? Buffer.from(payload, 'utf8').toString('base64url')
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signedBodyCookie(store, name, body)
}

function signedBodyCookie(store: RecordCredentials, name: string, body: string): string {
  const record = store.record
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no signing secret')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(
  store: RecordCredentials,
  maxAgeDays = 30,
  processOwner: object = {},
  pairing?: BrowserPairingPolicy,
): Promise<BrowserAuth> {
  return BrowserAuth.create(processOwner, credentials(store), maxAgeDays, pairing)
}

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
  peerAddress?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
    },
    peerAddress: init?.peerAddress,
  }
}

/** One LAN pairing authority and a peer address outside the host machine. */
const LAN_AUTHORITY = '192.168.1.5:3081'
const LAN_PEER = '192.168.1.23'

function pairingPolicy(overrides?: Partial<BrowserPairingPolicy>): BrowserPairingPolicy {
  return {
    authorities: ['192.168.1.5'],
    maxFailedAttempts: 5,
    lockoutMilliseconds: 300_000,
    maxTotalFailedAttempts: 50,
    ...overrides,
  }
}

function exchange(
  auth: BrowserAuth,
  authority = '127.0.0.1:3080',
): { cookie: string; launchUrl: string; state: ResponseState } {
  const launchUrl = auth.authenticatedUrl(`http://${authority}`)
  const target = new URL(launchUrl)
  const res = response()
  expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`, authority), res.value)).toBe(false)
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('token exchange did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, launchUrl, state: res.state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserAuth', () => {
  it('mints one process token and a persistent authority-bound cookie', async () => {
    const store = new RecordCredentials()
    const processOwner = {}
    const first = await createAuth(store, 30, processOwner)
    const login = exchange(first)

    expect(login.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(login.state.headers?.['set-cookie']).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(login.state.headers?.['set-cookie']).not.toContain('Secure')
    expect(first.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    expect(first.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie: login.cookie }),
    })).toBe(true)
    expect(first.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(first.isAuthenticated(request('/', 'localhost:3080', { cookie: login.cookie }))).toBe(false)
    expect(first.isAuthenticated(request('/', '127.0.0.1:3081', { cookie: login.cookie }))).toBe(false)

    const reloaded = await createAuth(store, 30, processOwner)
    expect(reloaded.authenticatedUrl('http://127.0.0.1:3080')).toBe(login.launchUrl)
    expect(reloaded.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)

    const restarted = await createAuth(store)
    expect(new URL(restarted.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token'))
      .not.toBe(new URL(login.launchUrl).searchParams.get('token'))
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    const staleUrl = new URL(login.launchUrl)
    const redirected = response()
    expect(restarted.authorizeIndex(request(
      `${staleUrl.pathname}${staleUrl.search}`,
      '127.0.0.1:3080',
      { cookie: login.cookie },
    ), redirected.value)).toBe(false)
    expect(redirected.state).toEqual({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
      },
    })
  })

  it('accepts the cookie for index serving and gives every unauthenticated request one response', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { cookie } = exchange(auth)
    const allowed = response()
    expect(auth.authorizeIndex(request('/index.html', '127.0.0.1:3080', { cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})

    for (const candidate of [
      request('/'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request('/index.html?token=wrong'),
      request(auth.authenticatedUrl('http://127.0.0.1:3080'), '127.0.0.1:3080', { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(denied.state.body).toBe(candidate.method === 'HEAD'
        ? undefined
        : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
    }
  })

  it('rejects tampering, expiry, future issuance, and a longer lifetime than configured', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, 'a'),
    }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080' } })).toBe(false)

    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 2, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: 42, issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: 'now', expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: 'later' },
    ]
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
        cookie: signedCookie(store, name, payload),
      }))).toBe(false)
    }

    const shorter = await createAuth(store, 1)
    expect(shorter.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('loads one secret per activation and replaces it after deletion on the next activation', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const first = exchange(auth)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    await store.deleteRecord()
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(true)
    const sameActivation = exchange(auth)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: sameActivation.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    const reactivated = await createAuth(store)
    const second = exchange(reactivated)
    expect(second.cookie).not.toBe(first.cookie)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(false)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: second.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 2 })
  })

  it('fails loud on an invalid owner record instead of replacing it', async () => {
    const unsupported = new RecordCredentials()
    unsupported.record = { kind: 'api-key', key: 'not-a-cookie-secret' }
    await expect(createAuth(unsupported)).rejects.toThrow(/unsupported format/u)

    const malformed = new RecordCredentials()
    malformed.record = { kind: 'grant', payload: { version: 1, secret: 'short' } }
    await expect(createAuth(malformed)).rejects.toThrow(/invalid secret/u)

    const nonString = new RecordCredentials()
    nonString.record = { kind: 'grant', payload: { version: 1, secret: 42 } }
    await expect(createAuth(nonString)).rejects.toThrow(/invalid secret/u)

    const discarded = new RecordCredentials()
    discarded.discardWrites = true
    await expect(createAuth(discarded)).rejects.toThrow(/was not created/u)

    await expect(createAuth(new RecordCredentials(), Number.MAX_SAFE_INTEGER))
      .rejects.toThrow(/safe timestamp range/u)
  })

  it('serves the LAN pairing page and exchanges its PIN for the session cookie', async () => {
    const owner = {}
    const auth = await createAuth(new RecordCredentials(), 30, owner, pairingPolicy())
    const pairing = auth.pairing
    expect(pairing?.pin).toMatch(/^\d{6}$/u)
    // The PIN belongs to the process owner, so a Connection reload keeps the
    // value the operator already read.
    const reloaded = await createAuth(new RecordCredentials(), 30, owner, pairingPolicy())
    expect(reloaded.pairing?.pin).toBe(pairing!.pin)

    const page = response()
    expect(auth.authorizeIndex(request('/', LAN_AUTHORITY, { peerAddress: LAN_PEER }), page.value)).toBe(false)
    expect(page.state).toMatchObject({
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
      },
    })
    expect(page.state.body).toContain('<form method="post" action="/pair">')
    expect(page.state.body).toContain('name="pin"')
    expect(page.state.body).not.toContain(pairing!.pin)

    // Only GET receives the form; HEAD on the same authority stays 401.
    const head = response()
    expect(auth.authorizeIndex(request('/', LAN_AUTHORITY, { method: 'HEAD' }), head.value)).toBe(false)
    expect(head.state.status).toBe(401)

    const paired = response()
    expect(auth.authorizePairing(
      request('/', LAN_AUTHORITY, { peerAddress: LAN_PEER }), pairing!.pin, paired.value,
    )).toBe(false)
    expect(paired.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(paired.state.headers?.['set-cookie']).toMatch(/^dsh-auth-[A-Za-z0-9_-]+=v1\./u)
    const cookie = paired.state.headers!['set-cookie']!.split(';', 1)[0]!
    expect(auth.isAuthenticated(request('/', LAN_AUTHORITY, { cookie }))).toBe(true)
    const allowed = response()
    expect(auth.authorizeIndex(request('/', LAN_AUTHORITY, { cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})
  })

  it('throttles failed PINs by peer address and accepts the PIN after the lockout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z'))
    const auth = await createAuth(new RecordCredentials(), 30, {}, pairingPolicy())
    const pin = auth.pairing!.pin
    const wrong = pin === '000000' ? '111111' : '000000'
    const submit = (peer: string, candidate: string): ResponseState => {
      const res = response()
      auth.authorizePairing(request('/', LAN_AUTHORITY, { peerAddress: peer }), candidate, res.value)
      return res.state
    }

    // A correct PIN clears a partial failure streak before the limit.
    expect(submit(LAN_PEER, wrong).status).toBe(401)
    expect(submit(LAN_PEER, wrong).status).toBe(401)
    expect(submit(LAN_PEER, pin).status).toBe(303)

    // Five failures from one peer lock that peer out; the PIN is not checked.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(submit(LAN_PEER, wrong).status).toBe(401)
    }
    const locked = submit(LAN_PEER, pin)
    expect(locked).toMatchObject({ status: 429, headers: { 'cache-control': 'no-store' } })
    expect(locked.body).toContain('too many pairing attempts')

    // Another peer keeps its own budget while this one is locked.
    expect(submit('192.168.1.24', pin).status).toBe(303)

    // The lock serves out and the throttled peer may pair again.
    vi.advanceTimersByTime(300_000)
    expect(submit(LAN_PEER, pin).status).toBe(303)
  })

  it('rejects pairing without a configured LAN authority, a peer address, or a matching PIN', async () => {
    const unpaired = await createAuth(new RecordCredentials())
    expect(unpaired.pairing).toBeUndefined()
    const lanPage = response()
    expect(unpaired.authorizeIndex(request('/', LAN_AUTHORITY), lanPage.value)).toBe(false)
    expect(lanPage.state.status).toBe(401)
    const disabled = response()
    expect(unpaired.authorizePairing(
      request('/', LAN_AUTHORITY, { peerAddress: LAN_PEER }), '000000', disabled.value,
    )).toBe(false)
    expect(disabled.state.status).toBe(401)

    const auth = await createAuth(new RecordCredentials(), 30, {}, pairingPolicy())
    const pin = auth.pairing!.pin
    for (const candidate of [
      request('/', LAN_AUTHORITY),
      request('/', '127.0.0.1:3080', { peerAddress: LAN_PEER }),
      request('/', '192.168.1.9:3081', { peerAddress: LAN_PEER }),
      request('/', 'bad host', { peerAddress: LAN_PEER }),
    ]) {
      const rejected = response()
      expect(auth.authorizePairing(candidate, pin, rejected.value)).toBe(false)
      expect(rejected.state).toMatchObject({
        status: 401,
        headers: { 'cache-control': 'no-store' },
      })
      expect(rejected.state.body).toContain('pairing rejected')
    }

    // A submitted value of the wrong length never matches the six-digit PIN.
    const malformed = response()
    expect(auth.authorizePairing(
      request('/', LAN_AUTHORITY, { peerAddress: LAN_PEER }), `${pin}0`, malformed.value,
    )).toBe(false)
    expect(malformed.state.status).toBe(401)
  })
})
