/**
 * How the app-server transport closes a turn or a compaction that could not
 * start: the events the chat reads instead of a reply, each ending the turn.
 *
 * @module services/runtimes/codex/transport/app-server-turn-failures
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import { creditsRefusalEvent } from '../../../core/cloud/credits-protocols.js';
import { CodexCrashLoopError } from '../app-server/process-pool.js';
import type { AppServerTurnMapper } from '../app-server/notification-mapper.js';
import { CodexProcessExitedError } from '../app-server/protocol/errors.js';

/**
 * The events a turn that could not be opened ends with: a credits refusal,
 * the crash-loop notice, or a plain could-not-start error, then `done`.
 *
 * @param sessionId - The session.
 * @param err - Why the turn could not open.
 */
export function* failedSetup(sessionId: string, err: unknown): Generator<StreamEvent> {
  const refusal = creditsRefusalEvent(err);
  if (refusal) {
    yield refusal;
  } else if (err instanceof CodexCrashLoopError) {
    yield { type: 'error', data: { message: err.message, code: 'codex_crash_loop' } };
  } else {
    logger.warn('[CodexAppServer] could not open the turn', { sessionId, err: String(err) });
    yield {
      type: 'error',
      data: {
        message: 'Codex could not start this reply. Send your message again to retry.',
        code: 'codex_unavailable',
        details: err instanceof Error ? err.message : String(err),
      },
    };
  }
  yield { type: 'done', data: { sessionId } };
}

/**
 * The events that close a compaction Codex refused to start.
 *
 * @param mapper - The compaction's turn mapper.
 * @param err - Why `thread/compact/start` failed.
 */
export function failedCompaction(mapper: AppServerTurnMapper, err: unknown): StreamEvent[] {
  if (err instanceof CodexProcessExitedError) return mapper.closeOnCrash(err.detail);
  logger.warn('[CodexAppServer] thread/compact/start failed', { err: String(err) });
  const message = 'Codex could not summarize this chat. Try again.';
  return [
    {
      type: 'operation_progress',
      data: {
        operation: 'compaction',
        state: 'failed',
        determinate: false,
        error: err instanceof Error ? err.message : String(err),
      },
    },
    ...mapper.closeQuietly({ message, code: 'compaction_failed' }),
  ];
}

/**
 * The events that close a turn Codex refused to start.
 *
 * @param mapper - The turn's mapper.
 * @param err - Why `turn/start` failed.
 */
export function failedStart(mapper: AppServerTurnMapper, err: unknown): StreamEvent[] {
  if (err instanceof CodexProcessExitedError) return mapper.closeOnCrash(err.detail);
  logger.warn('[CodexAppServer] turn/start failed', { err: String(err) });
  return mapper.closeQuietly({
    message: 'Codex could not start this reply. Send your message again to retry.',
    code: 'codex_unavailable',
  });
}
