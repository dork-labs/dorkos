import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAppStore,
  useTheme,
  useAgentCreationStore,
  useImportProjectsStore,
  useSettingsDeepLink,
  useTasksDeepLink,
  useOpenConnections,
  useFeedbackDialogStore,
  useTransport,
} from '@/layers/shared/model';
import { openLink, reportClientError } from '@/layers/shared/lib';
import {
  useDirectoryState,
  useStartNewSession,
  useSessionChatStore,
  resolveSessionForCwd,
  notifySessionLookupFailed,
} from '@/layers/entities/session';
import type { RoomSummary } from '@/layers/entities/room';
import { useInteractionStore } from '@/layers/entities/interactions';
import { PROFILE_PANEL_ID } from '@/layers/features/profile';
import { composeCommandDraft } from './palette-command-draft';
import { runPaletteCommandHandler } from './palette-command-handlers';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface PaletteActions {
  handleAgentSelect: (agent: AgentPathEntry) => void;
  /** Start a brand-new conversation, optionally with a named agent. */
  startNewSession: (dir?: string) => void;
  handleFeatureAction: (action: string) => void;
  handleQuickAction: (action: string) => void;
  handleRoomSelect: (room: RoomSummary) => void;
  /** Open a conversation that already exists, in the directory it belongs to. */
  handleSessionSelect: (sessionId: string, dir?: string | null) => void;
  /** Put a slash command into the active conversation's composer and go there. */
  handleCommandSelect: (command: string) => void;
  /**
   * Record that the operator reached an agent, for the rows that open one
   * without going through {@link PaletteActions.handleAgentSelect} — a second
   * tab, a second window, a fresh conversation.
   */
  recordAgentOpened: (projectPath: string) => void;
  setDir: (dir: string) => void;
  selectedCwd: string | null;
}

/**
 * Action dispatch handlers for the command palette.
 *
 * Encapsulates the side-effect logic for selecting agents,
 * opening features, and triggering quick actions. Extracted
 * from CommandPaletteDialog to keep the component focused on rendering.
 *
 * Dialog opens (settings, tasks, relay, mesh) are routed through URL
 * deep-link hooks so the palette participates in browser history and
 * can be reopened from a copied URL. Panels without a URL signal yet
 * (directory picker) and bare UI toggles (canvas, theme) fall back to
 * the store setters directly.
 *
 * @param closePalette - Callback to close the palette and reset state
 */
