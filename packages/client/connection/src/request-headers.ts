/** One reader for the two request-header representations the Host carrier sees. */

import type { ConnectionTrustRequest } from './rpc.ts'

/**
 * Read one request header from either an undici `Headers` map or a Node
 * incoming-header bag. Node repeats a duplicated header as an array, which this
 * reader treats as absent: every caller wants one authority or one cookie.
 * @param headers - request headers in either representation.
 * @param name - lower-case header name.
 * @returns the header value, or undefined when absent or repeated.
 */
export function requestHeader(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}
