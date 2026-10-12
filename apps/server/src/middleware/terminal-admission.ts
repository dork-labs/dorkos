/**
 * The headers of the `503` a stopping server answers with: the chain's first
 * step refuses every new request this way once the server is stopping
 * (`http/api-chain.ts`).
 */
export const SERVER_STOPPING_HEADERS = {
  'Cache-Control': 'no-store',
  Connection: 'close',
  'X-Content-Type-Options': 'nosniff',
} as const;

/** The body of the `503` a stopping server answers with. */
export const SERVER_STOPPING_BODY = {
  code: 'SERVER_STOPPING',
  error: 'The server is stopping. Try again after it restarts.',
} as const;
