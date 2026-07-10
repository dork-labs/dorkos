import { useCallback, useRef, type KeyboardEvent } from 'react';

/**
 * How a tab activation (or close) was triggered. Lets consumers vary focus
 * side effects by input: e.g. the terminal focuses its PTY on a pointer click
 * but must NOT steal focus from the strip during keyboard traversal.
 */
export type TabActivationSource = 'keyboard' | 'pointer';

/** Props the hook produces for a single tab element (the one Tab stop). */
export interface RovingTabProps {
  /** Ref callback that registers the tab element for programmatic focus. */
  ref: (element: HTMLElement | null) => void;
  /** `0` for the active (roving) tab, `-1` for every other — one Tab stop per strip. */
  tabIndex: 0 | -1;
  /** Activates the tab with a `'pointer'` source. */
  onClick: () => void;
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
  /**
   * Activate a tab by id, with the triggering input source: `'pointer'` for
   * clicks (via the returned `onClick`), `'keyboard'` for arrow/Home/End
   * (automatic activation: focus selects). Consumers that don't vary behaviour
   * by source can pass a single-parameter callback.
   */
  onActivate: (id: string, source: TabActivationSource) => void;
  /**
   * Close a tab by id. When provided, Delete closes the focused tab
   * (`'keyboard'` source) and focus moves to a neighbour — or to
   * {@link UseRovingTabListParams.getFallbackFocus} when none remains.
   */
  onClose?: (id: string, source: TabActivationSource) => void;
  /**
   * Focus target for Delete on the last remaining tab (no neighbour to move
   * to). Must return an element that already exists at close time and survives
   * the close's re-render — e.g. the strip's trailing "+" button or the panel
   * container (given `tabIndex={-1}`). Without it, closing the only tab drops
   * focus to the document body.
   */
  getFallbackFocus?: () => HTMLElement | null;
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
 * adjacent tab — or to the caller's `getFallbackFocus` element when the last
 * tab closes — so focus is never lost to the document body; each tab also
 * advertises the shortcut via `aria-keyshortcuts`.
 *
 * Activation and close callbacks receive a {@link TabActivationSource} so
 * consumers can vary focus side effects by input: pointer activation may focus
 * the panel's content, keyboard traversal must keep focus on the strip.
 *
 * The hook owns focus and keyboard only. The caller supplies `role="tab"`,
 * `aria-selected`, ids, and any `aria-controls` wiring, and renders close
 * controls as non-tab-stop siblings (`tabIndex={-1}`) so the DOM stays valid.
 *
 * @param params - The tab order, active id, activate/close callbacks, and
 *   optional last-tab fallback focus target.
 * @returns `getTabProps(id)` — the roving `ref`, `tabIndex`, `onClick`,
 *   `onKeyDown`, and optional `aria-keyshortcuts` to spread onto each tab.
 */
export function useRovingTabList({
  orderedIds,
  activeId,
  onActivate,
  onClose,
  getFallbackFocus,
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
      onActivate(id, 'keyboard');
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
            // Move focus BEFORE React unmounts the tab, so it never falls back
            // to the document body. The target pre-exists the close (neighbour
            // tabs are keyed by id; the fallback lives outside the strip), so
            // focusing it synchronously survives the re-render.
            const neighbour = orderedIds[index + 1] ?? orderedIds[index - 1] ?? null;
            onClose(id, 'keyboard');
            if (neighbour) focus(neighbour);
            else getFallbackFocus?.()?.focus();
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
        onClick: () => onActivate(id, 'pointer'),
        onKeyDown,
        ...(onClose ? { 'aria-keyshortcuts': 'Delete' } : {}),
      };
    },
    [orderedIds, rovingId, onActivate, onClose, getFallbackFocus, move, focus]
  );

  return { getTabProps };
}
