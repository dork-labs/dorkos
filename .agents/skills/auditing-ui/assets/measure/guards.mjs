/**
 * Two checks the measure leg runs before it touches anything (DOR-3281).
 * Kept apart from measure.mjs so they can be tested without a browser.
 */
import { resolve } from 'node:path';

/** The operator's own DorkOS. The measure leg never points at it. */
export const OPERATOR_PORT = '4242';

/**
 * Where to look for Playwright, in order. Never the current directory: a
 * planted `node_modules/playwright-core` there would run as this script.
 *
 * @param {string | undefined} fromEnv - `PLAYWRIGHT_FROM`, if set.
 * @param {string} here - This script's own directory.
 * @returns {string[]} Absolute roots to resolve Playwright from.
 */
export function playwrightRoots(fromEnv, here) {
  return [fromEnv, here, resolve(here, '../../../../../apps/e2e')]
    .filter(Boolean)
    .map((root) => resolve(root));
}

/**
 * Why a `--url` must be refused, or null if it's fine. The port is read from
 * the parsed URL, so every spelling of a loopback host is caught
 * (`localhost`, `127.0.0.1`, `[::1]`, `0x7f000001`, …).
 *
 * @param {string} raw - The `--url` value.
 * @returns {string | null} The refusal message, or null.
 */
export function refuseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `--url is not a URL: ${raw}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `--url must be http or https, not ${url.protocol}`;
  }
  if (url.port === OPERATOR_PORT) {
    return `--url points at port ${OPERATOR_PORT}, the operator's own DorkOS. Measure a dev or preview server instead (see SKILL.md).`;
  }
  return null;
}
