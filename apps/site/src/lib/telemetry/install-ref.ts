/**
 * The site half of the install ref (DOR-2862): a short anonymous tag added to
 * the install command a visitor copies, so PostHog can join that visit to the
 * first run of the install it led to, with no account.
 *
 * The ref is minted fresh for each copy and stored nowhere on the site: it lives
 * only in the copied command, the visitor's own `hero_install_copy` event, and
 * (once the CLI runs) the install's data folder. It is only ever minted for a
 * visitor who allows analytics cookies (see `prepareInstallCopy` in
 * `lib/analytics.ts`); a cookieless, declined, Do Not Track or Global Privacy
 * Control visitor copies the plain command.
 *
 * Wire form, mirrored by `@dorkos/shared/install-ref` (the site keeps its own
 * copy, per ADR-0235): `<token>[.<utm_source>[.<utm_campaign>]]`, where the
 * token is 12 random lowercase base-36 characters.
 *
 * Only the curl one-liner and `npx` can carry it, because only they run code
 * that can record it. `npm install -g dorkos` and the desktop downloads cannot:
 * npm runs no DorkOS code at install time, and a downloaded app has no way to
 * receive anything from the page that linked to it.
 *
 * Pure and dependency-free so both the browser and the Edge ingest route import it.
 *
 * @module lib/telemetry/install-ref
 */

/** The random part of a ref: 12 lowercase base-36 characters. */
export const INSTALL_REF_TOKEN_PATTERN = /^[a-z0-9]{12}$/;

/** A campaign tag carried by a ref: short, and only plain characters. */
export const INSTALL_REF_UTM_PATTERN = /^[a-z0-9_-]{1,32}$/;

const TOKEN_LENGTH = 12;
const UTM_MAX_LENGTH = 32;
const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The visitor's first-touch campaign tags, as read from the landing URL. */
export interface FirstTouchUtm {
  source?: string | null;
  campaign?: string | null;
}

/**
 * The PostHog distinct id a ref joins under. The browser aliases the visitor to
 * it when they copy the command; the ingest aliases the install's `instanceId`
 * to it when `first_run_completed` arrives. Both sides must build it here.
 *
 * @param token - The ref's random token.
 */
export function installRefDistinctId(token: string): string {
  return `install_ref:${token}`;
}

/**
 * Mint a fresh random token.
 *
 * @param fillRandom - Random source (tests). Defaults to `crypto.getRandomValues`.
 */
export function createInstallRefToken(
  fillRandom: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)
): string {
  const bytes = fillRandom(new Uint8Array(TOKEN_LENGTH));
  return Array.from(bytes, (byte) => BASE36[byte % BASE36.length]).join('');
}

/**
 * Fold a campaign tag into the ref's plain character set: lowercase, anything
 * else becomes `-`, capped at 32 characters. Empty in, `undefined` out.
 *
 * @param value - A raw `utm_*` value.
 */
export function sanitizeUtm(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, UTM_MAX_LENGTH);
  return INSTALL_REF_UTM_PATTERN.test(cleaned) ? cleaned : undefined;
}

/**
 * Build the wire form from a token and the first-touch tags.
 *
 * @param token - The ref's random token.
 * @param utm - First-touch `utm_source` / `utm_campaign`, if any.
 */
export function formatInstallRef(token: string, utm: FirstTouchUtm = {}): string {
  const source = sanitizeUtm(utm.source) ?? '';
  const campaign = sanitizeUtm(utm.campaign) ?? '';
  if (campaign) return `${token}.${source}.${campaign}`;
  if (source) return `${token}.${source}`;
  return token;
}

/**
 * Add a ref to an install command, or return `null` when the command has no
 * way to carry one (see the module doc).
 *
 * - `curl -fsSL https://dorkos.ai/install | bash` → `... | bash -s -- --ref=<ref>`
 * - `npx dorkos@latest` → `npx dorkos@latest --ref=<ref>`
 *
 * @param command - The install command as shown on the page.
 * @param ref - The ref in wire form.
 */
export function withInstallRef(command: string, ref: string): string | null {
  if (/\|\s*bash$/.test(command)) return `${command} -s -- --ref=${ref}`;
  if (/^npx dorkos(@\S+)?$/.test(command)) return `${command} --ref=${ref}`;
  return null;
}
