/**
 * Generated blocks inside hand-written docs.
 *
 * A doc that lists the required checks by hand drifts the first time the
 * ruleset changes (the PR skill listed 4 of 9 for weeks). Instead, each listed
 * doc carries a marked block rendered from `ci/required-checks.json`; the
 * census fails when a block differs from the file byte for byte, and
 * `census --fix` rewrites it.
 */

/** Opening marker of the required-checks block. */
const REQUIRED_CHECKS_START = '<!-- ci-steward:required-checks:start -->';
/** Closing marker of the required-checks block. */
const REQUIRED_CHECKS_END = '<!-- ci-steward:required-checks:end -->';

/**
 * Render the block: the two markers around one bullet per context, in file order.
 *
 * @param contexts - The required contexts from `ci/required-checks.json`.
 */
export function renderRequiredChecksBlock(contexts: readonly string[]): string {
  return [REQUIRED_CHECKS_START, ...contexts.map((c) => `- \`${c}\``), REQUIRED_CHECKS_END].join(
    '\n'
  );
}

/** How a doc's block compares with the rendered one. */
export type BlockState = 'ok' | 'drift' | 'missing' | 'malformed';

function locate(text: string): { start: number; end: number } | 'missing' | 'malformed' {
  const starts = text.split(REQUIRED_CHECKS_START).length - 1;
  const ends = text.split(REQUIRED_CHECKS_END).length - 1;
  if (starts === 0 && ends === 0) return 'missing';
  if (starts !== 1 || ends !== 1) return 'malformed';
  const start = text.indexOf(REQUIRED_CHECKS_START);
  const end = text.indexOf(REQUIRED_CHECKS_END) + REQUIRED_CHECKS_END.length;
  return end > start ? { start, end } : 'malformed';
}

/**
 * Compare a doc's block with the rendered block.
 *
 * @param text - The doc's full text.
 * @param rendered - The block from {@link renderRequiredChecksBlock}.
 */
export function blockState(text: string, rendered: string): BlockState {
  const at = locate(text);
  if (typeof at === 'string') return at;
  return text.slice(at.start, at.end) === rendered ? 'ok' : 'drift';
}

/**
 * Replace the doc's block with the rendered one; `null` when there is no single well-formed block.
 *
 * @param text - The doc's full text.
 * @param rendered - The block from {@link renderRequiredChecksBlock}.
 */
export function replaceBlock(text: string, rendered: string): string | null {
  const at = locate(text);
  if (typeof at === 'string') return null;
  return text.slice(0, at.start) + rendered + text.slice(at.end);
}
