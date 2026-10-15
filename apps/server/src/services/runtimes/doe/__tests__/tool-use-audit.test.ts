/**
 * Doe tool calls reach the audit log (spec `audit-trail` PR3): a main-scope
 * call, mapped by the real Doe turn mapper, becomes one `runtime.tool_used`
 * row with its target, and a helper's call, which never reaches the stream as
 * a tool event, is recorded through the mapper's helper hook.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { DoeEvent, ModelDescriptor } from '@dorkos/doe';
import type { StreamEvent } from '@dorkos/shared/types';
import { DoeTurnEvents } from '../turn.js';
import { resetAuditTrail } from '../../../audit/audit-trail.js';
import { recordRuntimeToolCall, toolActorOf } from '../../../audit/record-tool-use.js';
import { setAgentHomeRegistry } from '../../../core/agent-identity/agent-home.js';
import {
  runTurn,
  SCOUT,
  setUpAuditTrail,
  toolRows,
} from '../../../audit/__tests__/tool-use-harness.js';

const MODEL = { id: 'test-model' } as unknown as ModelDescriptor;

describe('Doe tool calls in the audit log', () => {
  afterEach(() => {
    resetAuditTrail();
    setAgentHomeRegistry(undefined);
  });

  it("records a call with its target, and a helper's call through the hook, once each", async () => {
    const db = setUpAuditTrail();
    const events: StreamEvent[] = [];
    const mapper = new DoeTurnEvents('session-1', MODEL, (event) => events.push(event));
    mapper.onHelperTool = (call) =>
      recordRuntimeToolCall(
        {
          runtime: 'doe',
          sessionId: 'session-1',
          toolCallId: call.callId,
          name: call.name,
          input: call.input,
          actor: toolActorOf('doe', { cwd: SCOUT.home })!,
          helperId: call.helper,
        },
        call.failed ? 'failed' : 'ok'
      );
    const engine: DoeEvent[] = [
      { type: 'tool-start', name: 'builder', callId: 'b1', scope: 'main', input: { task: 'x' } },
      { type: 'tool-start', name: 'bash', callId: 'm1', scope: 'main', input: { command: 'ls' } },
      { type: 'tool-end', name: 'bash', callId: 'm1', scope: 'main', result: { content: [] } },
    ];
    for (const event of engine) mapper.receive(event);
    mapper.childStarted('child:1', 'b1');
    mapper.receive({
      type: 'tool-start',
      name: 'write',
      callId: 'c1',
      scope: 'child:1',
      input: { path: '/projects/scout/app.ts' },
    });
    mapper.receive({
      type: 'tool-end',
      name: 'write',
      callId: 'c1',
      scope: 'child:1',
      result: { content: [], isError: true },
    });

    await runTurn(events, { runtime: 'doe' });

    expect(toolRows(db)).toMatchObject([
      {
        targetType: 'file',
        targetId: '/projects/scout/app.ts',
        outcome: 'failed',
        links: { causedBy: 'helper:child:1' },
      },
      {
        targetType: 'command',
        targetId: 'ls',
        outcome: 'ok',
        source: { runtime: 'doe', toolCallId: 'm1' },
      },
    ]);
    // The builder call started the helper, so the helper is not counted twice.
    expect(toolRows(db, 'runtime.helper_started')).toEqual([]);
  });
});
