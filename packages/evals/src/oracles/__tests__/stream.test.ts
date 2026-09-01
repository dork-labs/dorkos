/**
 * Stream oracles over canned frames: each has a PASSING and a deliberately
 * FAILING case (the tool never ran / the command never fired) so a broken
 * always-pass oracle is caught.
 *
 * Every tool-name assertion is written BOTH ways — bare and
 * `mcp__dorkos__`-qualified. That is not redundancy: the qualified form is the
 * ONLY form a real durable stream carries (an in-session tool lives on the SDK
 * MCP server named `dorkos`), and a whole suite of bare-name fixtures is exactly
 * why 158 green tests coexisted with oracles that could never match a real run.
 */
import { describe, it, expect } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils';
import { emptyApprovalLog, type OracleContext } from '../../types.js';
import {
  costReportedPositive,
  failedHonestly,
  modelReportedIs,
  toolInvokedInStream,
  toolLoopClosed,
  toolNameMatches,
  toolResultContains,
  toolResultPayloads,
  turnEndedExactlyOnce,
  uiCommandEmitted,
  uiActionTriggerObserved,
} from '../stream.js';

/** Qualify a tool name the way the in-session `dorkos` MCP server does. */
function qualified(toolName: string): string {
  return `mcp__dorkos__${toolName}`;
}

/** Build an OracleContext carrying `frames`. */
function ctx(frames: SseFrame[]): OracleContext {
  return {
    sandbox: { dorkHome: '/unused', projectCwd: '/unused' },
    baseUrl: 'http://unused',
    sessionId: 's',
    frames,
    approvals: emptyApprovalLog(),
  };
}

/** A durable `tool_call` frame. */
function toolCall(toolName: string): SseFrame {
  return { event: 'tool_call', data: { type: 'tool_call', seq: 1, toolName, toolCallId: 'tc1' } };
}

/** A durable `tool_result` frame carrying `result`. */
function toolResult(toolName: string, result: string): SseFrame {
  return {
    event: 'tool_result',
    data: { type: 'tool_result', seq: 2, toolName, toolCallId: 'tc1', result },
  };
}

/** A durable `ui_command` frame carrying `command`. */
function uiCommand(command: unknown): SseFrame {
  return { event: 'ui_command', data: { type: 'ui_command', seq: 3, command } };
}

/** A durable `turn_start` frame carrying an injected trigger `userMessage`. */
function turnStart(userMessage?: string): SseFrame {
  return {
    event: 'turn_start',
    data: { type: 'turn_start', seq: 4, ...(userMessage !== undefined ? { userMessage } : {}) },
  };
}

/** The `<ui_action>` block `formatUiActionMessage` injects for a widget action. */
function uiActionBlock(actionId: string): string {
  return [
    '<ui_action>',
    'The user interacted with a widget you rendered.',
    'Widget: Round-trip probe',
    `Action: ${actionId}`,
    'Payload: (none)',
    '</ui_action>',
  ].join('\n');
}

describe('toolNameMatches', () => {
  it('matches the bare name and the MCP-qualified name the SDK actually emits', () => {
    expect(toolNameMatches('marketplace_uninstall', 'marketplace_uninstall')).toBe(true);
    expect(toolNameMatches('mcp__dorkos__marketplace_uninstall', 'marketplace_uninstall')).toBe(
      true
    );
  });

  it('does NOT match a different tool that merely shares a suffix boundary', () => {
    // The bug this guards: `endsWith(name)` without the separator would accept
    // `marketplace_uninstall` as an invocation of `install`.
    expect(toolNameMatches('mcp__dorkos__marketplace_uninstall', 'marketplace_install')).toBe(
      false
    );
    expect(toolNameMatches('mcp__dorkos__marketplace_install', 'install')).toBe(false);
    expect(toolNameMatches(undefined, 'marketplace_install')).toBe(false);
  });
});

describe('toolInvokedInStream', () => {
  it('passes when the tool ran', async () => {
    const result = await toolInvokedInStream('marketplace_install')(
      ctx([toolCall('marketplace_install')])
    );
    expect(result.passed).toBe(true);
  });

  it('passes on the MCP-QUALIFIED name a real durable stream carries', async () => {
    const result = await toolInvokedInStream('marketplace_install')(
      ctx([toolCall(qualified('marketplace_install'))])
    );
    expect(result.passed).toBe(true);
    expect(result.evidence).toMatchObject({ invocations: 1 });
  });

  it('fails when a DIFFERENT tool ran (the model chose wrong)', async () => {
    const result = await toolInvokedInStream('marketplace_install')(ctx([toolCall('relay_send')]));
    expect(result.passed).toBe(false);
  });

  it('fails when a NEIGHBORING qualified tool ran, and names what it saw', async () => {
    const result = await toolInvokedInStream('marketplace_install')(
      ctx([toolCall(qualified('marketplace_uninstall'))])
    );
    expect(result.passed).toBe(false);
    // The evidence must distinguish "never called" from "called under a name the
    // oracle failed to match" — the confusion that kept this bug alive.
    expect(result.evidence).toMatchObject({
      observedToolNames: ['mcp__dorkos__marketplace_uninstall'],
    });
  });
});

