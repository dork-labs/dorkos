/**
 * Small pieces of one app-server turn: the queue its generator drains, and the
 * named filesystem profile its `turn/start` selects.
 *
 * @module services/runtimes/codex/app-server/turn-parts
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { codexPermissionProfile } from '../policy/protected-profile.js';
export { codexPermissionProfile };
import { EFFORT_TO_REASONING, promptToSend } from '../turn-input.js';
import type { CodexTurnRequest } from '../transport/codex-transport.js';
import type { TurnStartParams, AskForApproval } from './protocol/methods.js';

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

/** Project a resolved turn into sticky app-server settings on every start. */
export function codexTurnParams(
  request: CodexTurnRequest,
  threadId: string,
  modelNote?: string
): TurnStartParams {
  const effort =
    request.settings.effort !== undefined
      ? EFFORT_TO_REASONING[request.settings.effort]
      : undefined;
  return {
    threadId,
    // Preserve the fresh load’s model notice in the prompt (DOR-4447).
    input: [{ type: 'text', text: promptToSend(request, modelNote), text_elements: [] }],
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
