import type { UiCommand, UiCanvasContent, UiPanelId, UiSidebarTab } from '@dorkos/shared/types';
import { canvasContentForFile } from '@dorkos/shared/viewer-registry';
import { toast } from 'sonner';
import type { PipContent } from '@/layers/shared/model';
import { canvasViewForContent } from '@dorkos/shared/canvas-view';
import { getPlatform } from './platform';
import { fireCelebration, type CelebrationOrigin } from './celebrations/celebration-effects';

/**
 * Minimal store interface the dispatcher requires.
 *
 * Declared as a structural subset so it compiles against the current
 * `useAppStore` state and is forward-compatible when canvas fields
 * (task 5.1) and sidebar-tab extensions are added.
 */
export interface DispatcherStore {
  // Sidebar
  setSidebarOpen: (open: boolean) => void;
  setSidebarActiveTab: (tab: UiSidebarTab) => void;

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

/**
 * Who initiated a UI command — decides whether a tab switch persists.
 *
 * The right panel's active tab is a per-agent stored preference (DOR-227) that
 * only an explicit human pick may rewrite. `'user'` dispatches (a click in the
 * file tree, a widget action button) route tab switches through the persisting
 * setter; `'agent'` dispatches (the `control_ui` stream, programmatic extension
 * calls) switch the visible tab view-only, so an agent opening a terminal or
 * canvas never overwrites what the user chose.
 */
export type UiCommandOrigin = 'user' | 'agent';

/** Right-panel tab id the canvas contribution registers under (init-extensions). */
const CANVAS_TAB_ID = 'canvas';

/** Right-panel tab id the browser contribution registers under (init-extensions). */
const BROWSER_TAB_ID = 'browser';

/** Right-panel tab id the terminal contribution registers under (init-extensions). */
const TERMINAL_TAB_ID = 'terminal';

/**
 * Which `ui` commands are safe to run from a surface that has **no session**
 * behind it — a room message, chiefly (DOR-1997).
 *
 * A widget in a session belongs to that session, so a command it fires lands
 * where the person who is reading it already is. A widget in a room message
 * belongs to nobody: the message may have been written by an agent nobody in
 * the room runs, or relayed in from a bridged Telegram or Slack room by a
 * stranger, and every viewer's click runs against THEIR app. So the
 * session-shaped commands are exactly the dangerous ones there — a
 * `browser_navigate` writes an arbitrary URL into whichever session's canvas
 * the reader happens to have open, with no confirmation and nothing on screen
 * to say where it came from.
 *
 * `true` means the command changes only local, visible, reversible chrome the
 * reader can undo by looking at it: a panel, the palette, a toast, the theme,
 * some confetti. Everything else is `false`, including commands that merely
 * look harmless (`open_sidebar`, `close_canvas`, `scroll_to_message`) — an
 * allowlist earns its keep by erring closed, and nothing has asked for them.
 *
 * **Exhaustive on purpose.** It is a `Record` over the whole `UiCommand` union,
 * so a 23rd command added to the schema fails this file's typecheck until
 * somebody decides which side of the line it is on. That decision must never be
 * made by a default.
 */
const LOCAL_UI_ONLY_COMMANDS: Record<UiCommand['action'], boolean> = {
  // Local, visible, reversible chrome.
  open_panel: true,
  close_panel: true,
  toggle_panel: true,
  open_command_palette: true,
  show_toast: true,
  set_theme: true,
  celebrate: true,
  // Canvas, browser, file and diff — all write into a session's own document
  // store, keyed by whichever session the reader has open.
  open_canvas: false,
  update_canvas: false,
  close_canvas: false,
  open_file: false,
  open_diff: false,
  browser_navigate: false,
  // The terminal runs commands; PiP follows a session's newest fence.
  open_terminal: false,
  open_pip: false,
  close_pip: false,
  // These move the reader somewhere, or change what their app IS.
  switch_agent: false,
  apply_layout: false,
  scroll_to_message: false,
  // Embedded-shell chrome, off the approved list rather than judged harmless.
  open_sidebar: false,
  close_sidebar: false,
  switch_sidebar_tab: false,
};

/**
 * Whether `command` may run with no session behind the widget that fired it.
 *
 * Read by `features/gen-ui`'s action state, which renders a control inert when
 * this is `false` on a session-less surface — see {@link LOCAL_UI_ONLY_COMMANDS}
 * for what the line is and why it is drawn where it is.
 *
 * @param command - The `ui` command a control is about to render or fire.
 */
export function isLocalUiOnlyCommand(command: UiCommand): boolean {
  return LOCAL_UI_ONLY_COMMANDS[command.action];
}

/** Dependencies injected by the caller. All are obtainable outside React. */
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
   * Optional extension → viewer overrides (config `workbench.defaultViewers`)
   * consulted when resolving an `open_file` command's viewer. Omit to use only
   * the built-in registry defaults.
   */
  workbenchViewerOverrides?: Record<string, string>;
  /**
   * Whether the active transport can host a server-side terminal
   * (`transport.supportsTerminal`). Consulted by `open_terminal`: when `false`
   * the action surfaces a toast instead of revealing an unavailable tab (the
   * Terminal contribution is hidden under DirectTransport/Obsidian). Omit to
   * treat the terminal as available (the web default).
   */
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

/**
 * Reader/closer for the URL half of a panel's open state.
 *
 * Built in the app entry from the router, keyed by `isDualSignalDialog`. Panels
 * with no URL signal (`relay`, `picker`) report `false` and ignore `close`.
 */
interface PanelUrlSignal {
  /** Whether the panel's URL signal currently holds it open. */
  isOpen: (panel: UiPanelId) => boolean;
  /** Clear the panel's URL signal. No-op for panels that have none. */
  close: (panel: UiPanelId) => void;
}

/**
 * Execute a UI command issued by an agent or the command palette.
 *
 * Pure side-effect dispatcher — no return value, no async, no React
 * dependencies. Callable from stream event handlers, keyboard shortcuts,
 * and command palette actions with equal safety.
 *
 * @param ctx - Injected dependencies (store snapshot, theme setter, optional handlers)
 * @param command - Validated `UiCommand` discriminated union value
 * @param origin - Who initiated the command ({@link UiCommandOrigin}); `'user'`
 *   tab switches persist the per-agent preference, `'agent'` ones are view-only.
 *   Required so every call site declares who is asking — silently defaulting is
 *   how an agent overwrites a user preference.
 */
export function executeUiCommand(
  ctx: DispatcherContext,
  command: UiCommand,
  origin: UiCommandOrigin
): void {
  // One read per dispatch, so every branch below sees the state as of now — not
  // as of whenever this context was built (see `getStore`).
  const store = ctx.getStore();

  switch (command.action) {
    // --- Panels ---
    case 'open_panel':
      setPanelOpen(ctx, store, command.panel, true);
      break;
    case 'close_panel':
      setPanelOpen(ctx, store, command.panel, false);
      break;
    case 'toggle_panel':
      togglePanel(ctx, store, command.panel);
      break;

    // --- Sidebar ---
    case 'open_sidebar':
      store.setSidebarOpen(true);
      break;
    case 'close_sidebar':
      store.setSidebarOpen(false);
      break;
    case 'switch_sidebar_tab':
      // The sidebar tab strip lives ONLY in the embedded (Obsidian) shell; the
      // web cockpit retired it for the persistent roster plus the right-panel
      // inspector. Off the embedded host there is no strip to drive, so this is a
      // deliberate, documented no-op rather than a command that silently writes
      // state no visible surface reads (the get_ui_state/control_ui tool docs and
      // the web ui-state snapshot are honest about this).
      if (getPlatform().isEmbedded) {
        store.setSidebarActiveTab(command.tab);
        store.setSidebarOpen(true);
      }
      break;

    // --- Canvas (multi-document) ---
    case 'open_canvas':
      // Edit-protection (ADR-0292) is enforced inside `openCanvasDocument`: a
      // re-activated document that is being edited keeps its content. The
      // panel-reveal side effects below run regardless so the canvas surfaces.
      if (command.content != null && !ctx.serverAppliedCanvas) {
        store.openCanvasDocument(command.content);
      }
      if (command.preferredWidth != null) {
        store.setCanvasPreferredWidth(command.preferredWidth);
      }
      // The reveal follows what the command produced: a page surfaces the
      // Browser tab, everything else the Canvas tab. An `open_canvas` carrying
      // no content asks for the canvas itself.
      if (command.content != null) {
        revealForContent(store, origin, command.content);
      } else {
        revealCanvas(store, origin);
      }
      break;
    case 'update_canvas':
      // Routed by view inside the store: a page push acts on the Browser tab's
      // document and a document push on the Canvas tab's, so an update can never
      // rewrite the thing somebody is reading in the other tab.
      // `updateActiveDocument` ignores the push while that document is being
      // edited (ADR-0292); the editor stays the sole writer.
      //
      // Deliberately does NOT reveal anything: an update is not an open, and a
      // tab that selects itself because an agent refreshed a document is the
      // pixel version of a turn that triggers itself (spec `room-canvas` §9.3).
      if (!ctx.serverAppliedCanvas) store.updateActiveDocument(command.content);
      break;
    case 'open_file': {
      // Resolve the viewer from the mime→viewer registry and open the file as a
      // new canvas document. Local paths in the built content are resolved to
      // cwd-confined URLs by the renderers at render time, so no cwd is needed
      // here. This is the client seam the file explorer and the agent's
      // `open_file` tool both drive.
      // The SAME function the server calls when it writes an agent's
      // `open_file` (spec `canvas-agent-seat` §1.2). Two answers to "what does
      // opening this file mean" gave two `sourceKey`s for one file, so one file
      // grew two tabs and the agent's one opened a text editor on a PNG.
      const content = canvasContentForFile(command.sourcePath, ctx.workbenchViewerOverrides);
      if (!ctx.serverAppliedCanvas) store.openCanvasDocument(content);
      // No viewer resolves to the embedded browser today, so every opened file
      // reveals Canvas — and the day one does, this line routes it to Browser
      // without an edit, because it asks the content rather than the extension.
      revealForContent(store, origin, content);
      break;
    }
    case 'open_diff':
      // Open (or refresh) a diff review for the file as a new canvas document.
      // The store dedups by `diff:<sourcePath>`, so a repeated open — the common
      // case when an agent edits the same file several times — re-activates and
      // refreshes the existing document instead of spawning tabs. The viewer
      // loads baseline + current itself, so no bytes travel here (mirrors
      // `open_file`). `mediaKind` is left unset; the viewer resolves text vs
      // image from the registry.
      if (!ctx.serverAppliedCanvas) {
        store.openCanvasDocument({ type: 'diff', sourcePath: command.sourcePath });
      }
      revealCanvas(store, origin);
      break;
    case 'open_terminal': {
      // No agent-side PTY spawn (PTY creation is client-driven): reveal and
      // focus the Terminal tab for the attached session, which spawns the shell
      // in the session's own worktree — so the command's `cwd` hint is advisory
      // and unused here. Web-only: under a transport without terminal support
      // (DirectTransport/Obsidian) the tab does not exist, so degrade to a toast
      // rather than focusing a phantom tab.
      if (ctx.supportsTerminal === false) {
        toast.info('Terminal is not available here', {
          description: 'Open this session in the DorkOS web app to use the terminal.',
        });
        break;
      }
      store.setRightPanelOpen(true);
      tabSetterFor(store, origin)(TERMINAL_TAB_ID);
      break;
    }
    case 'browser_navigate':
      // Append-and-activate a `browser` canvas document (dedup by URL inside the
      // store), then reveal the canvas. Appending never clobbers a document the
      // user is editing (edit-protection is per-doc; ADR-0292).
      if (!ctx.serverAppliedCanvas) {
        store.openCanvasDocument({ type: 'browser', url: command.url });
      }
      revealBrowser(store, origin);
      break;
    case 'close_canvas':
      // **Naming a document closes THAT document; naming none closes the whole
      // panel, both views with it.** The verb names the surface unless it names
      // a row — which is what `documentId` has meant on it since the room canvas
      // added the field. A document close on a session is a write the server has
      // already made, so the `canvas` event is what drops it here.
      if (command.documentId !== undefined) {
        if (!ctx.serverAppliedCanvas) store.closeCanvasDocument(command.documentId);
        break;
      }
      store.setCanvasOpen(false);
      store.setRightPanelOpen(false);
      break;

    // --- PIP (floating panel) ---
    case 'open_pip':
      // PIP follows a specific session's live widget fence, so it needs the
      // originating session. Palette/extension dispatches carry none — degrade
      // to a toast rather than popping an empty panel (mirrors open_terminal's
      // graceful degrade). The panel then follows the session's newest
      // `dorkos-ui` fence (LiveSessionWidget), so re-emitting the fence updates
      // it live.
      if (ctx.sessionId === undefined) {
        toast.info('Picture-in-picture needs an active session', {
          description: 'Open a chat session, then pop its widget out.',
        });
        break;
      }
      store.openPip({ kind: 'widget', sessionId: ctx.sessionId, title: command.title ?? 'Widget' });
      break;
    case 'close_pip':
      store.closePip();
      break;

    // --- Toast ---
    case 'show_toast':
      toast[command.level](command.message, {
        description: command.description,
      });
      break;

    // --- Theme ---
    case 'set_theme':
      ctx.setTheme(command.theme);
      break;

    // --- Scroll ---
    case 'scroll_to_message':
      ctx.scrollToMessage?.(command.messageId);
      break;

    // --- Agent ---
    case 'switch_agent':
      ctx.switchAgent?.(command.cwd);
      break;

    // --- Shape ---
    // The app shell wires `applyShape` to the real flow (POST
    // /api/shapes/:name/apply → restore chrome + live re-mount, DOR-355 task
    // 3.1). Optional-context, so unwired (e.g. Obsidian) it is a safe no-op —
    // mirrors `switch_agent`.
    case 'apply_layout':
      ctx.applyShape?.(command.shape);
      break;

    // --- Command Palette ---
    case 'open_command_palette':
      store.setGlobalPaletteOpen(true);
      break;

    // --- Celebration ---
    case 'celebrate':
      // Fire-and-forget: fireCelebration lazy-loads canvas-confetti and no-ops
      // under prefers-reduced-motion itself, so no extra guard is needed here.
      // The origin (when present) makes the burst erupt from the clicked
      // control; agent/stream celebrates omit it and fall back to a default.
      void fireCelebration({
        kind: command.kind,
        emoji: command.emoji,
        origin: ctx.celebrationOrigin,
      });
      break;

    default: {
      // Exhaustive check — TypeScript errors here if a UiCommand variant is unhandled
      const _exhaustive: never = command;
      console.warn('[UiDispatcher] Unknown action:', (_exhaustive as UiCommand).action);
    }
  }
}

// --- Internal helpers ---

/** Tab setter for an origin: user picks persist the per-agent preference, agent switches are view-only (DOR-227). */
function tabSetterFor(
  store: DispatcherStore,
  origin: UiCommandOrigin
): (tabId: string | null) => void {
  return origin === 'user' ? store.setActiveRightPanelTab : store.setActiveRightPanelTabView;
}

/**
 * Reveal one of the panel's two document views: open the right panel and select
 * that tab. `setCanvasOpen` no longer shows anything by itself — the views are
 * right-panel contributions — but it is still what the per-session persisted
 * entry and the agent's `get_ui_state` snapshot read, so a reveal keeps it
 * truthful. The tab switch respects `origin` — agent-driven reveals do not
 * persist over the user's per-agent tab preference (DOR-227).
 *
 * @param store - `useAppStore.getState()`.
 * @param origin - Who is revealing it.
 * @param tabId - The contribution id to select.
 */
function revealTab(store: DispatcherStore, origin: UiCommandOrigin, tabId: string): void {
  store.setCanvasOpen(true);
  store.setRightPanelOpen(true);
  tabSetterFor(store, origin)(tabId);
}

/**
 * Reveal the Canvas tab — documents, data, diffs, widgets and apps.
 *
 * NOTE: both the canvas and browser contributions are `visibleWhen` pathname
 * === '/session' (init-extensions), so off that route RightPanelContainer's
 * auto-select falls back to the first visible tab — the command still lands (the
 * document is persisted per session) and shows on return to /session. The room
 * routes get both tabs in a later phase of the `room-canvas` spec.
 *
 * Exported because opening a document is not the same act as showing it, and
 * anything in the app that opens one owes the reader both. A caller that
 * reaches only for `setCanvasOpen` writes a document nobody can see: the panel
 * hosting the canvas stays shut, at width zero, with no sign anything happened
 * (DOR-829). Call this instead of assembling the three writes by hand.
 *
 * @param store - `useAppStore.getState()`.
 * @param origin - Who is revealing it: `'user'` persists the tab choice as a
 *   preference, `'agent'` switches the view without overwriting one.
 */
export function revealCanvas(store: DispatcherStore, origin: UiCommandOrigin): void {
  revealTab(store, origin, CANVAS_TAB_ID);
}

/**
 * Reveal the Browser tab — the pages the embedded browser renders.
 *
 * The sibling of {@link revealCanvas}, for the same reason: a page opened into a
 * tab nobody selected is a page nobody sees.
 *
 * @param store - `useAppStore.getState()`.
 * @param origin - Who is revealing it: `'user'` persists the tab choice as a
 *   preference, `'agent'` switches the view without overwriting one.
 */
export function revealBrowser(store: DispatcherStore, origin: UiCommandOrigin): void {
  revealTab(store, origin, BROWSER_TAB_ID);
}

/**
 * Reveal whichever tab renders `content` — the reveal half of the two-view split
 * (ADR 260911-200304), asked of the content rather than of a list of commands.
 *
 * **Prefer this over {@link revealCanvas} at any call site that opens a
 * document.** Picking the reveal by hand is picking the tab by hand, and it is
 * wrong the moment the content type changes: a chip opening a `url` and then
 * revealing Canvas shows the reader an empty canvas with their page one tab
 * over, and persists the wrong tab as their preference for `'user'` origins.
 *
 * @param store - `useAppStore.getState()`.
 * @param origin - Who is revealing it: `'user'` persists the tab choice as a
 *   preference, `'agent'` switches the view without overwriting one.
 * @param content - The content that was just opened.
 */
export function revealForContent(
  store: DispatcherStore,
  origin: UiCommandOrigin,
  content: UiCanvasContent
): void {
  if (canvasViewForContent(content) === 'browser') revealBrowser(store, origin);
  else revealCanvas(store, origin);
}

function setPanelOpen(
  ctx: DispatcherContext,
  store: DispatcherStore,
  panel: UiPanelId,
  open: boolean
): void {
  const setterMap: Record<UiPanelId, (open: boolean) => void> = {
    settings: store.setSettingsOpen,
    tasks: store.setTasksOpen,
    relay: store.setRelayOpen,
    picker: store.setPickerOpen,
  };
  setterMap[panel]?.(open);
  // Closing clears every signal that can hold the panel open, not just the store
  // flag — a deep-linked Settings or Tasks dialog stays on screen otherwise
  // (DOR-839). No-op for panels with no URL signal, and when none is injected.
  if (!open) ctx.panelUrlSignal?.close(panel);
}

function togglePanel(ctx: DispatcherContext, store: DispatcherStore, panel: UiPanelId): void {
  const getterMap: Record<UiPanelId, boolean> = {
    settings: store.settingsOpen,
    tasks: store.tasksOpen,
    relay: store.relayOpen,
    picker: store.pickerOpen,
  };
  // Same open rule `DialogHost` renders by: either signal counts. Reading the
  // store alone reports a deep-linked dialog as closed, so a toggle "opens" the
  // thing already on screen instead of closing it.
  const isOpen = getterMap[panel] || (ctx.panelUrlSignal?.isOpen(panel) ?? false);
  setPanelOpen(ctx, store, panel, !isOpen);
}
