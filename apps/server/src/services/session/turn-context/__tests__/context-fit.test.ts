import { describe, expect, it } from 'vitest';
import {
  CONTEXT_TRIM_ORDER,
  chooseTrims,
  dorkosContextBudget,
  fitItemOf,
  joinFitted,
  type ContextPart,
} from '../context-fit.js';

// DOR-2839 (FB-55): DorkOS's own share filled a 32k model's window.
describe('chooseTrims', () => {
  const parts: ContextPart[] = [
    { block: 'gen_ui', text: 'g'.repeat(4000) },
    { block: null, text: '<agent_safety_boundaries>never</agent_safety_boundaries>' },
    { block: 'dorkos_areas', text: 'a'.repeat(4000) },
    { block: null, text: '<working_rules>ask first</working_rules>' },
    { block: 'agent_memory', text: 'm'.repeat(4000) },
  ];
  const items = parts.map((part) => ({ block: part.block, chars: part.text.length }));

  it('leaves nothing out when the window is unknown or large', () => {
    expect(chooseTrims(items, undefined).dropped).toEqual([]);
    expect(chooseTrims(items, dorkosContextBudget(128_000, 8_192)).dropped).toEqual([]);
  });

  it('leaves blocks out in the stated order, and only as many as it must', () => {
    // 12,094 chars ≈ 3,024 tokens; a 2,100-token budget needs one 1,000-token block gone.
    const fit = chooseTrims(items, 2_100);
    expect(fit.dropped).toEqual(['gen_ui']);
    expect(fit.fits).toBe(true);
    expect(chooseTrims(items, 1_100).dropped).toEqual(['gen_ui', 'dorkos_areas']);
  });

  it('never leaves out the safety boundaries or the working rules, and says when it cannot fit', () => {
    const fit = chooseTrims(items, 1);
    expect(fit.dropped).toEqual(['gen_ui', 'dorkos_areas', 'agent_memory']);
    expect(fit.fits).toBe(false);
    const text = joinFitted(parts, fit.dropped);
    expect(text).toContain('<agent_safety_boundaries>');
    expect(text).toContain('<working_rules>');
    expect(text).not.toContain('ggg');
  });

  it('tells the agent what was left out', () => {
    const text = joinFitted(parts, ['gen_ui', 'agent_memory']);
    expect(text.startsWith('<small_window>')).toBe(true);
    expect(text).toContain('the widget guide; your saved memory');
    expect(joinFitted(parts, [])).not.toContain('<small_window>');
  });

  it('keeps memory last, after everything else that may go', () => {
    expect(CONTEXT_TRIM_ORDER.at(-1)).toBe('agent_memory');
    expect(CONTEXT_TRIM_ORDER).not.toContain('agent_safety_boundaries');
    expect(CONTEXT_TRIM_ORDER).not.toContain('working_rules');
  });
});

// DOR-3515: a block's guard lines stay in its place when the block is left out.
describe('a part with kept lines', () => {
  const parts: ContextPart[] = [
    {
      block: 'dorkos_context',
      text: `<dorkos_context>\n${'o'.repeat(4000)}\nNever run a bare dorkos.\n</dorkos_context>`,
      kept: '<dorkos_context>\nNever run a bare dorkos.\n</dorkos_context>',
    },
  ];

  it('renders the whole block when it fits, and only the kept lines when it does not', () => {
    expect(joinFitted(parts, [])).toContain('oooo');
    const left = joinFitted(parts, ['dorkos_context']);
    expect(left).toContain('Never run a bare dorkos.');
    expect(left).not.toContain('oooo');
  });

  it('counts only what leaving it out actually frees', () => {
    const fit = chooseTrims(parts.map(fitItemOf), 1);
    expect(fit.dropped).toEqual(['dorkos_context']);
    expect(fit.tokens).toBe(Math.ceil(parts[0]!.kept!.length / 4));
  });
});

describe('dorkosContextBudget', () => {
  it('is a quarter of what the model can read', () => {
    expect(dorkosContextBudget(32_768, 4_096)).toBe(7_168);
    expect(dorkosContextBudget(4_096, 8_192)).toBe(0);
  });
});
