/**
 * Agent browser sessions: the operator signs in to websites once, in a
 * dedicated Chrome profile, and every agent's Playwright browser starts from
 * the saved session (spec `agent-browser-sessions`).
 *
 * This module is the one place the CLI (`dorkos browser …`), the server (the
 * `mcp.browser_preset` capability and the agent-context notice) and the client
 * (the Toolkit's "Signed-in browser" button) agree on:
 *
 * - where the agent browser lives under the DorkOS data directory,
 * - the exact managed MCP server an agent is given,
 * - the shape of the saved session file (Playwright's storage state), and
 * - how that file is summarised for a person — by site, **never by value**.
 *
 * Deliberately free of `node:` imports: the client bundles it. Callers join the
 * path segments with their own platform's `path.join`.
 *
 * @module agent-browser
 */
import { z } from 'zod';

/** The name the agent browser's managed MCP server is added under. */
export const AGENT_BROWSER_SERVER_NAME = 'browser';

/**
 * The exact `@playwright/mcp` release agents run, pinned rather than `@latest`.
 *
 * It runs through `npx` on the agent's machine, so `@latest` would let any new
 * upstream release change, unreviewed, what every agent's browser can do. It
 * has already moved in ways this feature depends on: which tools are always on
 * (0.0.82 has no switch for `browser_run_code_unsafe` or `browser_network_request`,
 * so each runtime withholds both itself: {@link AGENT_BROWSER_WITHHELD_TOOLS}), and whether
 * `--storage-state` tolerates a file (0.0.82 fails every browser tool when the
 * file is missing, which is why DorkOS keeps an empty one in place).
 *
 * To bump it: change this string, then run the real-Chrome smoke test
 * (`DORKOS_BROWSER_SMOKE=1`, `packages/cli/src/lib/agent-browser/__tests__/agent-browser-smoke.test.ts`),
 * re-read `npx @playwright/mcp@<new> --help` for the flags the connection below
 * passes, and re-check the always-on tool list for any new tool that runs code
 * outside the page, which belongs in {@link AGENT_BROWSER_WITHHELD_TOOLS}, and
 * any new argument that names a file, which {@link AGENT_BROWSER_FILE_ARGUMENT} must match.
 */
export const AGENT_BROWSER_MCP_VERSION = '0.0.82';

/** The Playwright MCP package spec agents run: {@link AGENT_BROWSER_MCP_VERSION}, pinned. */
export const AGENT_BROWSER_MCP_PACKAGE = `@playwright/mcp@${AGENT_BROWSER_MCP_VERSION}`;

/**
 * Playwright MCP tools no agent is offered, on any server, in any letter case. The first two are
 * always on in 0.0.82, with no switch:
 *
 * - `browser_run_code_unsafe` runs any JavaScript in the browser server's own process, outside the
 *   page, so it reaches files and the network past every rule an agent's own tools follow.
 * - `browser_network_request` shows a recorded request's full headers, its `Cookie` and
 *   `Set-Cookie` among them, which hands an agent sign-in cookies the page itself could not read.
 *   `browser_network_requests`, the list without headers, stays.
 * - `browser_start_tracing` and `browser_stop_tracing` (the `devtools` tool set) write a live
 *   trace of every request, full headers and all, into the chat's own folder, where an agent
 *   reads the same cookies as a file.
 *
 * Each runtime withholds them: a deny rule and a hook on Claude Code, never registered on Doe, and
 * on Codex and OpenCode, which cannot hold back one argument ({@link AGENT_BROWSER_FILE_ARGUMENT}),
 * no agent browser at all. `browser_evaluate` stays: it runs inside the page.
 */
export const AGENT_BROWSER_WITHHELD_TOOLS: readonly string[] = [
  'browser_run_code_unsafe',
  'browser_network_request',
  'browser_start_tracing',
  'browser_stop_tracing',
];

/**
 * An argument name that could make a Playwright MCP tool read or write a file on this computer,
 * in any case: in 0.0.82, `filename` (a snapshot, screenshot, console log, network log or
 * `browser_evaluate` result saved to a file of the caller's choosing) and `paths`
 * (`browser_file_upload` and `browser_drop` sending local files to a page), and anything a later
 * or person-added version calls `path`, `dir` or `output`. 0.0.82 bounds them only by the folder
 * the MCP client reports as its root, which is the chat's own folder, so a call that carries one
 * could change an agent's protected setup files or, in a chat that runs in the home or data
 * folder, the saved sign-ins. A browser call with one is refused, at any depth; the same call
 * without it returns its result as text.
 */
