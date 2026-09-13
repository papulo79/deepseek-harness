# Web LAN Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a mobile browser on the LAN pair with `dsh web` through a temporary six-digit PIN while retaining authority-bound browser-session cookies and a configurable port.

**Architecture:** The web startup provider permits the existing all-interface server option. `dsh-client-connection` owns a LAN-only pairing page, PIN validation, peer-address throttling, and cookie issuance because it already owns browser authentication. The Web bundle supplies discovered LAN addresses to Connection and announces a clean mobile URL with its PIN.

**Tech Stack:** TypeScript ESM, Cordis, node:http, Node `crypto`, Schemastery, Vitest, Cordis YAML profiles.

---

## File Structure

- Modify `packages/bundle/web-app/src/startup.ts` to accept the already-supported webserver bind host `0.0.0.0`.
- Modify `packages/bundle/web-app/tests/startup.spec.ts` to cover the all-interface launch configuration.
- Modify `packages/client/connection/src/rpc.ts` and `src/rpc-host.ts` to carry the peer address and expose the pairing facts needed by the Web runtime.
- Modify `packages/client/connection/src/browser-auth.ts` to mint the pairing PIN, serve the pairing page, throttle failed submissions, and issue the existing signed cookie.
- Modify `packages/client/connection/src/index.ts` to configure BrowserAuth and register the authenticated pairing route.
- Modify `packages/client/connection/tests/browser-auth.host.spec.ts` and `packages/host/frontend-static/tests/frontend-static.spec.ts` to exercise PIN issuance and the real HTTP path.
- Modify `packages/bundle/web-app/cordis.patch.yml`, `src/index.ts`, and `tests/web-app.spec.ts` to pass LAN addresses to Connection and print the mobile pairing instruction.
- Modify `apps/cli/reference/README.md`, `packages/bundle/web-app/README.md`, `packages/client/connection/README.md`, `docs/subsystems/web-server.md`, and their `.zh.md` counterparts to document the LAN command, clean mobile URL, PIN, and private-network limitation.
- Add an Agent Note under `.agents/notes/implemented/architecture/` describing the LAN pairing security policy, then update its manifest according to `.agents/notes/implemented/AGENTS.md`.

### Task 1: Permit Explicit LAN Binding

**Files:**
- Modify: `packages/bundle/web-app/src/startup.ts:63-87`
- Test: `packages/bundle/web-app/tests/startup.spec.ts:94-149`

- [ ] **Step 1: Replace the rejected-host test with a failing acceptance test.**

```ts
it('publishes the all-interfaces host for the webserver consumer', async () => {
  const { values, observed } = await bootProvider(['--host', '0.0.0.0', '--port', '3081', '--no-open'])
  expect(values).toEqual({
    host: '0.0.0.0',
    openBrowser: false,
    port: 3081,
    trustedHosts: [],
  })
  expect(observed.readerConfig).toEqual(values)
  expect(observed.exits).toEqual([])
})
```

- [ ] **Step 2: Run the focused test and confirm it fails because `startup.ts` rejects the host.**

Run: `pnpm exec vitest run packages/bundle/web-app/tests/startup.spec.ts`

Expected: FAIL in `publishes the all-interfaces host for the webserver consumer` with the current intentional-host rejection.

- [ ] **Step 3: Remove only the `options.host === '0.0.0.0'` error branch from `apply()`.**

```ts
program.action(() => {
  const options = program.opts<WebOptions>()
  if (options.port !== undefined && !/^\d+$/.test(options.port)) {
    program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
  }
  ctx.provide(WEB_STARTUP_SERVICE, {
    openBrowser: options.open,
    ...options.host !== undefined && { host: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
    trustedHosts: options.trustedHost ?? [],
  } satisfies WebStartupValues)
})
```

- [ ] **Step 4: Run the focused suite.**