export function usePaletteActions(closePalette: () => void): PaletteActions {
  const [selectedCwd, setDir] = useDirectoryState();
  const { setTheme, theme } = useTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const transport = useTransport();

  const setPreviousCwd = useAppStore((s) => s.setPreviousCwd);
  const openFeedback = useFeedbackDialogStore((s) => s.openFeedback);

  // URL-based openers for dialog panels. These update TanStack Router
  // search params; DialogHost listens to both the store flag and the URL
  // signal, so either path opens the dialog.
  const { open: openSettings } = useSettingsDeepLink();
  const { open: openTasks } = useTasksDeepLink();
  const openConnections = useOpenConnections();

  // Store setters for commands without a URL deep-link equivalent. Picker
  // and canvas are plain store flags; we call them directly rather than
  // routing through the UI action dispatcher because the palette only
  // needs a small subset of commands.
  const setPickerOpen = useAppStore((s) => s.setPickerOpen);
  const setCanvasOpen = useAppStore((s) => s.setCanvasOpen);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const setActiveRightPanelTab = useAppStore((s) => s.setActiveRightPanelTab);

  /**
   * Record that the operator reached an agent.
   *
   * Keyed by the DIRECTORY, which is what every other surface in the cockpit
   * records and what the palette's own corpus ranks agents under. It used to be
   * written twice — once here by mesh id into ⌘K's private frecency key, once
   * by directory into the shared store — and the two could disagree about the
   * same act; there is one writer now.
   */
  const recordAgentOpened = useCallback((projectPath: string) => {
    useInteractionStore.getState().recordOpened('agent', projectPath);
  }, []);

  const handleAgentSelect = useCallback(
    (agent: AgentPathEntry) => {
      // The palette closes at once — it has done its job either way — but the
      // switch-back target and the frecency bump wait until the agent actually
      // opens. `setDir` resolves which conversation that is, which can fail or
      // be overtaken; recording either up front would rank an agent you never
      // reached and offer "switch back" to a directory you never left
      // (DOR-928).
      const leaving = selectedCwd;
      setDir(agent.projectPath, {
        onOpened: () => {
          if (leaving && leaving !== agent.projectPath) setPreviousCwd(leaving);
          recordAgentOpened(agent.projectPath);
        },
      });
      closePalette();
    },
    [recordAgentOpened, setDir, closePalette, selectedCwd, setPreviousCwd]
  );

  // Shared with the sidebar and the chat header's agent chip; carries the
  // router-less embed branch. See `useStartNewSession` for why it is not
  // `setDir`.
  const startNewSession = useStartNewSession();

  /**
   * Open a room. A room's identity travels as a `/channels` search param, and
   * `id` is all of it — every room the palette can offer is a room you open
   * directly (ADR 260728-022013).
   *
   * The open is recorded, because ranking reads it: a channel you keep coming
   * back to should be easier to reach the next time you type half its name
   * (design-decisions §15). It does not displace unread — that stays a separate,
   * larger signal in the ranker, because a message nobody has read is a fact and
   * this is only a habit.
   */
  const handleRoomSelect = useCallback(
    (room: RoomSummary) => {
      useInteractionStore.getState().recordOpened('room', room.id);
      closePalette();
      navigate({ to: '/channels', search: { id: room.id } });
    },
    [closePalette, navigate]
  );

  /**
   * Open a conversation the palette already names — the "Continue: …"
   * suggestion, or a row under an agent's Recent Sessions.
   *
   * `dir` travels with it and is not optional in practice: the durable stream
   * resolves a session's history from `?cwd=`, so a session id arriving under
   * the directory you happened to be in reads another project's transcript.
   * Callers pass the directory the session belongs to — the agent's own, in the
   * sub-menu's case, which is rarely the one on screen.
   *
   * The open is recorded under `session:<id>`, which is what makes a
   * conversation you were just in rank above one you have not touched in a week
   * the next time you go looking for it (design-decisions §15) — **and under
   * `agent:<dir>` as well**, because opening a conversation is also reaching the
   * agent whose project it runs in. The sidebar's own row has always written
   * both (`SidebarChrome.openSession`); ⌘K wrote only the first, so the same act
   * built a weaker memory depending on which door a person used.
   *
   * @param sessionId - The conversation to open.
   * @param dir - The working directory it belongs to.
   */
  const handleSessionSelect = useCallback(
    (sessionId: string, dir?: string | null) => {
      useInteractionStore.getState().recordOpened('session', sessionId);
      if (dir) recordAgentOpened(dir);
      closePalette();
      navigate({ to: '/session', search: { session: sessionId, dir: dir ?? undefined } });
    },
    [closePalette, navigate, recordAgentOpened]
  );

  /**
   * Put a slash command in the composer of the conversation it would run in,
   * and go there.
   *
   * **It types, it does not send.** A palette row is chosen from anywhere in
   * the cockpit, often without the target conversation on screen, and half
   * these commands (`/clear`, `/compact`) are not ones to fire at an agent on a
   * single keystroke with nothing named. Landing in the conversation with the
   * command already typed keeps the last, cheapest confirmation — pressing
   * Enter — with the person, and puts the caret where an argument goes.
   *
   * Which conversation is the same answer every other agent-switch surface
   * gets, through the shared resolver: the directory's most recent session, or
   * a fresh id when it genuinely has none. `null` means the lookup FAILED,
   * which is not a licence to mint — so it says so and stays put.
   *
   * An existing draft survives as the command's ARGUMENT — see
   * {@link composeCommandDraft} for why it cannot simply be joined onto the end.
   * Unsent text is the one thing in a session's chat state the server cannot
   * hand back (DOR-480), so nothing a person typed is dropped.
   */
  const handleCommandSelect = useCallback(
    (command: string) => {
      closePalette();
      void resolveSessionForCwd({ queryClient, transport }, selectedCwd)
        .then((resolved) => {
          if (resolved === null) {
            notifySessionLookupFailed(selectedCwd);
            return;
          }
          // Recorded here and not before the resolve, for the reason
          // `handleAgentSelect` defers its own write: the lookup can fail, and
          // a conversation nobody reached is not one to rank (DOR-928). This
          // row lands a person IN a conversation exactly as the session rows
          // above do, so it leaves the same memory behind.
          useInteractionStore.getState().recordOpened('session', resolved.sessionId);
          if (selectedCwd) recordAgentOpened(selectedCwd);
          const store = useSessionChatStore.getState();
          const draft = store.getSession(resolved.sessionId).input;
          store.updateSession(resolved.sessionId, {
            input: composeCommandDraft(command, draft),
          });
          void navigate({
            to: '/session',
            search: { session: resolved.sessionId, dir: selectedCwd ?? undefined },
          });
        })
        .catch((error: unknown) => {
          // `resolveSessionForCwd` handles its own failures, so anything landing
          // here is a defect in this callback — and without the catch it is an
          // unhandled rejection and a row that died in silence.
          reportClientError(transport, error);
          notifySessionLookupFailed(selectedCwd);
        });
    },
    [closePalette, navigate, queryClient, transport, selectedCwd, recordAgentOpened]
  );

  /**
   * Run whatever an extension registered under an action id the cockpit's own
   * switches do not know.
   *
   * The two dispatchers below are closed switches over the cockpit's built-in
   * actions, and extensions contribute rows with ids of their own
   * (`ext:<extension>:<command>`). Without this they fell off the end: the row
   * was offered, choosing it closed the palette, and nothing happened. An id
   * nobody claims is said out loud rather than swallowed — it means an
   * extension contributed a row and never registered its handler, which is a
   * bug in that extension and invisible otherwise.
   */
  const runExtensionAction = useCallback((action: string) => {
    if (runPaletteCommandHandler(action)) return;
    console.warn(`[command-palette] no handler registered for action "${action}"`);
  }, []);

  const handleFeatureAction = useCallback(
    (action: string) => {
      closePalette();
      switch (action) {
        case 'openTasks':
          openTasks();
          return;
        case 'openRelay':
          openConnections('messaging');
          return;
        case 'openMesh':
          navigate({ to: '/team' });
          return;
        case 'openSettings':
          openSettings();
          return;
        case 'discoverAgents':
          useImportProjectsStore.getState().open();
          return;
        case 'browseFilesystem':
          setPickerOpen(true);
          return;
        case 'openAgentProfile':
          // Open the right panel on the Profile tab for the current agent.
          setActiveRightPanelTab(PROFILE_PANEL_ID);
          setRightPanelOpen(true);
          return;
        default:
          runExtensionAction(action);
          return;
      }
    },
    [
      closePalette,
      navigate,
      openTasks,
      openConnections,
      openSettings,
      setPickerOpen,
      setActiveRightPanelTab,
      setRightPanelOpen,
      runExtensionAction,
    ]
  );

  const handleQuickAction = useCallback(
    (action: string) => {
      closePalette();
      switch (action) {
        case 'navigateDashboard':
          navigate({ to: '/' });
          return;
        case 'newSession':
          startNewSession();
          return;
        case 'openDevPlayground':
          // `/dev` mounts outside the router (see `Root` in main.tsx), so the
          // seam classifies it as external and gives it its own window — an
          // in-window tab could not hold it.
          openLink('/dev');
          return;
        case 'toggleDevtools':
          useAppStore.getState().toggleDevtools();
          return;
        case 'toggleRouterDevtools':
          useAppStore.getState().toggleRouterDevtools();
          return;
        case 'createAgent':
          useAgentCreationStore.getState().open();
          return;
        case 'switchShape':
          useAppStore.getState().setShapeSwitcherOpen(true);
          return;
        case 'openControlCenter':
          useAppStore.getState().setControlCenterOpen(true);
          return;
        case 'toggleCanvas':
          // Read current value at dispatch time so we flip, not set.
          setCanvasOpen(!useAppStore.getState().canvasOpen);
          return;
        case 'toggleTheme':
          setTheme(theme === 'dark' ? 'light' : 'dark');
          return;
        case 'openFeedback':
          openFeedback();
          return;
        case 'openTasks':
          openTasks();
          return;
        case 'openRelay':
          openConnections('messaging');
          return;
        case 'openMesh':
          navigate({ to: '/team' });
          return;
        case 'discoverAgents':
          useImportProjectsStore.getState().open();
          return;
        case 'openSettings':
          openSettings();
          return;
        case 'browseFilesystem':
          setPickerOpen(true);
          return;
        default:
          runExtensionAction(action);
          return;
      }
    },
    [
      closePalette,
      navigate,
      runExtensionAction,
      setTheme,
      theme,
      setCanvasOpen,
      setPickerOpen,
      openTasks,
      openConnections,
      openSettings,
      openFeedback,
      // Load-bearing: it closes over the ACTIVE agent, and the palette is
      // mounted for the whole life of the app. Omit it and this handler is
      // built once at boot and keeps whatever agent was selected then, so
      // "New Session" opens a conversation somewhere you are not (DOR-928).
      startNewSession,
    ]
  );

  return {
    handleAgentSelect,
    startNewSession,
    handleFeatureAction,
    handleQuickAction,
    handleRoomSelect,
    handleSessionSelect,
    handleCommandSelect,
    recordAgentOpened,
    setDir,
    selectedCwd,
  };
}
