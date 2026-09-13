/** Single-sample LAN-trust resolution for the /api browser-trust fence (`resolveLanTrust`). */

import { describe, expect, it, vi } from 'vitest'
import { resolveLanTrust } from '../src/index.ts'

vi.mock('node:os', () => ({
  networkInterfaces: () => ({
    lo0: [
      { family: 'IPv4', internal: true, address: '127.0.0.1' },
    ],
    en0: [
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: false, address: '192.168.1.5' },
    ],
    en1: [
      { family: 'IPv4', internal: false, address: '10.0.0.7' },
    ],
    en2: [
      { family: 'IPv4', internal: false, address: '172.16.4.1' },
      { family: 'IPv4', internal: false, address: '169.254.10.1' },
    ],
    en3: [
      { family: 'IPv4', internal: false, address: '100.64.0.9' },
      { family: 'IPv4', internal: false, address: '203.0.113.9' },
    ],
    utun0: undefined,
  }),
}))

const LAN_ADDRESSES = [
  '192.168.1.5', '10.0.0.7', '172.16.4.1', '169.254.10.1', '100.64.0.9', '203.0.113.9',
]

describe('resolveLanTrust', () => {
  it('samples non-internal IPv4 addresses once for an all-interfaces bind: trust and display share them', () => {
    const { lanAddresses, trustedHosts } = resolveLanTrust('0.0.0.0', ['harness.internal:3080'])
    expect(lanAddresses).toEqual(LAN_ADDRESSES)
    expect(trustedHosts).toEqual([...LAN_ADDRESSES, 'harness.internal:3080'])
  })

  it('pairs only RFC1918, link-local, and CGNAT literals — a globally routable address never receives the PIN form', () => {
    expect(resolveLanTrust('0.0.0.0', []).pairingAddresses)
      .toEqual(['192.168.1.5', '10.0.0.7', '172.16.4.1', '169.254.10.1', '100.64.0.9'])
  })

  it('derives nothing for a loopback bind — extras alone stand, no LAN URL to print', () => {
    expect(resolveLanTrust('127.0.0.1', [])).toEqual({ lanAddresses: [], pairingAddresses: [], trustedHosts: [] })
    expect(resolveLanTrust('127.0.0.1', ['lab.internal']))
      .toEqual({ lanAddresses: [], pairingAddresses: [], trustedHosts: ['lab.internal'] })
  })
})
