import { useCallback, useEffect, useRef, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { readTerminalTabs, writeTerminalTabs } from '../lib/terminal-id-store';
import { TerminalInstance } from './TerminalInstance';
import { TerminalTabs } from './TerminalTabs';

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
function buildInitialState(sessionId: string | null, cwd: string): PanelState {
  const { ids, activeIndex } = readTerminalTabs(sessionId, cwd);
  if (ids.length === 0) {
    // No stored terminals — seed one fresh shell so opening the panel lands you
    // straight in a terminal (not an empty state). Explicitly closing every tab
    // later shows the empty state; only a fresh mount re-seeds.
    const key = nextTabKey();
    return { tabs: [{ key, ptyId: null, label: 1, superseded: false }], activeKey: key };
  }
  const tabs: TerminalTab[] = ids.map((id, i) => ({
    key: nextTabKey(),
    ptyId: id,
    label: i + 1,
    superseded: false,
  }));
  return { tabs, activeKey: tabs[activeIndex]?.key ?? tabs[0].key };
}

/** Drop the tab with `key`, activating a sensible neighbor if it was active. */
function removeTab(state: PanelState, key: string): PanelState {
  const index = state.tabs.findIndex((t) => t.key === key);
  if (index === -1) return state;
  const tabs = state.tabs.filter((t) => t.key !== key);
  if (state.activeKey !== key) return { tabs, activeKey: state.activeKey };
  // Prefer the tab that shifts into this slot, else the previous one, else none.
  const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
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
function toPersisted(state: PanelState): { ids: string[]; activeIndex: number } {
  const ids = state.tabs.filter(isPersistable).map((t) => t.ptyId);
  const activeTab = state.tabs.find((t) => t.key === state.activeKey);
  // An active tab with no persisted id (still spawning, or superseded) has
  // nothing to point at; aim at the last real id so a refresh restores
  // something sane.
  const activeIndex =
    activeTab && isPersistable(activeTab)
      ? ids.indexOf(activeTab.ptyId)
      : Math.max(0, ids.length - 1);
  return { ids, activeIndex };
}

/**
 * Embedded terminal panel (spec right-panel-workbench, Chunk E; multi-terminal
 * tabs, DOR-226). Renders a tab strip over a stack of {@link TerminalInstance}s
 * — one xterm + one server-side PTY per tab. Only the active instance is
 * visible; the rest stay mounted (hidden), so switching tabs is instant and
 * never tears a PTY down.
 *
 * Tabs and their active index persist per (session, cwd) in `sessionStorage`, so
 * a page refresh re-attaches to every live shell with the same tab active;
 * shells that lapsed past the server's idle grace window are silently pruned.
 * Web-only — the whole feature is gated on `transport.supportsTerminal`, so this
 * never mounts under the in-process transport.
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
        Select a working directory to open a terminal.
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

  const [state, setState] = useState<PanelState>(() => buildInitialState(sessionId, cwd));
  // Current state behind a ref so close handlers can read a tab's id for the
  // teardown side effect without threading it through the pure state updater.
  // Synced in an effect (react-hooks/refs forbids ref writes during render);
  // handlers only fire after render, so the ref is always current when read.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Persist the open ids + active index on every change, so a refresh restores
  // the tabs. Never clears on unmount — that is what lets the shells survive a
  // reload (the persisted ids stay until a shell exits or a tab is closed).
  useEffect(() => {
    writeTerminalTabs(sessionId, cwd, toPersisted(state));
  }, [state, sessionId, cwd]);

  const createTab = useCallback(() => {
    setState((s) => {
      const label = s.tabs.reduce((max, t) => Math.max(max, t.label), 0) + 1;
      const tab: TerminalTab = { key: nextTabKey(), ptyId: null, label, superseded: false };
      return { tabs: [...s.tabs, tab], activeKey: tab.key };
    });
  }, []);

  // Keys of tabs the user closed while their create was still in flight (no
  // ptyId yet). When such a create resolves (late spawn), the PTY must be
  // DESTROYED — the user discarded that tab — not persisted. Body-scoped and
  // consumed on resolution; keys of creates that ultimately reject just expire
  // with the body.
  const closedPendingKeysRef = useRef(new Set<string>());

  const closeTab = useCallback(
    (key: string) => {
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

  const activateTab = useCallback((key: string) => {
    setState((s) => (s.activeKey === key ? s : { ...s, activeKey: key }));
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
      const stored = readTerminalTabs(sessionId, cwd);
      if (!stored.ids.includes(id)) {
        writeTerminalTabs(sessionId, cwd, {
          ids: [...stored.ids, id],
          activeIndex: stored.activeIndex,
        });
      }
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
        tabs: s.tabs.map((t) => (t.key === key ? { ...t, ptyId: id } : t)),
      }));
    },
    [handleLateSpawn]
  );

  const handleEnded = useCallback((key: string) => {
    // Shell exited (or a re-attach target was gone) — prune the tab. Never calls
    // closeTerminal: the PTY is already gone server-side.
    setState((s) => removeTab(s, key));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TerminalTabs
        tabs={state.tabs.map((t) => ({ key: t.key, label: `Terminal ${t.label}` }))}
        activeKey={state.activeKey}
        onActivate={activateTab}
        onClose={closeTab}
        onCreate={createTab}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
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
              active={tab.key === state.activeKey}
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
