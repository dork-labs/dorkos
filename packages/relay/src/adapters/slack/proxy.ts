/**
 * Corporate-proxy support for the Slack adapter's network traffic.
 *
 * `@slack/web-api` 7 sent every request through axios, which honors
 * `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` automatically. `@slack/web-api` 8 (and
 * `@slack/socket-mode`, which Bolt builds its Socket Mode connection on) moved
 * to native `fetch`, which does not read those variables — so upgrading past
 * v7 silently dropped proxy support for every install running behind one
 * (DOR-1542). This module restores it by building an undici
 * `EnvHttpProxyAgent` (which does read those variables) and wiring it through
 * the transport hooks both SDKs expose.
 *
 * @module relay/adapters/slack/proxy
 */
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { FetchFunction } from '@slack/web-api';

/**
 * Every env var (either case) that, on its own, means "use a proxy transport."
 *
 * `NO_PROXY` is deliberately excluded: alone it means "use no proxy," so
 * treating it as a trigger would switch Slack onto the custom
 * `EnvHttpProxyAgent` path for installs that never asked for one, for no
 * behavioral benefit. `EnvHttpProxyAgent` still reads `NO_PROXY` itself once
 * the transport exists for another reason (see {@link createSlackProxyTransport}).
 */
const PROXY_ENV_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'] as const;

/** Whether `HTTP_PROXY`/`HTTPS_PROXY` (either case) is set — see {@link PROXY_ENV_VARS}. */
export function hasProxyEnv(): boolean {
  // relay is a library with no env.ts; reading process.env directly here (rather than
  // threading a config value through every adapter constructor) matches how the CLI
  // package accesses ambient proxy-style env vars.
  // eslint-disable-next-line no-restricted-syntax
  return PROXY_ENV_VARS.some((name) => Boolean(process.env[name]));
}

/**
 * The Slack SDK transport wired to a corporate proxy: a shared undici
 * dispatcher plus a `fetch` bound to it.
 */
export interface SlackProxyTransport {
  /** Reads `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` from the environment on construction. */
  readonly dispatcher: Dispatcher;
  /** `fetch`, routed through {@link dispatcher} — pass to `WebClientOptions.fetch`. */
  readonly fetch: FetchFunction;
}

/**
 * Build the Slack SDK proxy transport, or `null` when no proxy env var is set.
 *
 * Callers pass `null` straight through as "nothing configured" — every
 * caller in this adapter treats that as leaving the SDK's own default
 * (`globalThis.fetch`, no dispatcher) untouched, so an install with no proxy
 * configured behaves exactly as it did before this module existed.
 */
export function createSlackProxyTransport(): SlackProxyTransport | null {
  if (!hasProxyEnv()) return null;

  const dispatcher = new EnvHttpProxyAgent();
  const fetch: FetchFunction = (url, init) =>
    undiciFetch(url, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]);

  return { dispatcher, fetch };
}
