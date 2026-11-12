/**
 * Keeps every agent browser off the Cloud origin (DOR-3196), on its way to a
 * runtime.
 *
 * The agent browser starts from the operator's saved sign-ins, so a Cloud
 * sign-in in that file would let any agent's browser act as the operator on
 * their Cloud account. Before a Playwright MCP browser reaches a runtime,
 * {@link guardAgentBrowsers}:
 *
 * 1. removes every Cloud cookie and Cloud page storage from the session file
 *    it loads (on every load, so a file saved before this fix is cleaned the
 *    first time it is used), and every cookie and page storage for this
 *    DorkOS's own hosts (DOR-3957: a saved DorkOS session would let any
 *    agent's browser call this app as its owner once login is on), and
 * 2. starts it blocked from the Cloud origin, with the two layers
 *    `withCloudOriginBlocked` describes.
 *
 * Fails closed: a browser that brings sign-ins or routes DorkOS cannot clean
 * or block (`unguardableBrowserReason`), whose session file still holds Cloud
 * entries, or whose block cannot be written, is left out of the session
 * rather than started unguarded. The origin list comes from `@dorkos/shared/cloud-origin`
 * and this server's own Cloud configuration, never from a manifest.
 *
 * @module services/browser/agent-browser-guard
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  agentBrowserStateFileOf,
  isPlaywrightBrowser,
  unguardableBrowserReason,
  withCloudOriginBlocked,
} from '@dorkos/shared/agent-browser';
import { cookieDomainOf, cookieReachesApp, isAppHostOrigin } from '@dorkos/shared/app-origin';
import {
  chromeHostResolverRules,
  cookieReachesCloud,
  isCloudOriginUrl,
  playwrightBlockedOrigins,
  type CloudOriginEntry,
} from '@dorkos/shared/cloud-origin';
import type { Logger } from '@dorkos/shared/logger';
import { resolveDorkHome } from '../../lib/dork-home.js';
import { cloudOriginsForThisServer } from '../core/cloud/cloud-api-origin.js';
import { localBrowserAppHosts } from '../session/local-browser/app-origins.js';
import {
  agentBrowserStateFile,
  ensureAgentBrowserStateFile,
} from '../mesh/agent-browser-preset.js';

/** Path segments, under the DorkOS data directory, of the guarded Playwright MCP config. */
const AGENT_BROWSER_CONFIG_SEGMENTS = ['browser', 'agent-browser-guard.json'] as const;

const RESOLVER_FLAG = '--host-resolver-rules=';

/** Write `0600`, atomically: a reader sees the old file or the new one, never half. */
function writePrivateFileSync(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** What {@link scrubAgentBrowserState} found. */
export type ScrubOutcome =
  /** No file, or a file with no Cloud or DorkOS entries: nothing to do. */
  | 'clean'
  /** Cloud or DorkOS entries were removed and the file rewritten. */
  | 'scrubbed'
  /** Not JSON: Playwright cannot load it either, so it signs the browser in to nothing. */
  | 'unreadable'
  /** It holds Cloud or DorkOS entries that could not be removed: the browser must not start from it. */
  | 'refused';

/**
 * Remove every Cloud cookie and every Cloud origin's page storage from a
 * saved session file, and every cookie and page storage for this DorkOS's own
 * hosts, on any port.
 *
 * Read loosely, not through the storage-state schema: Playwright loads any
 * cookie it can, so a file that fails DorkOS's schema is still scrubbed of
 * every entry Playwright would have used. Only THIS DorkOS's own session file
 * is ever rewritten; a file elsewhere that holds Cloud or DorkOS entries is
 * `'refused'` rather than edited, because a manifest names that path and it is
 * not ours to change.
 *
 * @param file - The session file a browser loads.
 * @param options - `entries` is the Cloud list; `appHosts` is this DorkOS's own hosts;
 *   `owned` is whether this file is ours to rewrite.
 */
export function scrubAgentBrowserState(
  file: string,
  options: {
    entries?: readonly CloudOriginEntry[];
    appHosts?: readonly string[];
    owned?: boolean;
  } = {}
): ScrubOutcome {
  const entries = options.entries ?? cloudOriginsForThisServer();
  const appHosts = options.appHosts ?? localBrowserAppHosts();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 'clean';
  }
  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    return 'unreadable';
  }
  if (!state || typeof state !== 'object') return 'unreadable';
  const record = state as { cookies?: unknown; origins?: unknown };
  const cookies = Array.isArray(record.cookies) ? record.cookies : [];
  const origins = Array.isArray(record.origins) ? record.origins : [];
  // Judged by where the browser sends it: its domain, or the url it was set by.
  // One with neither, or not an object, can't be judged, so it isn't kept.
  const keptCookies = cookies.filter((cookie: unknown) => {
    if (!cookie || typeof cookie !== 'object') return false;
    const domain = cookieDomainOf(cookie);
    return (
      domain !== null && !cookieReachesCloud(domain, entries) && !cookieReachesApp(domain, appHosts)
    );
  });
  const keptOrigins = origins.filter(
    (origin: { origin?: unknown }) =>
      typeof origin?.origin !== 'string' ||
      (!isCloudOriginUrl(origin.origin, entries) && !isAppHostOrigin(origin.origin, appHosts))
  );
  if (keptCookies.length === cookies.length && keptOrigins.length === origins.length)
    return 'clean';
  if (!options.owned) return 'refused';
  try {
    const next = { ...record, cookies: keptCookies, origins: keptOrigins };
    writePrivateFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    return 'scrubbed';
  } catch {
    return 'refused';
  }
}

