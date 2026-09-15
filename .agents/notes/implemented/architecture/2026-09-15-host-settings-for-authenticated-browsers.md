# Agent Note: Host settings for every authenticated browser

Status: implemented

English | [中文](2026-09-15-host-settings-for-authenticated-browsers.zh.md)

## Problem

The Web client resolved Host persistence from page locality: `ui-settings` read `ctx.remote.$host.isLoopback` and selected `'memory'` for every other authority. The dist root and `/api` share one browser-session check, so a page that loaded at all had already authenticated to this Host; locality was never the authentication signal the gate implied. A browser admitted by LAN PIN pairing ([LAN mobile pairing](2026-09-10-lan-mobile-pairing.md)) therefore received a terminally unavailable settings mirror: the Models page failed with `settings are unavailable in this browser`, the Plugins section offered no configurable namespace, and theme, locale, and onboarding-acknowledgement preferences stayed process-local even though the API served them.

## Decision

`dsh-client-ui-settings` resolves `persistence: 'host'` unconditionally. Host persistence follows the browser session that read the page, not the authority that served it. The `'memory'` mode stays the mechanism's other value — the mirror, the scope controller, and the welcome store keep their memory branches for a composition that genuinely wants every preference process-local — but no shipped composition selects it. `isLoopback` loses exactly one consumer: the native Host document action in `ui-settings-general` stays loopback-only, because opening a file in the Host desktop editor is locality-dependent.

The earlier [Host-backed preferences decision](../bug-fix/2026-08-06-host-backed-web-preferences.md) chose the locality gate for non-loopback pages; this note supersedes that part of it and leaves the rest in force.

## Verification

`packages/client/ui-settings/tests/plugin.client.spec.ts` pins that a non-loopback `$host` still reads the Host document, and the apply specs of `ui-theme`, `ui-settings-general`, and `ui-settings-models` pin that a non-loopback page loads and writes Host settings. The memory-mode mechanism keeps direct coverage in `settings-mirror.client.spec.ts`, `settings-scope.client.spec.ts`, and `welcome-store.client.spec.ts`.

## Alternatives considered

**Treat a paired LAN page as loopback.** Rejected: `connection.isLoopback` answers whether the carrier reaches the local Host, and the pairing flow grants no such identity. Widening it would also expose the locality-dependent native document opener to a phone.

**Add a paired/trusted-remote fact to the connection ready frame.** Rejected: the settings document is already gated by the same browser session as `/api`, so the extra wire fact would restate what every loaded page proves, and it would change the handshake both faces and the SDKs carry.

**Keep a per-host opt-in for remote settings.** Rejected: the only non-loopback composition is the explicit `--host 0.0.0.0` opt-in with PIN pairing, so a second switch would add a configuration state with no current consumer.

## Consequences

A LAN-paired browser edits the same `$DSH_HOME/settings.yaml` the loopback page reads, including the provider sections the Models page writes, and its theme, locale, and onboarding acknowledgement survive a reload. The operator-facing consequence is that any browser holding a valid session on this Host can change the durable model configuration, exactly as it can already prompt sessions that run tools. Only the native Host document action remains unavailable off-loopback.
