/** Trust overrides for one protected Codex thread load. */
import type { SessionSettings } from '@dorkos/shared/types';
import { MODE_TO_SANDBOX } from '../turn-input.js';
import type { SandboxMode } from './protocol/methods.js';
import type { CodexHomeKind } from './thread-loader.js';
import { noteProjectConfigTrusted } from './project-config-activity.js';

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
