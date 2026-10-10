/**
 * The tool-use recorder (spec `audit-trail` PR3), over a fake runtime: one row
 * per finished tool call, the right target, outcome and agent, nothing for
 * DorkOS's own tools, the turn passed through untouched, and a tool the turn
 * left running recorded once as started and settled once when its result comes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { auditEvents, type Db } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { auditTrail, resetAuditTrail } from '../audit-trail.js';
import { addressOf, recordRuntimeToolCall, toolTarget } from '../record-tool-use.js';
import { setAgentHomeRegistry } from '../../core/agent-identity/agent-home.js';
import { runTurn, SCOUT, setUpAuditTrail, toolRows } from './tool-use-harness.js';

/** A token prefix built from parts, so no fixture reads as a real key to a secret scanner. */
const STRIPE_LIVE = ['sk', 'live', ''].join('_');

const start = (id: string, name: string, input?: string): StreamEvent => ({
  type: 'tool_call_start',
  data: { toolCallId: id, toolName: name, status: 'running', ...(input ? { input } : {}) },
});
const result = (id: string, name: string, status: 'complete' | 'error'): StreamEvent => ({
  type: 'tool_result',
  data: { toolCallId: id, toolName: name, status, result: 'out' },
});

describe('recordToolUse', () => {
  let db: Db;
  beforeEach(() => {
    db = setUpAuditTrail();
  });
  afterEach(() => {
    resetAuditTrail();
    setAgentHomeRegistry(undefined);
  });

  it('records one row per finished tool call, by the agent, and passes the turn through', async () => {
    const events: StreamEvent[] = [
      start('t1', 'Bash', '{"command":"npm test"}'),
      { type: 'text_delta', data: { text: 'hi' } },
      result('t1', 'Bash', 'complete'),
      start('t2', 'Edit', '{"file_path":"/projects/scout/src/a.ts"}'),
      result('t2', 'Edit', 'error'),
    ];
    expect(await runTurn(events)).toEqual(events);

    expect(toolRows(db)).toMatchObject([
      {
        targetType: 'command',
        targetId: 'npm test',
        outcome: 'ok',
        operation: 'execute',
        actorKind: 'agent',
        actorId: SCOUT.id,
        actorName: 'Scout',
        source: {
          surface: 'runtime-tool',
          runtime: 'claude-code',
          sessionId: 'session-1',
          toolCallId: 't1',
        },
      },
      { targetType: 'file', targetId: '/projects/scout/src/a.ts', outcome: 'failed' },
    ]);
  });

  it('settles a call once, whichever terminal frames a runtime sends', async () => {
    await runTurn([
      start('t1', 'Shell', '{"command":"ls"}'),
      { type: 'tool_call_end', data: { toolCallId: 't1', toolName: 'Shell', status: 'complete' } },
      result('t1', 'Shell', 'complete'),
    ]);
    expect(toolRows(db)).toHaveLength(1);
  });

  it('waits for a real result when the input finishes streaming first', async () => {
    // Claude's tool_call_end means the INPUT is done, with the tool in flight.
    await runTurn([
      start('t1', 'Bash'),
      {
        type: 'tool_call_delta',
        data: { toolCallId: 't1', toolName: 'Bash', input: '{"comma', status: 'running' },
      },
      {
        type: 'tool_call_delta',
        data: { toolCallId: 't1', toolName: 'Bash', input: 'nd":"make"}', status: 'running' },
      },
      { type: 'tool_call_end', data: { toolCallId: 't1', toolName: 'Bash', status: 'running' } },
      result('t1', 'Bash', 'complete'),
    ]);
    expect(toolRows(db)).toMatchObject([{ targetId: 'make', outcome: 'ok' }]);
  });

  it.each([
    ['claude-code', 'mcp__dorkos__tasks_list', 'dorkos_tasks_list'],
    ['codex', 'mcp__dorkos__tasks_list', 'dorkos_tasks_list'],
    ['opencode', 'dorkos_tasks_list', 'mcp__dorkos__tasks_list'],
    ['doe', 'tasks_list', 'dorkos_tasks_list'],
  ])(
    "skips DorkOS's own tools as %s spells them, and only that spelling",
    async (runtime, own, other) => {
      await runTurn(
        [
          start('a', own, '{}'),
          result('a', own, 'complete'),
          start('b', other, '{}'),
          result('b', other, 'complete'),
        ],
        { runtime }
      );
      expect(toolRows(db).map((row) => row.source.toolCallId)).toEqual(['b']);
    }
  );

  it('records a call the turn left running as started, never as failed', async () => {
    await expect(
      runTurn([start('t1', 'Bash', '{"command":"sleep 100"}')], { throwAfter: new Error('crash') })
    ).rejects.toThrow('crash');
    expect(toolRows(db)).toEqual([]);
    expect(toolRows(db, 'runtime.tool_started')).toMatchObject([
      { targetId: 'sleep 100', outcome: 'ok', actorId: SCOUT.id },
    ]);
  });

  it('settles a call an earlier turn left running, once, when its result arrives later', async () => {
    await runTurn([start('bg', 'Shell', '{"command":"npm run watch"}')], { runtime: 'codex' });
    await runTurn([result('bg', 'Shell', 'error')], { runtime: 'codex' });
    await runTurn([result('bg', 'Shell', 'complete')], { runtime: 'codex' });

    expect(toolRows(db, 'runtime.tool_started')).toHaveLength(1);
    expect(toolRows(db)).toMatchObject([
      { targetId: 'npm run watch', outcome: 'failed', source: { toolCallId: 'bg' } },
    ]);
  });

  it('settles a later result under the agent that began the call', async () => {
    await runTurn([start('bg', 'Shell', '{"command":"npm run watch"}')], { runtime: 'codex' });
    await runTurn([result('bg', 'Shell', 'complete')], { runtime: 'codex', opts: {} });
    expect(toolRows(db)).toMatchObject([{ actorId: SCOUT.id, targetId: 'npm run watch' }]);
  });

  it('records nothing for a call cut off while its input was still streaming in', async () => {
    await expect(
      runTurn(
        [
          start('t1', 'Bash'),
          {
            type: 'tool_call_delta',
            data: { toolCallId: 't1', toolName: 'Bash', input: '{"comma', status: 'running' },
          },
        ],
        { throwAfter: new Error('interrupted') }
      )
    ).rejects.toThrow('interrupted');
    expect(toolRows(db, 'runtime.tool_started')).toEqual([]);
  });

  it('records a call left running when the caller stops early, by an agent it cannot name', async () => {
    const { recordToolUse } = await import('../record-tool-use.js');
    const fake = {
      type: 'codex',
      async *sendMessage() {
        yield start('t1', 'Shell', '{"command":"long"}');
        yield { type: 'text_delta', data: { text: 'more' } } as StreamEvent;
      },
    };
    for await (const _event of recordToolUse(fake as never).sendMessage('s', 'go', {})) break;
    expect(toolRows(db, 'runtime.tool_started')).toMatchObject([
      { targetId: 'long', actorKind: 'external', actorId: 'unidentified' },
    ]);
  });

  it('names the agent the turn is for when it stands outside that home', async () => {
    await runTurn([start('t1', 'Read', '{"file_path":"/x"}'), result('t1', 'Read', 'complete')], {
      opts: { cwd: '/projects/plain', forAgent: SCOUT.home },
    });
    expect(toolRows(db)).toMatchObject([
      { actorKind: 'agent', actorId: SCOUT.id, operation: 'access' },
    ]);
  });

  it('records a helper the runtime started on its own, and not one a tool call started', async () => {
    await runTurn([
      start('task-1', 'Task', '{"description":"look"}'),
      {
        type: 'background_task_started',
        data: { taskId: 'task-1', taskType: 'agent', startedAt: 1, description: 'look' },
      },
      result('task-1', 'Task', 'complete'),
      {
        type: 'background_task_started',
        data: { taskId: 'thread-9', taskType: 'agent', startedAt: 1, description: 'reviewer' },
      },
      {
        type: 'background_task_started',
        data: { taskId: 'cmd-1', taskType: 'bash', startedAt: 1, command: 'x' },
      },
    ]);
    expect(toolRows(db, 'runtime.helper_started')).toMatchObject([
      { targetType: 'helper', targetId: 'thread-9', actorId: SCOUT.id },
    ]);
  });

  it('records a call once when the stream and a hook both report it', async () => {
    await runTurn([start('t1', 'Bash', '{"command":"ls"}'), result('t1', 'Bash', 'complete')]);
    recordRuntimeToolCall(
      {
        runtime: 'claude-code',
        sessionId: 'session-1',
        toolCallId: 't1',
        name: 'Bash',
        input: '{"command":"ls"}',
        actor: auditTrail()!.accounts.agentAtHome(SCOUT.home),
      },
      'ok'
    );
    expect(toolRows(db)).toHaveLength(1);
  });

  it('records nothing, and still passes the turn through, with no audit trail', async () => {
    resetAuditTrail();
    const events = [start('t1', 'Bash', '{"command":"x"}'), result('t1', 'Bash', 'complete')];
    expect(await runTurn(events)).toEqual(events);
    expect(db.select().from(auditEvents).all()).toEqual([]);
  });
});

