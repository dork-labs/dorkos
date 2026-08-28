import { useState } from 'react';

/**
 * A mutable slot one component instance owns.
 *
 * See {@link useRenderSlot} for what it is for and when it is safe to write.
 */
export interface RenderSlot<T> {
  /** What the slot holds right now. */
  read(): T;
  /** Replace what the slot holds. */
  write(value: T): void;
}

/**
 * Per-instance bookkeeping that render itself is allowed to read.
 *
 * `useRef` is the usual home for a value that outlives a render, but a ref may
 * not be read while rendering — and a small family of values need exactly that:
 * something carried from the previous render decides what this one draws. A
 * latched widget document, a card order frozen when a panel opened, a held
 * identity that keeps a memo from rebuilding. In all of them the value is both
 * written and read inside the same render, so neither a ref nor state (whose
 * setter cannot run during render) can hold it.
 *
 * The slot is a closure created once by `useState`'s lazy initializer, so it is
 * per-mount and nothing outside the accessor can reach it.
 *
 * **Only for values a repeated render may recompute harmlessly** — caches,
 * latches, and captures that only ever move one way. React may discard a render
 * that has already written the slot, so never put something in it that a second
 * run would count twice.
 *
 * @param initial - What the slot holds on the first render. Later renders pass
 * it too and it is ignored, exactly like `useState`'s initial value.
 */
export function useRenderSlot<T>(initial: T): RenderSlot<T> {
  const [slot] = useState<RenderSlot<T>>(() => {
    let held = initial;
    return {
      read: () => held,
      write: (value: T) => {
        held = value;
      },
    };
  });
  return slot;
}

/**
 * The value as of the current render, readable later from a callback that
 * outlives it.
 *
 * The escape hatch for a callback that must always dispatch to the newest prop
 * without the prop's identity becoming a dependency — the thing that would
 * rebuild an expensive memo, or re-run a subscription, on every parent render.
 * Re-writing the same slot with each render's value is idempotent, so a
 * discarded render costs nothing.
 *
 * @param value - This render's value.
 */
export function useLatest<T>(value: T): RenderSlot<T> {
  const slot = useRenderSlot(value);
  slot.write(value);
  return slot;
}
