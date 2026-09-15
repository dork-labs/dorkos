/**
 * Top-level handler for `dorkos feedback`.
 *
 * Opens a prefilled GitHub issue so you can report a bug or request a feature
 * without hand-gathering your setup details. It reads your local config, keeps
 * only safe on/off values (never tokens, paths, or session content), and opens
 * `github.com/dork-labs/dorkos/issues/new` in your browser with the title,
 * body, and label filled in. You review and edit everything in GitHub before
 * submitting. Nothing is sent anywhere by DorkOS.
 *
 * With no browser (or with `--print`), it prints the URL instead. Wired from the
 * interception block in `cli.ts`; like every handler here it returns the exit
 * code rather than calling `process.exit`.
 *
 * @module commands/feedback
 */
import os from 'node:os';
import { execFile } from 'node:child_process';
import {
  buildIssueUrl,
  gatherFeedbackReport,
  type FeedbackKind,
  type FeedbackReport,
} from '@dorkos/shared/feedback';
import type { ConfigStore } from '../config-commands.js';
import { link } from '../terminal-link.js';

/** Help text for `dorkos feedback`. */
const HELP_TEXT = `
Usage: dorkos feedback [--bug | --feature | --runtime] [--print]

Report a bug or request a feature. Opens a prefilled GitHub issue in your
browser with your DorkOS version, OS, runtimes, and on/off settings already
filled in. You review and edit everything before submitting; nothing is sent
by DorkOS.

Options:
  --bug        Report a bug (default)
  --feature    Request a feature
  --runtime    Report a runtime issue (Claude Code, Codex, or OpenCode)
  --print      Print the URL instead of opening a browser
  -h, --help   Show this help
`;

/** Injectable side effects, so the command logic stays unit-testable. */
export interface FeedbackDeps {
  /** Print a line to the user. */
  log: (message: string) => void;
  /** Open a URL in the default browser; returns whether it was attempted. */
  openUrl: (url: string) => boolean;
}

/**
 * Gather a sanitized feedback report from the local environment and config.
 *
 * Everything but the two host facts comes from `gatherFeedbackReport` in
 * `@dorkos/shared/feedback`, which the server-side `feedback_draft` operator
 * capability calls too. That shared call is the whole reason an agent can hand a
 * person the link this command would have printed: one gatherer, one allowlist,
 * one URL builder, and `surface` the only field the two surfaces disagree on.
 *
 * @param kind - Which template the report maps to
 * @param version - The DorkOS version string
 * @param store - The config store, or `null` when it cannot be read
 * @returns A report ready for {@link buildIssueUrl}
 */
export function gatherCliReport(
  kind: FeedbackKind,
  version: string,
  store: ConfigStore | null
): FeedbackReport {
  return gatherFeedbackReport({
    kind,
    version,
    platform: `${os.platform()}-${os.arch()}`,
    surface: 'cli',
    readConfigValue: (key) => store?.getDot(key),
  });
}

/** Parse the argv slice after `feedback` into a kind and print flag. */
function parseArgs(args: string[]): { kind: FeedbackKind; print: boolean } {
  let kind: FeedbackKind = 'bug';
  if (args.includes('--feature')) kind = 'feature';
  else if (args.includes('--runtime')) kind = 'runtime';
  return { kind, print: args.includes('--print') };
}

/** Open a URL in the default browser. Guards the scheme and never shells out a string. */
function defaultOpenUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    if (process.platform === 'darwin') execFile('open', [url], () => {});
    else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else execFile('xdg-open', [url], () => {});
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_DEPS: FeedbackDeps = {
  log: (message) => console.log(message),
  openUrl: defaultOpenUrl,
};

/**
 * Run `dorkos feedback`.
 *
 * @param dorkHome - The resolved DorkOS data directory
 * @param version - The DorkOS version string (from `cli.ts`)
 * @param args - The argv slice after `feedback`
 * @param deps - Injectable side effects (defaults to real browser + console)
 * @returns The intended process exit code (always `0`)
 */
export async function runFeedback(
  dorkHome: string,
  version: string,
  args: string[],
  deps: FeedbackDeps = DEFAULT_DEPS
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    deps.log(HELP_TEXT);
    return 0;
  }

  const { kind, print } = parseArgs(args);
  const store = await loadConfig(dorkHome);
  const report = gatherCliReport(kind, version, store);
  const url = buildIssueUrl(report);

  if (print) {
    deps.log('\nOpen this link to report your issue on GitHub:\n');
    deps.log(url);
    deps.log('\nDorkOS filled in your version, OS, runtimes, and on/off settings.');
    deps.log('Review and edit everything in GitHub before you submit. Nothing was sent.\n');
    return 0;
  }

  const opened = deps.openUrl(url);
  if (opened) {
    deps.log('\nOpening a prefilled GitHub issue in your browser...');
    deps.log(`If it does not open, ${link('use this link', url)}:`);
  } else {
    deps.log('\nOpen this link to report your issue on GitHub:');
  }
  deps.log(`\n${url}\n`);
  deps.log('Review and edit everything before you submit. Nothing was sent by DorkOS.\n');
  return 0;
}

/** Load the config store, or `null` if it cannot be read (the report then degrades). */
async function loadConfig(dorkHome: string): Promise<ConfigStore | null> {
  try {
    const { initConfigManager } = await import('../../server/services/core/config-manager.js');
    return initConfigManager(dorkHome) as unknown as ConfigStore;
  } catch {
    return null;
  }
}
