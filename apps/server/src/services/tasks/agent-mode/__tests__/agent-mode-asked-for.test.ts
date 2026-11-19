/**
 * What a call asked for and does not apply, on the mode card (DOR-4335, Security D-5): shown,
 * bound, inert, and absent without a trace when the call asked for nothing.
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-asked-for
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@dorkos/shared/types';
import { agentModeChangeOf } from '../agent-mode-change.js';
import {
  askedForLines,
  askedForRules,
  inertText,
  modeLabel,
  RULES_NOTE,
} from '../agent-mode-asked-for.js';
import { FALLBACK_LABELS } from '../../../notifications/schedule-execution-copy.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../../runtimes/opencode/runtime-constants.js';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

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
  runtime: 'not-registered-here',
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
    // The picker's label, never the raw id (designer, #4001), with no runtime registered here.
    expect(text).toContain('\nAsked for: Bypass permissions\n');
    expect(text).toContain(
      '\nAlso asked for these rules (not applied):\n  - Bash(./a.sh)\n  - Bash(./b.sh)\n'
    );
    // Formatted like the `Version:` line below it.
    expect(text).toMatch(/\nRequest version: sha256:[A-Za-z0-9_-]{43}\n/);
    expect(text).toMatch(/\nVersion: sha256:[A-Za-z0-9_-]{43}$/);
  });

  it("names a mode by the task runtime's own picker label", () => {
    const codex = {
      permissionModes: { values: [{ id: 'acceptEdits', label: 'Workspace write' }] },
    } as unknown as RuntimeCapabilities;
    expect(askedForLines({ requestedPermissionMode: 'acceptEdits' }, 'plan', codex)[0]).toBe(
      'Asked for: Workspace write'
    );
    expect(askedForLines({ requestedPermissionMode: 'dontAsk' }, 'plan', undefined)[0]).toBe(
      'Asked for: Never ask'
    );
  });

  it('shows a mode nobody knows by its inert id, so the person still sees what was asked', () => {
    const [line] = askedForLines({ requestedPermissionMode: 'turbo\u202E' }, 'plan', undefined);
    expect(line).toBe('Asked for: Unknown mode (turbo\\u{202E})');
  });

  it('puts each rule on its own indented line, so one rule never poses as two', () => {
    const lines = askedForLines(
      { requestedAllow: ['Bash(./a.sh) · Bash(./b.sh)', 'x\nRequest version: sha256:fake'] },
      'dontAsk',
      undefined
    );
    expect(lines).toEqual([
      'Also asked for these rules (not applied):',
      '  - Bash(./a.sh) · Bash(./b.sh)',
      '  - x Request version: sha256:fake',
      expect.stringMatching(/^Request version: sha256:/),
    ]);
  });

  it('lists fifty rules and counts the rest, all bound', () => {
    const rules = Array.from(
      { length: 53 },
      (_, i) => `Bash(./step-${String(i + 1).padStart(2, '0')}.sh)`
    );
    const lines = askedForLines({ requestedAllow: rules }, 'dontAsk', undefined);
    expect(lines.filter((l) => l.startsWith('  - '))).toHaveLength(50);
    expect(lines).toContain('  - Bash(./step-50.sh)');
    expect(lines.join('\n')).not.toContain('step-51');
    expect(lines.at(-2)).toBe('  +3 more rules, none applied.');
    const fewer = askedForLines({ requestedAllow: rules.slice(0, 52) }, 'dontAsk', undefined);
    expect(fewer.at(-1)).not.toBe(lines.at(-1));
  });

  it('binds the raw request: rules or modes that only look alike once escaped stay distinct', () => {
    const real = askedForLines({ requestedAllow: ['Bash(a\u202Eb)'] }, 'dontAsk', undefined);
    const spelled = askedForLines({ requestedAllow: ['Bash(a\\u{202E}b)'] }, 'dontAsk', undefined);
    expect(real[1]).toBe(spelled[1]);
    expect(real[2]).not.toBe(spelled[2]);
    const modeReal = askedForLines({ requestedPermissionMode: 'plan\u200B' }, 'dontAsk', undefined);
    const modeSpelled = askedForLines(
      { requestedPermissionMode: 'plan\\u{200B}' },
      'dontAsk',
      undefined
    );
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
    // The link stays as plain characters inside the one rule's line.
    expect(text.split('\n').find((l) => l.startsWith('  - '))).toContain(
      '[click](https://example.invalid)'
    );
    expect(inertText('a\u2028b\u00ADc')).toBe('a\\u{2028}b\\u{AD}c');
  });
});

describe('a mode line never gives two modes the same words (Security, #4001)', () => {
  // The card text is the binding: two modes with one label would let a yes for one
  // answer a card for the other.
  const RUNTIMES = {
    'claude-code': CLAUDE_CODE_CAPABILITIES,
    codex: CODEX_CAPABILITIES,
    opencode: OPENCODE_CAPABILITIES,
    none: undefined,
  };

  for (const [name, capabilities] of Object.entries(RUNTIMES)) {
    it(`labels every mode on ${name} distinctly`, () => {
      const ids = [
        ...new Set([
          ...(capabilities?.permissionModes.values.map((value) => value.id) ?? []),
          ...Object.keys(FALLBACK_LABELS),
          'future-mode',
          'Unknown mode',
        ]),
      ];
      const labels = ids.map((id) => modeLabel(id, capabilities));
      expect(new Set(labels).size).toBe(ids.length);
    });
  }

  it('adds the id when two modes share a label, or a label reads like the unknown fallback', () => {
    const clash = {
      permissionModes: {
        values: [
          { id: 'a', label: 'Careful' },
          { id: 'b', label: 'Careful' },
          { id: 'c', label: 'Unknown mode (d)' },
        ],
      },
    } as unknown as RuntimeCapabilities;
    expect(modeLabel('a', clash)).toBe('Careful (a)');
    expect(modeLabel('b', clash)).toBe('Careful (b)');
    expect(modeLabel('c', clash)).toBe('Unknown mode (d) (c)');
    expect(modeLabel('d', clash)).toBe('Unknown mode (d)');
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
