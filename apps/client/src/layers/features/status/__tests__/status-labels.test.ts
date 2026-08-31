import { describe, it, expect } from 'vitest';
import type { ModelOption } from '@dorkos/shared/types';
import { STATUS_VALUE_MAX_CHARS } from '@dorkos/shared/constants';
import { RUNTIME_DESCRIPTORS } from '@/layers/entities/runtime';
import { compactStatusValue, statusModelLabel } from '../lib/status-labels';

/** The catalog shape the model picker hands the status line. */
function option(value: string, displayName: string): ModelOption {
  return { value, displayName, description: `${displayName} description` };
}

const CATALOG: ModelOption[] = [
  option('default', 'Default (recommended)'),
  option('opus[1m]', 'Opus'),
  option('sonnet', 'Sonnet'),
  option('ollama/qwen2.5-coder', 'Qwen 2.5 Coder'),
];

describe('compactStatusValue', () => {
  it('leaves a value that already fits exactly as it is', () => {
    // `GPT-5.3 Codex` is the longest name DorkOS's own catalogs carry, and it is
    // here because it must survive untouched: an ellipsis on a first-party model
    // name at full desktop width is a bug in the bound, not a budget working.
    for (const value of [
      '78%',
      '$1.24',
      'Plan Mode',
      'Reconnecting',
      'Claude Code',
      'GPT-5.3 Codex',
    ]) {
      expect(compactStatusValue(value)).toBe(value);
    }
  });

  it('marks the cut with an ellipsis so a shortened value never reads as the whole value', () => {
    expect(compactStatusValue('Bypass every permission check')).toBe('Bypass every…');
  });

  it('never returns more characters than the bound, whatever it is handed', () => {
    // The bound exists for strings DorkOS does not write — a runtime's own
    // permission-mode descriptor, a provider's model name. One verbose third-party
    // string must not be able to spend the whole bar.
    for (const value of ['x'.repeat(200), 'A very long descriptive mode name', '🙂'.repeat(40)]) {
      expect(Array.from(compactStatusValue(value)).length).toBeLessThanOrEqual(
        STATUS_VALUE_MAX_CHARS
      );
    }
  });

  it('cuts by character, not by UTF-16 unit — half an emoji is a replacement glyph', () => {
    expect(compactStatusValue('🙂'.repeat(40))).toBe(`${'🙂'.repeat(12)}…`);
  });

  it('does not leave a dangling space before the ellipsis', () => {
    expect(compactStatusValue('Full access to everything')).toBe('Full access…');
  });
});

describe('statusModelLabel', () => {
  it('drops the picker parenthetical — "recommended" is advice for choosing, not status', () => {
    expect(statusModelLabel('default', CATALOG)).toBe('Default');
  });

  it('leaves a name that is already a name alone', () => {
    expect(statusModelLabel('opus[1m]', CATALOG)).toBe('Opus');
    expect(statusModelLabel('sonnet', CATALOG)).toBe('Sonnet');
  });

  it('drops a trailing detail clause after a middot', () => {
    expect(statusModelLabel('m', [option('m', 'Opus · 1M context')])).toBe('Opus');
  });

  it('names a Claude model the catalog no longer offers by its family', () => {
    expect(statusModelLabel('claude-unknown-1', CATALOG)).toBe('Unknown');
  });

  it('drops the provider half of an id the catalog no longer offers', () => {
    expect(statusModelLabel('ollama/qwen-coder', [])).toBe('qwen-coder');
  });

  it('shows the raw id rather than nothing when it can say nothing else', () => {
    expect(statusModelLabel('gpt-4o', [])).toBe('gpt-4o');
  });

  it('bounds a catalog display name it cannot shorten', () => {
    const long = option('x', 'Extremely Verbose Model Name');
    expect(statusModelLabel('x', [long]).length).toBeLessThanOrEqual(STATUS_VALUE_MAX_CHARS);
  });

  it('says "Default" for the sentinel even before the catalog has answered (adversarial review)', () => {
    // The cold-catalog window: `options` is empty while the read is still in
    // flight, so the lookup that turns `'default'` into "Default" elsewhere in
    // this file never runs. `formatModelLabel` treats the sentinel as
    // unresolved and returns `null` (DOR-1279) — which used to fall through to
    // the raw wire value here, resurfacing the literal word "default" the
    // catalog-loaded case never shows.
    expect(statusModelLabel('default', [])).toBe('Default');
  });
});

describe('the compactness invariant the slot budget rests on', () => {
  // The budget counts slots, so a count is only honest while every slot is about
  // one size. These are the label sources DorkOS itself authors: they must fit the
  // bound outright, or the budget is over-promising before a third party is even
  // involved. See features/status/model/status-budget.
  //
  // The model half of this invariant is asserted where the catalogs live —
  // `apps/server/.../runtimes/__tests__/model-catalog-labels.test.ts` — because a
  // fixture written in this file could only ever fail if someone edited the
  // fixture, which is no invariant at all.
  it('keeps every runtime display label within the bound', () => {
    for (const descriptor of Object.values(RUNTIME_DESCRIPTORS)) {
      expect(descriptor.label.length).toBeLessThanOrEqual(STATUS_VALUE_MAX_CHARS);
    }
  });
});
