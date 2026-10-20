import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { Button, type TabActivationSource } from '@/layers/shared/ui';
import {
  useAppStore,
  useTransport,
  useUnifiedPanelChrome,
  useTerminalResourceChrome,
  PanelResourceVisible,
} from '@/layers/shared/model';
import {
  readTerminalTabs,
  writeTerminalTabs,
  appendLateTerminal,
  subscribeLateTerminals,
  type TerminalTabsState,
} from '../lib/terminal-id-store';
import { TerminalInstance } from './TerminalInstance';
import { TerminalTabs, TERMINAL_PANEL_ID, terminalTabDomId } from './TerminalTabs';

/** A live terminal tab in the panel's state. */
interface TerminalTab {
  /** Stable client key — the React key and active-tab identity, stable across the id-resolving create. */
  key: string;
  /** The server PTY id, or `null` while a freshly-created shell is still spawning. */
  ptyId: string | null;
  /** Monotonic display number; assigned once and never renumbered on close. */
  label: number;
  /**
   * The server closed this tab's socket with `TERMINAL_CLOSE_SUPERSEDED` —
   * another window took the PTY over. The tab stays visible for this app
   * lifetime (dead, showing the in-terminal notice), but the PTY is no longer
   * this window's: its id is excluded from persistence (so a refresh here never
   * re-attaches and steals the session back) and closing the tab skips the
   * server-side destroy (which would kill the other window's live shell).
   */
  superseded: boolean;
  /** Closing the view preserves its live or pending PTY. */
  hidden: boolean;
}

/** The panel's tab state: the open tabs and which one is active. */
interface PanelState {
  tabs: TerminalTab[];
  activeKey: string | null;
}

/** Process-local monotonic source of stable tab keys (unique within a render). */
let tabKeySeq = 0;
function nextTabKey(): string {
  return `t${(tabKeySeq += 1)}`;
}

/** Build the initial panel state for a (session, cwd) from persisted tabs. */
function buildInitialState(
  sessionId: string | null,
  cwd: string,
  createRequested = false
): PanelState {
  const { ids, activeIndex, closedIds } = readTerminalTabs(sessionId, cwd);
  if (ids.length === 0) {
    // No stored terminals — seed one fresh shell so opening the panel lands you
    // straight in a terminal (not an empty state). Explicitly closing every tab
    // later shows the empty state; only a fresh mount re-seeds.
    const key = nextTabKey();
    return {
      tabs: [{ key, ptyId: null, label: 1, superseded: false, hidden: false }],
      activeKey: key,
    };
  }
  const tabs: TerminalTab[] = ids.map((id, i) => ({
    key: nextTabKey(),
    ptyId: id,
    label: i + 1,
    superseded: false,
    hidden: closedIds?.includes(id) ?? false,
  }));
  const active = tabs[activeIndex];
  if (createRequested) {
    const fresh: TerminalTab = {
      key: nextTabKey(),
      ptyId: null,
      label: tabs.length + 1,
      superseded: false,
      hidden: false,
    };
    return { tabs: [...tabs, fresh], activeKey: fresh.key };
  }
  return {
    tabs,
    activeKey: (active && !active.hidden ? active : tabs.find((tab) => !tab.hidden))?.key ?? null,
  };
}

/** Drop the tab with `key`, activating a sensible neighbor if it was active. */
function removeTab(state: PanelState, key: string): PanelState {
  const index = state.tabs.findIndex((t) => t.key === key);
  if (index === -1) return state;
  const tabs = state.tabs.filter((t) => t.key !== key);
  if (state.activeKey !== key) return { tabs, activeKey: state.activeKey };
  // Prefer the tab that shifts into this slot, else the previous one, else none.
  const neighbor =
    tabs.slice(index).find((tab) => !tab.hidden) ??
    tabs
      .slice(0, index)
      .reverse()
      .find((tab) => !tab.hidden) ??
    null;
  return { tabs, activeKey: neighbor?.key ?? null };
}

/** Whether a tab's PTY id belongs in this window's persisted restore list. */
function isPersistable(tab: TerminalTab): tab is TerminalTab & { ptyId: string } {
  // A superseded tab's PTY belongs to the window that took it over — persisting
  // its id would make a refresh HERE re-attach and steal the session back
  // (ping-ponging it on every reload). The dead tab stays in UI state only.
  return tab.ptyId !== null && !tab.superseded;
}

