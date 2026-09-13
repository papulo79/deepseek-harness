# Web LAN Access Design

## Goal

Allow the Web GUI to be opened from a mobile browser on the same local network without placing an opaque authentication token in the mobile URL, while allowing the operator to choose the listening port.

## Scope

The Web CLI accepts `--host 0.0.0.0` as an explicit all-interface binding. `127.0.0.1` remains the default. The existing `--port` and `--no-open` options remain unchanged.

The Web runtime discovers LAN IPv4 addresses after the server binds, adds them to the API Host/Origin trust list, and prints a clean LAN URL plus a randomly generated six-digit pairing PIN. A mobile browser opens the clean URL, submits the PIN on a minimal pairing page, and receives an authority-bound browser session cookie.

The local computer continues to receive the existing token-bearing launch URL and exchanges it as before. The mobile PIN remains process-local and expires when the Web process stops.

## Security

LAN exposure is opt-in through `--host 0.0.0.0`. The API trust fence continues to require a loopback, discovered LAN, or explicitly configured trusted authority. Browser RPC and WebSocket connections continue to require an authority-bound signed cookie.

The pairing route accepts at most five failed PIN attempts from one peer address, then rejects further attempts from that address for five minutes. A successful PIN submission mints the same signed cookie used by the existing local token exchange and redirects to the clean root URL. The pairing page sends `Cache-Control: no-store` and does not expose the PIN in its URL.

The change does not add Internet exposure, TLS, reverse-proxy configuration, or authentication beyond the existing browser session mechanism. Operators must limit the selected port to their private network with their host firewall when their network is not trusted.

## Implementation

Remove the Web CLI's usage-error branch for `--host 0.0.0.0`. Retain input validation for port values and the existing configuration expressions that pass the parsed host and port to the webserver row.

Add a LAN-only mobile pairing route and its minimal HTML form. Keep the local token exchange intact. Update command help and user-facing Web documentation to state that an all-interface bind exposes the GUI to the local network, and describe the clean LAN URL and temporary PIN flow.

## Verification

Extend the startup command tests to accept `--host 0.0.0.0` and prove the parsed value reaches the webserver configuration. Add host authentication tests for successful and rejected PIN submissions, attempt throttling, and cookie issuance. Retain the tests that reject malformed ports. Run the focused Web bundle, connection, and CLI test suites.

## Usage

```sh
pnpm dsh web --host 0.0.0.0 --port 3081 --no-open
```

Open the printed LAN URL on the mobile device and enter the PIN printed beside it. The server must be restarted after a LAN address changes.
