import { describe, it, expect } from 'vitest';
import { formatDropList, formatWarnings } from '../drop-list.js';
import type { ProjectionPlan } from '../../plan/types.js';

describe('formatDropList', () => {
  it('groups drops by harness with their reasons', () => {
    // The drop list is the honesty surface — each drop shows its harness + reason.
    const plan: ProjectionPlan = {
      actions: [],
      drops: [
        {
          kind: 'drop',
          artifact: 'command',
          harness: 'codex',
          provenance: 'authored',
          name: 'commands',
          reason: 'no slash-command format',
        },
      ],
      warnings: [],
    };
    const out = formatDropList(plan);
    expect(out).toContain('codex:');
    expect(out).toContain('command');
    expect(out).toContain('no slash-command format');
  });

  it('reports a clean message when there are no drops', () => {
    // No drops is a valid, honest outcome.
    expect(formatDropList({ actions: [], drops: [], warnings: [] })).toMatch(/No drops/);
  });
});

describe('formatWarnings', () => {
  it('groups warnings by harness with their reasons', () => {
    const out = formatWarnings({
      actions: [],
      drops: [],
      warnings: [
        {
          artifact: 'hook',
          harness: 'codex',
          name: 'Stop',
          reason: 'hook command for "Stop" uses Claude-only "${CLAUDE_PLUGIN_ROOT}"; Codex …',
        },
      ],
    });
    expect(out).toContain('Warnings');
    expect(out).toContain('codex:');
    expect(out).toContain('Stop');
    expect(out).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('returns an empty string when there are no warnings', () => {
    // Callers omit the block entirely when empty.
    expect(formatWarnings({ actions: [], drops: [], warnings: [] })).toBe('');
  });
});
