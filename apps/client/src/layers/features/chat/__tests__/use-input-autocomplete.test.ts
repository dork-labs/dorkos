// @vitest-environment jsdom
/**
 * `useInputAutocomplete` — the two palette signals the composer keys off.
 *
 * `isPaletteOpen` means "a panel is on screen", which stays true for the "No
 * commands found." state. `paletteHasResults` means "there is a row to pick",
 * which is the only thing Enter may be taken away from the send path for.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInputAutocomplete } from '../model/use-input-autocomplete';
import type { PaletteCommandEntry } from '@/layers/entities/command';
import type { FileEntry } from '@/layers/shared/lib';

const COMMANDS = [
  { name: 'daily', fullCommand: '/daily', description: 'The daily note', source: 'user' },
] as unknown as PaletteCommandEntry[];

const FILES: FileEntry[] = [
  { path: 'src/main.tsx', filename: 'main.tsx', directory: 'src', isDirectory: false },
];

/** Drive the hook the way Composer.Input does: type into it, then read the signals. */
function typeInto(text: string) {
  const { result } = renderHook(() =>
    useInputAutocomplete({
      input: '',
      setInput: vi.fn(),
      commands: COMMANDS,
      fileEntries: FILES,
    })
  );
  act(() => result.current.handleInputChange(text));
  return result;
}

describe('useInputAutocomplete', () => {
  it('reports results for a command query that matches', () => {
    const result = typeInto('/dai');
    expect(result.current.isPaletteOpen).toBe(true);
    expect(result.current.paletteHasResults).toBe(true);
  });

  it('reports NO results for a command query that matches nothing', () => {
    // The panel is still up — it reads "No commands found." — but there is
    // nothing for Enter to select, so the composer must send instead.
    const result = typeInto('/zzz');
    expect(result.current.isPaletteOpen).toBe(true);
    expect(result.current.paletteHasResults).toBe(false);
  });

  it('reports results for a file query that matches', () => {
    const result = typeInto('@main');
    expect(result.current.isPaletteOpen).toBe(true);
    expect(result.current.paletteHasResults).toBe(true);
  });

  it('reports NO results for a file query that matches nothing', () => {
    const result = typeInto('@zzz');
    expect(result.current.isPaletteOpen).toBe(true);
    expect(result.current.paletteHasResults).toBe(false);
  });

  it('reports neither open nor results for ordinary prose', () => {
    const result = typeInto('just a message');
    expect(result.current.isPaletteOpen).toBe(false);
    expect(result.current.paletteHasResults).toBe(false);
  });
});
