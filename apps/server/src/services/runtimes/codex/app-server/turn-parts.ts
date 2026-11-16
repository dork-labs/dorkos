/**
 * Small pieces of one app-server turn: the queue its generator drains, and the
 * named filesystem profile its `turn/start` selects.
 *
 * @module services/runtimes/codex/app-server/turn-parts
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { codexPermissionProfile } from '../policy/protected-profile.js';
import { EFFORT_TO_REASONING } from '../turn-input.js';
import type { CodexTurnRequest } from '../transport/codex-transport.js';
import type { AskForApproval, TurnStartParams } from './protocol/methods.js';

export { codexPermissionProfile };

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

/**
 * Build the sticky native settings for one turn.
 *
 * @param request - The active turn request.
 * @param threadId - Its loaded native thread.
 */
export function turnParams(request: CodexTurnRequest, threadId: string): TurnStartParams {
  const effort =
    request.settings.effort !== undefined
      ? EFFORT_TO_REASONING[request.settings.effort]
      : undefined;
  return {
    threadId,
    input: [{ type: 'text', text: request.prompt, text_elements: [] }],
    ...(request.messageId !== undefined ? { clientUserMessageId: request.messageId } : {}),
    // Sent every turn (they are sticky): a mode or model change between turns lands.
    cwd: request.cwd,
    approvalPolicy: approvalPolicyFor(request.settings),
    permissions: codexPermissionProfile(request.settings),
    ...(request.settings.model !== undefined ? { model: request.settings.model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    summary: 'auto',
  };
}
