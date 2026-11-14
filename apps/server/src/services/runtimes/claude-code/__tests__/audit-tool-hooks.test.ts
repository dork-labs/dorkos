/**
 * The Claude Code hooks that record a helper agent's tool calls (spec
 * `audit-trail` PR3): a call inside a helper is recorded once, credited to the
 * session's agent and marked as a helper's; a main-thread call is left to the
 * stream; and a hook never holds or changes a tool.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { auditEvents, type Db } from '@dorkos/db';
import { resetAuditTrail } from '../../../audit/audit-trail.js';
import { setAgentHomeRegistry } from '../../../core/agent-identity/agent-home.js';
import { SCOUT, setUpAuditTrail, toolRows } from '../../../audit/__tests__/tool-use-harness.js';
import { createAuditToolHook, createShellRefusalRecorder } from '../audit-tool-hooks.js';

const base = {
  session_id: 'sdk-1',
  transcript_path: '/tmp/t.jsonl',
  cwd: SCOUT.home,
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  tool_use_id: 'helper-call-1',
};

function run(input: Record<string, unknown>) {
  const hook = createAuditToolHook({ sessionId: 'session-1', turn: { cwd: SCOUT.home } });
  return hook(input as unknown as HookInput, 'helper-call-1', {
    signal: new AbortController().signal,
  });
}

describe('createAuditToolHook', () => {
  let db: Db;
  beforeEach(() => {
    db = setUpAuditTrail();
  });
  afterEach(() => {
    resetAuditTrail();
    setAgentHomeRegistry(undefined);
  });

  it("records a helper's finished tool call, by the session's agent", async () => {
    expect(
      await run({
        ...base,
        hook_event_name: 'PostToolUse',
        tool_response: 'ok',
        agent_id: 'helper-7',
      })
    ).toEqual({});
    expect(toolRows(db)).toMatchObject([
      {
        targetId: 'rm -rf build',
        outcome: 'ok',
        actorId: SCOUT.id,
        links: { causedBy: 'helper:helper-7' },
        source: { runtime: 'claude-code', sessionId: 'session-1', toolCallId: 'helper-call-1' },
      },
    ]);
  });

  it("records a helper's failed tool call as failed, once", async () => {
    const failure = {
      ...base,
      hook_event_name: 'PostToolUseFailure',
      error: 'exit 1',
      agent_id: 'helper-7',
    };
    await run(failure);
    await run(failure);
    expect(toolRows(db)).toMatchObject([{ outcome: 'failed' }]);
  });

  it('leaves a main-thread call to the stream', async () => {
    await run({ ...base, hook_event_name: 'PostToolUse', tool_response: 'ok' });
    expect(toolRows(db)).toEqual([]);
  });
});

describe('createShellRefusalRecorder', () => {
  let db: Db;
  beforeEach(() => {
    db = setUpAuditTrail();
  });
  afterEach(() => {
    resetAuditTrail();
    setAgentHomeRegistry(undefined);
  });

  // DOR-4304: a check that couldn't start was audited as a setup-file write.
  it.each([
    ['writes', 'Refused: It changes an agent’s setup files.'],
    ['unreadable', 'Refused: Too long or complex to check.'],
    ['failed', 'Refused: The check couldn’t finish reading it.'],
    ['no-check', 'Refused: The check couldn’t start.'],
  ] as const)('records a %s refusal under its own reason', (verdict, reason) => {
    const record = createShellRefusalRecorder({
      sessionId: 'session-1',
      turn: { cwd: SCOUT.home },
    });
    record({ toolName: 'Bash', toolUseId: `call-${verdict}`, command: 'uptime', verdict });
    const rows = db.select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'refused', error: reason });
  });
});
