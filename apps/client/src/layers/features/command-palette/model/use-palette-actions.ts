import { useCallback } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { useTheme } from '@/layers/shared/model';
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
 * @param closePalette - Callback to close the palette and reset state
 */
export function usePaletteActions(closePalette: () => void): PaletteActions {
  const [selectedCwd, setDir] = useDirectoryState();
  const { recordUsage } = useAgentFrecency();
  const { setTheme, theme } = useTheme();

  const setPulseOpen = useAppStore((s) => s.setPulseOpen);
  const setRelayOpen = useAppStore((s) => s.setRelayOpen);
  const setMeshOpen = useAppStore((s) => s.setMeshOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setPickerOpen = useAppStore((s) => s.setPickerOpen);
  const setPreviousCwd = useAppStore((s) => s.setPreviousCwd);

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
    [recordUsage, setDir, closePalette, selectedCwd, setPreviousCwd],
  );

  const handleFeatureAction = useCallback(
    (action: string) => {
      closePalette();
      switch (action) {
        case 'openPulse':
          setPulseOpen(true);
          break;
        case 'openRelay':
          setRelayOpen(true);
          break;
        case 'openMesh':
          setMeshOpen(true);
          break;
        case 'openSettings':
          setSettingsOpen(true);
          break;
        default:
          break;
      }
    },
    [closePalette, setPulseOpen, setRelayOpen, setMeshOpen, setSettingsOpen],
  );

  const handleQuickAction = useCallback(
    (action: string) => {
      closePalette();
      switch (action) {
        case 'discoverAgents':
          setMeshOpen(true);
          break;
        case 'browseFilesystem':
          setPickerOpen(true);
          break;
        case 'toggleTheme':
          setTheme(theme === 'dark' ? 'light' : 'dark');
          break;
        default:
          break;
      }
    },
    [closePalette, setMeshOpen, setPickerOpen, setTheme, theme],
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
