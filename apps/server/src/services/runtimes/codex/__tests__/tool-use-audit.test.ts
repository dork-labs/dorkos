/**
 * Codex tool calls reach the audit log (spec `audit-trail` PR3): a shell
 * command and a file change, mapped by the real Codex event mapper, each
 * become one `runtime.tool_used` row with the right target and outcome.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { createCodexEventContext, mapCodexEvent } from '../event-mapper.js';
import {
  codexItemCompleted,
  codexItemStarted,
  commandExecutionItem,
  fileChangeItem,
} from './codex-scenarios.js';
import { resetAuditTrail } from '../../../audit/audit-trail.js';
import { runTurn, setUpAuditTrail, toolRows } from '../../../audit/__tests__/tool-use-harness.js';

describe('Codex tool calls in the audit log', () => {
  afterEach(() => resetAuditTrail());

  it('records a shell command and a file change, once each', async () => {
    const db = setUpAuditTrail();
    const ctx = createCodexEventContext('session-1');
    const events: StreamEvent[] = [
      codexItemStarted(commandExecutionItem('c1', { command: 'npm test' })),
      codexItemCompleted(
        commandExecutionItem('c1', {
          command: 'npm test',
          output: 'ok\n',
          status: 'completed',
          exitCode: 0,
        })
      ),
      codexItemStarted(commandExecutionItem('c2', { command: 'false' })),
      codexItemCompleted(
        commandExecutionItem('c2', { command: 'false', status: 'failed', exitCode: 1 })
      ),
      codexItemCompleted(fileChangeItem('f1', [{ path: 'src/a.ts', kind: 'update' }])),
    ].flatMap((event) => mapCodexEvent(event, ctx));

    await runTurn(events, { runtime: 'codex' });

    expect(toolRows(db)).toMatchObject([
      { targetType: 'command', targetId: 'npm test', outcome: 'ok', source: { runtime: 'codex' } },
      { targetType: 'command', targetId: 'false', outcome: 'failed' },
      { targetType: 'file', targetId: 'src/a.ts', outcome: 'ok', source: { toolCallId: 'f1' } },
    ]);
  });
});