export const AGENT_BROWSER_FILE_ARGUMENT = /file|path|dir|output/i;

/**
 * Whether a tool, by its bare name, is one of {@link AGENT_BROWSER_WITHHELD_TOOLS}, in any case.
 *
 * @param tool - The tool's own name, without any server prefix.
 */
export function isWithheldBrowserTool(tool: string): boolean {
  const name = tool.toLowerCase();
  return AGENT_BROWSER_WITHHELD_TOOLS.includes(name);
}

/** How deep {@link browserCallNamesFile} looks; anything deeper counts as naming a file. */
const FILE_ARGUMENT_DEPTH = 32;

/**
 * A `file:` address, or one shown as source (`view-source:file:` renders the file as text), in
 * any case. Tested after {@link urlParserView}, so it matches what the browser would load.
 */
const FILE_URL = /^(?:view-source:)?file:/i;

/**
 * A string as the URL parser reads it: tabs and line breaks dropped wherever they are, and
 * control characters and spaces dropped from the front, so `fi\tle:///x` and `\u0001file:///x`
 * load as `file:` and must be read that way here too.
 */
function urlParserView(value: string): string {
  // The control characters are the point: the URL parser drops them, so this must too.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, '');
}

/**
 * Whether `value` reaches a file on this computer at any depth: a key matching
 * {@link AGENT_BROWSER_FILE_ARGUMENT}, or a string that opens as a `file:` address.
 */
function reachesFile(value: unknown, depth: number): boolean {
  if (typeof value === 'string') return FILE_URL.test(urlParserView(value));
  if (!value || typeof value !== 'object') return false;
  if (depth > FILE_ARGUMENT_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => reachesFile(item, depth + 1));
  return Object.entries(value).some(
    ([key, child]) => AGENT_BROWSER_FILE_ARGUMENT.test(key) || reachesFile(child, depth + 1)
  );
}

/**
 * Whether a browser tool call reaches a file on this computer: a tool whose bare name starts
 * `browser_`, in any case, whose arguments, nested ones and objects in arrays included, hold a key
 * matching {@link AGENT_BROWSER_FILE_ARGUMENT} whatever its value (`""` and `null` too), or a
 * string that opens as a `file:` address (`browser_navigate` to one, or a new tab on one).
 *
 * @param tool - The tool's own name, without any server prefix.
 * @param input - The call's arguments.
 */
export function browserCallNamesFile(tool: string, input: unknown): boolean {
  if (!/^browser_/i.test(tool)) return false;
  return reachesFile(input, 0);
}

/** What an empty saved session looks like: valid for Playwright, signed in to nothing. */
export const EMPTY_STORAGE_STATE = { cookies: [], origins: [] } as const;

/** Path segments, under the DorkOS data directory, of the Chrome profile the operator signs in with. */
export const AGENT_BROWSER_PROFILE_SEGMENTS = ['browser', 'profile'] as const;

/** Path segments, under the DorkOS data directory, of the saved session file. */
export const AGENT_BROWSER_STATE_SEGMENTS = ['browser', 'storage-state.json'] as const;

/** The CLI command that creates or refreshes the saved session. */
export const AGENT_BROWSER_LOGIN_COMMAND = 'dorkos browser login';

