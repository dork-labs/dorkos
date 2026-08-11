import { describe, it, expect } from 'vitest';
import type { SmartGroupCandidate } from '@dorkos/shared/smart-groups';
import { offersGroupAffordances } from '../rules/build-library-sections';
import { activeNowPreset, byRuntimePresets } from '../smart-group-presets';

function candidate(overrides: Partial<SmartGroupCandidate> = {}): SmartGroupCandidate {
  return {
    projectPath: '/a',
    runtime: 'claude-code',
    namespace: null,
    attention: 'active',
    lastActivityAt: null,
    ...overrides,
  };
}

// The presets used to carry their own copy of this gate
// (`meetsSmartGroupDisclosureThreshold`, eight agents or two runtimes).
// `offersGroupAffordances` is the same predicate over the same numbers, and
// since P2.4 both are asked by the one New menu about the one "Agent group"
// item — so the copy is gone and the cases below moved onto the survivor.
describe('the gate the presets appear behind', () => {
  it('is false for a small, single-runtime fleet', () => {
    const candidates = Array.from({ length: 3 }, (_, i) => candidate({ projectPath: `/${i}` }));
    expect(offersGroupAffordances(candidates)).toBe(false);
  });

  it('is true once the fleet reaches 8 agents, even with one runtime', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => candidate({ projectPath: `/${i}` }));
    expect(offersGroupAffordances(candidates)).toBe(true);
  });

  it('is true with 2+ distinct runtimes regardless of fleet size', () => {
    const candidates = [
      candidate({ projectPath: '/a', runtime: 'codex' }),
      candidate({ projectPath: '/b', runtime: 'claude-code' }),
    ];
    expect(offersGroupAffordances(candidates)).toBe(true);
  });

  it('is false just under both thresholds', () => {
    const candidates = Array.from({ length: 7 }, (_, i) => candidate({ projectPath: `/${i}` }));
    expect(offersGroupAffordances(candidates)).toBe(false);
  });
});

describe('activeNowPreset', () => {
  it('matches needs-attention and active states', () => {
    expect(activeNowPreset()).toEqual({
      label: 'Active now',
      rules: { statuses: ['needs-attention', 'active'] },
    });
  });
});

describe('byRuntimePresets', () => {
  it('offers one chip per runtime with >= 2 agents, ordered by count then label', () => {
    const candidates = [
      candidate({ projectPath: '/a', runtime: 'codex' }),
      candidate({ projectPath: '/b', runtime: 'codex' }),
      candidate({ projectPath: '/c', runtime: 'codex' }),
      candidate({ projectPath: '/d', runtime: 'opencode' }),
      candidate({ projectPath: '/e', runtime: 'opencode' }),
      candidate({ projectPath: '/f', runtime: 'claude-code' }), // solo — excluded
    ];
    expect(byRuntimePresets(candidates)).toEqual([
      { label: 'By runtime · Codex', rules: { runtimes: ['codex'] } },
      { label: 'By runtime · OpenCode', rules: { runtimes: ['opencode'] } },
    ]);
  });

  it('returns no presets when every runtime has only one agent', () => {
    const candidates = [
      candidate({ projectPath: '/a', runtime: 'codex' }),
      candidate({ projectPath: '/b', runtime: 'opencode' }),
    ];
    expect(byRuntimePresets(candidates)).toEqual([]);
  });

  it('breaks a count tie by runtime label', () => {
    const candidates = [
      candidate({ projectPath: '/a', runtime: 'opencode' }),
      candidate({ projectPath: '/b', runtime: 'opencode' }),
      candidate({ projectPath: '/c', runtime: 'codex' }),
      candidate({ projectPath: '/d', runtime: 'codex' }),
    ];
    expect(byRuntimePresets(candidates).map((p) => p.label)).toEqual([
      'By runtime · Codex',
      'By runtime · OpenCode',
    ]);
  });
});
