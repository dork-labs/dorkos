import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  useAppStore,
  useTheme,
  useAgentCreationStore,
  useSettingsDeepLink,
  useTasksDeepLink,
  useRelayDeepLink,
} from '@/layers/shared/model';
import { useDirectoryState } from '@/layers/entities/session';
import { useAgentFrecency } from './use-agent-frecency';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface PaletteActions {
  handleAgentSelect: (agent: AgentPathEntry) => void;
  handleFeatureAction: (action: string) => void;
  handleQuickAction: (action: string) => void;
  recordUsage: (agentId: string) => void;
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
  const { recordUsage } = useAgentFrecency();
  const { setTheme, theme } = useTheme();
  const navigate = useNavigate();

  const setPreviousCwd = useAppStore((s) => s.setPreviousCwd);

  // URL-based openers for dialog panels. These update TanStack Router
  // search params; DialogHost listens to both the store flag and the URL
  // signal, so either path opens the dialog.
  const { open: openSettings } = useSettingsDeepLink();
  const { open: openTasks } = useTasksDeepLink();
  const { open: openRelay } = useRelayDeepLink();

  // Store setters for commands without a URL deep-link equivalent. Picker
  // and canvas are plain store flags; we call them directly rather than
  // routing through the UI action dispatcher because the palette only
  // needs a small subset of commands.
  const setPickerOpen = useAppStore((s) => s.setPickerOpen);
  const setCanvasOpen = useAppStore((s) => s.setCanvasOpen);

  const handleAgentSelect = useCallback(
    (agent: AgentPathEntry) => {
      // Track previous CWD for 'switch back' suggestions before switching
      if (selectedCwd && selectedCwd !== agent.projectPath) {
        setPreviousCwd(selectedCwd);
      }
      recordUsage(agent.id);
      setDir(agent.projectPath);
      closePalette();
    },
    [recordUsage, setDir, closePalette, selectedCwd, setPreviousCwd]
  );

  const handleFeatureAction = useCallback(
    (action: string) => {
      closePalette();
      switch (action) {
        case 'openTasks':
          openTasks();
          return;
        case 'openRelay':
          openRelay();
          return;
        case 'openMesh':
          navigate({ to: '/agents' });
          return;
        case 'openSettings':
          openSettings();
          return;
        case 'discoverAgents':
          navigate({ to: '/agents' });
          return;
        case 'browseFilesystem':
          setPickerOpen(true);
          return;
      }
    },
    [closePalette, navigate, openTasks, openRelay, openSettings, setPickerOpen]
  );

  const handleQuickAction = useCallback(
    (action: string) => {
      closePalette();
      switch (action) {
        case 'navigateDashboard':
          navigate({ to: '/' });
          return;
        case 'createAgent':
          useAgentCreationStore.getState().open();
          return;
        case 'toggleCanvas':
          // Read current value at dispatch time so we flip, not set.
          setCanvasOpen(!useAppStore.getState().canvasOpen);
          return;
        case 'toggleTheme':
          setTheme(theme === 'dark' ? 'light' : 'dark');
          return;
        case 'openTasks':
          openTasks();
          return;
        case 'openRelay':
          openRelay();
          return;
        case 'openMesh':
        case 'discoverAgents':
          navigate({ to: '/agents' });
          return;
        case 'openSettings':
          openSettings();
          return;
        case 'browseFilesystem':
          setPickerOpen(true);
          return;
      }
    },
    [
      closePalette,
      navigate,
      setTheme,
      theme,
      setCanvasOpen,
      setPickerOpen,
      openTasks,
      openRelay,
      openSettings,
    ]
  );

  return {
    handleAgentSelect,
    handleFeatureAction,
    handleQuickAction,
    recordUsage,
    setDir,
    selectedCwd,
  };
}
