/**
 * `dorkos browser login | status | forget` — the agent browser.
 *
 * The operator signs in to websites once, in a dedicated and unmistakably
 * orange Chrome profile where their password manager works as usual. The
 * signed-in session is saved as a Playwright storage-state file, and every
 * agent given the signed-in browser starts from it. Agents never see a
 * password; they only get cookies the site already issued.
 *
 * Every handler returns an exit code; `cli.ts` is the only place that exits.
 * Everything that touches the machine arrives through `BrowserDeps`
 * (`lib/agent-browser/browser-deps.ts`), so the flows are testable without a
 * Chrome.
 *
 * @module commands/browser-commands
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AGENT_BROWSER_PROFILE_SEGMENTS,
  AGENT_BROWSER_STATE_SEGMENTS,
  normalizeSiteInput,
  summarizeStorageState,
  withoutSite,
  type AgentBrowserSite,
  type StorageState,
} from '@dorkos/shared/agent-browser';
import { printJson, renderTable } from '../lib/operator-output.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';
import { ChromeNotFoundError } from '../lib/agent-browser/chrome-locator.js';
import { ChromeExitedError, type CdpPipe } from '../lib/agent-browser/cdp-pipe.js';
import { ensureAgentProfile } from '../lib/agent-browser/profile.js';
import type { BrowserDeps } from '../lib/agent-browser/browser-deps.js';
import {
  collectStorageState,
  readStorageState,
  writeStorageState,
} from '../lib/agent-browser/storage-state.js';
import { forgetInProfile, type ForgetTarget } from '../lib/agent-browser/profile-cleanup.js';

/** One-line usage for `browser login`. */
const LOGIN_USAGE = 'Usage: dorkos browser login [url] [--plain] [--chrome <path>]';
/** One-line usage for `browser status`. */
const STATUS_USAGE = 'Usage: dorkos browser status [--json]';
/** One-line usage for `browser forget`. */
const FORGET_USAGE = 'Usage: dorkos browser forget <site> | --all [--yes] [--chrome <path>]';

/** Where to find the agent browser's files. */
export interface AgentBrowserPaths {
  /** `<dorkHome>/browser/profile` — the Chrome profile. */
  profileDir: string;
  /** `<dorkHome>/browser/storage-state.json` — the saved session. */
  stateFile: string;
}

/**
 * The agent browser's paths under a DorkOS data directory. The same two paths
 * the first prototype used, so a session saved with it carries over.
 *
 * @param dorkHome - The DorkOS data directory.
 */
