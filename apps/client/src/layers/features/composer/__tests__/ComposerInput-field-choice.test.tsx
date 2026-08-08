// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ComposerInput } from '../ui/ComposerInput';

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

const base = { value: '', onChange: vi.fn(), onSubmit: vi.fn(), isStreaming: false };

describe('which field the composer renders', () => {
  it.each([
    ['with the flag absent', {}],
    ['with the flag off', { richText: false }],
  ])('is a textarea %s', (_label, props) => {
    const { container } = render(<ComposerInput {...base} {...props} />);

    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it('is a contenteditable with the flag on', async () => {
    const { container } = render(<ComposerInput {...base} richText />);

    // The Suspense fallback is the textarea, so the plain field is what shows
    // until the chunk lands — a composer that is briefly plain rather than
    // briefly un-typeable.
    // Generous: this is the first load of the lazy chunk in the suite, and it
    // pulls the whole editor through the transform pipeline.
    await waitFor(
      () => expect(container.querySelector('[contenteditable="true"]')).not.toBeNull(),
      {
        timeout: 10_000,
      }
    );
    expect(container.querySelector('textarea')).toBeNull();
  });

  // The exit path, and it is the reason the switch in Settings is safe to
  // offer. Both fields share `value`/`onChange` and both speak markdown, so a
  // half-written formatted message is never trapped in the editor: turning the
  // setting off puts its markdown source back in the textarea, unchanged.
  it('hands the draft back as markdown when the flag is turned off', async () => {
    /** A host that owns the draft, exactly as a real surface does. */
    function ExitHost({ richText }: { richText: boolean }) {
      const [value, setValue] = useState('**important**');
      return (
        <ComposerInput
          {...base}
          richText={richText}
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
        />
      );
    }

    const { container, rerender } = render(<ExitHost richText />);

    // With the flag on, the asterisks are consumed by the transformer — the
    // person sees the word, not the syntax.
    const field = await waitFor(
      () => {
        const el = container.querySelector('[contenteditable="true"]');
        expect(el).not.toBeNull();
        return el as HTMLElement;
      },
      { timeout: 10_000 }
    );
    await waitFor(() => expect(field.textContent).toBe('important'));
    expect(container.querySelector('textarea')).toBeNull();

    rerender(<ExitHost richText={false} />);

    // Nothing lost: the markdown source is back, character for character.
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe('**important**');
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it('keeps the same accessible name across the swap', async () => {
    const { rerender } = render(<ComposerInput {...base} />);
    expect(screen.getByRole('combobox', { name: 'Send a message...' })).toBeInTheDocument();

    rerender(<ComposerInput {...base} richText />);
    await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(screen.getByRole('combobox', { name: 'Send a message...' })).toBeInTheDocument();
  });
});
