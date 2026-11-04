/**
 * The pure half of the Mac browser reading: what a flag line must hold, and how
 * the rows add up. Kept apart from the run so a test can prove the job goes red
 * when a row is missing, which is the one failure a green run can't show.
 */

/** The features that must be off in both windows. The agent's window also keeps Playwright's own list. */
export const REQUIRED_DISABLED = ['HttpsUpgrades', 'HttpsFirstBalancedModeAutoEnable'];

/** Every row a run must report. A row that isn't here can't pass by being skipped. */
export const EXPECTED_ROWS = [
  'both: person opens',
  'both: agent navigates',
  'only-http: person opens',
  'only-http: agent navigates',
  'flags: agent window',
  'flags: plain window',
];

/**
 * Read every `--disable-features` from one process's command line.
 *
 * @param {string} args - The process's arguments.
 * @returns {string[][]} One list of features per flag. Chromium honours only the last.
 */
export function disabledFeatureFlags(args) {
  return [...args.matchAll(/(?:^|\s)--disable-features=(\S*)/g)].map((match) =>
    match[1].split(',').filter(Boolean)
  );
}

/** One `--disable-features` holding everything `wanted` names. */
function checkOneFlag(args, wanted) {
  const flags = disabledFeatureFlags(args);
  const held = new Set(flags[0] ?? []);
  const missing = [...new Set(wanted)].filter((name) => !held.has(name));
  const problems = [];
  if (flags.length !== 1) problems.push(`expected one --disable-features, found ${flags.length}`);
  if (missing.length > 0) problems.push(`missing: ${missing.join(', ')}`);
  return { pass: problems.length === 0, count: flags.length, missing, problems };
}

/**
 * The agent's window: exactly one `--disable-features`, holding Playwright's whole
 * list plus the required features.
 *
 * @param {string} args - The window's arguments.
 * @param {string[]} playwrightList - What stock Playwright disables, read from a stock launch.
 */
export function checkAgentFlags(args, playwrightList) {
  const result = checkOneFlag(args, [...playwrightList, ...REQUIRED_DISABLED]);
  if (playwrightList.length > 0) return result;
  return {
    ...result,
    pass: false,
    problems: [...result.problems, 'stock Playwright list is empty'],
  };
}

/**
 * The plain sign-in window: Playwright never starts it, so it has no list of Playwright's
 * to keep (Security's ruling, Nov 4). Exactly one `--disable-features`, holding the required features.
 *
 * @param {string} args - The window's arguments.
 */
export function checkPlainFlags(args) {
  return checkOneFlag(args, REQUIRED_DISABLED);
}

/**
 * Add up a run. Green only if every expected row is present and passed.
 *
 * @param {{ id: string, pass: boolean }[]} rows - What the run recorded.
 * @param {string | null} crash - The error that ended the run early, if one did.
 */
export function verdict(rows, crash = null) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const skipped = EXPECTED_ROWS.filter((id) => !byId.has(id));
  const failed = EXPECTED_ROWS.filter((id) => byId.has(id) && byId.get(id).pass !== true);
  const unexpected = rows.map((row) => row.id).filter((id) => !EXPECTED_ROWS.includes(id));
  return {
    pass: crash === null && skipped.length === 0 && failed.length === 0 && unexpected.length === 0,
    skipped,
    failed,
    unexpected,
    crash,
  };
}
