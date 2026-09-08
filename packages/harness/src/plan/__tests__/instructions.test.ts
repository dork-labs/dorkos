import { describe, it, expect } from 'vitest';
import { planInstruction, CLAUDE_INSTRUCTION_CONTENT } from '../instructions.js';
import { getActionContent } from '../content-map.js';
import { HARNESS_IDS } from '../../manifest/schema.js';

/** The harnesses that read `AGENTS.md` off disk with nothing written for them. */
const NATIVE_READERS = ['codex', 'cursor', 'opencode'] as const;

/** The harnesses that need a pointer file written, and where it goes. */
const SCAFFOLD_TARGETS = {
  'claude-code': '.claude/CLAUDE.md',
  gemini: 'GEMINI.md',
  copilot: '.github/copilot-instructions.md',
} as const;

describe('planInstruction', () => {
  it('drops on EVERY harness when there is no AGENTS.md, and calls none of them native (IN-03)', () => {
    // A `native` for a file that is not there is the plan telling the operator a
    // harness reads something that does not exist. Before this, the same plan
    // could carry `codex native AGENTS.md` beside `claude-code drop … no
    // AGENTS.md`, which is two answers to one question.
    const actions = HARNESS_IDS.map((harness) => planInstruction(harness, false));

    expect(actions).toHaveLength(HARNESS_IDS.length);
    expect(HARNESS_IDS.length).toBe(6);
    expect(actions.filter((a) => a.kind === 'drop')).toHaveLength(HARNESS_IDS.length);
    expect(actions.filter((a) => a.kind === 'native')).toEqual([]);
    for (const action of actions) {
      expect(action.reason).toBe('no AGENTS.md — nothing to read or point at');
    }
  });

  it('IN-01: is native for the three harnesses that read AGENTS.md once it exists', () => {
    const actions = NATIVE_READERS.map((harness) => planInstruction(harness, true));
    expect(actions).toHaveLength(3);
    for (const action of actions) {
      expect(action.kind).toBe('native');
      expect(action.source).toBe('AGENTS.md');
    }
  });

  it('IN-01: scaffolds a pointer for the three harnesses that cannot read AGENTS.md, once it exists', () => {
    const entries = Object.entries(SCAFFOLD_TARGETS) as [keyof typeof SCAFFOLD_TARGETS, string][];
    expect(entries).toHaveLength(3);
    for (const [harness, target] of entries) {
      const action = planInstruction(harness, true);
      expect({ harness, kind: action.kind, target: action.target }).toEqual({
        harness,
        kind: 'scaffold',
        target,
      });
      expect(getActionContent(action)).toContain('AGENTS.md');
    }
    expect(getActionContent(planInstruction('claude-code', true))).toBe(CLAUDE_INSTRUCTION_CONTENT);
  });
});