Run: `pnpm exec vitest run packages/bundle/web-app/tests/startup.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit the isolated CLI change.**

```sh
git add packages/bundle/web-app/src/startup.ts packages/bundle/web-app/tests/startup.spec.ts
git commit -m "feat(web): permit explicit LAN binding"
```

### Task 2: Add LAN Pairing to Browser Authentication

**Files:**
- Modify: `packages/client/connection/src/rpc.ts:78-99,164-200`
- Modify: `packages/client/connection/src/rpc-host.ts:70-109`
- Modify: `packages/client/connection/src/browser-auth.ts:1-313`
- Test: `packages/client/connection/tests/browser-auth.host.spec.ts:28-168`

- [ ] **Step 1: Add failing BrowserAuth tests for the complete pairing policy.**

Extend `request()` with `peerAddress?: string`, construct BrowserAuth with pairing enabled for `192.168.1.5`, and test the following values:

```ts
const pairing = auth.pairing
expect(pairing).toMatchObject({ pin: expect.stringMatching(/^\d{6}$/u) })

const page = response()
expect(auth.authorizeIndex(request('/', '192.168.1.5:3081', { peerAddress: '192.168.1.23' }), page.value)).toBe(false)
expect(page.state).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' } })
expect(page.state.body).toContain('<form method="post" action="/pair">')

const paired = response()
expect(auth.authorizePairing(request('/', '192.168.1.5:3081', { peerAddress: '192.168.1.23' }), pairing.pin, paired.value)).toBe(false)
expect(paired.state).toMatchObject({ status: 303, headers: { location: '/', 'set-cookie': expect.any(String) } })
```

Add a separate fake-clock test that submits five wrong PINs from `192.168.1.23`, observes a sixth 429 response, advances five minutes, and observes that the correct PIN succeeds. Verify that pairing is unavailable at `127.0.0.1` and that a missing peer address is rejected.

- [ ] **Step 2: Run the BrowserAuth suite and confirm the new tests fail on missing pairing members.**

Run: `pnpm exec vitest run packages/client/connection/tests/browser-auth.host.spec.ts`

Expected: FAIL because `BrowserAuth` does not expose `pairing` or `authorizePairing`.

- [ ] **Step 3: Define the minimal typed pairing interface.**

In `src/rpc.ts`, add `peerAddress?: string` to `ConnectionIndexRequest`, add `BrowserPairing` with `url`-independent `pin: string`, and add these `HostConnectionHandle` members:

```ts
readonly pairing: BrowserPairing | undefined
authorizePairing(
  request: ConnectionIndexRequest,
  pin: string,
  response: ConnectionIndexResponse,
): boolean
```

In `src/rpc-host.ts`, delegate both members directly to the private `BrowserAuth` instance. Do not expose the pairing PIN to browser modules or API responses.

- [ ] **Step 4: Implement pairing state and cookie issuance in `BrowserAuth`.**

Add a constructor options object with `pairingAuthorities`, `maxFailedAttempts`, and `lockoutMilliseconds`; use `randomInt(0, 1_000_000).toString().padStart(6, '0')` for the process-local PIN. Store failed-attempt state in a `Map<string, { failures: number; lockedUntil: number }>` keyed by `peerAddress`.

Refactor the duplicated cookie construction from the token branch into one private `issueCookie(authority, res)` method. Implement these rules:

```ts
// authorizeIndex(): authenticated cookie -> true
// valid local `?token=` -> issueCookie() and false
// unauthenticated LAN pairing authority -> write a no-store HTML form and false
// all other unauthenticated requests -> existing 401 response and false

// authorizePairing(): require a configured LAN authority and a peer address.
// A locked peer receives 429 without checking the PIN.
// A wrong PIN increments failures; failure number maxFailedAttempts sets
// lockedUntil to Date.now() + lockoutMilliseconds and responds 401.
// A correct PIN clears the peer state, calls issueCookie(), and returns false.
```

The pairing HTML must contain one `input` named `pin`, use `method="post"` and `action="/pair"`, send `Cache-Control: no-store`, and never include the PIN in HTML or a URL. Use `timingSafeEqual` through the existing `tokenMatches()` helper for the PIN comparison.

- [ ] **Step 5: Run the BrowserAuth suite.**

Run: `pnpm exec vitest run packages/client/connection/tests/browser-auth.host.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit the authentication implementation and its unit tests.**

