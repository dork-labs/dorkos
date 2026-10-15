import type { ServerResponse } from 'node:http';
/** Serialize the original owned writer response without caching. */
export async function json(response: ServerResponse, status: number, value: unknown) {
  const bytes = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(bytes);
}
