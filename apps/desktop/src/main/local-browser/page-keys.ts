/**
 * Keyboard shortcuts from the Agent browser's native guest page (DOR-4432, spec §13).
 *
 * Only the keys a browser takes before the page do: ⌘L, ⌘R / F5 and ⌘⇧C (Ctrl off a
 * Mac). Back and Forward keys and Esc stay the page's, as in Chrome, so an editor's
 * outdent or a terminal's Ctrl+[ never navigates; they work from the panel's chrome.
 *
 * The agent input gate is defense in depth. An agent drives the page over CDP, and if
 * Chromium hands its key events to the same `before-input-event` hook, they must never
 * count as the person's. Whether it does has not been checked on real Electron; the gate
 * holds either way, because no key is forwarded while an agent's `Input.*` command runs.
 *
 * @module main/local-browser/page-keys
 */
import type { WebContents } from 'electron';

/** One browser action recognized from a guest page's keyboard input. */
export type GuestShortcut = 'focus-address' | 'reload' | 'copy-address';

/** The quiet period after an agent input command finishes, in milliseconds. */
export const AGENT_INPUT_GRACE_MS = 100;

/**
 * Read a guest-page key as a browser shortcut for `platform`, or leave it to the page.
 *
 * @param input - Electron's account of the guest's keyboard input.
 * @param platform - The desktop platform choosing Command or Control as the modifier.
 */
export function guestShortcut(
  input: Electron.Input,
  platform: NodeJS.Platform
): GuestShortcut | null {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return null;

  if (!input.meta && !input.control && !input.alt && !input.shift)
    return input.code === 'F5' ? 'reload' : null;

  const modifier =
    platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!modifier || input.alt) return null;
  if (input.shift) return input.code === 'KeyC' ? 'copy-address' : null;
  if (input.code === 'KeyL') return 'focus-address';
  if (input.code === 'KeyR') return 'reload';
  return null;
}

/**
 * Mark agent `Input.*` commands as active until every command and its grace period finish.
 * A later or overlapping command replaces the old grace timer.
 */
export function createAgentInputGate() {
  let inFlight = 0;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    /** Run one agent input command while the gate is active. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      inFlight += 1;
      try {
        return await fn();
      } finally {
        inFlight -= 1;
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
        }, AGENT_INPUT_GRACE_MS);
      }
    },
    /** Whether agent input is in flight or still inside its grace period. */
    active(): boolean {
      return inFlight > 0 || graceTimer !== undefined;
    },
  };
}

/**
 * Forward person-entered guest shortcuts while leaving agent input and unfocused windows alone.
 * A forwarded key is kept from the page and from the app menu (whose ⌘R would reload the app).
 *
 * @param contents - The guest page whose key hook is watched.
 * @param options - Platform matching, agent gate, focus proof, and shortcut receiver.
 * @returns A disposer that removes the guest key hook.
 */
export function forwardGuestShortcuts(
  contents: Pick<WebContents, 'on' | 'removeListener'>,
  options: {
    platform: NodeJS.Platform;
    gate: ReturnType<typeof createAgentInputGate>;
    personFocused: () => boolean;
    send: (shortcut: GuestShortcut) => void;
  }
): () => void {
  const onBeforeInput = (event: Electron.Event, input: Electron.Input): void => {
    if (options.gate.active() || !options.personFocused()) return;
    const shortcut = guestShortcut(input, options.platform);
    if (!shortcut) return;
    event.preventDefault();
    options.send(shortcut);
  };
  contents.on('before-input-event', onBeforeInput);
  return () => contents.removeListener('before-input-event', onBeforeInput);
}
