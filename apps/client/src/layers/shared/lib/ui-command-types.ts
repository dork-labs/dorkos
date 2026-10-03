import type { UiCommand, UiCanvasContent, UiPanelId } from '@dorkos/shared/types';
import type { PipContent } from '@/layers/shared/model';
import type { CelebrationOrigin, EffectOwner } from './celebrations/celebration-effects';
export interface DispatcherStore {
  // Sidebar
  setSidebarOpen: (open: boolean) => void;

  // Panels
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  tasksOpen: boolean;
  setTasksOpen: (open: boolean) => void;
  relayOpen: boolean;
  setRelayOpen: (open: boolean) => void;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;

  // Command palette
  setGlobalPaletteOpen: (open: boolean) => void;

  // Canvas (multi-document)
  setCanvasOpen: (open: boolean) => void;
  /**
   * Append a document for `content` and activate it (dedup-by-source). Edit-
   * protection is enforced inside the store action: a re-activated document that
   * is being edited keeps its content (ADR-0292).
   */
  openCanvasDocument: (content: UiCanvasContent) => void;
  /** Take one document off the canvas by id (the `close_canvas` documentId arm). */
  closeCanvasDocument: (id: string) => void;
  /**
   * Mutate the active document of the view this content belongs to. A no-op
   * while that document is being edited, so the in-canvas editor stays the sole
   * writer (ADR-0292).
   */
  updateActiveDocument: (content: UiCanvasContent) => void;
  setCanvasPreferredWidth: (width: number | null) => void;

  // Right panel — the live host for the canvas contribution. The canvas only
  // renders when the right panel is open AND its active tab is 'canvas'
  // (RightPanelContainer), so agent-driven open/close must drive this state,
  // not just the legacy `canvasOpen` flag (DOR-97).
  setRightPanelOpen: (open: boolean) => void;
  /** Persisting tab setter — rewrites the per-agent stored preference (DOR-227). */
  setActiveRightPanelTab: (tabId: string | null) => void;
  /** View-only tab setter — switches the visible tab WITHOUT persisting (DOR-227). */
  setActiveRightPanelTabView: (tabId: string | null) => void;

  // PIP (floating panel)
  /** Pop content into the floating picture-in-picture panel, replacing whatever it shows (DOR-302). */
  openPip: (content: PipContent) => void;
  /** Close the floating picture-in-picture panel. */
  closePip: () => void;
}

export type UiCommandOrigin = 'user' | 'agent';

export interface DispatcherContext {
  /**
   * Reader for the live app store — pass `useAppStore.getState` itself, never a
   * value you already called it on.
   *
   * A getter rather than a snapshot because a `DispatcherContext` is allowed to
   * outlive a dispatch: the app entry builds one at module scope and hands it to
   * every extension for the life of the app (`ExtensionAPIDeps`). Zustand hands
   * back a NEW state object on every `set`, so a snapshot captured at boot keeps
   * boot-time values for the fields the dispatcher *reads* — `settingsOpen`,
   * `tasksOpen`, `relayOpen`, `pickerOpen` — and `toggle_panel` decides against a
   * constant. (The setters survive: their identities are stable. That is exactly
   * why the bug was invisible — every command still ran, only the reads lied.)
   * Called once per dispatch, so a command sees the state as of the moment it
   * runs.
   */
  getStore: () => DispatcherStore;
  /** Theme setter (from useTheme or stored ref) */
  setTheme: (theme: 'light' | 'dark') => void;
  /** Optional: scroll-to-message handler */
  scrollToMessage?: (messageId?: string) => void;
  /** Optional: agent switching handler */
  switchAgent?: (cwd: string) => void;
  /**
   * Optional: shape switching handler. Given an installed Shape name, applies it
   * (server resolves the manifest + degrades per-piece, then the client restores
   * the returned chrome + live-remounts extensions). Wired from the app shell to
   * `applyShapeAction` (DOR-355 task 3.1); when absent, `apply_layout` is a safe
   * no-op, matching `switchAgent`.
   */
  applyShape?: (shape: string) => void;
  /**
   * Extension → viewer overrides (config `workbench.defaultViewers`) consulted
   * when resolving an `open_file` command's viewer.
   *
   * **Omit it in production.** Four places build a context and any of them can
   * carry an `open_file`, so plumbing the value through each was four chances to
   * forget one — and forgetting one is not a missing feature, it is a SECOND
   * answer to "what does opening this file mean": the server resolves
   * `chart.png` to `{type:'file'}` under `{png:'file'}` while a blind client
   * resolves it to `{type:'image'}`, and the two `canvasSourceKey`s give one
   * file two tabs. So the default comes from {@link workbenchViewerOverrides},
   * which reads the same config the server reads, and this field exists for a
   * test that wants to state the overrides inline.
   */
  workbenchViewerOverrides?: Record<string, string>;

