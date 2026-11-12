/**
 * Warns about browser servers an agent's Claude Code loads by itself, outside
 * DorkOS's guard (DOR-3957).
 *
 * DorkOS guards the browser servers it hands a runtime (`agent-browser-guard.ts`).
 * Claude Code also loads servers on its own: a folder's `.mcp.json`, and the
 * `mcpServers` in an account's `.claude.json`, for every project or for one
 * folder. A Playwright browser there gets none of DorkOS's protections, so the
 * server says so at startup and whenever the mesh scan finds a folder:
 *
 * - `--extension` attaches to a person's real Chrome, with every sign-in in it;
 * - a profile on disk (`--user-data-dir`, `--cdp-endpoint`, `--endpoint`,
 *   `--no-isolated`, or no `--isolated`) keeps whatever anyone signs in to,
 *   DorkOS included;
 * - no origin limit (no `--allowed-origins` or `--blocked-origins`, in flags
 *   or `PLAYWRIGHT_MCP_*` variables, and no `--config` that could set one)
 *   lets it open DorkOS and DorkOS Cloud.
 *
 * It only warns: it never edits a config or drops a server. A warning names the
 * file, the server and the problems, never a command line or a variable's value.
 *
 * @module services/browser/agent-browser-lint
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPlaywrightBrowser } from '@dorkos/shared/agent-browser';
import type { Logger } from '@dorkos/shared/logger';
import { claudeUserConfigFile } from '../runtimes/claude-code/accounts/account-login-metadata.js';
import { resolveClaudeRootSet } from '../runtimes/claude-code/claude-config-dir.js';

/** One browser server that runs without DorkOS's protections. */
export interface RiskyBrowserServer {
  /** The file it is configured in, and where in it. */
  source: string;
  /** Its name under `mcpServers`. */
  server: string;
  /** What is wrong with it, in plain words. */
  risks: string[];
}

/** Bigger than any real `.claude.json`; a file past it is skipped, not read. */
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

const PROFILE_FLAGS = ['--user-data-dir', '--cdp-endpoint', '--endpoint', '--no-isolated'];
const ORIGIN_FLAGS = ['--allowed-origins', '--blocked-origins', '--config'];
const ORIGIN_VARIABLES = ['PLAYWRIGHT_MCP_ALLOWED_ORIGINS', 'PLAYWRIGHT_MCP_BLOCKED_ORIGINS'];

/** A raw `mcpServers` entry as a connection, or null when it isn't a local command. */
function asConnection(entry: unknown) {
  if (!entry || typeof entry !== 'object') return null;
  const { type, command, args, env } = entry as Record<string, unknown>;
  if (typeof command !== 'string' || (type !== undefined && type !== 'stdio')) return null;
  return {
    transport: 'stdio',
    command,
    args: Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [],
    env: env && typeof env === 'object' ? (env as Record<string, string>) : {},
  };
}

/**
 * What is wrong with one `mcpServers` entry, or nothing when it is not a
 * Playwright browser or has none of the problems.
 *
 * @param entry - The raw entry, as a config file holds it.
 */
export function browserServerRisks(entry: unknown): string[] {
  const connection = asConnection(entry);
  if (!connection || !isPlaywrightBrowser(connection)) return [];
  const named = (flag: string) =>
    connection.args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const risks: string[] = [];
  if (named('--extension'))
    risks.push('it attaches to a real Chrome and its sign-ins (--extension)');
  const profile = PROFILE_FLAGS.find(named);
  if (profile) risks.push(`it uses a real browser profile (${profile})`);
  else if (!named('--extension') && !connection.args.includes('--isolated'))
    risks.push('it keeps a browser profile on disk (no --isolated)');
  const limited = ORIGIN_FLAGS.some(named) || ORIGIN_VARIABLES.some((key) => key in connection.env);
  if (!limited) risks.push('it can open any site, DorkOS included (no origin limit)');
  return risks;
}

