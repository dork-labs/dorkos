import { describe, expect, it } from 'vitest';
import { countIn, lowered, type Counts } from '../check-design-tokens.ts';
import { compare } from '../design-tokens/compare.ts';

const CLIENT = 'apps/client/src/layers/features/thing/ui/Thing.tsx';
const LUCIDE = "import { Plus, X as CloseGlyph } from 'lucide-react';\n";

/** One file's counts in the shape `measure` returns for a tree. */
function measured(text: string): Counts {
  return Object.fromEntries(
    Object.entries(countIn(CLIENT, text)).map(([rule, n]) => [rule, { [CLIENT]: n }])
  );
}

describe('the text floor (design-review §2.2)', () => {
  it('refuses a literal size under 12px, with or without a variant', () => {
    const text = `'text-[9px] text-[11px] md:text-[10px] text-[11.5px] text-[.5px]'`;
    expect(countIn(CLIENT, text)).toEqual({ 'text-under-floor': 5 });
    expect(compare(measured(text), {})[0]).toMatchObject({ kind: 'hard', count: 5 });
  });

  it('leaves the floor, sizes above it, the tokens and the zero-size hide alone', () => {
    const text = `'text-[12px] text-[13px] text-[100px] text-3xs text-2xs text-[0px] text-[1rem]'`;
    expect(countIn(CLIENT, text)).toEqual({});
  });
});

describe('raw icon sizes (design-review §3.2)', () => {
  const icons = (jsx: string) => countIn(CLIENT, LUCIDE + jsx)['raw-icon-size'] ?? 0;

  it.each([
    ['a lucide icon', '<Plus className="size-4" />', 1],
    ['an aliased lucide icon', '<CloseGlyph className="size-3.5" />', 1],
    ['an h and w pair', '<Plus className="h-4 w-4" />', 1],
    ['a size prop', '<Plus size={16} />', 1],
    ['an <svg>', '<svg className="size-5" viewBox="0 0 24 24" />', 1],
    ['an icon in a variable', '<Icon className="size-4" />', 1],
    ['an icon on an object', '<item.icon className="size-4" />', 1],
    ['an arrow before the class', '<Plus onClick={() => go({ a: 1 })} className="size-4" />', 1],
    [
      'an icon inside a prop',
      '<Button icon={<Plus className="size-4" />} className="size-8" />',
      1,
    ],
    ['one icon with two raw sizes', '<Plus className="size-5 md:size-4" />', 1],
    ['the size token', '<Plus className="size-(--size-icon-sm)" />', 0],
    ['a box that is not an icon', '<div className="size-4"><Plus /></div>', 0],
    ['a height alone, or min sizes', '<Plus className="h-4 min-h-4 min-w-4" />', 0],
    ['a glyph not from lucide', '<Avatar className="size-4" />', 0],
  ])('%s', (_name, jsx, expected) => {
    expect(icons(jsx)).toBe(expected);
  });

  it('may only fall: a rise fails, a drop asks for an update that lowers it', () => {
    const baseline = { 'raw-icon-size': { [CLIENT]: 2 } };
    const at = (jsx: string) => measured(LUCIDE + jsx);
    const two = '<Plus className="size-4" /><CloseGlyph className="size-4" />';
    expect(compare(at(two), baseline)).toEqual([]);
    expect(compare(at(`${two}<Plus className="h-3 w-3" />`), baseline)[0]).toMatchObject({
      kind: 'grew',
      count: 3,
    });
    const one = at('<Plus className="size-4" /><CloseGlyph className="size-(--size-icon-sm)" />');
    expect(compare(one, baseline)[0]).toMatchObject({ kind: 'stale', count: 1 });
    expect(lowered(one, baseline)).toEqual({ 'raw-icon-size': { [CLIENT]: 1 } });
  });
});