describe('toolResultContains', () => {
  it('passes when a tool result carries the expected package', async () => {
    const frames = [toolResult('marketplace_search', '{"matches":["acme-notes"]}')];
    const result = await toolResultContains('marketplace_search', 'acme-notes')(ctx(frames));
    expect(result.passed).toBe(true);
  });

  it('passes on the MCP-QUALIFIED tool name', async () => {
    const frames = [toolResult(qualified('marketplace_search'), '{"matches":["acme-notes"]}')];
    const result = await toolResultContains('marketplace_search', 'acme-notes')(ctx(frames));
    expect(result.passed).toBe(true);
  });

  it('fails when no matching tool result carries the needle', async () => {
    const frames = [toolResult('marketplace_search', '{"matches":[]}')];
    const result = await toolResultContains('marketplace_search', 'acme-notes')(ctx(frames));
    expect(result.passed).toBe(false);
  });
});

describe('toolResultPayloads', () => {
  it('parses every JSON result the tool returned, in stream order', () => {
    const frames = [
      toolResult('marketplace_uninstall', JSON.stringify({ status: 'approval_required' }, null, 2)),
      toolResult('marketplace_uninstall', JSON.stringify({ status: 'uninstalled' }, null, 2)),
      toolResult('other_tool', JSON.stringify({ status: 'ignored' })),
    ];
    const { payloads, unparsed } = toolResultPayloads(frames, 'marketplace_uninstall');
    expect(payloads).toEqual([{ status: 'approval_required' }, { status: 'uninstalled' }]);
    expect(unparsed).toEqual([]);
  });

  it('collects the QUALIFIED tool results and ignores a neighboring tool', () => {
    const frames = [
      toolResult(
        qualified('marketplace_uninstall'),
        JSON.stringify({ status: 'approval_required' }, null, 2)
      ),
      toolResult(
        qualified('marketplace_install'),
        JSON.stringify({ status: 'installed' }, null, 2)
      ),
    ];
    const { payloads, observedToolNames } = toolResultPayloads(frames, 'marketplace_uninstall');
    expect(payloads).toEqual([{ status: 'approval_required' }]);
    expect(observedToolNames).toEqual([
      'mcp__dorkos__marketplace_uninstall',
      'mcp__dorkos__marketplace_install',
    ]);
  });

  it('recovers the JSON object when a runtime wrapped the result in text', () => {
    const frames = [
      toolResult('marketplace_uninstall', '[Resource from dorkos] {"status":"approval_required"}'),
    ];
    const { payloads } = toolResultPayloads(frames, 'marketplace_uninstall');
    expect(payloads).toEqual([{ status: 'approval_required' }]);
  });

  it('reports a non-JSON result as unparsed rather than dropping it silently', () => {
    const frames = [toolResult('marketplace_uninstall', 'Uninstalled the package for you.')];
    const { payloads, unparsed } = toolResultPayloads(frames, 'marketplace_uninstall');
    expect(payloads).toEqual([]);
    expect(unparsed).toEqual(['Uninstalled the package for you.']);
  });

  it('returns nothing when the tool never produced a result', () => {
    expect(
      toolResultPayloads([toolCall('marketplace_uninstall')], 'marketplace_uninstall')
    ).toEqual({ payloads: [], unparsed: [], observedToolNames: [] });
  });
});

describe('uiCommandEmitted', () => {
  it('passes when a matching ui_command fired', async () => {
    const frames = [uiCommand({ action: 'open_panel', panel: 'tasks' })];
    const result = await uiCommandEmitted((c) => (c as { panel?: string }).panel === 'tasks')(
      ctx(frames)
    );
    expect(result.passed).toBe(true);
  });

  it('fails when no ui_command matched the predicate', async () => {
    const frames = [uiCommand({ action: 'open_panel', panel: 'files' })];
    const result = await uiCommandEmitted((c) => (c as { panel?: string }).panel === 'tasks')(
      ctx(frames)
    );
    expect(result.passed).toBe(false);
  });
});

