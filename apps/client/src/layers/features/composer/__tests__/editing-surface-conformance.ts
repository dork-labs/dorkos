/**
 * The composer keyboard ladder's conformance suite — one scenario table, run
 * against every {@link EditingSurface} adapter.
 *
 * The same shape `runtimeConformance` and `communityConformance` use for the
 * runtime and community ports: a factory in, a registered `describe` block out,
 * and one table of behaviour both implementations must agree on. A rung that
 * behaves differently on two surfaces fails here, which is the whole bar for
 * "the keyboard survived".
 *
 * **Where the scenarios come from.** They are lifted from
 * `ComposerInput.test.tsx` — the ladder's component-level regression net, which
 * stays exactly where it is. This table is the surface-level net, and the two
 * overlap on purpose: the component test proves the ladder works inside a real
 * React tree with a real `<textarea>`; this one proves the ladder's decisions
 * survive a change of field. Before the port existed it could not be written at
 * all, because `surface.insertLineBreak()` has no meaning on a ref.
 *
 * **What the table does not cover, and why.** The ladder's own state — the
 * 500 ms arming window, the context-keyed disarm — is exercised here because a
 * `before` step can drive it, but it is not surface-dependent. The surface's own
 * `isComposing()` is driven through {@link MountedSurface.setComposing}, which
 * only an adapter with editor-level composition state can offer; an adapter
 * without one is asserted against its declared constant instead of skipped.
 *
 * @module features/composer/__tests__/editing-surface-conformance
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { EditingSurface } from '../ui/editing-surface';
import { useInputKeyboard, type UseInputKeyboardOptions } from '../ui/use-input-keyboard';

/**
 * Every callback the ladder can reach for. A scenario names the ones it expects
 * and the ones it forbids; the runner spies on all of them either way.
 */
const LADDER_CALLBACKS = [
  'onSubmit',
  'onStop',
  'onEscape',
  'onClear',
  'onArrowUp',
  'onArrowDown',
  'onCommandSelect',
  'onQueue',
  'onSaveEdit',
  'onCancelEdit',
  'onQueueNavigateUp',
  'onQueueNavigateDown',
  'onCancelUpload',
] as const satisfies readonly (keyof UseInputKeyboardOptions)[];

/** One of the ladder's callbacks, by name. */
type LadderCallback = (typeof LADDER_CALLBACKS)[number];

/** One key press, as the ladder sees it. */
interface LadderKey {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  /** `KeyboardEvent.isComposing` — the keydown that commits an IME candidate. */
  readonly isComposing?: boolean;
  /** Legacy `keyCode`; `229` is the other IME signal some engines send instead. */
  readonly keyCode?: number;
}

/** One keyboard scenario, expressed so it can run on any EditingSurface. */
export interface LadderScenario {
  readonly name: string;
  /**
   * Text and caret to start from, as a markdown string and an offset into it.
   * `anchor` makes the selection a RANGE from `anchor` to `caret` — the rules
   * that require a collapsed caret need a way to say so.
   */
  readonly given: { text: string; caret: number; anchor?: number };
  readonly key: LadderKey;
  readonly props: Partial<UseInputKeyboardOptions>;
  /**
   * What happened just before the key under test. Only the double-Escape rungs
   * need it: the wipe exists only after a first tap, and it expires. Callback
   * spies are cleared once this has run, so `expect` always describes the key
   * under test alone.
   */
  readonly before?: {
    readonly keys?: readonly LadderKey[];
    /** Advance the ladder's arming clock by this many ms, on fake timers. */
    readonly advanceMs?: number;
    /** Re-render with this `contextKey` — the draft changed under the arm. */
    readonly contextKey?: string;
  };
  readonly expect: {
    calls?: readonly LadderCallback[];
    notCalls?: readonly LadderCallback[];
    /** Text after the key, when the scenario edits the document. */
    text?: string;
    defaultPrevented: boolean;
  };
}