/** Derive the persisted `{ ids, activeIndex }` view from live panel state. */
function toPersisted(state: PanelState): TerminalTabsState {
  const ids = state.tabs.filter(isPersistable).map((t) => t.ptyId);
  const activeTab = state.tabs.find((t) => t.key === state.activeKey);
  // An active tab with no persisted id (still spawning, or superseded) has
  // nothing to point at; aim at the last real id so a refresh restores
  // something sane.
  const activeIndex =
    activeTab && isPersistable(activeTab)
      ? ids.indexOf(activeTab.ptyId)
      : Math.max(0, ids.length - 1);
  const closedIds = state.tabs
    .filter(isPersistable)
    .filter((tab) => tab.hidden)
    .map((tab) => tab.ptyId);
  return { ids, activeIndex, ...(closedIds.length ? { closedIds } : {}) };
}

/**
 * Embedded terminal panel (spec right-panel-workbench, Chunk E; multi-terminal
 * tabs, DOR-226). Renders a tab strip over a stack of {@link TerminalInstance}s
 * — one xterm + one server-side PTY per tab. Only the active instance is
 * visible; the rest stay mounted (hidden), so switching tabs is instant and
 * never tears a PTY down.
 *
 * The whole feature module is lazy-loaded by the right-panel contribution
 * (`React.lazy`), so `@xterm/*` lands in its own async chunk.
 *
 * @module features/terminal/ui/TerminalPanel
 */
export function TerminalPanel() {
  const cwd = useAppStore((s) => s.selectedCwd);
  const sessionId = useAppStore((s) => s.sessionId);

  if (!cwd) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-sm">
        Pick a folder to open a terminal.
      </div>
    );
  }

  // Keyed on (session, cwd): a context change remounts the body, which re-seeds
  // its tab state from storage in its useState initializer — no re-seed effect,
  // and every TerminalInstance beneath is torn down and re-attached cleanly.
  return <TerminalPanelBody key={`${sessionId ?? ''}:${cwd}`} sessionId={sessionId} cwd={cwd} />;
}

/**
 * The tab strip + instance stack for one fixed (session, cwd) context. Split
 * from {@link TerminalPanel} so the context can be a remount key: `sessionId`
 * and `cwd` are constant for this component's lifetime.
 */
