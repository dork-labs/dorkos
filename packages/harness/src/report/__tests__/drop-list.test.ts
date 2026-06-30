import { describe, it, expect } from 'vitest';
import { formatDropList } from '../drop-list.js';
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
    };
    const out = formatDropList(plan);
    expect(out).toContain('codex:');
    expect(out).toContain('command');
    expect(out).toContain('no slash-command format');
  });

  it('reports a clean message when there are no drops', () => {
    // No drops is a valid, honest outcome.
    expect(formatDropList({ actions: [], drops: [] })).toMatch(/No drops/);
  });
});
