/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { isConfiguredAuthority } from './api-request-trust.ts'
import type {
  BrowserPairing,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>()
const PROCESS_PAIRING_PINS = new WeakMap<object, string>()
const PROCESS_PAIRING_BUDGETS = new WeakMap<object, { failures: number }>()
const PAIRING_PIN_DIGITS = 6
const PAIRING_PIN_LIMIT = 10 ** PAIRING_PIN_DIGITS

/** Resolved LAN pairing policy; each field carries its effective value. */
export interface BrowserPairingPolicy {
  /** Authorities whose unauthenticated browsers receive the pairing page. */
  readonly authorities: readonly string[]
  /** Failed submissions from one peer address before that address is locked out. */
  readonly maxFailedAttempts: number
  /** Milliseconds one locked peer address stays rejected. */
  readonly lockoutMilliseconds: number
  /** Failed submissions from every peer together before pairing stops until the process exits. */
  readonly maxTotalFailedAttempts: number
}

/** One peer address's failed PIN submissions and lock state. */
interface PairingAttempts {
  failures: number
  /** Absolute lock expiry in milliseconds; zero while the peer is not locked. */
  lockedUntil: number
}

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}

/**
 * The process's pairing PIN. Keyed by the root application context so a
 * Connection hot reload keeps the PIN the operator already read, while a new
 * process mints a different one.
 */
function processPairingPin(owner: object): string {
  const existing = PROCESS_PAIRING_PINS.get(owner)
  if (existing !== undefined) return existing
  const created = randomInt(0, PAIRING_PIN_LIMIT).toString().padStart(PAIRING_PIN_DIGITS, '0')
  PROCESS_PAIRING_PINS.set(owner, created)
  return created
}

/**
 * The process's spent pairing guesses. Keyed like the PIN so a Connection hot
 * reload cannot hand an attacker a fresh budget for a PIN the operator already
 * read; the count survives until the process exits.
 */