/**
 * Write the guarded Playwright MCP config: Chrome told that every Cloud host
 * resolves to nothing. Rewritten only when missing or different.
 *
 * @returns The file's path.
 */
function writeGuardedConfig(dorkHome: string, entries: readonly CloudOriginEntry[]): string {
  const file = path.join(dorkHome, ...AGENT_BROWSER_CONFIG_SEGMENTS);
  const config = {
    browser: {
      launchOptions: { args: [`${RESOLVER_FLAG}${chromeHostResolverRules(entries)}`] },
    },
  };
  const content = `${JSON.stringify(config, null, 2)}\n`;
  try {
    if (fs.readFileSync(file, 'utf8') === content) return file;
  } catch {
    // Not written yet.
  }
  writePrivateFileSync(file, content);
  return file;
}

/**
 * Every server in a session's set, with each Playwright MCP browser scrubbed
 * and blocked from the Cloud origin, and any browser that cannot be guarded
 * left out. Servers that are not a Playwright browser pass through untouched.
 *
 * @param servers - The servers about to reach a runtime, by name.
 * @param options - The data directory, the Cloud list, DorkOS's own hosts and a logger, all defaulted.
 */
export function guardAgentBrowsers<
  T extends {
    transport: string;
    command?: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
  },
>(
  servers: Record<string, T>,
  options: {
    dorkHome?: string;
    entries?: readonly CloudOriginEntry[];
    appHosts?: readonly string[];
    logger?: Pick<Logger, 'warn'>;
  } = {}
): Record<string, T> {
  // Nothing to guard keeps the caller's object, so its cache identity holds.
  if (!Object.values(servers).some(isPlaywrightBrowser)) return servers;
  const dorkHome = options.dorkHome ?? resolveDorkHome();
  const entries = options.entries ?? cloudOriginsForThisServer();
  const appHosts = options.appHosts ?? localBrowserAppHosts();
  const ownStateFile = path.resolve(agentBrowserStateFile(dorkHome));
  const guarded: Record<string, T> = {};
  for (const [name, connection] of Object.entries(servers)) {
    if (!isPlaywrightBrowser(connection)) {
      guarded[name] = connection;
      continue;
    }
    const reason = unguardableBrowserReason(connection);
    if (reason) {
      options.logger?.warn(
        `[agent-browser] left "${name}" out: ${reason}, so DorkOS cannot keep it off DorkOS Cloud`
      );
      continue;
    }
    ensureAgentBrowserStateFile(connection, dorkHome);
    const stateFile = agentBrowserStateFileOf(connection);
    if (stateFile) {
      const owned = path.resolve(stateFile) === ownStateFile;
      if (scrubAgentBrowserState(stateFile, { entries, appHosts, owned }) === 'refused') {
        options.logger?.warn(
          `[agent-browser] left "${name}" out: its saved session holds DorkOS or DorkOS Cloud sign-ins DorkOS could not remove`
        );
        continue;
      }
    }
    let configFile: string;
    try {
      configFile = writeGuardedConfig(dorkHome, entries);
    } catch {
      options.logger?.warn(
        `[agent-browser] left "${name}" out: DorkOS could not write its DorkOS Cloud block`
      );
      continue;
    }
    guarded[name] = withCloudOriginBlocked(connection, {
      blockedOrigins: playwrightBlockedOrigins(entries),
      configFile,
    });
  }
  return guarded;
}

/**
 * Clean this DorkOS's own saved session at startup, so a file saved by an
 * older version holds no Cloud sign-in from the moment the new one runs, not
 * only from the first agent browser that loads it. Never throws.
 *
 * @param dorkHome - The DorkOS data directory.
 */
export function scrubAgentBrowserStateAtStartup(
  dorkHome: string = resolveDorkHome()
): ScrubOutcome {
  try {
    return scrubAgentBrowserState(agentBrowserStateFile(dorkHome), { owned: true });
  } catch {
    return 'refused';
  }
}
