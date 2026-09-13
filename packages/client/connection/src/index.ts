/** Host HTTP bridge for browser-client RPC. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { BrowserAuth, type BrowserPairingPolicy } from './browser-auth.ts'
import { HostConnectionService } from './rpc-host.ts'
import type { HostConnectionHandle } from './rpc.ts'
import { ConnectionRecoveryConfigSchema, resolveConnectionConfig, type ConnectionRecoveryConfig } from './recovery-config.ts'

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export { RpcId, transportError } from './rpc.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

/** Exact webserver route owning LAN pairing form submissions. */
const PAIRING_PATH = '/pair'

/** Maximum accepted pairing form body; the form carries one six-digit field. */
const MAX_PAIRING_BODY_BYTES = 1024

/** Failed PIN submissions from one peer address before that address is locked out. */
const DEFAULT_MAX_PAIRING_ATTEMPTS = 5

/** Milliseconds one locked peer address stays rejected. */
const DEFAULT_PAIRING_LOCKOUT_MILLISECONDS = 300_000

/**
 * LAN pairing policy: browsers arriving on these authorities receive the PIN
 * form instead of the 401 response. An empty authority list disables both the
 * form and the pairing route.
 */
export interface ConnectionPairingConfig {
  /** Authorities whose unauthenticated browsers receive the pairing page. @default [] */
  authorities: string[]
  /** Failed submissions from one peer address before lockout. @default 5 */
  maxFailedAttempts?: number
  /** Milliseconds one locked peer address stays rejected. @default 300000 */
  lockoutMilliseconds?: number
}

const ConnectionPairingConfigSchema: z<ConnectionPairingConfig> = z.object({
  authorities: z.array(String).default([]),
  maxFailedAttempts: z.natural().min(1).default(DEFAULT_MAX_PAIRING_ATTEMPTS),
  lockoutMilliseconds: z.natural().min(1).default(DEFAULT_PAIRING_LOCKOUT_MILLISECONDS),
})

/** Resolve a loaded pairing config into the policy BrowserAuth enforces. */
function resolvePairing(config: ConnectionPairingConfig | undefined): BrowserPairingPolicy | undefined {
  if (config === undefined || config.authorities.length === 0) return undefined
  return {
    authorities: config.authorities,
    maxFailedAttempts: config.maxFailedAttempts ?? DEFAULT_MAX_PAIRING_ATTEMPTS,
    lockoutMilliseconds: config.lockoutMilliseconds ?? DEFAULT_PAIRING_LOCKOUT_MILLISECONDS,
  }
}

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection. */
export const inject = ['credentials']

/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing, injected into each served page. */
  recovery?: ConnectionRecoveryConfig
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by; the Web runtime derives LAN IP literals from an active all-interface
   * bind. An entry that is not a bare, canonical authority fails plugin load.
   */
  trustedHosts?: string[]
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
  /**
   * LAN pairing: browsers arriving on `authorities` receive the PIN form, and
   * a submitted PIN mints the same authority-bound cookie as the local token
   * exchange. An empty or omitted policy leaves `/pair` unregistered.
   */
  pairing?: ConnectionPairingConfig
}

export const Config: z<ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}),
  trustedHosts: z.array(String).default([]),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  pairing: ConnectionPairingConfigSchema.default({ authorities: [] }),
})

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin also mounts the `/api` browser transport with Host/Origin
 * checks and persistent browser authentication, plus the LAN pairing route when
 * a pairing authority is configured.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  const recovery = resolveConnectionConfig(config?.recovery)
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const pairing = resolvePairing(config?.pairing)
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  if (pairing !== undefined) {
    for (const entry of pairing.authorities) assertTrustedAuthority(entry)
  }
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(
    ctx,
    trustedHosts,
    await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays, pairing),
  )
  ctx.inject(['webServer'], (webCtx) => {
    assertImageBodyCapacity(webCtx, maxRequestBodyBytes)
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: recovery })
    })
    const fetchHandler = connection.createSharedFetchHandler(API_PATH)
    const route: WebRoute = {
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, fetchHandler, maxRequestBodyBytes)
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route')
    if (pairing !== undefined) {
      const pairingRoute: WebRoute = {
        kind: 'exact',
        path: PAIRING_PATH,
        handler: (req, res) => handlePairingSubmission(connection, trustedHosts, req, res),
      }
      webCtx.effect(
        () => webCtx.webServer.register(pairingRoute),
        'client-connection: LAN pairing route',
      )
    }
  })
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}

/**
 * Serve one `/pair` submission: trust fence, method and body-size limits, form
 * parse, then the PIN exchange. This route owns every response, so the
 * frontend-static fallback keeps serving only GET and HEAD.
 */
async function handlePairingSubmission(
  connection: HostConnectionHandle,
  trustedHosts: readonly string[],
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isTrustedApiRequest(req, trustedHosts)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  const body = await readPairingBody(req)
  if (body === undefined) {
    res.writeHead(413, { 'cache-control': 'no-store', 'connection': 'close' })
    res.end()
    req.destroy()
    return
  }
  const form = new URLSearchParams(body)
  const pin = form.get('pin')
  if (pin === null || form.getAll('pin').length !== 1) {
    res.writeHead(400, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  connection.authorizePairing({
    method: req.method,
    url: req.url,
    headers: req.headers,
    peerAddress: req.socket.remoteAddress ?? undefined,
  }, pin, res)
}

/** Buffer one pairing body up to the cap, or undefined when it exceeds it. */
async function readPairingBody(req: IncomingMessage): Promise<string | undefined> {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > MAX_PAIRING_BODY_BYTES) {
    return undefined
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_PAIRING_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
