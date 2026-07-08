import { describe, it, expect } from 'vitest';
import { parseWidget } from '../model/parse-widget';

describe('parseWidget', () => {
  it('returns ok for a valid document', () => {
    const result = parseWidget(
      JSON.stringify({ version: 1, root: { type: 'text', text: 'hello' } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.root.type).toBe('text');
  });

  it('returns an error for malformed JSON', () => {
    const result = parseWidget('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toBe('{ not json');
  });

  it('returns an error for an unknown node type', () => {
    const result = parseWidget(JSON.stringify({ version: 1, root: { type: 'blink' } }));
    expect(result.ok).toBe(false);
  });

  it('returns an error for a wrong-version document', () => {
    const result = parseWidget(JSON.stringify({ version: 9, root: { type: 'divider' } }));
    expect(result.ok).toBe(false);
  });
});
