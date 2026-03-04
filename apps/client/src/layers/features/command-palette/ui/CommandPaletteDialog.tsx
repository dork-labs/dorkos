import { useState, useCallback, useMemo } from 'react';
import { AnimatePresence } from 'motion/react';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { useTheme } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/layers/shared/ui';
import { useDirectoryState } from '@/layers/entities/session';
import { usePaletteItems } from '../model/use-palette-items';
import { useAgentFrecency } from '../model/use-agent-frecency';
import { useGlobalPalette } from '../model/use-global-palette';
import { usePaletteSearch } from '../model/use-palette-search';
import { AgentCommandItem } from './AgentCommandItem';
import { AgentPreviewPanel } from './AgentPreviewPanel';
import { Clock, Radio, Globe, Settings, Plus, Search, FolderOpen, Moon } from 'lucide-react';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { FuseResultMatch } from 'fuse.js';

const ICON_MAP: Record<string, React.ElementType> = {
  Clock,
  Radio,
  Globe,
  Settings,
  Plus,
  Search,
  FolderOpen,
  Moon,
};

/**
 * Global command palette dialog.
 *
 * Rendered at the app root (App.tsx). Activated via Cmd+K / Ctrl+K.
 * Uses ResponsiveDialog (Dialog on desktop, Drawer on mobile).
 * Content powered by usePaletteItems() which assembles all groups.
 *
 * The `@` prefix activates agent-only mode, hiding all non-agent groups.
 */