export function agentBrowserPaths(dorkHome: string): AgentBrowserPaths {
  return {
    profileDir: path.join(dorkHome, ...AGENT_BROWSER_PROFILE_SEGMENTS),
    stateFile: path.join(dorkHome, ...AGENT_BROWSER_STATE_SEGMENTS),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Chrome flags every agent-browser launch uses. */
function profileFlags(profileDir: string): string[] {
  return [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'];
}

/** Flags for a background pass on the profile: no window, no extensions running. */
function backgroundFlags(profileDir: string): string[] {
  return [...profileFlags(profileDir), '--headless', '--disable-extensions', 'about:blank'];
}

/** The page the agent browser opens on when no site is named. */
export const WELCOME_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  [
    '<!doctype html><title>DorkOS agent browser</title>',
    '<body style="font:16px/1.5 system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">',
    '<h1 style="color:#c2410c">This is the DorkOS agent browser</h1>',
    '<p>Sign in here to the sites you want your agents to use. Your password manager works as usual.</p>',
    '<p>When you are done, leave the tabs open, go back to your terminal and press <b>Enter</b>.</p>',
    '<p>Agents get the saved sign-ins, never your passwords.</p>',
    '</body>',
  ].join('')
)}`;

/**
 * The URL to open: a bare host gets `https://`, anything with a scheme is
 * used as given, and nothing opens the welcome page.
 *
 * @param input - What the operator typed after `login`.
 */
export function loginStartUrl(input: string | undefined): string {
  if (!input) return WELCOME_PAGE;
  return /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
}

/** `YYYY-MM-DD` for a Unix-seconds time. */
function isoDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** How long a site's session lasts, in words. */
export function describeExpiry(site: AgentBrowserSite): string {
  if (site.expired) return 'expired, sign in again';
  if (site.expiresAt === null) return 'no end date set';
  return `until ${isoDay(site.expiresAt)}`;
}

/** Print the list of sites a session covers (names only). */
function printSiteNames(deps: BrowserDeps, sites: AgentBrowserSite[]): void {
  for (const site of sites) deps.log(`  ${site.site}`);
}

/** The line that tells the operator how an agent gets the browser. */
const NEXT_STEP =
  "To give an agent the browser: open the agent's profile, then Tools & MCP, then Signed-in browser.";

/** Map a failure of the Chrome lookup or launch to a message, or rethrow. */
function chromeProblem(err: unknown): string {
  if (err instanceof ChromeNotFoundError) return err.message;
  if (err instanceof ChromeExitedError) {
    return (
      'Chrome closed straight away. If the agent browser is already open, ' +
      'quit it and run this again.'
    );
  }
  throw err;
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

/** Parsed arguments for `browser login`. */
export interface BrowserLoginArgs {
  /** The site or URL to open first. */
  url?: string;
  /** Sign in with no debugging channel; save after Chrome quits. */
  plain: boolean;
  /** A Chrome to use instead of the standard install. */
  chrome?: string;
}

/**
 * Parse the argv after `dorkos browser login`.
 *
 * @param rawArgs - The argv slice.
 */
export function parseBrowserLoginArgs(rawArgs: string[]): BrowserLoginArgs {
  try {
    const { values, positionals } = parseArgs({
      args: rawArgs,
      options: { plain: { type: 'boolean', default: false }, chrome: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 1) throw new Error(`Too many arguments.\n${LOGIN_USAGE}`);
    return {
      ...(positionals[0] ? { url: positionals[0] } : {}),
      plain: values.plain ?? false,
      ...(values.chrome ? { chrome: values.chrome } : {}),
    };
  } catch (err) {
    rethrowUnknownOption(err, 'browser login', LOGIN_USAGE);
  }
}

/** Write the collected session and tell the operator what it covers. */
async function saveAndReport(
  deps: BrowserDeps,
  stateFile: string,
  state: StorageState,
  note?: string
): Promise<number> {
  await writeStorageState(stateFile, state);
  const sites = summarizeStorageState(state, deps.now().getTime() / 1000).filter((s) => !s.expired);
  deps.log('');
  if (sites.length === 0) {
    deps.log('Saved, but no site has a session yet. Sign in to a site in the agent browser,');
    deps.log('then run this again.');
    return 0;
  }
  deps.log(`Saved sign-ins for ${sites.length} ${sites.length === 1 ? 'site' : 'sites'}:`);
  printSiteNames(deps, sites);
  deps.log('');
  if (note) deps.log(note);
  deps.log('Agents with the signed-in browser start with these the next time they open one.');
  deps.log(`Saved to ${stateFile} (only you can read it).`);
  deps.log(NEXT_STEP);
  return 0;
}

/**
 * Open the agent browser, let the operator sign in, and save the session.
 *
 * Saves when the operator presses Enter, while Chrome is still open: that is
 * the only moment everything is readable. Cookies on disk are encrypted with a
 * key Chrome keeps in the system keychain, a page's own storage can only be read
 * from an open tab, and cookies meant to last only as long as the browser are
 * dropped the moment it quits. So a Chrome that quits before Enter means
 * nothing is saved, and the earlier file is left as it was.
 *
 * `--plain` trades that for a Chrome with no debugging channel at all (see
 * {@link runPlainLogin}).
 *
 * @param args - Parsed arguments.
 * @param deps - The machine.
 */
export async function runBrowserLogin(args: BrowserLoginArgs, deps: BrowserDeps): Promise<number> {
  const { profileDir, stateFile } = agentBrowserPaths(deps.dorkHome);
  if (!deps.interactive) {
    deps.error(
      'dorkos browser login needs you at the keyboard to sign in. Run it in a terminal window.'
    );
    return 1;
  }
  let chrome: string;
  try {
    chrome = deps.findChrome(args.chrome);
  } catch (err) {
    deps.error(chromeProblem(err));
    return 1;
  }
  const lock = deps.profileLock(profileDir);
  if (lock.inUse) {
    deps.error(
      `The agent browser is already open${lock.pid ? ` (process ${lock.pid})` : ''}. ` +
        'Quit it, then run this again.'
    );
    return 1;
  }
  const profile = ensureAgentProfile(profileDir, deps.now());
  if (profile.themed) {
    deps.log('Set up the agent browser with an orange frame, so you can always tell it apart.');
  }

  const url = loginStartUrl(args.url);
  if (args.plain) return runPlainLogin(chrome, profileDir, stateFile, url, deps);

  const cdp = deps.launchPipe(chrome, [...profileFlags(profileDir), url]);
  try {
    await cdp.send('Browser.getVersion', {}, undefined, 20_000);
  } catch (err) {
    await cdp.close(2_000);
    deps.error(chromeProblem(err));
    return 1;
  }

  deps.log('The agent browser is open (it has an orange frame).');
  deps.log('');
  deps.log('  1. Sign in to the sites your agents need. Your password manager works as usual.');
  deps.log('  2. Leave those tabs open, come back here, and press Enter to save.');
  deps.log('');
  deps.log('Press Ctrl+C to stop without saving.');

  const action = await deps.waitForOperator(cdp.exited);
  if (action === 'closed') {
    deps.error('');
    deps.error('The agent browser closed before you pressed Enter, so nothing was saved.');
    deps.error(
      'Your earlier sign-ins are unchanged. Run this again and press Enter while it is open.'
    );
    return 1;
  }
  if (action === 'cancelled') {
    await cdp.close();
    deps.log('Stopped. Nothing was saved.');
    return 130;
  }

  let state: StorageState;
  try {
    state = await collectStorageState(cdp);
  } catch (err) {
    await cdp.close();
    if (err instanceof ChromeExitedError) {
      deps.error('The agent browser closed while saving, so nothing was saved. Run this again.');
      return 1;
    }
    throw err;
  }
  await cdp.close();
  return saveAndReport(deps, stateFile, state);
}

/**
 * The `--plain` sign-in: Chrome runs with no debugging channel, exactly as if
 * the operator had opened it themselves, so a site that turns away automated
 * browsers sees an ordinary one. The session is read after Chrome quits, from
 * a background Chrome on the same profile.
 *
 * The cost: cookies meant to last only as long as the browser are gone by
 * then. Sign-ins made with "keep me signed in" (or its equivalent) survive,
 * which is most of them.
 */
async function runPlainLogin(
  chrome: string,
  profileDir: string,
  stateFile: string,
  url: string,
  deps: BrowserDeps
): Promise<number> {
  const plain = deps.spawnPlain(chrome, [...profileFlags(profileDir), url]);
  deps.log('The agent browser is open (it has an orange frame).');
  deps.log('');
  deps.log('  1. Sign in to the sites your agents need. Tick "keep me signed in" where offered.');
  deps.log('  2. Come back here and press Enter (or quit the agent browser) to save.');
  deps.log('');
  deps.log('Press Ctrl+C to stop without saving.');

  const action = await deps.waitForOperator(plain.exited);
  if (action !== 'closed') {
    plain.quit();
    const forced = setTimeout(() => plain.kill(), 15_000);
    await plain.exited;
    clearTimeout(forced);
  }
  if (action === 'cancelled') {
    deps.log('Stopped. Nothing was saved.');
    return 130;
  }

  const cdp = deps.launchPipe(chrome, backgroundFlags(profileDir));
  let state: StorageState;
  try {
    state = await collectStorageState(cdp, { pageStorage: false });
  } catch (err) {
    await cdp.close(2_000);
    deps.error(chromeProblem(err));
    return 1;
  }
  await cdp.close();
  return saveAndReport(
    deps,
    stateFile,
    state,
    'Saved with --plain: sign-ins that end when the browser closes were not kept.'
  );
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Parse the argv after `dorkos browser status`.
 *
 * @param rawArgs - The argv slice.
 */
export function parseBrowserStatusArgs(rawArgs: string[]): { json: boolean } {
  try {
    const { values } = parseArgs({
      args: rawArgs,
      options: { json: { type: 'boolean', default: false } },
      allowPositionals: false,
      strict: true,
    });
    return { json: values.json ?? false };
  } catch (err) {
    rethrowUnknownOption(err, 'browser status', STATUS_USAGE);
  }
}

/**
 * Show which sites have a saved session and how long each lasts. Names and
 * dates only: no cookie or storage value is ever printed, in either format.
 *
 * @param args - `json` for machine output.
 * @param deps - The machine.
 */
export async function runBrowserStatus(
  args: { json: boolean },
  deps: BrowserDeps
): Promise<number> {
  const { stateFile } = agentBrowserPaths(deps.dorkHome);
  const state = readStorageState(stateFile);
  const savedAt = state ? fs.statSync(stateFile).mtime : null;
  const sites = state ? summarizeStorageState(state, deps.now().getTime() / 1000) : [];

  if (args.json) {
    printJson({
      stateFile,
      saved: state !== null,
      savedAt: savedAt?.toISOString() ?? null,
      sites: sites.map((s) => ({
        ...s,
        expiresAt: s.expiresAt === null ? null : new Date(s.expiresAt * 1000).toISOString(),
      })),
    });
    return 0;
  }

  if (!state) {
    deps.log('No saved sign-ins yet.');
    deps.log('Run `dorkos browser login <site>` to sign in to a site for your agents.');
    deps.log(`They will be saved to ${stateFile}`);
    return 0;
  }
  if (sites.length === 0) {
    deps.log('The saved session has no sites in it. Run `dorkos browser login <site>` to add one.');
    return 0;
  }
  deps.log(
    `Saved sign-ins (last saved ${savedAt!.toISOString().slice(0, 16).replace('T', ' ')} UTC)`
  );
  deps.log('');
  deps.log(
    renderTable(
      ['Site', 'Lasts', 'Page storage'],
      sites.map((s) => [s.site, describeExpiry(s), s.pageStorage ? 'yes' : ''])
    )
  );
  deps.log('');
  deps.log('A site can end a sign-in sooner than its cookies say.');
  deps.log(`File: ${stateFile}`);
  return 0;
}

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

/** Parsed arguments for `browser forget`. */
export interface BrowserForgetArgs {
  /** The site to forget, normalised; absent with `all`. */
  site?: string;
  /** Forget every site. */
  all: boolean;
  /** Skip the confirmation for `--all`. */
  yes: boolean;
  /** A Chrome to use instead of the standard install. */
  chrome?: string;
}

/**
 * Parse the argv after `dorkos browser forget`.
 *
 * @param rawArgs - The argv slice.
 */
export function parseBrowserForgetArgs(rawArgs: string[]): BrowserForgetArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        all: { type: 'boolean', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        chrome: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'browser forget', FORGET_USAGE);
  }
  const all = parsed.values.all === true;
  const [raw, ...extra] = parsed.positionals;
  if (all && raw) throw new Error(`Name a site or use --all, not both.\n${FORGET_USAGE}`);
  if (!all && !raw) throw new Error(`Name the site to forget.\n${FORGET_USAGE}`);
  if (extra.length > 0) throw new Error(`Forget one site at a time.\n${FORGET_USAGE}`);
  const site = raw ? normalizeSiteInput(raw) : undefined;
  if (raw && !site) throw new Error(`"${raw}" is not a site name.\n${FORGET_USAGE}`);
  const chrome = parsed.values.chrome;
  return {
    ...(site ? { site } : {}),
    all,
    yes: parsed.values.yes === true,
    ...(typeof chrome === 'string' ? { chrome } : {}),
  };
}

/**
 * Remove the forgotten site from the agent browser's profile too, so the next
 * save does not bring it back. Returns a warning to show when that could not
 * happen, or `null`.
 */
async function cleanProfile(
  deps: BrowserDeps,
  profileDir: string,
  target: ForgetTarget,
  knownOrigins: string[],
  chromeFlag: string | undefined
): Promise<string | null> {
  if (!fs.existsSync(profileDir)) return null;
  const what = target === 'all' ? 'those sites are' : `${target.site} is`;
  const nextSave = 'the next `dorkos browser login` will save it again';
  if (deps.profileLock(profileDir).inUse) {
    return (
      `The agent browser is open, so ${what} still signed in there, and ${nextSave}. ` +
      'Sign out in the agent browser, or quit it and run this again.'
    );
  }
  let cdp: CdpPipe | undefined;
  try {
    const chrome = deps.findChrome(chromeFlag);
    cdp = deps.launchPipe(chrome, backgroundFlags(profileDir));
    await forgetInProfile(cdp, target, knownOrigins);
    return null;
  } catch (err) {
    const reason =
      err instanceof ChromeNotFoundError ? 'Chrome was not found' : 'Chrome did not respond';
    return `${reason}, so ${what} still signed in inside the agent browser, and ${nextSave}.`;
  } finally {
    await cdp?.close();
  }
}

/**
 * Take one site (or every site) away from agents: out of the saved session
 * first, then out of the agent browser's profile.
 *
 * @param args - Parsed arguments.
 * @param deps - The machine.
 */
export async function runBrowserForget(
  args: BrowserForgetArgs,
  deps: BrowserDeps
): Promise<number> {
  const { profileDir, stateFile } = agentBrowserPaths(deps.dorkHome);
  const state = readStorageState(stateFile);
  const knownOrigins = (state?.origins ?? []).map((o) => o.origin);

  if (args.all) {
    if (!args.yes) {
      if (!deps.interactive) {
        deps.error('Forgetting every site needs a yes. Add --yes to confirm.');
        return 1;
      }
      const ok = await deps.confirm(
        'Forget every saved sign-in, and sign the agent browser out of every site?'
      );
      if (!ok) {
        deps.log('Nothing changed.');
        return 1;
      }
    }
    fs.rmSync(stateFile, { force: true });
    const warning = await cleanProfile(deps, profileDir, 'all', knownOrigins, args.chrome);
    deps.log('Forgot every saved sign-in. Agents start signed out of everything.');
    deps.log('Browsers agents already have open keep their sign-ins until they close.');
    if (warning) deps.error(warning);
    return 0;
  }

  const site = args.site!;
  let removed = 0;
  if (state) {
    const trimmed = withoutSite(state, site);
    removed = trimmed.removedCookies + trimmed.removedOrigins;
    if (removed > 0) await writeStorageState(stateFile, trimmed.state);
  }
  const warning = await cleanProfile(deps, profileDir, { site }, knownOrigins, args.chrome);
  if (removed > 0) {
    deps.log(`Forgot ${site}. Agents that open a new browser start signed out of it.`);
    deps.log('Browsers agents already have open keep it until they close.');
  } else {
    deps.log(`There was no saved sign-in for ${site}.`);
  }
  if (warning) deps.error(warning);
  return 0;
}