function TerminalPanelBody({ sessionId, cwd }: { sessionId: string | null; cwd: string }) {
  const transport = useTransport();
  const unified = useUnifiedPanelChrome();
  const visible = useContext(PanelResourceVisible);
  const publishChrome = useTerminalResourceChrome((s) => s.publish);

  // Read without consuming during initialization: StrictMode may initialize twice.
  const [initialCreateRequest] = useState(() => {
    const request = useTerminalResourceChrome.getState().createRequest;
    return unified && request?.scope === `${sessionId ?? ''}:${cwd}` ? request : null;
  });
  const [state, setState] = useState<PanelState>(() =>
    buildInitialState(sessionId, cwd, initialCreateRequest !== null)
  );
  useEffect(() => {
    if (initialCreateRequest)
      useTerminalResourceChrome
        .getState()
        .consumeCreate(initialCreateRequest.scope, initialCreateRequest.id);
  }, [initialCreateRequest]);
  // Whether the instance revealed by the LAST activation should grab keyboard
  // focus. True for pointer clicks, tab creation, and the initial mount (the
  // user wants to type into the shell); false for keyboard strip traversal —
  // an xterm `focus()` there would steal focus off the strip mid-arrow-scrub
  // and feed the next arrow key to the shell (DOR-229 review).
  const [focusOnActivate, setFocusOnActivate] = useState(true);
  // Current state behind a ref so close handlers can read a tab's id for the
  // teardown side effect without threading it through the pure state updater.
  // Synced in an effect (react-hooks/refs forbids ref writes during render);
  // handlers only fire after render, so the ref is always current when read.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  useLayoutEffect(() => {
    const adopt = (terminal: { id: string; closed: boolean }) => {
      setState((s) => {
        if (s.tabs.some((tab) => tab.ptyId === terminal.id)) return s;
        const label = s.tabs.reduce((max, tab) => Math.max(max, tab.label), 0) + 1;
        const adopted: TerminalTab = {
          key: nextTabKey(),
          ptyId: terminal.id,
          label,
          superseded: false,
          hidden: terminal.closed,
        };
        // Late observation never steals the replacement owner's active/new-shell intent.
        return { ...s, tabs: [...s.tabs, adopted] };
      });
    };
    const unsubscribe = subscribeLateTerminals(sessionId, cwd, adopt);
    // Concurrent rendering may yield after initialization; reconcile once before persistence.
    const stored = readTerminalTabs(sessionId, cwd);
    for (const id of stored.ids) adopt({ id, closed: stored.closedIds?.includes(id) ?? false });
    return unsubscribe;
  }, [sessionId, cwd]);

  // Persist the open ids + active index on every change, so a refresh restores
  // the tabs. Never clears on unmount — that is what lets the shells survive a
  // reload (the persisted ids stay until a shell exits or a tab is closed).
  useEffect(() => {
    writeTerminalTabs(sessionId, cwd, toPersisted(state));
  }, [state, sessionId, cwd]);

  const createTab = useCallback(() => {
    setFocusOnActivate(true);
    setState((s) => {
      const label = s.tabs.reduce((max, t) => Math.max(max, t.label), 0) + 1;
      const tab: TerminalTab = {
        key: nextTabKey(),
        ptyId: null,
        label,
        superseded: false,
        hidden: false,
      };
      return { tabs: [...s.tabs, tab], activeKey: tab.key };
    });
  }, []);

  // Keys of tabs the user closed while their create was still in flight (no
  // ptyId yet). When such a create resolves (late spawn), the PTY must be
  // DESTROYED — the user discarded that tab — not persisted. Body-scoped and
  // consumed on resolution; keys of creates that ultimately reject just expire
  // with the body.
  const closedPendingKeysRef = useRef(new Set<string>());
  // Synchronous requests survive delayed create callbacks and owner unmount.
  const hiddenKeysRef = useRef(new Set<string>());
  const hideTab = useCallback((key: string) => {
    hiddenKeysRef.current.add(key);
    setFocusOnActivate(false);
    setState((s) => {
      const tabs = s.tabs.map((tab) => (tab.key === key ? { ...tab, hidden: true } : tab));
      return {
        tabs,
        activeKey:
          s.activeKey === key ? (tabs.find((tab) => !tab.hidden)?.key ?? null) : s.activeKey,
      };
    });
  }, []);

  const closeTab = useCallback(
    (key: string, source: TabActivationSource) => {
      // Closing the active tab activates a neighbour; whether that neighbour's
      // shell should take focus follows the same input rule as activation.
      setFocusOnActivate(source === 'pointer');
      const tab = stateRef.current.tabs.find((t) => t.key === key);
      if (tab?.superseded) {
        // Superseded tab: its PTY belongs to the other window now. Just drop the
        // dead tab — never DELETE the shared shell out from under the live one.
        // (Reading superseded off stateRef is safe here: the takeover committed
        // via setState long before a human can click ×, unlike the same-tick
        // create/close race that closedPendingKeysRef guards below.)
      } else if (tab?.ptyId) {
        // Closing a tab is an explicit teardown — destroy the PTY server-side
        // (best-effort) rather than detaching. Resolves the reviewer note that
        // DELETE /api/terminal/:id had no client callers (DOR-225 → DOR-226).
        void transport.closeTerminal(tab.ptyId).catch(() => {});
      } else if (tab) {
        // Still spawning: no id to destroy yet. Mark the key so the late-spawn
        // handler destroys the PTY the moment the in-flight create resolves.
        closedPendingKeysRef.current.add(key);
      }
      setState((s) => removeTab(s, key));
    },
    [transport]
  );

  /**
   * An instance's socket was superseded by another window. Mark the tab in
   * state: the persist effect then rewrites THIS window's stored ids without it
   * (sessionStorage is per-browser-tab, so the takeover window's copy is
   * untouched) — a refresh here won't re-attach and steal the session back.
   * The dead tab itself stays visible with its in-terminal notice.
   */
  const handleSuperseded = useCallback((key: string) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.key === key ? { ...t, superseded: true } : t)),
    }));
  }, []);

  const activateTab = useCallback((key: string, source: TabActivationSource) => {
    hiddenKeysRef.current.delete(key);
    setFocusOnActivate(source === 'pointer');
    setState((s) => ({
      tabs: s.tabs.map((tab) => (tab.key === key ? { ...tab, hidden: false } : tab)),
      activeKey: key,
    }));
  }, []);

  /**
   * A create (or re-attach) resolved after its instance was torn down — the
   * resolved PTY has no owner and would otherwise leak until the server's idle
   * TTL (#173 review finding). Two windows, opposite resolutions:
   *
   * - The tab was explicitly CLOSED while spawning → destroy the PTY.
   * - The instance/panel UNMOUNTED while spawning (tab switch, leaving
   *   /session) → the shell must survive: persist the id straight into the
   *   sessionStorage tabs store so the next mount re-attaches to it. Safe
   *   post-unmount — a pure write via the store module, no React state.
   *
   * A late RE-attach needs neither: its id is already persisted (or was
   * explicitly destroyed by closeTab, which had the id).
   */
  const handleLateSpawn = useCallback(
    (key: string, id: string, reattached: boolean) => {
      if (closedPendingKeysRef.current.delete(key)) {
        void transport.closeTerminal(id).catch(() => {});
        return;
      }
      if (reattached) return;
      appendLateTerminal(sessionId, cwd, { id, closed: hiddenKeysRef.current.has(key) });
    },
    [transport, sessionId, cwd]
  );

  const handleCreated = useCallback(
    (key: string, id: string) => {
      // The tab can already be closed when the create resolves: closeTab
      // committed removeTab, but the instance's teardown (which flips
      // `cancelled`) runs in a deferred effect cleanup — so the instance still
      // reports through onCreated, and the setState below would silently no-op
      // and strand the PTY. `closedPendingKeysRef` is the authoritative signal
      // for that window: closeTab mutates it SYNCHRONOUSLY at click time (a
      // stateRef check would be useless here — stateRef syncs in a passive
      // effect, the same deferred timing as `cancelled`, so it is exactly as
      // stale). closeTab is the only tab-remover that can precede onCreated:
      // handleEnded can't fire before the create resolves for the same
      // instance (the output stream doesn't exist yet), and a body unmount
      // flips `cancelled` in synchronous cleanup before this continuation
      // runs, routing to onLateSpawn instead.
      if (closedPendingKeysRef.current.has(key)) {
        handleLateSpawn(key, id, false);
        return;
      }
      setState((s) => ({
        ...s,
        tabs: s.tabs.map((t) =>
          t.key === key
            ? { ...t, ptyId: id, hidden: t.hidden || hiddenKeysRef.current.has(key) }
            : t
        ),
      }));
    },
    [handleLateSpawn]
  );

  const handleEnded = useCallback((key: string) => {
    // Shell exited (or a re-attach target was gone) — prune the tab. Never calls
    // closeTerminal: the PTY is already gone server-side.
    setState((s) => removeTab(s, key));
  }, []);

  useEffect(() => {
    if (!unified) return;
    const find = (id: string) => state.tabs.find((t) => (t.ptyId ?? t.key) === id);
    publishChrome({
      scope: `${sessionId ?? ''}:${cwd}`,
      tabs: state.tabs.map((t) => ({
        id: t.ptyId ?? t.key,
        title: `Shell ${t.label}`,
        closed: t.hidden,
      })),
      activeId: state.tabs.find((t) => t.key === state.activeKey)?.ptyId ?? state.activeKey,
      activate: (id, source) => {
        const tab = find(id);
        if (tab) activateTab(tab.key, source);
      },
      create: createTab,
      hide: (id) => {
        const tab = find(id);
        if (tab) hideTab(tab.key);
      },
      stop: (id, source) => {
        const tab = find(id);
        if (tab) closeTab(tab.key, source);
      },
    });
  }, [unified, state, sessionId, cwd, activateTab, createTab, closeTab, hideTab, publishChrome]);
  useEffect(
    () => () => {
      if (unified) publishChrome(null);
    },
    [unified, publishChrome]
  );

  return (
    <div className="flex h-full flex-col">
      {!unified && (
        <TerminalTabs
          tabs={state.tabs.map((t) => ({ key: t.key, label: `Terminal ${t.label}` }))}
          activeKey={state.activeKey}
          onActivate={activateTab}
          onClose={closeTab}
          onCreate={createTab}
        />
      )}
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        {...(!unified && state.activeKey
          ? {
              id: TERMINAL_PANEL_ID,
              role: 'tabpanel',
              'aria-labelledby': terminalTabDomId(state.activeKey),
            }
          : {})}
      >
        {state.tabs.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
            <SquareTerminal className="size-6 opacity-60" />
            <p>No terminals open.</p>
            <Button variant="outline" size="sm" onClick={createTab}>
              New terminal
            </Button>
          </div>
        ) : (
          state.tabs.map((tab) => (
            <TerminalInstance
              key={tab.key}
              cwd={cwd}
              initialPtyId={tab.ptyId}
              active={visible && !tab.hidden && tab.key === state.activeKey}
              focusOnActivate={focusOnActivate}
              onCreated={(id) => handleCreated(tab.key, id)}
              onEnded={() => handleEnded(tab.key)}
              onSuperseded={() => handleSuperseded(tab.key)}
              onLateSpawn={(id, reattached) => handleLateSpawn(tab.key, id, reattached)}
            />
          ))
        )}
      </div>
    </div>
  );
}