  supportsTerminal?: boolean;
  /**
   * Normalized viewport point a `celebrate` command should erupt from — the
   * center of the control the user clicked, so confetti bursts out of the
   * button rather than screen-center. Omitted for agent/stream-initiated
   * celebrates (there is no element), which fall back to a sensible default
   * origin. Ignored by ambient celebration kinds (fireworks/cannons/rain).
   */
  celebrationOrigin?: CelebrationOrigin;
  /**
   * The session that issued an agent stream command. Threaded per-dispatch from
   * the StreamManager's `ui_command` side effect so PIP commands know which
   * session's live widget to pop out. Unset for palette/extension dispatches,
   * which have no originating session — `open_pip` then degrades to a toast.
   */
  sessionId?: string;
  /**
   * Whether the SERVER has already applied this command's canvas effect (spec
   * `canvas-agent-seat` §1.5).
   *
   * True on exactly one path: the `ui_command` events arriving on a session's
   * own stream. A session's canvas is the server's now, so `control_ui` writes
   * the row itself and the change reaches every window as a `canvas` event —
   * what is left for the dispatcher is the REVEAL, which is what a `ui_command`
   * has always been for on a session.
   *
   * Absent everywhere else, and that is not an oversight: a click in the file
   * tree, a widget button, an extension calling `api.ui.dispatch` — none of
   * those has been applied by anybody, so each still opens the document through
   * the store, which writes it through.
   */
  serverAppliedCanvas?: boolean;
  /**
   * Optional: the URL half of the dual dialog open signal (DOR-839).
   *
   * Settings and Tasks can be held open by a search param as well as by the
   * store flag — `DialogHost` renders on either — so closing one by store flag
   * alone leaves a deep-linked dialog on screen, and toggling one reads it as
   * closed and "opens" it again. Dispatch happens outside React, so it cannot
   * reach the deep-link hooks; the app entry injects a router-backed adapter
   * instead, the same shape as `switchAgent`. Omit at call sites that never
   * dispatch panel commands — a Shape apply only ever emits `open_panel`, and
   * the file explorer only `open_file`.
   *
   * One call site can dispatch panel commands and still omits it: the gen-ui
   * widget context builds its context per click and accepts the full
   * `UiCommandSchema`, so a widget button carrying `close_panel` or
   * `toggle_panel` against a deep-linked Settings or Tasks dialog hits the
   * original bug. Known gap, not an oversight — filed as DOR-908.
   */
  panelUrlSignal?: PanelUrlSignal;
}

export interface PanelUrlSignal {
  /** Whether the panel's URL signal currently holds it open. */
  isOpen: (panel: UiPanelId) => boolean;
  /** Clear the panel's URL signal. No-op for panels that have none. */
  close: (panel: UiPanelId) => void;
}

export type EffectInvoke = <Args extends unknown[], Result>(
  receiver: unknown,
  method: (...args: Args) => Result,
  args: Args
) => Result;

/** Captured dispatch inputs shared only by internal selector groups. */
export interface CommandInvocation {
  ctx: DispatcherContext;
  store: DispatcherStore;
  command: UiCommand;
  origin: UiCommandOrigin;
  owner?: EffectOwner;
  invoke: EffectInvoke;
}
