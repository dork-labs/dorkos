/** Trust overrides for one protected Codex thread load. */
import type { SessionSettings } from '@dorkos/shared/types';
import { MODE_TO_SANDBOX } from '../turn-input.js';
import type { SandboxMode } from './protocol/methods.js';
import { logger } from '../../../../lib/logger.js';
import type { CodexHomeKind, ThreadLoadInput } from './thread-loader.js';
import { noteProjectConfigTrusted, projectConfigFiles } from './project-config-activity.js';

/** Map the recorded mode to the sandbox used for the thread's trust decision. */
export function sandboxFor(settings: SessionSettings): SandboxMode {
  return (MODE_TO_SANDBOX[settings.permissionMode ?? 'default'] ?? 'read-only') as SandboxMode;
}

/**
 * The trust a thread loads with (spike 2c). The credits home never trusts a
 * folder; the person's home keeps the person's own recorded verdict, else
 * trusts the folder at Full only, without writing their config.toml.
 *
 * Trust is what makes Codex load the folder's own `.codex/config.toml`, and an
 * `[mcp_servers.*]` `command` there starts outside Codex's sandbox, with the
 * network, on the first turn (DOR-4408). A cloned repo is someone else's
 * words, so below Full it stays untrusted until the person trusts it in Codex
 * themselves. Ask first sends no override, as it always has.
 *
 * @param home - Which home.
 * @param sandbox - The thread's sandbox.
 * @param recorded - The person's own verdict for this path, if any.
 */
export function trustLevelFor(
  home: CodexHomeKind,
  sandbox: SandboxMode,
  recorded: string | undefined
): 'trusted' | 'untrusted' | undefined {
  if (home === 'credits') return 'untrusted';
  if (recorded === 'trusted' || recorded === 'untrusted') return recorded;
  if (sandbox === 'read-only') return undefined;
  return sandbox === 'danger-full-access' ? 'trusted' : 'untrusted';
}

/**
 * {@link trustLevelFor} for a load, and the Activity line when DorkOS itself
 * trusts the folder at Full: the folder's own Codex settings load, and the
 * person should be able to see that they did, as they can for Claude Code's.
 *
 * @param home - Which home.
 * @param sandbox - The thread's sandbox.
 * @param recorded - The person's own verdict for this path, if any.
 * @param realCwd - The folder, by real path.
 */
export function loadTrust(
  home: CodexHomeKind,
  sandbox: SandboxMode,
  recorded: string | undefined,
  realCwd: string
): 'trusted' | 'untrusted' | undefined {
  const trust = trustLevelFor(home, sandbox, recorded);
  if (trust === 'trusted' && recorded === undefined) noteProjectConfigTrusted(realCwd);
  return trust;
}

/** What the model is told when the project's own Codex settings did not load. */
const SKIPPED =
  "This project's own Codex settings (.codex/config.toml), and any MCP servers they name, did not load in this chat.";

/**
 * The line the model reads on the first turn of a load that left the folder
 * untrusted while the project has its own `.codex/config.toml` (DOR-4447), so
 * a missing project MCP server or setting is not a mystery. Only an explicit
 * `untrusted` says it: with no override (Ask first) the person's own Codex
 * config decides, and DorkOS does not guess. Existence only: never what the
 * file says.
 *
 * @param home - Which home.
 * @param recorded - The person's own verdict for this path, if any.
 * @param trust - The trust the load sent.
 * @param realCwd - The folder, by real path.
 * @returns The line, or `undefined` when there is nothing to say.
 */
export function skippedProjectConfigNote(
  home: CodexHomeKind,
  recorded: string | undefined,
  trust: 'trusted' | 'untrusted' | undefined,
  realCwd: string
): string | undefined {
  if (trust !== 'untrusted' || projectConfigFiles(realCwd).length === 0) return undefined;
  if (home === 'credits') return `${SKIPPED} Chats on DorkOS credits never load them.`;
  if (recorded === 'untrusted') {
    return `${SKIPPED} The person marked this folder untrusted in Codex; they load once it is trusted there.`;
  }
  return `${SKIPPED} They load at Full, or once the person trusts this folder in Codex.`;
}

/**
 * Everything trust decides for one load: the person's recorded verdict (read
 * from Codex, never from the file), the trust the load sends, and the line
 * the model reads when that leaves the project's own settings out.
 *
 * @param input - The load's inputs: its home, settings and process.
 * @param realCwd - The folder, by real path.
 */
export async function trustForLoad(
  input: Pick<ThreadLoadInput, 'home' | 'settings' | 'process' | 'cwd'>,
  realCwd: string
): Promise<{ trust: 'trusted' | 'untrusted' | undefined; modelNote: string | undefined }> {
  const recorded = input.home === 'person' ? await recordedTrust(input, realCwd) : undefined;
  const trust = loadTrust(input.home, sandboxFor(input.settings), recorded, realCwd);
  return { trust, modelNote: skippedProjectConfigNote(input.home, recorded, trust, realCwd) };
}

/** The person's own recorded verdict for a folder, as Codex reads it. */
async function recordedTrust(
  input: Pick<ThreadLoadInput, 'process' | 'cwd'>,
  realCwd: string
): Promise<string | undefined> {
  try {
    const result = await input.process.client.request('config/read', { cwd: input.cwd });
    return result.config.projects?.[realCwd]?.trust_level;
  } catch (err) {
    logger.debug('[CodexAppServer] config/read failed; applying the default trust rule', {
      err: String(err),
    });
    return undefined;
  }
}
