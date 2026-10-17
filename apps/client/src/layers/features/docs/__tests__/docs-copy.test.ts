/**
 * The small pieces live docs draw with (DOR-2984): cursor colours in the one
 * spelling live cursors accept, and the quiet presence and change lines.
 */
import { describe, expect, it } from 'vitest';
import { FALLBACK_COLLABORATOR_COLOR, toHexColor } from '../lib/collaborator-color';
import { changeLine, presenceLine } from '../lib/presence-copy';

describe('toHexColor', () => {
  it('keeps hex, expands short hex, and converts hsl', () => {
    expect(toHexColor('#3366CC')).toBe('#3366cc');
    expect(toHexColor('#36c')).toBe('#3366cc');
    expect(toHexColor('hsl(0, 100%, 50%)')).toBe('#ff0000');
    expect(toHexColor('hsl(120 100% 25%)')).toBe('#008000');
    expect(toHexColor('hsl(210deg, 50%, 40%)')).toBe('#336699');
  });

  it('falls back for anything else', () => {
    expect(toHexColor('var(--brand)')).toBe(FALLBACK_COLLABORATOR_COLOR);
  });
});

describe('presence and change lines', () => {
  it('names who else is here, briefly', () => {
    expect(presenceLine([])).toBeNull();
    expect(presenceLine(['Sam'])).toBe('Sam is here');
    expect(presenceLine(['Sam', 'Lee'])).toBe('Sam and Lee are here');
    expect(presenceLine(['Sam', 'Lee', 'Kai'])).toBe('Sam and 2 others are here');
  });

  it('says who changed the doc from outside the editor', () => {
    expect(changeLine({ kind: 'agent', name: 'Ada' })).toBe('Ada changed this doc');
    expect(changeLine({ kind: 'agent' })).toBe('An agent changed this doc');
    expect(changeLine({ kind: 'disk' })).toBe('Updated from the file on disk');
  });
});
