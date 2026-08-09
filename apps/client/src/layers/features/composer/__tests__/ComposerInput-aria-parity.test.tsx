// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ComposerInput, type ComposerInputProps } from '../ui/ComposerInput';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

/** Every `aria-*` attribute on an element, plus its role, as a plain map. */
function ariaMap(element: Element): Record<string, string> {
  const map: Record<string, string> = { role: element.getAttribute('role') ?? '' };
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.startsWith('aria-')) map[attribute.name] = attribute.value;
  }
  return map;
}

/** Render one field and return its accessibility map. */
async function mapFor(props: Partial<ComposerInputProps>, richText: boolean) {
  const { container, unmount } = render(
    <ComposerInput
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      isStreaming={false}
      {...props}
      richText={richText}
    />
  );

  const selector = richText ? '[contenteditable="true"]' : 'textarea';
  await waitFor(() => expect(container.querySelector(selector)).not.toBeNull(), {
    timeout: 10_000,
  });
  const element = container.querySelector(selector)!;
  const map = ariaMap(element);
  // The textarea's placeholder is a native attribute; the contenteditable has
  // no such thing and must say it in ARIA. Captured under one name so the two
  // can be compared as equivalents rather than excused as a difference.
  const placeholder = richText
    ? (element.getAttribute('aria-placeholder') ?? '')
    : (element.getAttribute('placeholder') ?? '');
  unmount();
  return { map, placeholder };
}

/**
 * The two fields must be indistinguishable to assistive technology.
 *
 * Two attributes are intended additions on the rich field, and both exist
 * because a `contenteditable` div has to say in ARIA what a `<textarea>` gets
 * from being a form control:
 *
 * - `aria-multiline` — a textarea is multiline by definition.
 * - `aria-placeholder` — a textarea has a native `placeholder` attribute. This
 *   is not waved through: the assertion below checks the two carry the SAME
 *   text, so they are equivalents rather than a gap.
 *
 * Everything else must match value for value. A difference here is a real a11y
 * regression, not a swap, and it would otherwise be lost inside a large DOM
 * diff.
 */
const INTENDED_RICH_TEXT_ONLY = ['aria-multiline', 'aria-placeholder'];

describe('the two fields are the same control to a screen reader', () => {
  it.each([
    ['at rest', {}],
    [
      'with a palette open',
      { isPaletteOpen: true, paletteListboxId: 'lb-1', activeDescendantId: 'opt-2' },
    ],
    ['with a custom placeholder', { placeholder: 'Reply in this thread…' }],
    ['with an overlay placeholder', { placeholderOverlay: <span>hint</span> }],
  ])('%s', async (_label, props) => {
    const plain = await mapFor(props, false);
    const rich = await mapFor(props, true);

    // The placeholder text itself must be identical, however each field spells
    // the attribute.
    expect(rich.placeholder).toBe(plain.placeholder);

    expect(rich.map['aria-multiline']).toBe('true');
    for (const key of INTENDED_RICH_TEXT_ONLY) delete rich.map[key];

    expect(rich.map).toEqual(plain.map);
  });
});
