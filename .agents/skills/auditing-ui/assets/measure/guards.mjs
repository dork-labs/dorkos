/**
 * Safety checks measure.mjs runs before it opens a browser (DOR-3281).
 *
 * - `refuseOperatorUrl`: never measure :4242, the operator's own DorkOS. The rule used to be
 *   prose only (`/ui-audit:measure`). It parses the URL, so every spelling of a host is caught
 *   (`localhost`, `127.0.0.1`, `[::1]`, `0x7f000001`, a hostname): the port decides, not the host.
 * - `playwrightRoots`: where Playwright may be loaded from. `PLAYWRIGHT_FROM`, then this
 *   script's own folder, then the repo's `apps/e2e`. Never the current directory: run from an
 *   agent's repo or any folder with a planted `node_modules/playwright-core`, that would run
 *   whatever code sits there.
 */
import { resolve } from 'node:path';

export const OPERATOR_PORT = '4242';

/** Returns an error message when `url` may not be measured, or null when it may. */
export function refuseOperatorUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return `measure.mjs: --url is not a valid URL: ${url}`;
  }
  // `localhost:4242` parses as a `localhost:` scheme with no port, so only http(s) gets through.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `measure.mjs: --url must start with http:// or https://: ${url}`;
  }
  if (parsed.port === OPERATOR_PORT) {
    return (
      `measure.mjs: refusing ${parsed.host}. Port ${OPERATOR_PORT} is the operator's own DorkOS; ` +
      'start your own dev server on a free port and measure that (see /ui-audit:measure).'
    );
  }
  return null;
}

/** The folders Playwright may be resolved from, in order. Never `process.cwd()`. */
export function playwrightRoots({ env = process.env, here }) {
  return [env.PLAYWRIGHT_FROM, here, resolve(here, '../../../../../apps/e2e')].filter(Boolean);
}
