/**
 * What a call asked for and does not apply, on the mode card (DOR-4335, Security D-5): shown,
 * bound, inert, and absent without a trace when the call asked for nothing.
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-asked-for
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@dorkos/shared/types';
import { agentModeChangeOf } from '../agent-mode-change.js';
import { askedForLines, askedForRules, inertText, RULES_NOTE } from '../agent-mode-asked-for.js';

const TASK = {
  id: 'task-1',
  name: 'sweep',
  prompt: 'sweep the backlog',
  cron: '0 3 * * *',
  timezone: 'UTC',
  agentId: 'agent-a',
  permissionMode: 'default',
  status: 'pending_approval',
  filePath: '',
} as Task;

function changeFor(body: Record<string, unknown>) {
  return agentModeChangeOf(
    { door: 'update', body, task: TASK },
    { mode: 'dontAsk', previousMode: 'default' },
    undefined,
    '/tmp/dor4335/agent-a'
  );
}

describe('the mode card names what the call asked for', () => {
  it('keeps the text byte-identical when the call asked for nothing, or the decided mode', () => {
    const plain = changeFor({ permissionMode: 'dontAsk' });
    expect(changeFor({ permissionMode: 'dontAsk', requestedPermissionMode: 'dontAsk' })).toBe(
      plain
    );
    expect(changeFor({ permissionMode: 'dontAsk', requestedAllow: [] })).toBe(plain);
    expect(plain).not.toMatch(/Asked for|Rules/);
  });

  it('names a requested mode other than the one decided, and the rules with their version', () => {
    const text = changeFor({
      permissionMode: 'dontAsk',
      requestedPermissionMode: 'bypassPermissions',
      requestedAllow: ['Bash(./b.sh)', 'Bash(./a.sh)', 'Bash(./a.sh)'],
    });
    expect(text).toContain('Asked for: bypassPermissions');
    expect(text).toContain('Rules asked for (not applied): Bash(./a.sh) · Bash(./b.sh)');
    expect(text).toMatch(/Request version: [0-9a-f]{64}/);
  });

  it('keeps one rule from posing as two', () => {
    const [line] = askedForLines({ requestedAllow: ['Bash(./a.sh) · Bash(./b.sh)'] }, 'dontAsk');
    expect(line).toBe('Rules asked for (not applied): Bash(./a.sh) \\u{B7} Bash(./b.sh)');
  });

  it('lists five rules and counts the rest', () => {
    const rules = Array.from({ length: 8 }, (_, i) => `Bash(./step-${i + 1}.sh)`);
    const [line] = askedForLines({ requestedAllow: rules }, 'dontAsk');
    expect(line).toMatch(/step-5\.sh\) \+3 more$/);
    expect(line).not.toContain('step-6');
  });

  it('binds the raw request: rules or modes that only look alike once escaped stay distinct', () => {
    const real = askedForLines({ requestedAllow: ['Bash(a\u202Eb)'] }, 'dontAsk');
    const spelled = askedForLines({ requestedAllow: ['Bash(a\\u{202E}b)'] }, 'dontAsk');
    expect(real[0]).toBe(spelled[0]);
    expect(real[1]).not.toBe(spelled[1]);
    const modeReal = askedForLines({ requestedPermissionMode: 'plan\u200B' }, 'dontAsk');
    const modeSpelled = askedForLines({ requestedPermissionMode: 'plan\\u{200B}' }, 'dontAsk');
    expect(modeReal[0]).toBe(modeSpelled[0]);
    expect(modeReal[1]).not.toBe(modeSpelled[1]);
  });

  it('shows agent-written rule text inert: no bidi, no line break, no live link', () => {
    const rule =
      'Bash(./ok.sh)\u202Etxt.exe\nMode: bypassPermissions [click](https://example.invalid)';
    const text = changeFor({ requestedAllow: [rule] });
    expect(text).not.toContain('\u202E');
    expect(text).toContain('\\u{202E}');
    // The rule cannot draw a line of its own: no second "Mode:" line starts anywhere.
    expect(text.split('\n').filter((l) => l.startsWith('Mode:'))).toHaveLength(1);
    // The link stays as plain characters inside the one rules line.
    expect(text.split('\n').find((l) => l.startsWith('Rules asked for'))).toContain(
      '[click](https://example.invalid)'
    );
    expect(inertText('a\u2028b\u00ADc')).toBe('a\\u{2028}b\\u{AD}c');
  });
});

describe('the tool reply says why the rules did nothing', () => {
  it('answers with the fixed note only when rules were asked for, never echoing them', () => {
    expect(askedForRules({ requestedAllow: ['Bash(./a.sh)'] })).toBe(true);
    expect(askedForRules({ requestedAllow: [] })).toBe(false);
    expect(askedForRules({ permissionMode: 'dontAsk' })).toBe(false);
    expect(RULES_NOTE).not.toMatch(/Bash/);
  });
});
