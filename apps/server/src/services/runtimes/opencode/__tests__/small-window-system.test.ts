/**
 * @vitest-environment node
 *
 * DOR-2839 (FB-55): on a small model, DorkOS's own system text is trimmed in the
 * stated order, and the safety boundaries and working rules never are.
 */
import { describe, it, expect } from 'vitest';
import { buildOpenCodeSystem } from '../messaging/turn-input.js';
import type { ContextPart } from '../../shared/window/context-fit.js';

const parts: ContextPart[] = [
  { block: null, text: '<agent_safety_boundaries>\nNever push.\n</agent_safety_boundaries>' },
  { block: null, text: '<working_rules>\nAsk first.\n</working_rules>' },
  { block: 'dorkos_areas', text: `<dorkos_areas>\n${'a'.repeat(8_000)}\n</dorkos_areas>` },
  { block: 'agent_memory', text: `<agent_memory>\n${'m'.repeat(2_000)}\n</agent_memory>` },
];

describe('buildOpenCodeSystem on a small window', () => {
  it('sends everything when the window is large or unknown', () => {
    for (const system of [
      buildOpenCodeSystem(undefined, parts),
      buildOpenCodeSystem(undefined, parts, 200_000),
    ]) {
      expect(system).toContain('<gen_ui>');
      expect(system).toContain('<dorkos_areas>');
      expect(system).not.toContain('<small_window>');
    }
  });

  it('leaves out the widget guide, then the areas list, and keeps the rules', () => {
    const system = buildOpenCodeSystem(
      { systemPromptAppend: 'Run the nightly report.' },
      parts,
      8_192
    );
    expect(system).not.toContain('<gen_ui>');
    expect(system).not.toContain('<dorkos_areas>');
    expect(system).toContain('<small_window>');
    expect(system).toContain('<agent_memory>');
    expect(system).toContain('<agent_safety_boundaries>');
    expect(system).toContain('<working_rules>');
    expect(system).toContain('Run the nightly report.');
  });

  it('still takes the context as one string', () => {
    expect(buildOpenCodeSystem(undefined, '<env>\nx\n</env>', 200_000)).toContain('<env>');
  });
});
