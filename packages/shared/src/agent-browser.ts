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
 * (there is no switch to turn off `browser_run_code_unsafe` or
 * `browser_network_request` in 0.0.82, which is why the docs spell out that an
 * agent with the browser can read the saved sign-ins), and whether
 * `--storage-state` tolerates a file (0.0.82 fails every browser tool when the
 * file is missing, which is why DorkOS keeps an empty one in place).
 *
 * To bump it: change this string, then run the real-Chrome smoke test
 * (`DORKOS_BROWSER_SMOKE=1`, `packages/cli/src/lib/agent-browser/__tests__/agent-browser-smoke.test.ts`),
 * re-read `npx @playwright/mcp@<new> --help` for the flags the connection below
 * passes, and re-check the always-on tool list the docs describe
 * (`docs/guides/agent-browser.mdx`, "The trade-off, honestly").
 */
export const AGENT_BROWSER_MCP_VERSION = '0.0.82';

/** The Playwright MCP package spec agents run: {@link AGENT_BROWSER_MCP_VERSION}, pinned. */
export const AGENT_BROWSER_MCP_PACKAGE = `@playwright/mcp@${AGENT_BROWSER_MCP_VERSION}`;

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
 * dropping it from the entry shows the window.
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

/**
 * The saved session file a managed server loads, when the server is a
 * Playwright MCP browser started from one; `undefined` for anything else.
 *
 * Recognised by shape rather than by name, so a server the operator renamed
 * (or added by hand with a pinned Playwright version) is still recognised.
 *
 * @param connection - Any managed server connection.
 */
export function agentBrowserStateFileOf(connection: {
  transport: string;
  args?: readonly string[];
}): string | undefined {
  if (connection.transport !== 'stdio' || !connection.args) return undefined;
  const args = connection.args;
  if (!args.some((arg) => arg.startsWith('@playwright/mcp'))) return undefined;
  const flag = args.indexOf('--storage-state');
  if (flag !== -1) return args[flag + 1];
  const inline = args.find((arg) => arg.startsWith('--storage-state='));
  return inline?.slice('--storage-state='.length);
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
  return host.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
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
