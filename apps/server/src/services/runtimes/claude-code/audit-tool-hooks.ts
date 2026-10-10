/**
 * Records the tools a Claude Code helper agent uses (spec `audit-trail` PR3).
 *
 * The audit record of runtime tool calls (`services/audit/record-tool-use.ts`)
 * reads the turn's stream. A helper agent (the `Task`/`Agent` tool) runs its
 * own tools, and the stream mappers drop every message that carries a
 * `parent_tool_use_id`, so those calls never reach that reader. Claude Code
 * still runs its `PostToolUse` and `PostToolUseFailure` hooks for them, with
 * the helper's `agent_id` on the input. These hooks record exactly those calls,
 * through the same settle-once path, credited to the agent whose session ran
 * the helper. A call on the main thread is the stream's to record; the hooks
 * leave it alone.
 *
 * Observe-only: every hook answers `{}`, so no tool is held, changed or
 * refused by this.
 *
 * @module services/runtimes/claude-code/audit-tool-hooks
 */
import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import { recordRuntimeToolCall, toolActorOf } from '../../audit/record-tool-use.js';
import { logger } from '../../../lib/logger.js';

/** What the hooks need to know about the turn that launched the process. */
export interface AuditToolHookOptions {
  /** The DorkOS session the helper runs inside. */
  sessionId: string;
  /** The launching turn's folder and agent, which name who the helper works for. */
  turn: Pick<MessageOpts, 'cwd' | 'forAgent' | 'roomTurn'>;
}

/** A tool's input as text, the shape the target reader takes. */
function inputText(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return '';
  }
}

/**
 * The hook that records one helper tool call when it finishes.
 *
 * @param options - The session and the launching turn.
 */
export function createAuditToolHook(options: AuditToolHookOptions): HookCallback {
  // Who the helper works for is fixed for the process, so it is looked up once.
  let actor: AuditActor | undefined;
  return async (hookInput) => {
    try {
      if (
        (hookInput.hook_event_name === 'PostToolUse' ||
          hookInput.hook_event_name === 'PostToolUseFailure') &&
        hookInput.agent_id
      ) {
        actor ??= toolActorOf('claude-code', options.turn);
        if (actor) {
          const failed = hookInput.hook_event_name === 'PostToolUseFailure';
          recordRuntimeToolCall(
            {
              runtime: 'claude-code',
              sessionId: options.sessionId,
              toolCallId: hookInput.tool_use_id,
              name: hookInput.tool_name,
              input: inputText(hookInput.tool_input),
              actor,
              helperId: hookInput.agent_id,
            },
            failed ? 'failed' : 'ok',
            failed ? hookInput.error : undefined
          );
        }
      }
    } catch (err) {
      // Recording is never worth a tool call.
      logger.warn('[audit] could not record a helper tool call', { err });
    }
    return {};
  };
}

/**
 * The `PostToolUse` and `PostToolUseFailure` registrations, matching every
 * tool: a helper may run any of them.
 *
 * @param options - The session and the launching turn.
 */
export function auditToolHookMatchers(options: AuditToolHookOptions): {
  PostToolUse: HookCallbackMatcher[];
  PostToolUseFailure: HookCallbackMatcher[];
} {
  const hook = createAuditToolHook(options);
  return { PostToolUse: [{ hooks: [hook] }], PostToolUseFailure: [{ hooks: [hook] }] };
}
