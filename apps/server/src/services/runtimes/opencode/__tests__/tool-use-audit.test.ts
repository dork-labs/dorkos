/**
 * OpenCode tool calls reach the audit log (spec `audit-trail` PR3): tool parts
 * mapped by the real OpenCode part mapper — a shell command, a failed edit,
 * and one of DorkOS's own tools — become one `runtime.tool_used` row each for
 * the first two, and none for the DorkOS tool, which the server records itself.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { mapPartSnapshot } from '../events/part-event-mapper.js';
import { createOpenCodeEventContext } from '../events/event-mapper.js';
import {
  OC_SESSION_A,
  toolPart,
  toolStateCompleted,
  toolStateError,
  toolStateRunning,
} from './opencode-sse-fixtures.js';
import { resetAuditTrail } from '../../../audit/audit-trail.js';
import { runTurn, setUpAuditTrail, toolRows } from '../../../audit/__tests__/tool-use-harness.js';

describe('OpenCode tool calls in the audit log', () => {
  afterEach(() => resetAuditTrail());

  it('records each tool once it settles, and skips DorkOS tools', async () => {
    const db = setUpAuditTrail();
    const ctx = createOpenCodeEventContext('session-1');
    const bash = { command: 'pnpm build' };
    const edit = { filePath: '/projects/scout/README.md' };
    const events: StreamEvent[] = [
      toolPart(OC_SESSION_A, 'call_1', 'bash', toolStateRunning(bash)),
      toolPart(OC_SESSION_A, 'call_1', 'bash', toolStateCompleted(bash, 'built')),
      toolPart(OC_SESSION_A, 'call_2', 'edit', toolStateRunning(edit)),
      toolPart(OC_SESSION_A, 'call_2', 'edit', toolStateError(edit, 'no such file')),
      toolPart(OC_SESSION_A, 'call_3', 'dorkos_tasks_list', toolStateCompleted({}, '[]')),
    ].flatMap((part) => mapPartSnapshot(part, ctx));

    await runTurn(events, { runtime: 'opencode' });

    expect(toolRows(db)).toMatchObject([
      {
        targetType: 'command',
        targetId: 'pnpm build',
        outcome: 'ok',
        source: { runtime: 'opencode' },
      },
      { targetType: 'file', targetId: '/projects/scout/README.md', outcome: 'failed' },
    ]);
    expect(toolRows(db)).toHaveLength(2);
  });
});
