/** Trust overrides for one protected Codex thread load. */
import type { SessionSettings } from '@dorkos/shared/types';
import { MODE_TO_SANDBOX } from '../turn-input.js';
import type { SandboxMode } from './protocol/methods.js';
import type { CodexHomeKind } from './thread-loader.js';

/** Map the recorded mode to the sandbox used for the thread's trust decision. */
export function sandboxFor(settings: SessionSettings): SandboxMode {
  return (MODE_TO_SANDBOX[settings.permissionMode ?? 'default'] ?? 'read-only') as SandboxMode;
}

/**
 * The trust a thread loads with (spike 2c). The credits home never trusts a
 * folder; the person's home keeps the person's own recorded verdict, else
 * trusts the folder for a writable mode, without writing their config.toml.
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
  return sandbox === 'read-only' ? undefined : 'trusted';
}
