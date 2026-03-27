import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAppStore } from '@/layers/shared/model';
import { useTheme } from '@/layers/shared/model';
import { useDirectoryState } from '@/layers/entities/session';
import { useAgentCreationStore } from '@/layers/shared/model';
import { executeUiCommand, type DispatcherStore } from '@/layers/shared/lib';
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

/** Maps a palette feature action string to a UiCommand for the dispatcher. */
function paletteActionToUiCommand(action: string) {
  switch (action) {
    case 'openPulse':
      return { action: 'open_panel', panel: 'pulse' } as const;
    case 'openRelay':
      return { action: 'open_panel', panel: 'relay' } as const;
    case 'openMesh':
      return { action: 'open_panel', panel: 'mesh' } as const;
    case 'openSettings':
      return { action: 'open_panel', panel: 'settings' } as const;
    case 'discoverAgents':
      return { action: 'open_panel', panel: 'mesh' } as const;
    case 'browseFilesystem':
      return { action: 'open_panel', panel: 'picker' } as const;
    default:
      return null;
  }
}

/**
 * Action dispatch handlers for the command palette.
 *
 * Encapsulates the side-effect logic for selecting agents,
 * opening features, and triggering quick actions. Extracted
 * from CommandPaletteDialog to keep the component focused on rendering.
 *
 * @param closePalette - Callback to close the palette and reset state
 */
export function usePaletteActions(closePalette: () => void): PaletteActions {
  const [selectedCwd, setDir] = useDirectoryState();
  const { recordUsage } = useAgentFrecency();
  const { setTheme, theme } = useTheme();
  const navigate = useNavigate();

  const setPreviousCwd = useAppStore((s) => s.setPreviousCwd);

  // Collect the minimal store shape required by DispatcherStore from individual selectors.
  // This avoids calling useAppStore.getState() (which bypasses the mock in tests) while
  // still satisfying the DispatcherContext interface expected by executeUiCommand.
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  // Cast: AppState uses a narrow union for setSidebarActiveTab, but DispatcherStore
  // declares (tab: string) => void for forward-compatibility. The cast is safe because
  // the dispatcher only passes validated UiSidebarTab values ('sessions' | 'agents').
  const setSidebarActiveTab = useAppStore((s) => s.setSidebarActiveTab as (tab: string) => void);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const pulseOpen = useAppStore((s) => s.pulseOpen);
  const setPulseOpen = useAppStore((s) => s.setPulseOpen);
  const relayOpen = useAppStore((s) => s.relayOpen);
  const setRelayOpen = useAppStore((s) => s.setRelayOpen);
  const meshOpen = useAppStore((s) => s.meshOpen);
  const setMeshOpen = useAppStore((s) => s.setMeshOpen);
  const pickerOpen = useAppStore((s) => s.pickerOpen);
  const setPickerOpen = useAppStore((s) => s.setPickerOpen);
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);

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
      const command = paletteActionToUiCommand(action);
      if (command) {
        const store: DispatcherStore = {
          setSidebarOpen,
          setSidebarActiveTab,
          settingsOpen,
          setSettingsOpen,
          pulseOpen,
          setPulseOpen,
          relayOpen,
          setRelayOpen,
          meshOpen,
          setMeshOpen,
          pickerOpen,
          setPickerOpen,
          setGlobalPaletteOpen,
        };
        executeUiCommand({ store, setTheme }, command);
      }
    },
    [
      closePalette,
      setSidebarOpen,
      setSidebarActiveTab,
      settingsOpen,
      setSettingsOpen,
      pulseOpen,
      setPulseOpen,
      relayOpen,
      setRelayOpen,
      meshOpen,
      setMeshOpen,
      pickerOpen,
      setPickerOpen,
      setGlobalPaletteOpen,
      setTheme,
    ]
  );

  const handleQuickAction = useCallback(
    (action: string) => {
      closePalette();
      // navigateDashboard and createAgent are not expressible as UiCommands — keep as direct calls.
      if (action === 'navigateDashboard') {
        navigate({ to: '/' });
        return;
      }
      if (action === 'createAgent') {
        useAgentCreationStore.getState().open();
        return;
      }
      // toggleTheme requires the current theme value to compute the next state.
      if (action === 'toggleTheme') {
        executeUiCommand(
          {
            store: {
              setSidebarOpen,
              setSidebarActiveTab,
              settingsOpen,
              setSettingsOpen,
              pulseOpen,
              setPulseOpen,
              relayOpen,
              setRelayOpen,
              meshOpen,
              setMeshOpen,
              pickerOpen,
              setPickerOpen,
              setGlobalPaletteOpen,
            },
            setTheme,
          },
          { action: 'set_theme', theme: theme === 'dark' ? 'light' : 'dark' }
        );
        return;
      }
      const command = paletteActionToUiCommand(action);
      if (command) {
        const store: DispatcherStore = {
          setSidebarOpen,
          setSidebarActiveTab,
          settingsOpen,
          setSettingsOpen,
          pulseOpen,
          setPulseOpen,
          relayOpen,
          setRelayOpen,
          meshOpen,
          setMeshOpen,
          pickerOpen,
          setPickerOpen,
          setGlobalPaletteOpen,
        };
        executeUiCommand({ store, setTheme }, command);
      }
    },
    [
      closePalette,
      navigate,
      setSidebarOpen,
      setSidebarActiveTab,
      settingsOpen,
      setSettingsOpen,
      pulseOpen,
      setPulseOpen,
      relayOpen,
      setRelayOpen,
      meshOpen,
      setMeshOpen,
      pickerOpen,
      setPickerOpen,
      setGlobalPaletteOpen,
      setTheme,
      theme,
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
