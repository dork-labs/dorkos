/**
 * ⌘K's remote-access rows, which exist only when they would do something.
 *
 * Every other palette row is registered once at startup and offered forever.
 * These four are not, and the difference is deliberate: "Copy remote link" with
 * no tunnel running is a row that can only disappoint, and a palette that
 * offers dead ends is one people stop trusting. So the set is derived from what
 * remote access is actually doing (DOR-1743).
 *
 * @module features/command-palette/model/palette-remote-access
 */

import { useMemo } from 'react';
import type { CommandPaletteContribution } from '@/layers/shared/model';
import { useRemoteAccessSnapshot } from '@/layers/entities/tunnel';

/**
 * The action ids `usePaletteActions` dispatches on. Named constants rather than
 * loose strings, because the row and its handler live in different files and a
 * typo between them is a row that closes the palette and does nothing.
 */
export const REMOTE_ACCESS_PALETTE_ACTIONS = {
  copyLink: 'copyRemoteLink',
  showQr: 'showRemoteQr',
  turnOn: 'turnRemoteAccessOn',
  turnOff: 'turnRemoteAccessOff',
} as const;

/** Sorted after the ten built-in quick actions, in the order they are useful. */
const PRIORITY = { copyLink: 11, showQr: 12, turnOff: 13, turnOn: 11 } as const;

/**
 * The remote-access rows ⌘K should be offering right now.
 *
 * @param state - What remote access is doing.
 * @param url - Its public address, if it has one.
 * @param tokenConfigured - Whether the one-time ngrok setup is done.
 * @returns Zero, one, or three rows.
 */
export function remoteAccessPaletteItems(
  state: string,
  url: string | null,
  tokenConfigured: boolean
): CommandPaletteContribution[] {
  // Reachable, and with an address to hand over. `starting` deliberately offers
  // nothing: there is no link to copy yet, and a row that copies `null` is
  // worse than no row.
  if ((state === 'connected' || state === 'reconnecting') && url) {
    return [
      {
        id: 'remote-access-copy',
        label: 'Copy remote link',
        icon: 'Copy',
        action: REMOTE_ACCESS_PALETTE_ACTIONS.copyLink,
        category: 'quick-action',
        priority: PRIORITY.copyLink,
        keywords: ['remote', 'tunnel', 'url', 'address', 'phone', 'share'],
      },
      {
        id: 'remote-access-qr',
        label: 'Show QR code',
        icon: 'QrCode',
        action: REMOTE_ACCESS_PALETTE_ACTIONS.showQr,
        category: 'quick-action',
        priority: PRIORITY.showQr,
        keywords: ['remote', 'tunnel', 'scan', 'phone'],
      },
      {
        id: 'remote-access-off',
        label: 'Turn remote access off',
        icon: 'Globe',
        action: REMOTE_ACCESS_PALETTE_ACTIONS.turnOff,
        category: 'quick-action',
        priority: PRIORITY.turnOff,
        keywords: ['remote', 'tunnel', 'ngrok', 'stop', 'disconnect'],
      },
    ];
  }

  // Set up but not running — including after a failed start, where turning it
  // on again IS the retry.
  if (tokenConfigured && (state === 'off' || state === 'error')) {
    return [
      {
        id: 'remote-access-on',
        label: 'Turn remote access on',
        icon: 'Globe',
        action: REMOTE_ACCESS_PALETTE_ACTIONS.turnOn,
        category: 'quick-action',
        priority: PRIORITY.turnOn,
        keywords: ['remote', 'tunnel', 'ngrok', 'phone', 'start'],
      },
    ];
  }

  // Nothing set up yet, or mid-transition. Setting remote access up is a
  // one-time task with its own screen; ⌘K is not where it belongs.
  return [];
}

/**
 * The remote-access rows, ready to merge into the palette's quick actions.
 *
 * Reads the shared STORE rather than the config query. ⌘K's corpus is
 * assembled on every keystroke and mounted in shells that have no tunnel at
 * all, so it takes no data dependency of its own — the app shell's
 * `useTunnelSync` is what keeps the store current.
 *
 * @returns A stable array while remote access holds still.
 */
export function useRemoteAccessPaletteItems(): CommandPaletteContribution[] {
  const { state, url, tokenConfigured } = useRemoteAccessSnapshot();
  return useMemo(
    () => remoteAccessPaletteItems(state, url, tokenConfigured),
    [state, url, tokenConfigured]
  );
}
