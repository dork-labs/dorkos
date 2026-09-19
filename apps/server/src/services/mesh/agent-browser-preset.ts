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
  StorageStateSchema,
  agentBrowserConnection,
  summarizeStorageState,
  type AgentBrowserPreset,
  type StorageState,
} from '@dorkos/shared/agent-browser';

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
    saved: read !== null,
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
 * The line an agent reads when its signed-in browser has nothing to start from
 * yet, or `''` when every agent-browser server it has is ready. Runtime-neutral
 * on purpose: it names no tool, only the situation and the operator's fix.
 *
 * @param missingStateFiles - Session files the agent's enabled browser servers
 *   point at that do not exist.
 */
export function agentBrowserMissingNotice(missingStateFiles: readonly string[]): string {
  if (missingStateFiles.length === 0) return '';
  return `<agent_browser>
Your browser tools will start signed out: the operator has not saved any browser
sign-ins yet (${missingStateFiles.join(', ')} does not exist). If a site you need
asks you to sign in, stop and ask the operator to run \`${AGENT_BROWSER_LOGIN_COMMAND} <site>\`
in a terminal, then start a new session. Never type a password yourself, and never
ask the operator for one.
</agent_browser>`;
}