```sh
git add packages/client/connection/src/rpc.ts packages/client/connection/src/rpc-host.ts packages/client/connection/src/browser-auth.ts packages/client/connection/tests/browser-auth.host.spec.ts
git commit -m "feat(web): add LAN browser pairing"
```

### Task 3: Mount the Pairing Route and Wire LAN Configuration

**Files:**
- Modify: `packages/client/connection/src/index.ts:70-139`
- Modify: `packages/bundle/web-app/cordis.patch.yml:154-188`
- Modify: `packages/bundle/web-app/src/index.ts:252-273`
- Modify: `packages/bundle/web-app/tests/web-app.spec.ts:120-155`
- Modify: `packages/host/frontend-static/tests/frontend-static.spec.ts:32-157`

- [ ] **Step 1: Add a failing real-composition HTTP test for pairing.**

Make `loadComposition()` bind `0.0.0.0`, configure Connection with one fixture LAN authority, and return `loaded.connection.pairing`. Assert this flow through `fetch`:

```ts
const page = await request(port, '/', { headers: { host: `192.168.1.5:${String(port)}` } })
expect(page).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' })
expect(page.body).toContain('name="pin"')

const paired = await fetch(`http://127.0.0.1:${String(port)}/pair`, {
  method: 'POST',
  redirect: 'manual',
  headers: {
    host: `192.168.1.5:${String(port)}`,
    origin: `http://192.168.1.5:${String(port)}`,
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ pin: pairing.pin }),
})
expect(paired.status).toBe(303)
expect(paired.headers.get('set-cookie')).not.toBeNull()
```

- [ ] **Step 2: Run the real-composition test and confirm it fails with the existing 401/404 responses.**

Run: `pnpm exec vitest run packages/host/frontend-static/tests/frontend-static.spec.ts`

Expected: FAIL because unauthenticated LAN root requests receive 401 and `/pair` is unregistered.

- [ ] **Step 3: Add validated Connection pairing configuration and the exact `/pair` route.**

Extend `ConnectionConfig` with a `pairing` object:

```ts
pairing?: {
  authorities: string[]
  maxFailedAttempts?: number
  lockoutMilliseconds?: number
}
```

Its schema defaults `authorities` to `[]`, `maxFailedAttempts` to `5`, and `lockoutMilliseconds` to `300_000`; validate every authority with `assertTrustedAuthority`. Pass its resolved values to `BrowserAuth.create()`.

Inside the existing `ctx.inject(['webServer'], ...)` callback, register an exact `/pair` route. Require `POST`, apply `isTrustedApiRequest(req, trustedHosts)` before reading the body, reject a body over 1024 bytes with 413, parse `application/x-www-form-urlencoded` through `URLSearchParams`, require exactly one `pin`, then call `connection.authorizePairing({ method: req.method, url: req.url, headers: req.headers, peerAddress: req.socket.remoteAddress }, pin, res)`. Responses for a malformed form are 400 and no-store. The named route owns its response, so the frontend-static fallback remains GET/HEAD-only.

Set the Connection row in `cordis.patch.yml` to retain its existing trust expression and add:

```yml
pairing:
  authorities: !!js ctx.webRuntime.lanAddresses
```

- [ ] **Step 4: Announce the mobile pairing URL and PIN only when LAN pairing is active.**

In `web-app/src/index.ts`, retain the existing loopback token URL and replace the LAN token URL display with:

```ts
const lanUrl = lanCandidate === undefined ? undefined : `http://${lanCandidate}:${String(port)}`
const pairing = connectionCtx.connection.pairing
const lanAnnouncement = lanUrl === undefined || pairing === undefined
  ? ''
  : ` (LAN: ${lanUrl}; pairing PIN: ${pairing.pin})`
console.log(`dsh web: ${authenticatedUrl}${lanAnnouncement}`)
```

Update the Web-app unit expectation to match the clean LAN URL and six-digit PIN. The default browser handoff remains `authenticatedUrl`, so the local host continues to use its token exchange.

- [ ] **Step 5: Run the focused HTTP and Web-bundle suites.**

Run: `pnpm exec vitest run packages/host/frontend-static/tests/frontend-static.spec.ts packages/bundle/web-app/tests/web-app.spec.ts packages/bundle/web-app/tests/trusted-hosts.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit the route, composition, announcement, and integration coverage.**