export function CommandPaletteDialog() {
  const { globalPaletteOpen, setGlobalPaletteOpen } = useGlobalPalette();
  const [search, setSearch] = useState('');
  const [selectedValue, setSelectedValue] = useState('');
  const [selectedCwd, setDir] = useDirectoryState();
  const { recordUsage } = useAgentFrecency();
  const { setTheme, theme } = useTheme();
  const isMobile = useIsMobile();

  const { recentAgents, allAgents, features, commands, quickActions, searchableItems } =
    usePaletteItems(selectedCwd);

  const { results, prefix } = usePaletteSearch(searchableItems, search);

  // Build lookup maps from search results for efficient access during render
  const agentMatchMap = useMemo(() => {
    const map = new Map<string, readonly FuseResultMatch[] | undefined>();
    for (const result of results) {
      if (result.item.type === 'agent') {
        map.set(result.item.id, result.matches);
      }
    }
    return map;
  }, [results]);

  // Determine which agents/features/commands are visible based on search results
  const visibleAgentIds = useMemo(() => {
    if (!search) return null; // null means "use group defaults"
    return new Set(
      results.filter((r) => r.item.type === 'agent').map((r) => r.item.id),
    );
  }, [results, search]);

  const visibleFeatureIds = useMemo(() => {
    if (!search || prefix === '@' || prefix === '>') return null;
    return new Set(
      results.filter((r) => r.item.type === 'feature').map((r) => r.item.id),
    );
  }, [results, search, prefix]);

  // Use item IDs (format: "cmd-{name}") for command visibility — matches searchableItems
  const visibleCommandIds = useMemo(() => {
    if (!search || prefix === '@') return null;
    return new Set(
      results.filter((r) => r.item.type === 'command').map((r) => r.item.id),
    );
  }, [results, search, prefix]);

  const visibleQuickActionIds = useMemo(() => {
    if (!search || prefix === '@' || prefix === '>') return null;
    return new Set(
      results.filter((r) => r.item.type === 'quick-action').map((r) => r.item.id),
    );
  }, [results, search, prefix]);

  const isAtMode = prefix === '@';
  const isCommandMode = prefix === '>';

  // Derive the currently selected agent from the cmdk selected value.
  // Agents are identified by name (cmdk uses the value prop of CommandItem).
  const selectedAgent = useMemo<AgentPathEntry | null>(() => {
    if (!selectedValue) return null;
    const allVisibleAgents = [...recentAgents, ...allAgents];
    return allVisibleAgents.find((a) => a.name === selectedValue) ?? null;
  }, [selectedValue, recentAgents, allAgents]);

  const hasAgentSelected = !isMobile && selectedAgent !== null;

  const setPulseOpen = useAppStore((s) => s.setPulseOpen);
  const setRelayOpen = useAppStore((s) => s.setRelayOpen);
  const setMeshOpen = useAppStore((s) => s.setMeshOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setPickerOpen = useAppStore((s) => s.setPickerOpen);
  const setPreviousCwd = useAppStore((s) => s.setPreviousCwd);

  const closePalette = useCallback(() => {
    setGlobalPaletteOpen(false);
    setSearch('');
    setSelectedValue('');
  }, [setGlobalPaletteOpen]);

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

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setGlobalPaletteOpen(open);
      if (!open) {
        setSearch('');
        setSelectedValue('');
      }
    },
    [setGlobalPaletteOpen],
  );

  // Zero-query state: show Recent Agents, Features, Quick Actions (default layout)
  const isZeroQuery = !search;

  // Which agents to show in the All Agents group during search
  const searchAgents = useMemo(() => {
    if (!visibleAgentIds) return allAgents;
    return allAgents.filter((a) => visibleAgentIds.has(a.id));
  }, [allAgents, visibleAgentIds]);

  // Which features to show during search
  const searchFeatures = useMemo(() => {
    if (!visibleFeatureIds) return features;
    return features.filter((f) => visibleFeatureIds.has(f.id));
  }, [features, visibleFeatureIds]);

  // Which commands to show during search
  const searchCommands = useMemo(() => {
    if (!visibleCommandIds) return commands;
    return commands.filter((cmd) => visibleCommandIds.has(`cmd-${cmd.name}`));
  }, [commands, visibleCommandIds]);

  // Which quick actions to show during search
  const searchQuickActions = useMemo(() => {
    if (!visibleQuickActionIds) return quickActions;
    return quickActions.filter((qa) => visibleQuickActionIds.has(qa.id));
  }, [quickActions, visibleQuickActionIds]);

  return (
    <ResponsiveDialog open={globalPaletteOpen} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent
        className={cn(
          'overflow-hidden p-0 transition-[max-width] duration-200',
          hasAgentSelected ? 'max-w-[720px]' : 'max-w-[480px]',
        )}
      >
        <div className="flex overflow-hidden">
          {/* Command list — takes remaining width when preview panel is absent */}
          <Command
            loop
            shouldFilter={false}
            value={selectedValue}
            onValueChange={setSelectedValue}
            className="flex-1 min-w-0"
          >
            <CommandInput
              placeholder="Search agents, features, commands..."
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>

              {/* Zero-query state: Recent Agents group */}
              {isZeroQuery && recentAgents.length > 0 && (
                <CommandGroup heading="Recent Agents">
                  {recentAgents.map((agent) => (
                    <AgentCommandItem
                      key={agent.id}
                      agent={agent}
                      isActive={agent.projectPath === selectedCwd}
                      onSelect={() => handleAgentSelect(agent)}
                    />
                  ))}
                </CommandGroup>
              )}

              {/* Search state: All Agents — always shown in @ mode or when searching */}
              {!isZeroQuery && searchAgents.length > 0 && (
                <CommandGroup heading="All Agents">
                  {searchAgents.map((agent) => (
                    <AgentCommandItem
                      key={agent.id}
                      agent={agent}
                      isActive={agent.projectPath === selectedCwd}
                      onSelect={() => handleAgentSelect(agent)}
                      nameIndices={
                        agentMatchMap
                          .get(agent.id)
                          ?.find((m) => m.key === 'name')
                          ?.indices as readonly [number, number][] | undefined
                      }
                    />
                  ))}
                </CommandGroup>
              )}

              {/* Features — hidden in @ and > mode; shown in zero-query and non-prefix search */}
              {!isAtMode && !isCommandMode && (
                <>
                  {searchFeatures.length > 0 && <CommandSeparator />}
                  <CommandGroup heading="Features">
                    {searchFeatures.map((f) => {
                      const Icon = ICON_MAP[f.icon];
                      return (
                        <CommandItem
                          key={f.id}
                          value={f.label}
                          onSelect={() => handleFeatureAction(f.action)}
                        >
                          {Icon && <Icon className="size-4" />}
                          <span>{f.label}</span>
                          {f.shortcut && (
                            <span className="text-muted-foreground ml-auto text-xs">
                              {f.shortcut}
                            </span>
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </>
              )}

              {/* Commands — hidden in @ mode; shown in > mode or when searching */}
              {!isAtMode && (isCommandMode || search.length > 0) && searchCommands.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Commands">
                    {searchCommands.map((cmd) => (
                      <CommandItem key={cmd.name} value={cmd.name}>
                        <span className="font-mono text-xs">{cmd.name}</span>
                        {cmd.description && (
                          <span className="text-muted-foreground ml-2 text-xs">
                            {cmd.description}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}

              {/* Quick Actions — hidden in @ and > mode; shown in zero-query and non-prefix search */}
              {!isAtMode && !isCommandMode && searchQuickActions.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Quick Actions">
                    {searchQuickActions.map((qa) => {
                      const Icon = ICON_MAP[qa.icon];
                      return (
                        <CommandItem
                          key={qa.id}
                          value={qa.label}
                          onSelect={() => handleQuickAction(qa.action)}
                        >
                          {Icon && <Icon className="size-4" />}
                          <span>{qa.label}</span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>

          {/* Agent preview panel — only shown on desktop when an agent item is selected */}
          <AnimatePresence>
            {hasAgentSelected && selectedAgent && (
              <AgentPreviewPanel key={selectedAgent.id} agent={selectedAgent} />
            )}
          </AnimatePresence>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