/**
 * Every risky browser server in one `mcpServers` map.
 *
 * @param source - Where the map came from, for the warning.
 * @param servers - The map, as a config file holds it.
 */
function riskyBrowserServers(source: string, servers: unknown): RiskyBrowserServer[] {
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers as Record<string, unknown>).flatMap(([server, entry]) => {
    const risks = browserServerRisks(entry);
    return risks.length > 0 ? [{ source, server, risks }] : [];
  });
}

/** A JSON file's contents, or null when it is missing, a link, too big or not JSON. */
function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    // A link is refused rather than followed, as the account reader does.
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // Never log the content or the parser's error.
  }
}

/** Where to look: agent folders, and the `.claude.json` of each Claude account. */
export interface BrowserLintSources {
  /** Agent folders, each read for its own `.mcp.json`. */
  agentPaths: readonly string[];
  /** Account `.claude.json` files: their every-project servers, and each agent folder's. */
  claudeConfigFiles: readonly string[];
  /** Whether to read each account's every-project servers too (startup does; a scan doesn't repeat them). */
  includeUserServers?: boolean;
}

/**
 * Every risky browser server the given agents' Claude Code would load.
 *
 * @param sources - The folders and account files to read.
 */
export function findRiskyAgentBrowsers(sources: BrowserLintSources): RiskyBrowserServer[] {
  const found: RiskyBrowserServer[] = [];
  for (const folder of sources.agentPaths) {
    const file = path.join(folder, '.mcp.json');
    found.push(...riskyBrowserServers(file, readJsonFile(file)?.mcpServers));
  }
  for (const file of new Set(sources.claudeConfigFiles)) {
    const config = readJsonFile(file);
    if (!config) continue;
    if (sources.includeUserServers !== false)
      found.push(...riskyBrowserServers(`${file} (every project)`, config.mcpServers));
    const projects = config.projects;
    if (!projects || typeof projects !== 'object') continue;
    for (const folder of sources.agentPaths) {
      const project = (projects as Record<string, unknown>)[folder];
      if (project && typeof project === 'object')
        found.push(
          ...riskyBrowserServers(
            `${file} (project ${folder})`,
            (project as Record<string, unknown>).mcpServers
          )
        );
    }
  }
  return found;
}

/**
 * Log one warning per risky browser server. Never throws.
 *
 * @param sources - The folders and account files to read.
 * @param logger - Where the warnings go.
 * @returns What was found.
 */
export function warnRiskyAgentBrowsers(
  sources: BrowserLintSources,
  logger: Pick<Logger, 'warn'>
): RiskyBrowserServer[] {
  let found: RiskyBrowserServer[];
  try {
    found = findRiskyAgentBrowsers(sources);
  } catch {
    return [];
  }
  for (const { source, server, risks } of found)
    logger.warn(
      `[agent-browser] "${server}" in ${source} runs without DorkOS's browser protections: ${risks.join('; ')}`
    );
  return found;
}

/** The `.claude.json` of every Claude account this server launches with. */
export function claudeConfigFilesForThisServer(): string[] {
  return resolveClaudeRootSet().map(claudeUserConfigFile);
}

/**
 * A warner for one mesh scan: each folder the scan finds is checked for its own
 * `.mcp.json` and its project entry in each account's `.claude.json`. The
 * every-project servers are left to the startup check, so a scan of many
 * folders does not repeat them. Never throws.
 *
 * @param logger - Where the warnings go.
 * @param claudeConfigFiles - The account files, read once per scan.
 */
export function createScanBrowserWarner(
  logger: Pick<Logger, 'warn'>,
  claudeConfigFiles: () => readonly string[] = claudeConfigFilesForThisServer
): (folder: string) => void {
  let files: readonly string[] | undefined;
  return (folder) => {
    try {
      files ??= claudeConfigFiles();
      warnRiskyAgentBrowsers(
        { agentPaths: [folder], claudeConfigFiles: files, includeUserServers: false },
        logger
      );
    } catch {
      // A warning only: a scan never fails over it.
    }
  };
}
