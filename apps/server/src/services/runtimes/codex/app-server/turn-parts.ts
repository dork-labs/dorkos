/**
 * Small pieces of one app-server turn: the queue its generator drains, and the
 * tagged sandbox policy its `turn/start` carries.
 *
 * @module services/runtimes/codex/app-server/turn-parts
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { MODE_TO_SANDBOX } from '../turn-input.js';
import type { CodexTurnRequest } from '../transport/codex-transport.js';
import type { AskForApproval, SandboxPolicy } from './protocol/methods.js';

/** A small single-consumer queue the generator drains. */
export class EventQueue {
  private items: StreamEvent[] = [];
  private waiting: (() => void) | undefined;
  private ended = false;

  push(events: readonly StreamEvent[]): void {
    if (this.ended || events.length === 0) return;
    this.items.push(...events);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  async *drain(): AsyncGenerator<StreamEvent> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }
}

/**
 * The tagged `SandboxPolicy` `turn/start` takes (protocol risk 6), from the
 * session's mode and the turn's validated write grants.
 *
 * @param request - The turn.
 */
export function sandboxPolicyFor(
  request: Pick<CodexTurnRequest, 'settings' | 'writableDirectories'>
): SandboxPolicy {
  switch (MODE_TO_SANDBOX[request.settings.permissionMode ?? 'default'] ?? 'read-only') {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [...request.writableDirectories],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    default:
      return { type: 'readOnly', networkAccess: false };
  }
}

/**
 * When Codex stops to ask, by mode (spec §10): `never` only for full access;
 * every other mode, and any mode id this table does not know, asks
 * `on-request`, so an unknown mode can never run without a person.
 *
 * @param settings - The session's mode.
 */
export function approvalPolicyFor(
  settings: Pick<CodexTurnRequest['settings'], 'permissionMode'>
): AskForApproval {
  return settings.permissionMode === 'bypassPermissions' ? 'never' : 'on-request';
}