```sh
git add packages/client/connection/src/index.ts packages/bundle/web-app/cordis.patch.yml packages/bundle/web-app/src/index.ts packages/bundle/web-app/tests/web-app.spec.ts packages/host/frontend-static/tests/frontend-static.spec.ts
git commit -m "feat(web): announce and serve LAN pairing"
```

### Task 4: Document the LAN Operating Procedure

**Files:**
- Modify: `apps/cli/reference/README.md:77-91`
- Modify: `apps/cli/reference/README.zh.md:79-93`
- Modify: `packages/bundle/web-app/README.md:39-58`
- Modify: `packages/bundle/web-app/README.zh.md:39-58`
- Modify: `packages/client/connection/README.md:32-40`
- Modify: `packages/client/connection/README.zh.md:32-40`
- Modify: `docs/subsystems/web-server.md:31-53`
- Modify: `docs/subsystems/web-server.zh.md:31-53`
- Add: `.agents/notes/implemented/architecture/2026-09-10-lan-mobile-pairing.md`
- Modify: `.agents/notes/implemented/architecture/manifest.json`

- [ ] **Step 1: Add the English and Chinese user instructions.**

Document this exact launch command and sequence in the CLI and Web-app references:

```sh
dsh web --host 0.0.0.0 --port 3081 --no-open
```

State that the operator opens the clean LAN URL printed by the command on the phone, enters the six-digit PIN shown beside it, and restarts the process after a LAN address changes. State that the server is intended for a private local network, not public Internet exposure.

- [ ] **Step 2: Update the browser-authentication and webserver references.**

Replace statements saying all-interface binding is unsupported. Specify that loopback starts retain the token URL, while a LAN bind adds a clean pairing URL and temporary PIN. Record the five-attempt and five-minute throttling policy, authority-bound cookie, Host/Origin fence, and the fact that the HTTP server does not add TLS.

- [ ] **Step 3: Record the lasting security decision.**

Add the Agent Note using the active-note format. It must state that LAN pairing is explicit, process-local, constrained to discovered LAN authorities, throttled by peer address, and does not make the server an Internet deployment. Link the Connection and webserver subsystem documentation as the current behavior sources, then add the note to the implemented architecture manifest.

- [ ] **Step 4: Run documentation checks.**

Run: `pnpm run verify-md-links && pnpm run verify-md-wrap && pnpm run verify-agent-note-format`

Expected: PASS.

- [ ] **Step 5: Run the selected final checks.**

Run: `pnpm exec vitest run packages/client/connection/tests/browser-auth.host.spec.ts packages/host/frontend-static/tests/frontend-static.spec.ts packages/bundle/web-app/tests/startup.spec.ts packages/bundle/web-app/tests/web-app.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit documentation and the security decision.**

```sh
git add apps/cli/reference/README.md apps/cli/reference/README.zh.md packages/bundle/web-app/README.md packages/bundle/web-app/README.zh.md packages/client/connection/README.md packages/client/connection/README.zh.md docs/subsystems/web-server.md docs/subsystems/web-server.zh.md .agents/notes/implemented/architecture/2026-09-10-lan-mobile-pairing.md .agents/notes/implemented/architecture/manifest.json
git commit -m "docs(web): document LAN mobile pairing"
```

## Plan Review

- Scope coverage: Task 1 enables the opt-in LAN bind and port selection; Tasks 2 and 3 implement the clean URL, six-digit PIN, cookie issuance, Host/Origin trust, and throttling; Task 4 provides the requested operating instructions and durable security record.
- Placeholder review: every implementation and test task names its files, methods, commands, and expected observable outcome.
- Type review: `ConnectionIndexRequest.peerAddress`, `HostConnectionHandle.pairing`, and `HostConnectionHandle.authorizePairing()` are introduced before the runtime and route use them.
