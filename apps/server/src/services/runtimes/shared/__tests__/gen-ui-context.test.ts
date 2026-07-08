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

  it('summarizes the catalog and includes both worked examples', () => {
    for (const type of ['stack', 'card', 'stat', 'table', 'list', 'chart', 'form']) {
      expect(GEN_UI_CONTEXT).toContain(type);
    }
    // The stat-card and table examples both appear as fenced blocks.
    expect(GEN_UI_CONTEXT.match(/```dorkos-ui/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('stays compact — it rides the cacheable prefix on every turn', () => {
    expect(GEN_UI_CONTEXT.length).toBeLessThan(2500);
  });
});
