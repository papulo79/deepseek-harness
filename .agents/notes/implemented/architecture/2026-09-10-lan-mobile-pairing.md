# Agent Note: LAN mobile pairing for the Web GUI

Status: implemented

English | [中文](2026-09-10-lan-mobile-pairing.zh.md)

## Problem

The Web GUI began as a loopback-only surface: `dsh web` bound `127.0.0.1`, and the CLI rejected `--host 0.0.0.0` outright. An operator who wanted to drive the same tool-capable session from a phone on the same network therefore had to forward a port or paste the process launch token — a per-process bearer credential — into the mobile browser, where it would sit in the address bar, history, and any bookmark. The existing browser-session cookie already bounds an authenticated browser to one authority; what was missing was a way to admit a phone without handing it the process credential.

## Decision

`dsh web --host 0.0.0.0` is a supported, explicit opt-in. Loopback remains the default, and the CLI adds no host validation of its own: the parsed value reaches the webserver row, whose schemastery `host` literal union is the single validity source, so any other value fails the load loudly. After the server binds, the Web runtime samples the machine's non-internal IPv4 addresses once, adds them to the `/api` Host/Origin fence, and prints them as a clean LAN URL next to a six-digit PIN; the loopback URL keeps the process token and its existing exchange.

`dsh-client-connection` owns pairing because it already owns browser authentication. With `config.pairing.authorities` non-empty it mints one six-digit PIN per process, retained by the root application context across Connection hot reloads, and registers an exact `POST /pair` route. An unauthenticated `GET` for the dist root whose Host matches a pairing authority receives a minimal HTML form containing no PIN; every other unauthenticated index request keeps the plain 401. The route applies the Host/Origin fence first, caps the body at 1024 bytes, requires exactly one `pin` field in an `application/x-www-form-urlencoded` body, and compares it with the existing constant-time comparison. A match mints the same signed, authority-bound cookie as the local token exchange, so a paired phone and the local browser converge on one authentication path. Five failed submissions from one peer address (`maxFailedAttempts`) lock that address out for five minutes (`lockoutMilliseconds`), during which it receives 429 without a PIN check; `maxTotalFailedAttempts` (default 50) failures from every peer together stop pairing until the process restarts, which bounds a peer set that rotates source addresses. The Web bundle passes only the private, link-local, and CGNAT subset of the discovered literals as pairing authorities, so an interface holding a globally routable address serves no pairing form to an Internet client.

The Web bundle passes `ctx.webRuntime.lanAddresses` as the pairing authorities, so pairing exists exactly when the CLI bound all interfaces and at least one LAN address was discovered. The Web runtime prints the PIN only when both the LAN URL and `ctx.connection.pairing` exist, and the local token URL is never replaced.

## Verification

[`browser-auth.host.spec.ts`](../../../../packages/client/connection/tests/browser-auth.host.spec.ts) pins the form, the PIN comparison, the per-peer throttle, lockout expiry, and rejection without an authority or a peer address. [`node-half.host.spec.ts`](../../../../packages/client/connection/tests/node-half.host.spec.ts) pins the route's 403/405/413/400 responses, the PIN defaults, and load-time authority validation. [`frontend-static.spec.ts`](../../../../packages/host/frontend-static/tests/frontend-static.spec.ts) boots the real Loader composition, serves the pairing page over HTTP, exchanges the PIN, and serves the shell with the issued cookie. [`web-app.spec.ts`](../../../../packages/bundle/web-app/tests/web-app.spec.ts) and [`startup.spec.ts`](../../../../packages/bundle/web-app/tests/startup.spec.ts) pin the URL line and the accepted flag.

## Alternatives considered

**Put the launch token in the LAN URL.** Rejected: the URL would place a process bearer credential in the phone's address bar, history, and bookmarks, so a screenshot or a shared link would leak it.

**Accept a PIN on the existing token query.** Rejected: the exchange owns `GET /`, and a visible query value would be logged and bookmarked the same way. A POST form keeps the PIN out of URLs and browser history.

**Let any `trustedHosts` authority pair.** Rejected: `--trusted-host` exists to serve a named deployment authority, and an operator may add one without intending it as a LAN pairing endpoint. Pairing uses the derived LAN literals, a strict subset.

**Authenticate the phone by IP address.** Rejected: a DHCP lease is not an identity, and the peer address serves only as the throttle key.

## Consequences

Pairing adds no new authority: a valid PIN yields the same cookie the local token exchange already issues, and an invalid one yields 401 or 429. The PIN is memory-only and expires with the process, so a restart changes it and a network change requires a restart to re-advertise.

The listener still adds no TLS. On an untrusted network the PIN and the session cookie travel in cleartext, so the all-interface bind is an explicit operator risk rather than a hardened remote deployment. Peer state is a map keyed by source address and bounded by the process failure budget: every tracked peer spent at least one of those submissions. `--trusted-host` still grants no identity, and the LAN PIN flow does not change the [Host/Origin fence](2026-07-28-api-browser-trust-boundary.md) or the [browser token exchange](2026-08-24-browser-token-authentication.md).
