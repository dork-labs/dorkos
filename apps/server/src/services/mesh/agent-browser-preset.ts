/**
 * The server's read of the agent browser (spec `agent-browser-sessions`): is
 * there a saved sign-in, which sites does it cover, and which managed MCP
 * server gives an agent a browser that starts from it.
 *
 * The operator creates the session with `dorkos browser login`; the CLI owns
 * every write. The server only ever reads, and only ever reports site names and
 * dates — never a cookie or storage value.
 *
 * @module services/mesh/agent-browser-preset
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_BROWSER_LOGIN_COMMAND,
  AGENT_BROWSER_SERVER_NAME,
  AGENT_BROWSER_STATE_SEGMENTS,
  EMPTY_STORAGE_STATE,
  StorageStateSchema,
  agentBrowserConnection,
  agentBrowserStateFileOf,
  summarizeStorageState,
  type AgentBrowserPreset,
  type StorageState,
} from '@dorkos/shared/agent-browser';
import { resolveDorkHome } from '../../lib/dork-home.js';

/** The saved session file under a DorkOS data directory. */
export function agentBrowserStateFile(dorkHome: string): string {
  return path.join(dorkHome, ...AGENT_BROWSER_STATE_SEGMENTS);
}

/** Read and parse the session file, or `null` when it is missing or unreadable. */
function readState(stateFile: string): { state: StorageState; savedAt: Date } | null {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const state = StorageStateSchema.parse(JSON.parse(raw));
    return { state, savedAt: fs.statSync(stateFile).mtime };
  } catch {
    // Missing, or not a session DorkOS can read: either way the operator's next
    // step is the same `dorkos browser login`, which writes a fresh file.
    return null;
  }
}

/**
 * Describe the agent browser for the `mcp.browser_preset` capability and the
 * Tools & MCP page's "Signed-in browser" button.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param now - Clock seam.
 */
export function readAgentBrowserPreset(
  dorkHome: string,
  now: Date = new Date()
): AgentBrowserPreset {
  const stateFile = agentBrowserStateFile(dorkHome);
  const read = readState(stateFile);
  const sites = read ? summarizeStorageState(read.state, now.getTime() / 1000) : [];
  return {
    stateFile,
    saved: sites.some((site) => !site.expired),
    savedAt: read?.savedAt.toISOString() ?? null,
    sites: sites.map((site) => ({
      ...site,
      expiresAt: site.expiresAt === null ? null : new Date(site.expiresAt * 1000).toISOString(),
    })),
    loginCommand: AGENT_BROWSER_LOGIN_COMMAND,
    server: { name: AGENT_BROWSER_SERVER_NAME, connection: agentBrowserConnection(stateFile) },
  };
}

/**
 * Make sure the saved session file an agent-browser server points at exists,
 * writing an empty one (`0600`, folder `0700`) when it does not.
 *
 * Playwright MCP 0.0.82 does not "start signed out" on a missing
 * `--storage-state` file: every browser tool fails with `ENOENT`. An empty
 * session is a valid file that signs the browser in to nothing, so keeping
 * one in place is what makes "it starts signed out" true for an agent given
 * the browser before the operator has saved anything (or after
 * `dorkos browser forget --all`).
 *
 * Only ever touches THIS DorkOS's own session file
 * (`<dorkHome>/browser/storage-state.json`): a manifest names the path, and a
 * path somewhere else is not ours to create. The create is exclusive (`wx`),
 * so it never replaces a session the CLI wrote a moment earlier. Never throws.
 *
 * @param connection - Any managed server connection; only an agent browser is acted on.
 * @param dorkHome - The DorkOS data directory (defaults to the server's).
 * @returns Whether an empty file was written.
 */
export function ensureAgentBrowserStateFile(
  connection: { transport: string; args?: readonly string[] },
  dorkHome: string = resolveDorkHome()
): boolean {
  const file = agentBrowserStateFileOf(connection);
  if (!file || path.resolve(file) !== path.resolve(agentBrowserStateFile(dorkHome))) return false;
  if (fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    fs.writeFileSync(file, `${JSON.stringify(EMPTY_STORAGE_STATE)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    // EEXIST (the CLI won the race) is the good outcome; anything else leaves
    // the file missing, which the agent's context notice still explains.
    return false;
  }
}

/** Why an agent's browser will not be signed in anywhere, for the context notice. */
export type AgentBrowserGap = 'missing' | 'empty';

/**
 * Whether an agent-browser server's session file will leave the browser
 * signed in to nothing: `'missing'` (missing or unreadable, so every browser
 * tool will fail),
 * `'empty'` (it works, signed out), or `null` when at least one site is saved.
 *
 * @param stateFile - The session file the server loads.
 * @param now - Clock seam.
 */
export function agentBrowserGap(stateFile: string, now: Date = new Date()): AgentBrowserGap | null {
  const read = readState(stateFile);
  if (!read) return 'missing';
  const live = summarizeStorageState(read.state, now.getTime() / 1000).some((s) => !s.expired);
  return live ? null : 'empty';
}

/**
 * The line an agent reads when its signed-in browser has nothing to start
 * from, or `''` when it does. Runtime-neutral on purpose: it names no tool,
 * only the situation and the operator's fix. The file path is deliberately
 * left out: it comes from a manifest, and the notice is prompt text.
 *
 * @param gap - What {@link agentBrowserGap} found, or `null`.
 */
export function agentBrowserNotice(gap: AgentBrowserGap | null): string {
  if (gap === null) return '';
  const situation =
    gap === 'missing'
      ? 'Your browser tools will fail until the operator saves browser sign-ins: the saved\nsession file is missing or unreadable.'
      : 'Your browser tools start signed out: the operator has not saved a sign-in for any\nsite yet.';
  return `<agent_browser>
${situation} If a site you need asks you to sign in, stop and ask the
operator to run \`${AGENT_BROWSER_LOGIN_COMMAND} <site>\` in a terminal, then start a new
session. Never type a password yourself, and never ask the operator for one.
</agent_browser>`;
}