/** A live adapter, ready for the table to drive. */
export interface MountedSurface {
  /** The adapter under test. */
  readonly surface: EditingSurface;
  /** Put `text` in the field, with a caret at `caret` (or a range from `anchor`). */
  setContent(text: string, caret: number, anchor?: number): void;
  /** The field's current text, in the units `value` is measured in. */
  getText(): string;
  /**
   * Put the surface into (or out of) an IME composition.
   *
   * Omitted by adapters with no editor-level composition state — a `<textarea>`
   * answers a constant `false` and the keydown's own flags are the whole IME
   * story there. The runner asserts that constant rather than skipping.
   */
  setComposing?(composing: boolean): void;
  /** Tear down whatever the mount created. */
  cleanup(): void;
}

/** A key press that has been through the ladder, and what it left behind. */
interface PressedKey {
  defaultPrevented: boolean;
}

/** Send one key through the ladder and report whether it was consumed. */
function pressKey(handleKeyDown: (e: React.KeyboardEvent) => void, key: LadderKey): PressedKey {
  const event = {
    key: key.key,
    shiftKey: key.shiftKey ?? false,
    altKey: key.altKey ?? false,
    keyCode: key.keyCode ?? 0,
    nativeEvent: { isComposing: key.isComposing ?? false },
    defaultPrevented: false,
    preventDefault(this: PressedKey) {
      this.defaultPrevented = true;
    },
  };
  handleKeyDown(event as unknown as React.KeyboardEvent);
  return event;
}

/** A fresh spy for every ladder callback. */
function spyOnEveryCallback(): Record<LadderCallback, Mock<() => void>> {
  return Object.fromEntries(LADDER_CALLBACKS.map((name) => [name, vi.fn<() => void>()])) as Record<
    LadderCallback,
    Mock<() => void>
  >;
}

/**
 * The scenarios every editing surface must agree on.
 *
 * Lifted from `ComposerInput.test.tsx`, named after the behaviour rather than
 * the key, and grouped in the order the ladder consults them.
 */
