import { useCallback, useRef, type KeyboardEvent } from 'react';

/** Props the hook produces for a single tab element (the one Tab stop). */
export interface RovingTabProps {
  /** Ref callback that registers the tab element for programmatic focus. */
  ref: (element: HTMLElement | null) => void;
  /** `0` for the active (roving) tab, `-1` for every other — one Tab stop per strip. */
  tabIndex: 0 | -1;
  /** Arrow/Home/End/Delete handler implementing the WAI-ARIA Tabs keyboard model. */
  onKeyDown: (event: KeyboardEvent) => void;
  /** Present only when `onClose` is set — advertises the Delete-to-close shortcut. */
  'aria-keyshortcuts'?: string;
}

/** Configuration for {@link useRovingTabList}. */
export interface UseRovingTabListParams {
  /** Tab ids in visual (tab) order — the sole source of navigation order. */
  orderedIds: string[];
  /** Id of the active tab, or `null`. Falls back to the first tab for the roving stop. */
  activeId: string | null;
  /** Activate a tab by id. Called on arrow/Home/End (automatic activation: focus selects). */
  onActivate: (id: string) => void;
  /** Close a tab by id. When provided, Delete closes the focused tab and focus moves to a neighbor. */
  onClose?: (id: string) => void;
}

/** The public surface of {@link useRovingTabList}. */
export interface RovingTabListApi {
  /** Build the roving/keyboard props for the tab with `id`. Spread onto its `role="tab"` element. */
  getTabProps: (id: string) => RovingTabProps;
}

/**
 * Keyboard behaviour for a `role="tablist"` strip, per the WAI-ARIA Tabs pattern
 * with **automatic activation** (focus selects — matches Chrome and VS Code).
 *
 * The strip is a single composite Tab stop: the active tab has `tabIndex=0`, all
 * others `-1`. ArrowLeft/ArrowRight move focus between tabs (wrapping at the
 * ends) and activate as they go; Home/End jump to the first/last tab. When
 * `onClose` is supplied, Delete closes the focused tab and moves focus to an
 * adjacent tab so it is never lost to the document body — and each tab
 * advertises the shortcut via `aria-keyshortcuts`.
 *
 * The hook owns focus and keyboard only. The caller supplies `role="tab"`,
 * `aria-selected`, ids, and any `aria-controls` wiring, and renders close
 * controls as non-tab-stop siblings (`tabIndex={-1}`) so the DOM stays valid.
 *
 * @param params - The tab order, active id, and activate/close callbacks.
 * @returns `getTabProps(id)` — the roving `ref`, `tabIndex`, `onKeyDown`, and
 *   optional `aria-keyshortcuts` to spread onto each tab element.
 */
export function useRovingTabList({
  orderedIds,
  activeId,
  onActivate,
  onClose,
}: UseRovingTabListParams): RovingTabListApi {
  const elements = useRef(new Map<string, HTMLElement>());

  // The single Tab stop is the active tab, or the first tab when the active id
  // is absent (e.g. transiently null) — a strip always keeps exactly one.
  const rovingId = activeId && orderedIds.includes(activeId) ? activeId : (orderedIds[0] ?? null);

  const focus = useCallback((id: string | null) => {
    if (id) elements.current.get(id)?.focus();
  }, []);

  const move = useCallback(
    (id: string) => {
      onActivate(id);
      focus(id);
    },
    [onActivate, focus]
  );

  const getTabProps = useCallback(
    (id: string): RovingTabProps => {
      const onKeyDown = (event: KeyboardEvent) => {
        const index = orderedIds.indexOf(id);
        if (index === -1) return;
        const last = orderedIds.length - 1;

        switch (event.key) {
          case 'ArrowRight':
            event.preventDefault();
            move(orderedIds[index === last ? 0 : index + 1]);
            break;
          case 'ArrowLeft':
            event.preventDefault();
            move(orderedIds[index === 0 ? last : index - 1]);
            break;
          case 'Home':
            event.preventDefault();
            move(orderedIds[0]);
            break;
          case 'End':
            event.preventDefault();
            move(orderedIds[last]);
            break;
          case 'Delete': {
            if (!onClose) return;
            event.preventDefault();
            // Move focus to a neighbour BEFORE the tab unmounts, so it never
            // falls back to the document body. The neighbour element persists
            // (keyed by id), so focusing it synchronously survives the re-render.
            const neighbour = orderedIds[index + 1] ?? orderedIds[index - 1] ?? null;
            onClose(id);
            focus(neighbour);
            break;
          }
        }
      };

      return {
        ref: (element: HTMLElement | null) => {
          if (element) elements.current.set(id, element);
          else elements.current.delete(id);
        },
        tabIndex: id === rovingId ? 0 : -1,
        onKeyDown,
        ...(onClose ? { 'aria-keyshortcuts': 'Delete' } : {}),
      };
    },
    [orderedIds, rovingId, onClose, move, focus]
  );

  return { getTabProps };
}
