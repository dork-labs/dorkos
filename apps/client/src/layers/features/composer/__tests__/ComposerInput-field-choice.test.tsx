// @vitest-environment jsdom
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