export const LADDER_SCENARIOS: readonly LadderScenario[] = [
  // --- Enter, the plain cases ---
  {
    name: 'Enter sends the message',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Enter' },
    props: {},
    expect: { calls: ['onSubmit'], defaultPrevented: true },
  },
  {
    name: 'Enter sends nothing from an empty box',
    given: { text: '', caret: 0 },
    key: { key: 'Enter' },
    props: {},
    expect: { notCalls: ['onSubmit'], defaultPrevented: true },
  },
  {
    name: 'Enter queues instead of sending while a turn streams',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Enter' },
    props: { isStreaming: true },
    expect: { calls: ['onQueue'], notCalls: ['onSubmit'], defaultPrevented: true },
  },
  {
    name: 'Enter saves a queue-item edit rather than queueing it again',
    given: { text: 'edited', caret: 6 },
    key: { key: 'Enter' },
    props: { editingQueueItem: true, isStreaming: true },
    expect: { calls: ['onSaveEdit'], notCalls: ['onQueue', 'onSubmit'], defaultPrevented: true },
  },
  {
    name: 'Shift+Enter never sends',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Enter', shiftKey: true },
    props: {},
    expect: { notCalls: ['onSubmit'], defaultPrevented: false },
  },
  {
    name: 'Enter sends nothing while the session is busy',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Enter' },
    props: { sessionBusy: true },
    expect: { notCalls: ['onSubmit'], defaultPrevented: true },
  },
  {
    name: 'Enter sends nothing while the send target is not ready',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Enter' },
    props: { canSubmit: false },
    expect: { notCalls: ['onSubmit'], defaultPrevented: true },
  },
  {
    name: 'a dispatched command still settling swallows Enter',
    given: { text: '/compact the api bits', caret: 20 },
    key: { key: 'Enter' },
    props: { commandPending: true },
    expect: { notCalls: ['onSubmit'], defaultPrevented: true },
  },
  {
    name: 'an upload in flight swallows Enter — the send is already happening',
    given: { text: 'here you go', caret: 11 },
    key: { key: 'Enter' },
    props: { isUploading: true },
    expect: { notCalls: ['onSubmit'], defaultPrevented: true },
  },
  {
    name: 'Enter leaves a newline to the browser on a touch-only device',
    given: { text: 'send me', caret: 7 },
    key: { key: 'Enter' },
    props: { isTouchOnly: true },
    expect: { notCalls: ['onSubmit'], text: 'send me', defaultPrevented: false },
  },

  // --- Alt+Enter: an explicit newline, never a pick and never a send ---
  {
    name: 'Alt+Enter inserts a line break instead of sending',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Enter', altKey: true },
    props: {},
    expect: { notCalls: ['onSubmit'], text: 'hello\n', defaultPrevented: true },
  },
  {
    name: 'Alt+Enter does not pick a palette row',
    given: { text: '/dai', caret: 4 },
    key: { key: 'Enter', altKey: true },
    props: { isPaletteOpen: true, paletteHasResults: true },
    expect: { notCalls: ['onCommandSelect'], text: '/dai\n', defaultPrevented: true },
  },

  // --- Backslash line continuation, upstream of all three Enter modes ---
  {
    name: 'a trailing backslash continues the line instead of sending',
    given: { text: 'foo\\', caret: 4 },
    key: { key: 'Enter' },
    props: {},
    expect: { notCalls: ['onSubmit'], text: 'foo\n', defaultPrevented: true },
  },
  {
    name: 'an even run of backslashes is a literal, and sends',
    given: { text: 'foo\\\\', caret: 5 },
    key: { key: 'Enter' },
    props: {},
    expect: { calls: ['onSubmit'], text: 'foo\\\\', defaultPrevented: true },
  },
  {
    name: 'a three-backslash run is odd, and continues',
    given: { text: 'foo\\\\\\', caret: 6 },
    key: { key: 'Enter' },
    props: {},
    expect: { notCalls: ['onSubmit'], text: 'foo\\\\\n', defaultPrevented: true },
  },
  {
    name: 'a backslash that does not touch the caret sends',
    given: { text: 'foo\\ ', caret: 5 },
    key: { key: 'Enter' },
    props: {},
    expect: { calls: ['onSubmit'], text: 'foo\\ ', defaultPrevented: true },
  },
  {
    name: 'the backslash rule needs a collapsed caret',
    given: { text: 'foo\\', caret: 4, anchor: 0 },
    key: { key: 'Enter' },
    props: {},
    expect: { calls: ['onSubmit'], text: 'foo\\', defaultPrevented: true },
  },
  {
    name: 'the backslash rule reads the caret, not the end of the value',
    given: { text: 'foo\\bar', caret: 4 },
    key: { key: 'Enter' },
    props: {},
    expect: { notCalls: ['onSubmit'], text: 'foo\nbar', defaultPrevented: true },
  },
  {
    name: 'a trailing backslash never queues mid-stream',
    given: { text: 'foo\\', caret: 4 },
    key: { key: 'Enter' },
    props: { isStreaming: true },
    expect: { notCalls: ['onQueue'], text: 'foo\n', defaultPrevented: true },
  },
  {
    name: 'a trailing backslash never saves a queue-item edit',
    given: { text: 'foo\\', caret: 4 },
    key: { key: 'Enter' },
    props: { editingQueueItem: true },
    expect: { notCalls: ['onSaveEdit'], text: 'foo\n', defaultPrevented: true },
  },
  {
    name: 'the backslash rule stays out of Shift+Enter, already a newline',
    given: { text: 'foo\\', caret: 4 },
    key: { key: 'Enter', shiftKey: true },
    props: {},
    expect: { text: 'foo\\', defaultPrevented: false },
  },

  // --- Escape priority ladder ---
  {
    name: 'Escape dismisses an open palette before stopping the turn',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Escape' },
    props: { isStreaming: true, isPaletteOpen: true, paletteHasResults: true },
    expect: { calls: ['onEscape'], notCalls: ['onStop', 'onClear'], defaultPrevented: true },
  },
  {
    name: 'Escape cancels a queue-item edit before stopping the turn',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Escape' },
    props: { isStreaming: true, editingQueueItem: true },
    expect: { calls: ['onCancelEdit'], notCalls: ['onStop'], defaultPrevented: true },
  },
  {
    name: 'Escape stops the turn once no palette or edit is open',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Escape' },
    props: { isStreaming: true },
    expect: { calls: ['onStop'], notCalls: ['onClear'], defaultPrevented: true },
  },
  {
    name: 'Escape cancels an upload in flight, on the rung Stop sits on',
    given: { text: 'here you go', caret: 11 },
    key: { key: 'Escape' },
    props: { isUploading: true },
    expect: { calls: ['onCancelUpload'], notCalls: ['onClear'], defaultPrevented: true },
  },
  {
    name: 'the first bare Escape arms the wipe rather than performing it',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Escape' },
    props: {},
    expect: { calls: ['onEscape'], notCalls: ['onClear'], defaultPrevented: true },
  },
  {
    name: 'the second Escape empties the field through the undo pipeline',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Escape' },
    props: {},
    before: { keys: [{ key: 'Escape' }] },
    expect: { calls: ['onClear'], text: '', defaultPrevented: true },
  },
  {
    name: 'the wipe selects the whole draft first, so nothing survives it',
    given: { text: 'one\ntwo', caret: 0 },
    key: { key: 'Escape' },
    props: {},
    before: { keys: [{ key: 'Escape' }] },
    expect: { calls: ['onClear'], text: '', defaultPrevented: true },
  },
  {
    name: 'the arming window closes, and the second Escape only arms again',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Escape' },
    props: {},
    before: { keys: [{ key: 'Escape' }], advanceMs: 600 },
    expect: { calls: ['onEscape'], notCalls: ['onClear'], text: 'hello', defaultPrevented: true },
  },
  {
    name: 'a context change disarms the wipe raised against the old draft',
    given: { text: 'hello', caret: 5 },
    key: { key: 'Escape' },
    props: { contextKey: 'session-a' },
    before: { keys: [{ key: 'Escape' }], contextKey: 'session-b' },
    expect: { calls: ['onEscape'], notCalls: ['onClear'], text: 'hello', defaultPrevented: true },
  },
  {
    name: 'Escape in an empty box stays available to the surface around it',
    given: { text: '', caret: 0 },
    key: { key: 'Escape' },
    props: {},
    before: { keys: [{ key: 'Escape' }] },
    expect: { calls: ['onEscape'], notCalls: ['onClear'], defaultPrevented: false },
  },

  // --- Palette open, with rows to pick ---
  {
    name: 'an open palette takes ArrowDown',
    given: { text: '/d', caret: 2 },
    key: { key: 'ArrowDown' },
    props: { isPaletteOpen: true, paletteHasResults: true },
    expect: { calls: ['onArrowDown'], defaultPrevented: true },
  },
  {
    name: 'an open palette takes ArrowUp',
    given: { text: '/d', caret: 2 },
    key: { key: 'ArrowUp' },
    props: { isPaletteOpen: true, paletteHasResults: true },
    expect: { calls: ['onArrowUp'], defaultPrevented: true },
  },
  {
    name: 'an open palette takes Tab as a pick',
    given: { text: '/d', caret: 2 },
    key: { key: 'Tab' },
    props: { isPaletteOpen: true, paletteHasResults: true },
    expect: { calls: ['onCommandSelect'], defaultPrevented: true },
  },
  {
    name: 'an open palette takes Enter as a pick, not a send',
    given: { text: '/daily', caret: 6 },
    key: { key: 'Enter' },
    props: { isPaletteOpen: true, paletteHasResults: true },
    expect: { calls: ['onCommandSelect'], notCalls: ['onSubmit'], defaultPrevented: true },
  },
  {
    name: 'an open palette leaves Shift+Enter alone',
    given: { text: '/daily', caret: 6 },
    key: { key: 'Enter', shiftKey: true },
    props: { isPaletteOpen: true, paletteHasResults: true },
    expect: { notCalls: ['onCommandSelect'], defaultPrevented: false },
  },

  // --- Palette open with nothing to pick ---
  {
    name: 'Enter falls through and sends when the palette has no rows',
    given: { text: '/zzz', caret: 4 },
    key: { key: 'Enter' },
    props: { isPaletteOpen: true, paletteHasResults: false },
    expect: { calls: ['onSubmit'], notCalls: ['onCommandSelect'], defaultPrevented: true },
  },
  {
    name: 'Enter queues mid-stream when the palette has no rows',
    given: { text: '@zzz', caret: 4 },
    key: { key: 'Enter' },
    props: { isStreaming: true, isPaletteOpen: true, paletteHasResults: false },
    expect: { calls: ['onQueue'], notCalls: ['onCommandSelect'], defaultPrevented: true },
  },
  {
    name: 'Escape dismisses an empty panel twice without arming the wipe',
    given: { text: '/zzz', caret: 4 },
    key: { key: 'Escape' },
    props: { isPaletteOpen: true, paletteHasResults: false },
    before: { keys: [{ key: 'Escape' }] },
    expect: { calls: ['onEscape'], notCalls: ['onClear'], defaultPrevented: true },
  },

  // --- Queue navigation, palette closed ---
  {
    name: 'ArrowUp at the start of the document reaches the queue',
    given: { text: 'hello', caret: 0 },
    key: { key: 'ArrowUp' },
    props: { queueHasItems: true },
    expect: { calls: ['onQueueNavigateUp'], defaultPrevented: true },
  },
  {
    name: 'ArrowUp from an empty box reaches the queue',
    given: { text: '', caret: 0 },
    key: { key: 'ArrowUp' },
    props: { queueHasItems: true },
    expect: { calls: ['onQueueNavigateUp'], defaultPrevented: true },
  },
  {
    name: 'ArrowUp mid-draft moves the caret instead',
    given: { text: 'hello', caret: 3 },
    key: { key: 'ArrowUp' },
    props: { queueHasItems: true },
    expect: { notCalls: ['onQueueNavigateUp'], defaultPrevented: false },
  },
  {
    name: 'ArrowUp with an empty queue moves the caret instead',
    given: { text: '', caret: 0 },
    key: { key: 'ArrowUp' },
    props: { queueHasItems: false },
    expect: { notCalls: ['onQueueNavigateUp'], defaultPrevented: false },
  },
  {
    name: 'ArrowDown at the end of a queue edit leaves it',
    given: { text: 'hello', caret: 5 },
    key: { key: 'ArrowDown' },
    props: { queueHasItems: true, editingQueueItem: true },
    expect: { calls: ['onQueueNavigateDown'], defaultPrevented: true },
  },
  {
    name: 'ArrowDown mid-draft stays inside the edit',
    given: { text: 'hello', caret: 2 },
    key: { key: 'ArrowDown' },
    props: { queueHasItems: true, editingQueueItem: true },
    expect: { notCalls: ['onQueueNavigateDown'], defaultPrevented: false },
  },
  {
    name: 'ArrowDown does not leave a queue that is not being edited',
    given: { text: 'hello', caret: 5 },
    key: { key: 'ArrowDown' },
    props: { queueHasItems: true, editingQueueItem: false },
    expect: { notCalls: ['onQueueNavigateDown'], defaultPrevented: false },
  },

  // --- IME, at the event level ---
  {
    name: 'the Enter that commits an IME candidate is not handled',
    given: { text: 'こん', caret: 2 },
    key: { key: 'Enter', isComposing: true },
    props: {},
    expect: { notCalls: ['onSubmit'], defaultPrevented: false },
  },
  {
    name: 'the legacy keyCode 229 signal is honoured too',
    given: { text: 'こん', caret: 2 },
    key: { key: 'Enter', keyCode: 229 },
    props: {},
    expect: { notCalls: ['onSubmit'], defaultPrevented: false },
  },
  {
    name: 'Escape does not stop a turn mid-composition',
    given: { text: '', caret: 0 },
    key: { key: 'Escape', isComposing: true },
    props: { isStreaming: true },
    expect: { notCalls: ['onStop', 'onEscape'], defaultPrevented: false },
  },
];

