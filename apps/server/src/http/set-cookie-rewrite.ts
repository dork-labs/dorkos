/**
 * Rewrite every `Set-Cookie` a response sends, whichever way it is set:
 * `setHeader`, `appendHeader`, or the headers given to `writeHead`. Shared by
 * the listeners that rename DorkOS's sign-in cookies for where a request came
 * from: the Wi-Fi listener (`services/core/lan-access/lan-cookies.ts`) and a
 * hub (`services/core/hub/hub-cookies.ts`).
 *
 * @module http/set-cookie-rewrite
 */
import type { ServerResponse } from 'node:http';

/** Every shape a header value takes on its way into a response. */
type HeaderValue = number | string | readonly string[];

/** One `Set-Cookie` value in, the value to send out. */
export type SetCookieRewrite = (value: string) => string;

/** Apply `rewrite` to whatever shape a `Set-Cookie` value arrives in. */
function rewriteValue<T extends HeaderValue>(value: T, rewrite: SetCookieRewrite): T {
  if (Array.isArray(value)) return value.map(rewrite) as unknown as T;
  return (typeof value === 'string' ? rewrite(value) : value) as T;
}

/** Rewrite `Set-Cookie` inside the headers argument `writeHead` was given. */
function rewriteHeaders(headers: unknown, rewrite: SetCookieRewrite): unknown {
  // A flat `[name, value, name, value]` list.
  if (Array.isArray(headers)) {
    return headers.map((entry, index) =>
      index % 2 === 1 && String(headers[index - 1]).toLowerCase() === 'set-cookie'
        ? rewriteValue(entry as HeaderValue, rewrite)
        : entry
    );
  }
  if (headers && typeof headers === 'object') {
    const record = { ...(headers as Record<string, HeaderValue>) };
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() === 'set-cookie') record[key] = rewriteValue(record[key]!, rewrite);
    }
    return record;
  }
  return headers;
}

/**
 * Pass every `Set-Cookie` this response sends through `rewrite`, in place.
 *
 * @param res - The response.
 * @param rewrite - Maps one `Set-Cookie` value to the one sent.
 */
export function rewriteResponseSetCookies(res: ServerResponse, rewrite: SetCookieRewrite): void {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) =>
    setHeader(name, name.toLowerCase() === 'set-cookie' ? rewriteValue(value, rewrite) : value);
  const appendHeader = res.appendHeader.bind(res);
  res.appendHeader = (name, value) =>
    appendHeader(name, name.toLowerCase() === 'set-cookie' ? rewriteValue(value, rewrite) : value);
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  res.writeHead = ((...args: unknown[]) => {
    const headersAt = typeof args[1] === 'string' ? 2 : 1;
    if (args[headersAt] !== undefined) args[headersAt] = rewriteHeaders(args[headersAt], rewrite);
    return writeHead(...args);
  }) as ServerResponse['writeHead'];
}
