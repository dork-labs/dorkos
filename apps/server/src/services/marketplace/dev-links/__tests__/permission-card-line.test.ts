import { describe, expect, it } from 'vitest';
import type { ApprovedPermissionSet } from '@dorkos/shared/config-schema';
import { describePermissionSet, parsePermissionSet } from '../permission-card-line.js';

const SEPARATE: ApprovedPermissionSet = {
  runtime: 'subprocess',
  net: ['api.example.com'],
  run: ['git'],
  agents: true,
  slots: ['command-palette.items', 'pages'],
};

describe('describePermissionSet', () => {
  // Purpose: the card names places in DorkOS's words, never raw keys (DOR-4282).
  it('names places in plain words, in card order', () => {
    expect(describePermissionSet(SEPARATE, true)).toBe(
      'runs separately; connects to api.example.com; runs git; messages your agents; shows in a page, ⌘K commands'
    );
    expect(
      describePermissionSet(
        { runtime: 'in-process', net: [], run: [], agents: false, slots: ['dialog'] },
        false
      )
    ).toBe('only screens; shows in dialogs');
  });

  it('leaves out unknown keys and an empty list', () => {
    expect(
      describePermissionSet(
        { runtime: 'in-process', net: [], run: [], agents: false, slots: ['made-up'] },
        true
      )
    ).toBe('runs inside DorkOS with full access to this computer');
  });
});

describe('parsePermissionSet', () => {
  // Purpose: the line reads back to the keys it was written from.
  it('reads its own line back into keys', () => {
    const line = describePermissionSet(SEPARATE, true);
    expect(parsePermissionSet(line)).toEqual({
      ...SEPARATE,
      slots: ['pages', 'command-palette.items'],
    });
    expect(describePermissionSet(parsePermissionSet(line)!, true)).toBe(line);
  });

  it('reads a line with no places as no places', () => {
    expect(parsePermissionSet('only screens')?.slots).toEqual([]);
  });

  it('refuses words it does not write', () => {
    expect(parsePermissionSet('only screens; shows in pages')).toBeNull();
    expect(
      parsePermissionSet('runs separately; no internet; shows in a page, a portal')
    ).toBeNull();
  });
});
