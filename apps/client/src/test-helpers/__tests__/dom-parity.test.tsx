// @vitest-environment jsdom
/**
 * What the DOM-parity harness can and cannot see.
 *
 * This file is the reason the parity proofs downstream are worth anything. A
 * check that cannot fail is worse than no check, and the whole harness is one
 * long normalization — every rule it applies is a way for a real regression to
 * become invisible. So each rule is pinned from BOTH sides: the thing it is
 * supposed to forgive stays green, and the nearest thing it must NOT forgive
 * goes red.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { useId } from 'react';
import { serializeDom, diffDom, formatDomDiff, matchDomBaseline } from '../dom-parity';

/** Parse an HTML string into a detached root element, ready to serialize. */
function html(markup: string): Element {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

/** Serialize two HTML strings and diff them. */
function diffHtml(before: string, after: string) {
  return diffDom(serializeDom(html(before)), serializeDom(html(after)));
}

describe('dom-parity — class attributes compare as token sets', () => {
  it('forgives a reordered class string', () => {
    // The exact thing `cn()` does when a className moves from a caller into a
    // wrapper: same tokens, different order, identical pixels.
    const diff = diffHtml(
      '<div class="chat-input-container bg-surface relative m-2 rounded-xl border p-2"></div>',
      '<div class="bg-surface relative m-2 rounded-xl border p-2 chat-input-container"></div>'
    );
    expect(formatDomDiff(diff)).toBe('');
  });

  it('forgives duplicate tokens and irregular whitespace', () => {
    const diff = diffHtml(
      '<div class="p-2  border   p-2"></div>',
      '<div class="border p-2"></div>'
    );
    expect(formatDomDiff(diff)).toBe('');
  });

  it('reports a single ADDED class token', () => {
    const diff = diffHtml(
      '<div class="relative border-t p-3"></div>',
      '<div class="relative border-t p-3 m-2"></div>'
    );
    expect(diff).toEqual([
      { path: 'div > div', kind: 'class-added', detail: 'class token "m-2" added' },
    ]);
  });

  it('reports a single REMOVED class token', () => {
    // The one that matters most for chat: losing `chat-input-container` breaks a
    // safe-area rule in index.css that no rendered attribute would reveal.
    const diff = diffHtml(
      '<div class="chat-input-container bg-surface p-2"></div>',
      '<div class="bg-surface p-2"></div>'
    );
    expect(diff).toEqual([
      {
        path: 'div > div',
        kind: 'class-removed',
        detail: 'class token "chat-input-container" removed',
      },
    ]);
  });
});

describe('dom-parity — structure compares literally', () => {
  it('reports reordered sibling elements', () => {
    // The mention picker sitting above vs below the clear-armed hint is exactly
    // this shape, and it is a real visual change.
    const diff = diffHtml(
      '<div><span data-testid="picker"></span><p data-testid="hint"></p></div>',
      '<div><p data-testid="hint"></p><span data-testid="picker"></span></div>'
    );
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((entry) => entry.kind === 'tag')).toBe(true);
  });

  it('reports reordered siblings even when the tags match', () => {
    const diff = diffHtml(
      '<div><div data-testid="a"></div><div data-testid="b"></div></div>',
      '<div><div data-testid="b"></div><div data-testid="a"></div></div>'
    );
    expect(diff.map((entry) => entry.kind)).toEqual(['attr-changed', 'attr-changed']);
  });

  it('reports a changed placeholder', () => {
    const diff = diffHtml(
      '<textarea placeholder="Message DorkBot…"></textarea>',
      '<textarea placeholder="Send a message..."></textarea>'
    );
    expect(diff).toEqual([
      {
        path: 'div > textarea',
        kind: 'attr-changed',
        detail: 'attribute placeholder: "Message DorkBot…" -> "Send a message..."',
      },
    ]);
  });

  it('reports a changed aria-label', () => {
    const diff = diffHtml(
      '<button aria-label="Clear message"></button>',
      '<button aria-label="Clear"></button>'
    );
    expect(diff).toEqual([
      {
        path: 'div > button',
        kind: 'attr-changed',
        detail: 'attribute aria-label: "Clear message" -> "Clear"',
      },
    ]);
  });

  it('reports an added wrapper element — the dashboard`s intended delta', () => {
    const diff = diffHtml(
      '<section><p>hi</p></section>',
      '<section><div><p>hi</p></div></section>'
    );
    expect(diff).toEqual([{ path: 'div > section > p', kind: 'tag', detail: '<p> -> <div>' }]);
  });

  it('reports a removed node', () => {
    const diff = diffHtml('<div><i></i><b></b></div>', '<div><i></i></div>');
    expect(diff).toEqual([
      { path: 'div > div > b[1]', kind: 'node-removed', detail: '<b> removed' },
    ]);
  });

  it('reports changed text', () => {
    const diff = diffHtml('<h2>What are we building today?</h2>', '<h2>What next?</h2>');
    expect(diff).toEqual([
      {
        path: 'div > h2 > #text',
        kind: 'text',
        detail: 'text "What are we building today?" -> "What next?"',
      },
    ]);
  });

  it('reports a dropped attribute, including `disabled`', () => {
    const diff = diffHtml('<button disabled=""></button>', '<button></button>');
    expect(diff).toEqual([
      { path: 'div > button', kind: 'attr-removed', detail: 'attribute disabled="" removed' },
    ]);
  });
});