describe('uiActionTriggerObserved', () => {
  it('passes when a turn_start carries the <ui_action> trigger for the action', async () => {
    const frames = [turnStart(uiActionBlock('confirm-order'))];
    const result = await uiActionTriggerObserved('confirm-order')(ctx(frames));
    expect(result.passed).toBe(true);
  });

  it('fails when the turn_start carried a DIFFERENT action (a stray turn, not the widget)', async () => {
    const frames = [turnStart(uiActionBlock('some-other-action'))];
    const result = await uiActionTriggerObserved('confirm-order')(ctx(frames));
    expect(result.passed).toBe(false);
  });

  it('fails when the turn_start carried an ordinary message, not a <ui_action> block', async () => {
    const frames = [turnStart('Just a normal prompt mentioning Action: confirm-order in prose')];
    const result = await uiActionTriggerObserved('confirm-order')(ctx(frames));
    expect(result.passed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-runtime chat oracles
// ─────────────────────────────────────────────────────────────────────────────
//
// Each has a passing case AND the specific failure it exists to catch, because
// an always-pass structural oracle is worse than none: these are the only
// assertions the `chat` suite makes, so a broken one turns the whole paid tier
// into a green that measures nothing.

/** A durable `turn_end` frame. */
function turnEnd(): SseFrame {
  return { event: 'turn_end', data: { type: 'turn_end', seq: 9 } };
}

/** A durable `status_change` frame carrying a model and/or a cost. */
function statusChange(status: { model?: string; cost?: number }): SseFrame {
  return { event: 'status_change', data: { type: 'status_change', seq: 5, status } };
}

/** A durable `error` frame. */
function errorFrame(message: string): SseFrame {
  return { event: 'error', data: { type: 'error', seq: 7, message } };
}

/** A `tool_call` / `tool_result` pair addressed by an explicit call id. */
function toolPair(id: string, toolName = 'read'): SseFrame[] {
  return [
    { event: 'tool_call', data: { type: 'tool_call', seq: 1, toolName, toolCallId: id } },
    { event: 'tool_result', data: { type: 'tool_result', seq: 2, toolName, toolCallId: id } },
  ];
}

describe('turnEndedExactlyOnce', () => {
  it('passes on exactly one terminal', async () => {
    expect((await turnEndedExactlyOnce()(ctx([turnEnd()]))).passed).toBe(true);
  });

  it('fails on a turn that never ended — the hang', async () => {
    const result = await turnEndedExactlyOnce()(ctx([statusChange({ cost: 1 })]));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('saw 0');
  });

  it('fails on two terminals — a client that closes on the first goes deaf', async () => {
    const result = await turnEndedExactlyOnce()(ctx([turnEnd(), turnEnd()]));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('saw 2');
  });
});

describe('toolLoopClosed', () => {
  it('passes when a call opens and the SAME call closes', async () => {
    expect((await toolLoopClosed()(ctx(toolPair('tc-a')))).passed).toBe(true);
  });

  it('fails when a different call closes — the demux failure it exists to catch', async () => {
    // One opened, one closed, nothing paired: exactly what a stream filtered on
    // the wrong key produces, and exactly what a "saw a call, saw a result"
    // oracle would have called green.
    const opened = toolPair('tc-a')[0] as SseFrame;
    const closed = toolPair('tc-b')[1] as SseFrame;
    const result = await toolLoopClosed()(ctx([opened, closed]));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('1 opened, 1 closed');
  });

  it('fails when a result precedes its own call', async () => {
    const [call, res] = toolPair('tc-a') as [SseFrame, SseFrame];
    expect((await toolLoopClosed()(ctx([res, call]))).passed).toBe(false);
  });

  it('fails when the turn used no tools at all', async () => {
    const result = await toolLoopClosed()(ctx([turnEnd()]));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('0 opened');
  });
});

describe('costReportedPositive', () => {
  it('passes on a real reported cost', async () => {
    expect((await costReportedPositive()(ctx([statusChange({ cost: 0.00028 })]))).passed).toBe(
      true
    );
  });

  it('fails when nothing reported a cost — the ceiling was watching nothing', async () => {
    const result = await costReportedPositive()(ctx([turnEnd()]));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('no status frame carried a cost');
  });

  it('fails on a zero from a completed paid turn', async () => {
    expect((await costReportedPositive()(ctx([statusChange({ cost: 0 })]))).passed).toBe(false);
  });
});

describe('modelReportedIs', () => {
  it('matches the model id half of a `provider/model` pin', async () => {
    // The sidecar reports `modelID` alone; the provider half rides usage.detail.
    const frames = [statusChange({ model: 'qwen/qwen3.7-flash' })];
    expect((await modelReportedIs('openrouter/qwen/qwen3.7-flash')(ctx(frames))).passed).toBe(true);
  });

  it('fails when the turn answered on a different model', async () => {
    const result = await modelReportedIs('openrouter/qwen/qwen3.7-flash')(
      ctx([statusChange({ model: 'anthropic/claude-haiku-4-5' })])
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('anthropic/claude-haiku-4-5');
  });

  it('fails, rather than passing vacuously, when no model was reported', async () => {
    const result = await modelReportedIs('openrouter/qwen/qwen3.7-flash')(ctx([turnEnd()]));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('nothing');
  });
});

describe('failedHonestly', () => {
  it('passes on a typed error followed by the terminal', async () => {
    const frames = [errorFrame("That model isn't available."), turnEnd()];
    expect((await failedHonestly()(ctx(frames))).passed).toBe(true);
  });

  it('fails on an error with no terminal — the hang a person actually complains about', async () => {
    const result = await failedHonestly()(ctx([errorFrame('boom')]));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('never ended');
  });

  it('fails on a terminal with no error — a silent failure', async () => {
    const result = await failedHonestly()(ctx([turnEnd()]));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('silent');
  });
});
