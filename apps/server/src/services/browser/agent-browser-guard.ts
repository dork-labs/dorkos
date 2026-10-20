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
 *    first time it is used), and
 * 2. starts it blocked from the Cloud origin, with the two layers
 *    `withCloudOriginBlocked` describes.
 *
 * Fails closed: a browser whose session file still holds Cloud entries, or
 * whose block cannot be written, is left out of the session rather than
 * started unguarded. The origin list comes from `@dorkos/shared/cloud-origin`
 * and this server's own Cloud configuration, never from a manifest.
 *
 * @module services/browser/agent-browser-guard
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  agentBrowserConfigFileOf,
  agentBrowserStateFileOf,
  isPlaywrightBrowser,
  withCloudOriginBlocked,
} from '@dorkos/shared/agent-browser';
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
import {
  agentBrowserStateFile,
  ensureAgentBrowserStateFile,
} from '../mesh/agent-browser-preset.js';

/** The folder, under the DorkOS data directory, the guarded Playwright MCP configs live in. */
export const AGENT_BROWSER_CONFIG_SEGMENTS = ['browser', 'guard'] as const;

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
  /** No file, or a file with no Cloud entries: nothing to do. */
  | 'clean'
  /** Cloud entries were removed and the file rewritten. */
  | 'scrubbed'
  /** Not JSON: Playwright cannot load it either, so it signs the browser in to nothing. */
  | 'unreadable'
  /** It holds Cloud entries that could not be removed: the browser must not start from it. */
  | 'refused';

/**
 * Remove every Cloud cookie and every Cloud origin's page storage from a
 * saved session file.
 *
 * Read loosely, not through the storage-state schema: Playwright loads any
 * cookie it can, so a file that fails DorkOS's schema is still scrubbed of
 * every entry Playwright would have used. Only THIS DorkOS's own session file
 * is ever rewritten; a file elsewhere that holds Cloud entries is
 * `'refused'` rather than edited, because a manifest names that path and it is
 * not ours to change.
 *
 * @param file - The session file a browser loads.
 * @param options - `entries` is the Cloud list; `owned` is whether this file is ours to rewrite.
 */
export function scrubAgentBrowserState(
  file: string,
  options: { entries?: readonly CloudOriginEntry[]; owned?: boolean } = {}
): ScrubOutcome {
  const entries = options.entries ?? cloudOriginsForThisServer();
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
  const keptCookies = cookies.filter(
    (cookie: { domain?: unknown }) =>
      typeof cookie?.domain !== 'string' || !cookieReachesCloud(cookie.domain, entries)
  );
  const keptOrigins = origins.filter(
    (origin: { origin?: unknown }) =>
      typeof origin?.origin !== 'string' || !isCloudOriginUrl(origin.origin, entries)
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
 * The guarded Playwright MCP config: the operator's own `--config` settings,
 * when they named a readable one, with Chrome told that every Cloud host
 * resolves to nothing.
 *
 * @param operatorConfig - The config file the manifest named, if any.
 * @param entries - The Cloud list.
 */
function guardedConfig(
  operatorConfig: string | undefined,
  entries: readonly CloudOriginEntry[]
): string {
  let config: Record<string, unknown> = {};
  if (operatorConfig) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(operatorConfig, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        config = parsed as Record<string, unknown>;
    } catch {
      // An unreadable operator config would have failed the browser anyway; the
      // guarded one still starts it, blocked.
    }
  }
  const browser = { ...(config.browser as Record<string, unknown> | undefined) };
  const launchOptions = { ...(browser.launchOptions as Record<string, unknown> | undefined) };
  const args = Array.isArray(launchOptions.args) ? (launchOptions.args as unknown[]) : [];
  const isRules = (arg: unknown): arg is string =>
    typeof arg === 'string' && arg.startsWith(RESOLVER_FLAG);
  const theirRules = args.filter(isRules).map((arg) => arg.slice(RESOLVER_FLAG.length));
  const rules = [chromeHostResolverRules(entries), ...theirRules].filter(Boolean).join(', ');
  launchOptions.args = [...args.filter((arg) => !isRules(arg)), `${RESOLVER_FLAG}${rules}`];
  browser.launchOptions = launchOptions;
  return `${JSON.stringify({ ...config, browser }, null, 2)}\n`;
}

/**
 * Write a guarded config where a browser can load it, named by its content so
 * two agents with different operator configs never overwrite each other's.
 * Rewritten only when missing or different.
 *
 * @returns The file's path.
 */
function writeGuardedConfig(dorkHome: string, content: string): string {
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const file = path.join(dorkHome, ...AGENT_BROWSER_CONFIG_SEGMENTS, `config-${digest}.json`);
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
 * @param options - The data directory, the Cloud list and a logger, all defaulted.
 */
export function guardAgentBrowsers<T extends { transport: string; args?: readonly string[] }>(
  servers: Record<string, T>,
  options: {
    dorkHome?: string;
    entries?: readonly CloudOriginEntry[];
    logger?: Pick<Logger, 'warn'>;
  } = {}
): Record<string, T> {
  // Nothing to guard keeps the caller's object, so its cache identity holds.
  if (!Object.values(servers).some(isPlaywrightBrowser)) return servers;
  const dorkHome = options.dorkHome ?? resolveDorkHome();
  const entries = options.entries ?? cloudOriginsForThisServer();
  const ownStateFile = path.resolve(agentBrowserStateFile(dorkHome));
  const guarded: Record<string, T> = {};
  for (const [name, connection] of Object.entries(servers)) {
    if (!isPlaywrightBrowser(connection)) {
      guarded[name] = connection;
      continue;
    }
    ensureAgentBrowserStateFile(connection, dorkHome);
    const stateFile = agentBrowserStateFileOf(connection);
    if (stateFile) {
      const owned = path.resolve(stateFile) === ownStateFile;
      if (scrubAgentBrowserState(stateFile, { entries, owned }) === 'refused') {
        options.logger?.warn(
          `[agent-browser] left "${name}" out: its saved session holds DorkOS Cloud sign-ins DorkOS could not remove`
        );
        continue;
      }
    }
    let configFile: string;
    try {
      configFile = writeGuardedConfig(
        dorkHome,
        guardedConfig(agentBrowserConfigFileOf(connection), entries)
      );
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