describe('dom-parity — generated values are placeholder-substituted', () => {
  /** A component whose ids come from `useId`, the way the palettes` do. */
  function IdConsumer() {
    const id = useId();
    return (
      <div>
        <ul id={`${id}-listbox`} />
        <textarea aria-controls={`${id}-listbox`} aria-activedescendant={`${id}-option-0`} />
      </div>
    );
  }

  it('treats two renders with different useId values as identical', () => {
    // Two mounts in one document never share a `useId` counter, so this is a
    // genuinely different pair of strings — not the same render twice.
    const first = render(<IdConsumer />);
    const second = render(<IdConsumer />);

    const firstId = first.container.querySelector('ul')!.id;
    const secondId = second.container.querySelector('ul')!.id;
    expect(firstId).not.toBe(secondId);

    const diff = diffDom(serializeDom(first.container), serializeDom(second.container));
    expect(formatDomDiff(diff)).toBe('');
  });

  it('erases only the generated fragment, so the literal suffix still compares', () => {
    const { container } = render(<IdConsumer />);
    const serialized = serializeDom(container);
    const list = JSON.stringify(serialized);
    expect(list).toContain('<useId>-listbox');
    expect(list).toContain('<useId>-option-0');

    // Same generated prefix, different literal suffix: a real difference.
    const rendered = container.querySelector('ul')!;
    const generated = rendered.id.replace('-listbox', '');
    const diff = diffHtml(
      `<ul id="${generated}-listbox"></ul>`,
      `<ul id="${generated}-menu"></ul>`
    );
    expect(diff.map((entry) => entry.kind)).toEqual(['attr-changed']);
  });

  it('erases motion transform VALUES but still reports a transform that appeared', () => {
    const forgiven = diffHtml(
      '<div style="opacity: 1; transform: translateY(4px) scale(0.98)"></div>',
      '<div style="opacity: 1; transform: translateY(0px) scale(1)"></div>'
    );
    expect(formatDomDiff(forgiven)).toBe('');

    const reported = diffHtml(
      '<div style="opacity: 1"></div>',
      '<div style="opacity: 1; transform: translateY(0px)"></div>'
    );
    expect(reported.map((entry) => entry.kind)).toEqual(['attr-changed']);
  });

  it('does not erase non-transform style values', () => {
    // `opacity` is animated too, but it is also how a component says "hidden".
    const diff = diffHtml('<div style="opacity: 1"></div>', '<div style="opacity: 0"></div>');
    expect(diff.map((entry) => entry.kind)).toEqual(['attr-changed']);
  });
});

describe('dom-parity — a missing baseline is a failure, never a recording', () => {
  it('refuses to invent a baseline it could only copy from the current code', () => {
    expect(() =>
      matchDomBaseline(import.meta.url, 'does-not-exist', serializeDom(html('<div></div>')))
    ).toThrow(/No DOM baseline at/);
  });
});