function processPairingBudget(owner: object): { failures: number } {
  const existing = PROCESS_PAIRING_BUDGETS.get(owner)
  if (existing !== undefined) return existing
  const created = { failures: 0 }
  PROCESS_PAIRING_BUDGETS.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Canonical request authority used as the cookie name and signed audience. */
function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(name: string, value: string, expiresAt: number, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
}

/**
 * The LAN pairing form. It carries no PIN and no token: the operator reads the
 * PIN from the host's console and types it here.
 */
const PAIRING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh web pairing</title>
</head>
<body>
<main>
<h1>Pair this device</h1>
<p>Enter the six-digit PIN printed by dsh web on the host computer.</p>
<form method="post" action="/pair">
<label for="pin">PIN</label>
<input id="pin" name="pin" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
<button type="submit">Pair</button>
</form>
</main>
</body>
</html>
`

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  return decoded as unknown as BrowserCookiePayload
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Process launch-token exchange and persistent signed-cookie verification.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export class BrowserAuth {
  private readonly launchToken: string
  private readonly maxAgeMilliseconds: number
  private readonly pairingState: {
    policy: BrowserPairingPolicy
    pin: string
    budget: { failures: number }
  } | undefined
  private readonly pairingAttempts = new Map<string, PairingAttempts>()

  private constructor(
    processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
    policy: BrowserPairingPolicy | undefined,
  ) {
    this.launchToken = processLaunchToken(processOwner)
    this.pairingState = policy === undefined
      ? undefined
      : { policy, pin: processPairingPin(processOwner), budget: processPairingBudget(processOwner) }
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @param pairing - resolved LAN pairing policy; omitted when no pairing authority is configured.
   * @returns initialized authentication owner with the process owner's launch token.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
    pairing?: BrowserPairingPolicy,
  ): Promise<BrowserAuth> {
    const policy = pairing === undefined || pairing.authorities.length === 0 ? undefined : pairing
    return new BrowserAuth(processOwner, await initializeSecret(credentials), maxAgeDays, policy)
  }

  /** Process-local LAN pairing facts, or undefined when no pairing authority is configured. */
  get pairing(): BrowserPairing | undefined {
    return this.pairingState === undefined ? undefined : { pin: this.pairingState.pin }
  }

  /**
   * Add this process's launch token to the ordinary application root URL.
   * @param baseUrl - canonical browser origin without credentials.
   * @returns root URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    url.searchParams.set(TOKEN_QUERY, this.launchToken)
    return url.href
  }

  /**
   * Authenticate an index request. A valid root query token mints the cookie
   * and redirects to clean `/`; a valid cookie lets the caller serve the
   * index; an unauthenticated request on a configured LAN pairing authority
   * receives the pairing form; every other request receives the same minimal
   * 401 response.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (tokens.length > 0) {
      const authority = requestAuthority(req.headers)
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1
        && authority !== undefined && tokenMatches(tokens.join(''), this.launchToken)) {
        this.issueCookie(authority, res)
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req)) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return false
      }
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req)) return true
    if (req.method === 'GET' && this.isPairingAuthority(req)) {
      this.writePairingPage(res)
      return false
    }
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Exchange one submitted LAN pairing PIN for the browser-session cookie. A
   * peer address locked by earlier failures receives 429 without a PIN check;
   * a wrong PIN extends that peer's failure streak; the correct PIN clears the
   * streak and mints the same authority-bound cookie as the token exchange.
   * A process-wide budget bounds the guesses every peer together may spend, so
   * a fresh source address resets the streak but not the budget: once it is
   * spent, the correct PIN is refused too and only a process restart reopens
   * pairing. The caller MUST apply the Host/Origin trust fence first: this
   * method admits any authority the policy names, and the fence is what stops a
   * cross-site page from spending a peer's attempt budget. The registered
   * `/pair` route is the only caller.
   * @param req - pairing request facts including the TCP peer address.
   * @param pin - submitted six-digit PIN.
   * @param res - response this exchange owns for every outcome.
   * @returns false, because the exchange always writes the response.
   */
  authorizePairing(
    req: ConnectionIndexRequest,
    pin: string,
    res: ConnectionIndexResponse,
  ): boolean {
    const pairing = this.pairingState
    const authority = requestAuthority(req.headers)
    const peer = req.peerAddress
    if (pairing === undefined || peer === undefined
      || authority === undefined || !this.isPairingAuthority(req)) {
      this.writePairingRejection(res, 401)
      return false
    }
    if (pairing.budget.failures >= pairing.policy.maxTotalFailedAttempts) {
      this.writePairingRejection(res, 429)
      return false
    }
    const attempts = this.pairingAttempts.get(peer)
    if (attempts !== undefined && attempts.lockedUntil > Date.now()) {
      this.writePairingRejection(res, 429)
      return false
    }
    // A served lock is spent: the next window starts from zero.
    if (attempts !== undefined && attempts.lockedUntil !== 0) this.pairingAttempts.delete(peer)
    if (tokenMatches(pin, pairing.pin)) {
      this.pairingAttempts.delete(peer)
      this.issueCookie(authority, res)
      return false
    }
    const failures = (this.pairingAttempts.get(peer)?.failures ?? 0) + 1
    pairing.budget.failures += 1
    this.pairingAttempts.set(peer, {
      failures,
      lockedUntil: failures >= pairing.policy.maxFailedAttempts
        ? Date.now() + pairing.policy.lockoutMilliseconds
        : 0,
    })
    this.writePairingRejection(res, 401)
    return false
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @returns true only for an unexpired cookie signed by this activation's loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return false
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return false
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return false
    const now = Date.now()
    return payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
  }

  /** Whether the request authority is one this process pairs over the LAN. */
  private isPairingAuthority(request: ConnectionTrustRequest): boolean {
    const pairing = this.pairingState
    if (pairing === undefined) return false
    const authority = requestAuthority(request.headers)
    return authority !== undefined && isConfiguredAuthority(authority, pairing.policy.authorities)
  }

  /** Write the 303 cookie exchange shared by the token and pairing paths. */
  private issueCookie(authority: string, res: ConnectionIndexResponse): void {
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const value = encodeCookie({
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
    }, this.secret)
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': '/',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(
        cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000),
      ),
    })
    res.end()
  }

  private writePairingPage(res: ConnectionIndexResponse): void {
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    })
    res.end(PAIRING_PAGE)
  }

  private writePairingRejection(res: ConnectionIndexResponse, status: 401 | 429): void {
    res.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(status === 429
      ? 'too many pairing attempts; wait before trying again, or restart dsh web to mint a new PIN.\n'
      : 'dsh web pairing rejected; check the PIN printed by dsh web.\n')
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}