/** The stdio connection the agent browser's managed MCP server runs. */
export interface AgentBrowserConnection {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The managed MCP server entry that gives an agent the signed-in browser.
 *
 * `--isolated` keeps each server's browser profile in memory, so two servers
 * never share (and never fight over) one profile, and nothing an agent does in
 * its browser is written back. `--storage-state` seeds each of those in-memory
 * browsers from the operator's saved session. `--headless` keeps a window from
 * appearing for every session and lets it run on a machine with no screen;
 * dropping it from the entry shows the window. The Cloud block is deliberately
 * not baked in here: {@link withCloudOriginBlocked} adds it to every agent
 * browser on its way to a runtime, so the list is always the current one, and
 * a manifest written before the block existed starts blocked too.
 *
 * @param stateFile - Absolute path to the saved session file.
 * @returns The stdio connection to add under {@link AGENT_BROWSER_SERVER_NAME}.
 */
export function agentBrowserConnection(stateFile: string): AgentBrowserConnection {
  return {
    transport: 'stdio',
    command: 'npx',
    args: [
      '-y',
      AGENT_BROWSER_MCP_PACKAGE,
      '--isolated',
      '--headless',
      '--storage-state',
      stateFile,
    ],
    env: {},
  };
}

const BLOCKED_ORIGINS_FLAG = '--blocked-origins';
const CONFIG_FLAG = '--config';
const STORAGE_STATE_FLAG = '--storage-state';

/** A managed server connection, as far as this module reads one. */
interface BrowserConnectionLike {
  transport: string;
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/** The command names Playwright MCP is published under. */
const PLAYWRIGHT_MCP_BIN = /(^|[/\\])(playwright-mcp|mcp-server-playwright)(\.cmd|\.js)?$/;

/**
 * Whether a managed server connection is a Playwright MCP browser, by shape,
 * so a renamed or hand-added one counts: the package anywhere in its command
 * or arguments (`npx @playwright/mcp`, `npx --package=@playwright/mcp …`, a
 * path into `node_modules/@playwright/mcp`), or one of its command names.
 *
 * @param connection - Any managed server connection.
 */
export function isPlaywrightBrowser(connection: BrowserConnectionLike): boolean {
  if (connection.transport !== 'stdio') return false;
  const words = [connection.command ?? '', ...(connection.args ?? [])];
  return words.some((word) => word.includes('@playwright/mcp') || PLAYWRIGHT_MCP_BIN.test(word));
}

/**
 * The value of a `--flag value` or `--flag=value` argument, every time it
 * appears, and the arguments without it.
 */
function takeFlag(args: readonly string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === flag) {
      if (args[i + 1] !== undefined) values.push(args[i + 1]!);
      i += 1;
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    } else {
      rest.push(arg);
    }
  }
  return { values, rest };
}

/** Flags that give the browser a sign-in, a profile or a route DorkOS cannot clean or block. */
const UNGUARDABLE_FLAGS = [
  '--extension',
  '--executable-path',
  '--no-isolated',
  '--cdp-endpoint',
  '--endpoint',
  '--user-data-dir',
  '--proxy-server',
  CONFIG_FLAG,
  // Each lets the browser write files of its own choosing (`@playwright/mcp` 0.0.82's options):
  // a saved session in its output folder, an output folder anywhere, or any file on disk
  // (DOR-4136). A browser that writes state could save a sign-in where a later one loads it.
  '--save-session',
  '--output-dir',
  '--allow-unrestricted-file-access',
  // Runs a file's code in the browser server's own process, outside the page, at every start.
  '--init-page',
];

/**
 * The opt-in tool sets that write browser state: `storage` adds `browser_storage_state`, which
 * saves the session's cookies to a file, and its cookie and page-storage setters (DOR-4136).
 */
const STATE_WRITING_CAPS = new Set(['storage']);

/** The browsers the Cloud block works in: it relies on a Chrome launch flag. */
const CHROMIUM_BROWSER = /^(chrome|chromium|msedge)(-[a-z]+)?$/;

/**
 * Why an agent browser cannot be kept off the Cloud origin, or `undefined`
 * when it can (DOR-3196). Such a browser is left out of an agent's session
 * rather than started unguarded. It cannot be guarded when it:
 *
 * - attaches to a browser DorkOS does not launch, or keeps a profile on disk
 *   (`--extension`, `--cdp-endpoint`, `--endpoint`, `--user-data-dir`,
 *   `--no-isolated`, or no `--isolated`), or runs a browser binary DorkOS
 *   did not choose (`--executable-path`): its sign-ins are not the saved
 *   session DorkOS cleans, or the Chrome flag may not apply;
 * - sends traffic through a proxy (`--proxy-server`), which the Chrome flag
 *   that stops redirects does not reach;
 * - runs a browser other than Chrome, Chromium or Edge, for the same reason;
 * - brings its own config file (`--config`, or `PLAYWRIGHT_MCP_CONFIG`, in any case), which can
 *   do any of the above; DorkOS's own guarded config is the only one a browser starts with;
 * - can write files of its own or save browser state (`--save-session`, `--output-dir`,
 *   `--allow-unrestricted-file-access`, `--caps` with `storage`), so a session could save a
 *   sign-in a later browser loads (DOR-4136); or runs a file's code outside the page at start
 *   (`--init-page`);
 * - names its saved session more than once (the last one wins in Playwright,
 *   so DorkOS could clean the wrong file);
 * - sets any `PLAYWRIGHT_MCP_*` variable, in any case, the environment form of every flag.
 *
 * Every flag is matched in any letter case, as `--flag value` or `--flag=value`.
 *
 * @param connection - A Playwright MCP browser connection.
 */