/**
 * Register the whole table against one adapter.
 *
 * @param name - The adapter's name, used in the describe block.
 * @param mount - Brings up a live adapter; called once per scenario.
 */
export function runLadderConformance(name: string, mount: () => Promise<MountedSurface>): void {
  describe(`EditingSurface ladder conformance — ${name}`, () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    for (const scenario of LADDER_SCENARIOS) {
      it(scenario.name, async () => {
        if (scenario.before?.advanceMs !== undefined) vi.useFakeTimers();
        const mounted = await mount();
        const spies = spyOnEveryCallback();
        const initialContextKey = scenario.props.contextKey;

        const { result, rerender, unmount } = renderHook(
          ({ contextKey }: { contextKey: string | undefined }) =>
            useInputKeyboard({
              value: scenario.given.text,
              isStreaming: false,
              isTouchOnly: false,
              sessionBusy: false,
              editingQueueItem: false,
              queueHasItems: false,
              ...spies,
              ...scenario.props,
              surface: mounted.surface,
              contextKey,
            }),
          { initialProps: { contextKey: initialContextKey } }
        );

        try {
          mounted.setContent(scenario.given.text, scenario.given.caret, scenario.given.anchor);

          for (const key of scenario.before?.keys ?? []) {
            act(() => void pressKey(result.current.handleKeyDown, key));
          }
          if (scenario.before?.advanceMs !== undefined) {
            const ms = scenario.before.advanceMs;
            act(() => void vi.advanceTimersByTime(ms));
          }
          if (scenario.before?.contextKey !== undefined) {
            rerender({ contextKey: scenario.before.contextKey });
          }
          // Everything above is setup; the expectations describe the key under
          // test alone.
          for (const spy of Object.values(spies)) spy.mockClear();

          let pressed: PressedKey | undefined;
          act(() => void (pressed = pressKey(result.current.handleKeyDown, scenario.key)));

          expect(pressed?.defaultPrevented).toBe(scenario.expect.defaultPrevented);
          for (const callback of scenario.expect.calls ?? []) {
            expect(spies[callback], `expected ${callback} to be called`).toHaveBeenCalled();
          }
          for (const callback of scenario.expect.notCalls ?? []) {
            expect(spies[callback], `expected ${callback} NOT to be called`).not.toHaveBeenCalled();
          }
          if (scenario.expect.text !== undefined) {
            expect(mounted.getText()).toBe(scenario.expect.text);
          }
        } finally {
          unmount();
          mounted.cleanup();
        }
      });
    }

    it('reports its own composition state to the ladder', async () => {
      const mounted = await mount();
      const spies = spyOnEveryCallback();
      const { result, unmount } = renderHook(() =>
        useInputKeyboard({
          value: 'hello',
          isStreaming: false,
          isTouchOnly: false,
          sessionBusy: false,
          editingQueueItem: false,
          queueHasItems: false,
          ...spies,
          surface: mounted.surface,
        })
      );

      try {
        mounted.setContent('hello', 5);
        if (!mounted.setComposing) {
          // This surface has no editor-level composition state to report. That
          // constant `false` IS its contract — the keydown's own flags carry the
          // whole IME story here — so assert it rather than skipping the rung.
          expect(mounted.surface.isComposing()).toBe(false);
          act(() => void pressKey(result.current.handleKeyDown, { key: 'Enter' }));
          expect(spies.onSubmit).toHaveBeenCalled();
          return;
        }

        mounted.setComposing(true);
        act(() => void pressKey(result.current.handleKeyDown, { key: 'Enter' }));
        expect(spies.onSubmit).not.toHaveBeenCalled();

        mounted.setComposing(false);
        act(() => void pressKey(result.current.handleKeyDown, { key: 'Enter' }));
        expect(spies.onSubmit).toHaveBeenCalledOnce();
      } finally {
        unmount();
        mounted.cleanup();
      }
    });
  });
}
