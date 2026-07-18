/**
 * Stream oracles over canned frames: each has a PASSING and a deliberately
 * FAILING case (the tool never ran / the command never fired) so a broken
 * always-pass oracle is caught.
 */
import { describe, it, expect } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils';
import type { OracleContext } from '../../types.js';
import {
  toolInvokedInStream,
  toolResultContains,
  uiCommandEmitted,
  uiActionTriggerObserved,
} from '../stream.js';

/** Build an OracleContext carrying `frames`. */
function ctx(frames: SseFrame[]): OracleContext {
  return {
    sandbox: { dorkHome: '/unused', projectCwd: '/unused' },
    baseUrl: 'http://unused',
    sessionId: 's',
    frames,
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

describe('toolInvokedInStream', () => {
  it('passes when the tool ran', async () => {
    const result = await toolInvokedInStream('marketplace_install')(
      ctx([toolCall('marketplace_install')])
    );
    expect(result.passed).toBe(true);
  });

  it('fails when a DIFFERENT tool ran (the model chose wrong)', async () => {
    const result = await toolInvokedInStream('marketplace_install')(ctx([toolCall('relay_send')]));
    expect(result.passed).toBe(false);
  });
});

describe('toolResultContains', () => {
  it('passes when a tool result carries the expected package', async () => {
    const frames = [toolResult('marketplace_search', '{"matches":["acme-notes"]}')];
    const result = await toolResultContains('marketplace_search', 'acme-notes')(ctx(frames));
    expect(result.passed).toBe(true);
  });

  it('fails when no matching tool result carries the needle', async () => {
    const frames = [toolResult('marketplace_search', '{"matches":[]}')];
    const result = await toolResultContains('marketplace_search', 'acme-notes')(ctx(frames));
    expect(result.passed).toBe(false);
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
