import { describe, it, expect } from 'vitest';
import { GEN_UI_CONTEXT } from '../gen-ui-context.js';

describe('GEN_UI_CONTEXT', () => {
  it('is wrapped in a <gen_ui> tag', () => {
    expect(GEN_UI_CONTEXT.startsWith('<gen_ui>')).toBe(true);
    expect(GEN_UI_CONTEXT.trimEnd().endsWith('</gen_ui>')).toBe(true);
  });

  it('teaches the dorkos-ui fence and the version-1 document shape', () => {
    expect(GEN_UI_CONTEXT).toContain('dorkos-ui');
    expect(GEN_UI_CONTEXT).toContain('"version": 1');
  });

  it('summarizes the full catalog, including the Tier-1 utility nodes', () => {
    for (const type of [
      'stack',
      'card',
      'stat',
      'table',
      'list',
      'chart',
      'form',
      'timeline',
      'checklist',
      'compare',
      'rating',
    ]) {
      expect(GEN_UI_CONTEXT).toContain(type);
    }
    // The stat-card example appears as a fenced block.
    expect(GEN_UI_CONTEXT.match(/```dorkos-ui/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it('teaches the <ui_action> return channel the agent receives on interaction', () => {
    expect(GEN_UI_CONTEXT).toContain('<ui_action>');
    // Names the three things the agent gets back: widget, action id, payload.
    expect(GEN_UI_CONTEXT).toContain('action id');
    expect(GEN_UI_CONTEXT).toContain('payload');
  });

  it('stays compact — it rides the cacheable prefix on every turn', () => {
    // Budget ceiling: 3000 chars; current usage is ~2700 (~90%). Any addition
    // to the block requires trimming elsewhere — condense before you append.
    expect(GEN_UI_CONTEXT.length).toBeLessThanOrEqual(3000);
  });
});
