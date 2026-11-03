/** Framing policy at the final HTTP boundary, including routes that write raw Node responses. */
import type { ServerResponse } from 'node:http';

const CSP = 'content-security-policy';
const FRAME_ANCESTORS = /(?:^|[;,])\s*frame-ancestors(?:\s|$)/i;
type HeaderValue = number | string | readonly string[] | undefined;

/** The headers supplied directly to writeHead override earlier setHeader calls. */
function valuesFrom(headers: unknown, name: string): string[] | undefined {
  const values: string[] = [];
  const add = (value: HeaderValue): void => {
    if (value !== undefined) values.push(...(Array.isArray(value) ? value : [String(value)]));
  };
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2)
      if (String(headers[index]).toLowerCase() === name) add(headers[index + 1] as HeaderValue);
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers))
      if (key.toLowerCase() === name) add(value as HeaderValue);
  }
  return values.length ? values : undefined;
}

/** Replace only CSP; keep other headers, including repeated Set-Cookie fields, intact. */
function withPolicy(headers: unknown, policy: readonly string[]): unknown {
  if (Array.isArray(headers)) {
    const kept: unknown[] = [];
    for (let index = 0; index < headers.length; index += 2)
      if (String(headers[index]).toLowerCase() !== CSP)
        kept.push(headers[index], headers[index + 1]);
    for (const value of policy) kept.push(CSP, value);
    return kept;
  }
  if (headers && typeof headers === 'object') {
    const kept = Object.fromEntries(
      Object.entries(headers).filter(([key]) => key.toLowerCase() !== CSP)
    );
    return { ...kept, [CSP]: policy };
  }
  return headers;
}

/**
 * Deny framing unless a route supplies an explicit framing policy. Workbench
 * content already supplies one. Successful PDFs need trusted app ancestors for
 * the canvas's native object viewer; other responses, including API refusals,
 * redirects, errors and streams, default to none. Existing CSP directives stay.
 *
 * Installed before admission, and applied at writeHead so raw streams and the
 * Hono adapter cannot overwrite it accidentally. Never buffers a response body.
 *
 * @param response - The response before its headers are sent.
 * @param trustedOrigins - App origins, read only when serving a PDF preview.
 */
export function protectResponseFraming(
  response: ServerResponse,
  trustedOrigins: () => readonly string[]
): void {
  const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
  response.writeHead = ((...args: unknown[]) => {
    const headersAt = typeof args[1] === 'string' ? 2 : 1;
    const headers = args[headersAt];
    const prior = response.getHeader(CSP);
    const policies =
      valuesFrom(headers, CSP) ??
      (prior === undefined ? [] : Array.isArray(prior) ? [...prior] : [String(prior)]);
    if (!policies.some((policy) => FRAME_ANCESTORS.test(policy))) {
      const contentType =
        valuesFrom(headers, 'content-type')?.[0] ??
        String(response.getHeader('content-type') ?? '');
      const status = Number(args[0]);
      const pdf = status >= 200 && status < 300 && /^application\/pdf(?:\s*;|$)/i.test(contentType);
      policies.push(
        pdf
          ? `frame-ancestors 'self' ${trustedOrigins().join(' ')}`.trimEnd()
          : "frame-ancestors 'none'"
      );
    }
    response.setHeader(CSP, policies);
    if (headers !== undefined) args[headersAt] = withPolicy(headers, policies);
    return writeHead(...args);
  }) as ServerResponse['writeHead'];
}
