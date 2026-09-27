/**
 * The identity rules an account registry row follows: its id pattern, the one
 * reserved id, and its display color (marketplace `specs/flow-cli-core`
 * §1.1a, the contract flow and DorkOS share).
 *
 * Kept free of imports on purpose. `config-schema.ts` applies these rules when
 * it reads and validates `runtimes.claudeCode.accounts`, and that module must
 * stay light enough for the CLI and the client to load, so it cannot import
 * `account-usage.ts` (which teaches zod OpenAPI). `account-usage.ts` re-exports
 * everything here, and that re-export is the public way in.
 *
 * @module shared/account-identity
 */

/**
 * The pattern every account registry id must match (contract §1.1a). It is
 * also the ledger's file name, so anything else is refused: no path traversal.
 */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The id of a runtime's default account, and the one id a registry row may
 * never take (contract §1.1a, revision 6d).
 *
 * `<runtime>:default` always names that runtime's default account: the folder
 * `runtimes.claudeCode.defaultAccount` names, else `~/.claude`. A registered
 * row called `default` would be a second account answering to that name, so
 * minting skips it (a label "Default" becomes `default-2`), every config write
 * refuses it as a new or changed id, and a row still carrying it is listed with
 * an `id-reserved` warning until the config migration renames it. It matches
 * {@link ACCOUNT_ID_PATTERN}, so it names a ledger file like any other id.
 */
export const IMPLICIT_ACCOUNT_ID = 'default';

/** A stored account color: lowercase `#rrggbb` (contract §1.1a). */
export const ACCOUNT_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/**
 * The positional default colors for accounts with no stored color.
 *
 * Provisional: the UI track owns these values, and nothing persists them (a
 * stored `color: null` means "the default for this position", resolved at read
 * time), so they may change freely.
 */
export const DEFAULT_ACCOUNT_COLORS: readonly string[] = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
];

/** Wrap any integer position into the default palette, negatives included. */
function paletteColorAt(index: number): string {
  const n = DEFAULT_ACCOUNT_COLORS.length;
  const i = Number.isFinite(index) ? Math.trunc(index) : 0;
  return DEFAULT_ACCOUNT_COLORS[((i % n) + n) % n]!;
}

/**
 * Whether a stored color is one the contract accepts: lowercase `#rrggbb`.
 *
 * @param stored - Whatever the row's `color` field holds.
 */
export function isAccountColor(stored: unknown): stored is string {
  return typeof stored === 'string' && ACCOUNT_COLOR_PATTERN.test(stored);
}

/**
 * The color an account is drawn in: its stored color when that is a valid
 * lowercase `#rrggbb`, else the default for its position in the registry.
 *
 * @param stored - The row's stored `color`, possibly `null` or a hand-edited bad value.
 * @param index - The row's position in the registry; wraps around the palette.
 */
export function resolveAccountColor(stored: string | null | undefined, index: number): string {
  if (isAccountColor(stored)) return stored;
  return paletteColorAt(index);
}

/**
 * The color to give a newly registered account: the first palette value no
 * existing row uses, else the positional default when every value is taken.
 *
 * @param taken - The colors registered rows already resolve to.
 * @param index - The new row's position in the registry.
 */
export function nextAccountColor(taken: Iterable<string>, index: number): string {
  const used = new Set<string>();
  for (const color of taken) used.add(color.toLowerCase());
  return DEFAULT_ACCOUNT_COLORS.find((color) => !used.has(color)) ?? paletteColorAt(index);
}

/**
 * Whether a path names a folder on the machine the server runs on: a POSIX
 * root (`/Users/you/.claude2`) or a Windows drive or network root
 * (`C:\Users\you\.claude2`, `\\host\share\claude`). A leading `~` does not
 * count: nothing between the config file and the runtime expands it.
 *
 * @param candidate - The stored `path`.
 */
export function isAbsoluteAccountPath(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(candidate);
}