describe('toolTarget', () => {
  it.each([
    ['Bash', '{"command":"git push"}', { type: 'command', id: 'git push' }],
    ['Shell', '{"command":["ls","-la"]}', { type: 'command', id: 'ls -la' }],
    ['Write', '{"file_path":"/a/b/c.md"}', { type: 'file', id: '/a/b/c.md', name: 'c.md' }],
    ['write', '{"filePath":"/a/b.ts"}', { type: 'file', id: '/a/b.ts' }],
    [
      'WebFetch',
      '{"url":"https://example.com/p?token=abc#x"}',
      { type: 'url', id: 'example.com/p' },
    ],
    [
      'WebFetch',
      '{"url":"https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX"}',
      { type: 'url', id: 'hooks.slack.com/services' },
    ],
    ['WebSearch', '{"query":"vitest docs"}', { type: 'search', id: 'vitest docs' }],
    ['Grep', '{"pattern":"TODO"}', { type: 'search', id: 'TODO' }],
    [
      'ApplyPatch',
      '*** Begin Patch\n*** Update File: src/x.ts\n@@',
      { type: 'file', id: 'src/x.ts' },
    ],
    [
      'ApplyPatch',
      '{"changes":[{"path":"src/a.ts","kind":"update"},{"path":"b.md","kind":"add"}]}',
      { type: 'file', id: 'src/a.ts', name: 'a.ts and 1 more' },
    ],
    ['mcp__linear__create', '{}', { type: 'mcp-tool', id: 'mcp__linear__create' }],
  ])('%s', (name, input, expected) => {
    expect(toolTarget(name, input)).toMatchObject(expected);
  });

  it('names nothing it cannot recognise', () => {
    expect(toolTarget('TodoWrite', '{"todos":[]}')).toBeNull();
    expect(toolTarget('Bash', 'not json')).toBeNull();
  });

  it('cuts a long command short', () => {
    expect(toolTarget('Bash', JSON.stringify({ command: 'x'.repeat(500) }))!.id).toHaveLength(200);
  });

  it('sweeps a key before the cut, so no piece of one survives it', () => {
    const key = `${STRIPE_LIVE}AbCdEf0123456789abcdefGHIJ`;
    const command = `${'x'.repeat(185)} STRIPE=${key}`;
    const target = toolTarget('Bash', JSON.stringify({ command }))!;
    expect(target.id).not.toContain('sk_l');
    expect(target.name).not.toContain('sk_l');
  });

  it('keeps only the host and first path segment of an address', () => {
    expect(addressOf('https://u:p@api.example.com/v1/keys/abc?x=1')).toBe('api.example.com/v1');
    expect(addressOf('not a url/a/b/c/d/e')).toBe('not a url/a/b/c');
  });
});