export function unguardableBrowserReason(connection: BrowserConnectionLike): string | undefined {
  const args = connection.args ?? [];
  // In any letter case, as `--flag value` or `--flag=value`: a spelling the browser would turn
  // down is refused all the same, so no spelling of a refused flag ever gets through.
  const lower = args.map((arg) => arg.toLowerCase());
  const named = (flag: string) => lower.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const flag = UNGUARDABLE_FLAGS.find(named);
  if (flag) return `it uses ${flag}`;
  if (!args.includes('--isolated')) return 'it keeps a browser profile on disk (no --isolated)';
  const browsers = takeFlag(args, '--browser').values;
  if (browsers.some((browser) => !CHROMIUM_BROWSER.test(browser)))
    return 'it runs a browser other than Chrome';
  if (takeFlag(args, STORAGE_STATE_FLAG).values.length > 1)
    return 'it names more than one saved session';
  const caps = takeFlag(args, '--caps').values.flatMap((value) => value.split(','));
  const writing = caps
    .map((cap) => cap.trim().toLowerCase())
    .find((cap) => STATE_WRITING_CAPS.has(cap));
  if (writing) return `it can save browser state (--caps=${writing})`;
  // In any case: Windows reads environment names case-blind, so `playwright_mcp_config` is
  // `PLAYWRIGHT_MCP_CONFIG` there.
  const variable = Object.keys(connection.env ?? {}).find((key) =>
    key.toUpperCase().startsWith('PLAYWRIGHT_MCP_')
  );
  if (variable) return `it sets ${variable}`;
  return undefined;
}

/**
 * A Playwright MCP browser connection that cannot reach the Cloud origin
 * (DOR-3196). Two layers, because neither covers every path on its own (both
 * measured against `@playwright/mcp` 0.0.82):
 *
 * - `--blocked-origins` aborts direct visits, iframes and popups with
 *   `net::ERR_BLOCKED_BY_CLIENT`, but a route only sees the first request of a
 *   redirect chain, so a link that answers 302 to Cloud gets through;
 * - `--config` names a file whose Chrome launch flag makes the Cloud hosts
 *   unresolvable (`net::ERR_NAME_NOT_RESOLVED`), which stops every hop of a
 *   redirect and every request the page makes. The server writes that file
 *   (`services/browser/agent-browser-guard.ts`).
 *
 * Neither reaches a request sent from Node rather than the page (Playwright
 * code run in the server, which {@link AGENT_BROWSER_WITHHELD_TOOLS} keeps from
 * agents, and `page.request`); that is why the saved session never holds a
 * Cloud sign-in in the first place. Only call this on a
 * connection {@link unguardableBrowserReason} accepts. An operator's own
 * `--blocked-origins` entries are kept beside the Cloud ones. A server that is
 * not a Playwright MCP browser is returned unchanged.
 *
 * @param connection - Any managed server connection.
 * @param guard - The Cloud list as `--blocked-origins` wants it, and the guarded config file.
 */
export function withCloudOriginBlocked<T extends BrowserConnectionLike>(
  connection: T,
  guard: { blockedOrigins: string; configFile: string }
): T {
  if (!isPlaywrightBrowser(connection)) return connection;
  const blocked = takeFlag(connection.args ?? [], BLOCKED_ORIGINS_FLAG);
  const { rest } = takeFlag(blocked.rest, CONFIG_FLAG);
  const merged = [
    ...new Set([guard.blockedOrigins, ...blocked.values].flatMap((value) => value.split(';'))),
  ]
    .filter(Boolean)
    .join(';');
  return {
    ...connection,
    args: [...rest, BLOCKED_ORIGINS_FLAG, merged, CONFIG_FLAG, guard.configFile],
  };
}

/**
 * The saved session file a managed server loads, when the server is a
 * Playwright MCP browser started from one; `undefined` for anything else.
 * When the flag appears more than once the last one is the one Playwright
 * loads, so that is the one returned.
 *
 * Recognised by shape rather than by name, so a server the operator renamed
 * (or added by hand with a pinned Playwright version) is still recognised.
 *
 * @param connection - Any managed server connection.
 */
export function agentBrowserStateFileOf(connection: BrowserConnectionLike): string | undefined {
  if (!isPlaywrightBrowser(connection)) return undefined;
  return takeFlag(connection.args ?? [], STORAGE_STATE_FLAG).values.at(-1);
}

