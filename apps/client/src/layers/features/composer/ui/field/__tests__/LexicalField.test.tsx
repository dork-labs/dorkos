// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { EditingSurface } from '../../editing-surface';
import { LexicalField } from '../LexicalField';

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

/** The field wired the way `ComposerInput` wires it: value follows onChange. */
function ControlledField({
  initialValue = '',
  ...props
}: Partial<Parameters<typeof LexicalField>[0]> & { initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  return (
    <LexicalField
      value={value}
      onChange={setValue}
      onKeyDown={props.onKeyDown ?? (() => {})}
      onFocus={props.onFocus ?? (() => {})}
      onBlur={props.onBlur ?? (() => {})}
      placeholder={props.placeholder ?? 'Send a message...'}
      placeholderOverlay={props.placeholderOverlay}
      isPaletteOpen={props.isPaletteOpen}
      paletteListboxId={props.paletteListboxId}
      activeDescendantId={props.activeDescendantId}
      onSurfaceChange={props.onSurfaceChange ?? (() => {})}
      onCursorChange={props.onCursorChange}
    />
  );
}

describe('LexicalField', () => {
  // apps/e2e/pages/ChatPage.ts and RoomsPage.ts both locate the composer by
  // this role and name, and use-feed-keyboard-nav's tab-stop selector matches
  // `[contenteditable="true"]` literally. All three break silently if these
  // move.
  it('is a combobox named by its placeholder, and literally contenteditable="true"', async () => {
    render(<ControlledField />);
    const field = await screen.findByRole('combobox', { name: 'Send a message...' });
    expect(field.getAttribute('contenteditable')).toBe('true');
  });

  it('carries the same ARIA attributes the textarea carries', async () => {
    render(<ControlledField isPaletteOpen paletteListboxId="lb" activeDescendantId="opt-1" />);
    const field = await screen.findByRole('combobox');

    expect(field.getAttribute('aria-autocomplete')).toBe('list');
    expect(field.getAttribute('aria-expanded')).toBe('true');
    expect(field.getAttribute('aria-controls')).toBe('lb');
    expect(field.getAttribute('aria-activedescendant')).toBe('opt-1');
    expect(field.getAttribute('aria-label')).toBe('Send a message...');
    expect(field.getAttribute('aria-multiline')).toBe('true');
  });

  it('leaves aria-controls and aria-activedescendant off while no palette is open', async () => {
    render(<ControlledField paletteListboxId="lb" activeDescendantId="opt-1" />);
    const field = await screen.findByRole('combobox');

    expect(field.getAttribute('aria-expanded')).toBe('false');
    expect(field.hasAttribute('aria-controls')).toBe(false);
    expect(field.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('caps its height at 200px and scrolls, rather than growing without bound', async () => {
    render(<ControlledField />);
    const field = await screen.findByRole('combobox');
    expect(field.className).toContain('max-h-[200px]');
    expect(field.className).toContain('overflow-y-auto');
  });

  it('renders the host overlay instead of its own placeholder when given one', async () => {
    render(<ControlledField placeholderOverlay={<span>animated hint</span>} />);
    await screen.findByRole('combobox');
    expect(screen.getByText('animated hint')).toBeInTheDocument();
    expect(screen.queryByText('Send a message...')).toBeNull();
  });

  it('hands its editing surface up once the editor exists', async () => {
    const onSurfaceChange = vi.fn();
    render(<ControlledField onSurfaceChange={onSurfaceChange} />);

    await waitFor(() => expect(onSurfaceChange).toHaveBeenCalled());
    const surface = onSurfaceChange.mock.calls[0][0] as EditingSurface;
    expect(typeof surface.textBeforeCaret).toBe('function');
    expect(typeof surface.isComposing).toBe('function');
  });

  it('shows an externally written value as text', async () => {
    render(<ControlledField initialValue="**hello**" />);
    const field = await screen.findByRole('combobox');
    await waitFor(() => expect(field.textContent).toBe('hello'));
    expect(field.querySelector('strong, b')).not.toBeNull();
  });
});
