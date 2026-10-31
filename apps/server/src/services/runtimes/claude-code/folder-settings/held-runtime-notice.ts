/**
 * The chat line that says why an agent set to another runtime is running on
 * Claude Code (DOR-3459). A new session falls back to the default runtime when
 * the agent file's runtime is held for a person's OK (DOR-3068 M3) or is not
 * set up on this computer; without this line the switch was silent.
 *
 * @module services/runtimes/claude-code/folder-settings/held-runtime-notice
 */
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { runtimeUnlessHeld } from './folder-config-consent.js';

/**
 * The `system_status` to show when this Claude Code turn runs for an agent
 * whose agent file names another runtime it could not have, or `undefined`.
 *
 * @param manifest - The agent file as read, or `null`.
 * @param home - The agent's home, if any.
 */
export function heldRuntimeNotice(
  manifest: { id?: string; runtime?: string } | null,
  home: string | null | undefined
): StreamEvent | undefined {
  const named = manifest?.runtime;
  if (!named || named === 'claude-code') return undefined;
  const name = runtimeDisplayName(named);
  let message: string | undefined;
  if (!runtimeUnlessHeld(manifest, home)) {
    message = `${name} waits for your OK on this agent's file. This chat runs on Claude Code.`;
  } else if (!runtimeRegistry.has(named)) {
    message = `${name} isn't set up on this computer, so this chat runs on Claude Code.`;
  }
  return message ? { type: 'system_status', data: { message } } : undefined;
}