/**
 * One cookie in a Playwright storage-state file. Unknown fields (a partition
 * key, for one) are kept, because the file is handed to Playwright as-is.
 */
export const StorageStateCookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    /** Unix seconds; `-1` for a cookie that lasts only as long as the browser. */
    expires: z.number(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(['Strict', 'Lax', 'None']),
  })
  .passthrough();

/** See {@link StorageStateCookieSchema}. */
export type StorageStateCookie = z.infer<typeof StorageStateCookieSchema>;

/** One origin's saved page storage (`localStorage`) in a storage-state file. */
export const StorageStateOriginSchema = z
  .object({
    origin: z.string(),
    localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
  })
  .passthrough();

/** See {@link StorageStateOriginSchema}. */
export type StorageStateOrigin = z.infer<typeof StorageStateOriginSchema>;

/** Playwright's storage-state file: what `--storage-state` loads. */
export const StorageStateSchema = z
  .object({
    cookies: z.array(StorageStateCookieSchema),
    origins: z.array(StorageStateOriginSchema).default([]),
  })
  .passthrough();

/** See {@link StorageStateSchema}. */
export type StorageState = z.infer<typeof StorageStateSchema>;

/** One site in a saved session, described without any value in it. */
export interface AgentBrowserSite {
  /** The site's host, e.g. `github.com`. */
  site: string;
  /** How many cookies the session holds for the site (expired ones included). */
  cookies: number;
  /**
   * When the longest-lived of the site's live cookies runs out, in Unix
   * seconds, or `null` when every live cookie lasts only as long as the
   * browser. A site can end a sign-in sooner than this.
   */
  expiresAt: number | null;
  /** Every cookie for the site has already run out, and it saved no page storage. */
  expired: boolean;
  /** The site saved page storage (`localStorage`) too. */
  pageStorage: boolean;
}

/** A cookie domain or URL host, lowercased and without the leading dot. */
function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/^\.+/, '');
  // Trim trailing dots by hand: `/\.+$/` backtracks quadratically on a long run
  // of dots that is not at the end, and cookie domains come from the session file.
  let end = h.length;
  while (end > 0 && h[end - 1] === '.') end--;
  return h.slice(0, end);
}

/**
 * Whether `host` belongs to `site`: the same host, or a subdomain of it.
 *
 * @param host - A cookie domain or URL host.
 * @param site - A site as {@link summarizeStorageState} names it.
 */
export function hostBelongsToSite(host: string, site: string): boolean {
  const h = normalizeHost(host);
  const s = normalizeHost(site);
  return h === s || h.endsWith(`.${s}`);
}

/** The host of an origin string (`https://app.example.com:8443` → `app.example.com`). */
function originHost(origin: string): string | undefined {
  try {
    return normalizeHost(new URL(origin).hostname);
  } catch {
    return undefined;
  }
}

/**
 * Turn what a person typed into a site name: a bare host, or a URL whose host
 * is taken (`https://github.com/login` → `github.com`).
 *
 * @param input - A host or URL.
 * @returns The normalised host, or `''` when nothing usable was given.
 */
export function normalizeSiteInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return originHost(trimmed) ?? '';
  return normalizeHost(trimmed.split('/')[0]!.split(':')[0]!);
}

/**
 * Group the hosts a session touches into sites. A host joins the shortest
 * already-seen host it is a subdomain of, so `.github.com` and
 * `gist.github.com` read as one site, `github.com`, without a public-suffix
 * list: no site ever sets a cookie on a bare suffix like `com`.
 */
function groupHosts(hosts: Iterable<string>): Map<string, string> {
  const unique = [...new Set([...hosts].map(normalizeHost).filter(Boolean))];
  unique.sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b));
  const siteOf = new Map<string, string>();
  const sites: string[] = [];
  for (const host of unique) {
    const parent = sites.find((site) => hostBelongsToSite(host, site));
    if (parent) siteOf.set(host, parent);
    else {
      sites.push(host);
      siteOf.set(host, host);
    }
  }
  return siteOf;
}

/**
 * Describe a saved session site by site, for a person to read. Never includes
 * a cookie or storage value — only names of sites, counts and dates.
 *
 * @param state - The parsed storage-state file.
 * @param nowSeconds - "Now" in Unix seconds (injected so tests are stable).
 * @returns The sites, alphabetically.
 */
export function summarizeStorageState(state: StorageState, nowSeconds: number): AgentBrowserSite[] {
  const originHosts = state.origins
    .map((o) => originHost(o.origin))
    .filter((h): h is string => Boolean(h));
  const siteOf = groupHosts([...state.cookies.map((c) => c.domain), ...originHosts]);
  const bySite = new Map<string, AgentBrowserSite & { live: number }>();
  const entryFor = (site: string) => {
    let entry = bySite.get(site);
    if (!entry) {
      entry = {
        site,
        cookies: 0,
        expiresAt: null,
        expired: false,
        pageStorage: false,
        live: 0,
      };
      bySite.set(site, entry);
    }
    return entry;
  };

  for (const cookie of state.cookies) {
    const site = siteOf.get(normalizeHost(cookie.domain));
    if (!site) continue;
    const entry = entryFor(site);
    entry.cookies += 1;
    if (cookie.expires === -1) {
      entry.live += 1;
    } else if (cookie.expires > nowSeconds) {
      entry.live += 1;
      entry.expiresAt = Math.max(entry.expiresAt ?? 0, cookie.expires);
    }
  }
  for (const origin of state.origins) {
    const host = originHost(origin.origin);
    const site = host ? siteOf.get(host) : undefined;
    if (site && origin.localStorage.length > 0) entryFor(site).pageStorage = true;
  }

  return [...bySite.values()]
    .map(({ live, ...site }) => ({
      ...site,
      expired: live === 0 && !site.pageStorage,
    }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

/**
 * A copy of the saved session with one site's cookies and page storage
 * removed: the site itself and every subdomain of it.
 *
 * @param state - The parsed storage-state file.
 * @param site - The site to drop, as {@link summarizeStorageState} names it.
 * @returns The trimmed state, and how many cookies and origins were removed.
 */
export function withoutSite(
  state: StorageState,
  site: string
): { state: StorageState; removedCookies: number; removedOrigins: number } {
  const cookies = state.cookies.filter((c) => !hostBelongsToSite(c.domain, site));
  const origins = state.origins.filter((o) => {
    const host = originHost(o.origin);
    return !host || !hostBelongsToSite(host, site);
  });
  return {
    state: { ...state, cookies, origins },
    removedCookies: state.cookies.length - cookies.length,
    removedOrigins: state.origins.length - origins.length,
  };
}

/** One site in {@link AgentBrowserPresetSchema}: {@link AgentBrowserSite} with ISO dates. */
export const AgentBrowserPresetSiteSchema = z.object({
  site: z.string(),
  cookies: z.number().int(),
  /** ISO time the longest-lived live cookie runs out, or `null` for no end date. */
  expiresAt: z.string().nullable(),
  expired: z.boolean(),
  pageStorage: z.boolean(),
});

/** See {@link AgentBrowserPresetSiteSchema}. */
export type AgentBrowserPresetSite = z.infer<typeof AgentBrowserPresetSiteSchema>;

/**
 * What the `mcp.browser_preset` capability answers: whether the operator has a
 * saved browser session, which sites it covers (names and dates only — never a
 * value), and the exact managed server to hand to `mcp.add`.
 *
 * The connection's `env` is an open object rather than a record for the reason
 * `McpServerTransportSchema` gives: a record anywhere in an in-session tool's
 * schema breaks the claude-code tool list.
 */
export const AgentBrowserPresetSchema = z.object({
  /** Absolute path of the saved session file on the DorkOS machine. */
  stateFile: z.string(),
  /**
   * Whether the saved session signs in to at least one site right now. False
   * for no file, an unreadable one, an empty one, or one whose cookies have all
   * run out.
   */
  saved: z.boolean(),
  /** ISO time the session was last saved, or `null`. */
  savedAt: z.string().nullable(),
  /** The sites in the session, alphabetically. */
  sites: z.array(AgentBrowserPresetSiteSchema),
  /** The command the operator runs to sign in (agents cannot run it for them). */
  loginCommand: z.string(),
  /** The managed MCP server that gives an agent the signed-in browser. */
  server: z.object({
    name: z.string(),
    connection: z.object({
      transport: z.literal('stdio'),
      command: z.string(),
      args: z.array(z.string()),
      env: z.object({}).catchall(z.string()),
    }),
  }),
});

/** See {@link AgentBrowserPresetSchema}. */
export type AgentBrowserPreset = z.infer<typeof AgentBrowserPresetSchema>;
