import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
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
  ScrollArea,
} from '@/layers/shared/ui';
import { usePaletteItems } from '../model/use-palette-items';
import { useGlobalPalette } from '../model/use-global-palette';
import { usePaletteSearch } from '../model/use-palette-search';
import { usePaletteActions } from '../model/use-palette-actions';
import { AgentCommandItem } from './AgentCommandItem';
import { AgentPreviewPanel } from './AgentPreviewPanel';
import { AgentSubMenu } from './AgentSubMenu';
import { PaletteFooter } from './PaletteFooter';
import { usePreviewData } from '../model/use-preview-data';
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

/** Ease-out curve for entrances (design system standard). */
const EASE_OUT = [0, 0, 0.2, 1] as const;

/** Ease-in curve for exits (design system standard). */
const EASE_IN = [0.4, 0, 1, 1] as const;

/** Dialog entrance/exit animation variants. */
const dialogVariants = {
  hidden: { opacity: 0, scale: 0.96, y: -8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: 0.2, ease: EASE_OUT },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: -8,
    transition: { duration: 0.12, ease: EASE_IN },
  },
} as const;

/** Stagger container variants — applied to a key-changed wrapper to re-trigger on open/page. */
const listVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.035, delayChildren: 0.04 },
  },
} as const;

/** Stagger child variants — used on the first 8 items only. */
const itemVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: EASE_OUT },
  },
} as const;

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedValue, setSelectedValue] = useState('');
  // cmdk pages stack: each entry is a page name; last entry is the active page
  const [pages, setPages] = useState<string[]>([]);
  // The agent that was drilled into (set when navigating to 'agent-actions' page)
  const [subMenuAgent, setSubMenuAgent] = useState<AgentPathEntry | null>(null);
  const page = pages[pages.length - 1];
  // staggerKey drives the stagger entrance animation: incremented on dialog open
  // and page transitions, but NOT on search keystrokes.
  const [staggerKey, setStaggerKey] = useState(0);
  const isMobile = useIsMobile();

  const globalPaletteInitialSearch = useAppStore((s) => s.globalPaletteInitialSearch);
  const clearGlobalPaletteInitialSearch = useAppStore((s) => s.clearGlobalPaletteInitialSearch);

  const closePalette = useCallback(() => {
    setGlobalPaletteOpen(false);
    clearGlobalPaletteInitialSearch();
    setSearch('');
    setSelectedValue('');
    setPages([]);
    setSubMenuAgent(null);
  }, [setGlobalPaletteOpen, clearGlobalPaletteInitialSearch]);

  const {
    handleAgentSelect,
    handleFeatureAction,
    handleQuickAction,
    recordUsage,
    setDir,
    selectedCwd,
  } = usePaletteActions(closePalette);

  const {
    recentAgents,
    allAgents,
    features,
    commands,
    quickActions,
    searchableItems,
    suggestions,
  } = usePaletteItems(selectedCwd);

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
    return new Set(results.filter((r) => r.item.type === 'agent').map((r) => r.item.id));
  }, [results, search]);

  const visibleFeatureIds = useMemo(() => {
    if (!search || prefix === '@' || prefix === '>') return null;
    return new Set(results.filter((r) => r.item.type === 'feature').map((r) => r.item.id));
  }, [results, search, prefix]);

  // Use item IDs (format: "cmd-{name}") for command visibility — matches searchableItems
  const visibleCommandIds = useMemo(() => {
    if (!search || prefix === '@') return null;
    return new Set(results.filter((r) => r.item.type === 'command').map((r) => r.item.id));
  }, [results, search, prefix]);

  const visibleQuickActionIds = useMemo(() => {
    if (!search || prefix === '@' || prefix === '>') return null;
    return new Set(results.filter((r) => r.item.type === 'quick-action').map((r) => r.item.id));
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

  // Preview data for the sub-menu (agent-actions page); always call hook but use subMenuAgent
  const previewData = usePreviewData(subMenuAgent?.id ?? '', subMenuAgent?.projectPath ?? '');

  // Navigate back one page in the pages stack
  const goBack = useCallback(() => {
    setPages((prev) => prev.slice(0, -1));
    setSubMenuAgent((prev) => (pages.length <= 1 ? null : prev));
  }, [pages.length]);

  // Push the agent-actions page and set the active agent for sub-menu.
  // Bump staggerKey so items re-stagger on page entry.
  const goToAgentActions = useCallback((agent: AgentPathEntry) => {
    setSubMenuAgent(agent);
    setPages((prev) => [...prev, 'agent-actions']);
    setSearch('');
    // Reset selected value so cmdk auto-selects the first sub-menu item ("open-here")
    setSelectedValue('');
    setStaggerKey((k) => k + 1);
  }, []);

  // Consume initial search text when palette opens (e.g. "@" from AgentIdentityChip click).
  // Uses useEffect because globalPaletteInitialSearch and globalPaletteOpen are set
  // simultaneously in the store, so the value isn't available in handleOpenChange's closure.
  useEffect(() => {
    if (globalPaletteOpen && globalPaletteInitialSearch != null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- consuming initial search text injected by external trigger (e.g. "@" from AgentIdentityChip)
      setSearch(globalPaletteInitialSearch);
      clearGlobalPaletteInitialSearch();
      // Place cursor after the prefix so typing appends instead of replacing.
      // Deferred to next frame so the input value has been committed by React.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          const len = globalPaletteInitialSearch.length;
          el.setSelectionRange(len, len);
        }
      });
    }
  }, [globalPaletteOpen, globalPaletteInitialSearch, clearGlobalPaletteInitialSearch]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setGlobalPaletteOpen(open);
      if (open) {
        // Bump staggerKey so items stagger-animate on every dialog open.
        setStaggerKey((k) => k + 1);
      } else {
        setSearch('');
        setSelectedValue('');
        setPages([]);
        setSubMenuAgent(null);
      }
    },
    [setGlobalPaletteOpen]
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
          '!min-h-0 overflow-hidden p-0 transition-[max-width] duration-200',
          // Align the DialogContent close button with the CommandInput row (h-9 / px-3)
          '[&>button:last-child]:top-2 [&>button:last-child]:right-2.5',
          hasAgentSelected ? 'max-w-[640px]' : 'max-w-[480px]',
          isMobile && 'h-[85vh]'
        )}
      >
        {/* Dialog entrance animation — scale + fade + y slide */}
        <motion.div
          variants={dialogVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          className={cn('flex overflow-hidden', isMobile && 'h-full flex-col')}
        >
          {/* Command list — takes remaining width when preview panel is absent */}
          <Command
            loop
            shouldFilter={false}
            value={selectedValue}
            onValueChange={setSelectedValue}
            className={cn(
              'min-w-0 flex-1',
              isMobile &&
                'flex flex-col [&_[cmdk-list]]:max-h-none [&_[cmdk-list]]:flex-1 [&_[cmdk-list]]:overflow-y-auto'
            )}
            onKeyDown={(e) => {
              // Cmd+Enter (or Ctrl+Enter) on root page opens selected agent in new tab
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !page && selectedAgent) {
                e.preventDefault();
                const url = new URL(window.location.href);
                url.searchParams.set('dir', selectedAgent.projectPath);
                window.open(url.toString(), '_blank');
                recordUsage(selectedAgent.id);
                closePalette();
                return;
              }
              // Cmd+Enter (or Ctrl+Enter) on agent sub-menu opens in new tab
              if (
                e.key === 'Enter' &&
                (e.metaKey || e.ctrlKey) &&
                page === 'agent-actions' &&
                subMenuAgent
              ) {
                e.preventDefault();
                const url = new URL(window.location.href);
                url.searchParams.set('dir', subMenuAgent.projectPath);
                window.open(url.toString(), '_blank');
                recordUsage(subMenuAgent.id);
                closePalette();
                return;
              }
              // Backspace when input is empty pops the last page (goes back)
              if (e.key === 'Backspace' && !search && pages.length > 0) {
                e.preventDefault();
                goBack();
              }
              // Escape in a sub-menu goes back one level instead of closing the dialog
              if (e.key === 'Escape' && pages.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                goBack();
              }
            }}
          >
            {/* Breadcrumb — shown when inside a sub-menu page */}
            {pages.length > 0 && (
              <div className="text-muted-foreground flex items-center gap-1 border-b px-3 py-1.5 text-xs">
                <button
                  onClick={() => {
                    setPages([]);
                    setSubMenuAgent(null);
                    setStaggerKey((k) => k + 1);
                  }}
                  className="hover:text-foreground transition-colors"
                >
                  All
                </button>
                <span>/</span>
                <span>Agent: {subMenuAgent?.name}</span>
              </div>
            )}
            <CommandInput
              ref={inputRef}
              placeholder={
                page === 'agent-actions'
                  ? `${subMenuAgent?.name ?? 'Agent'} actions...`
                  : 'Search agents, features, commands...'
              }
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <ScrollArea className="h-full">
                <CommandEmpty>No results found.</CommandEmpty>

                {/*
                 * Directional page transition:
                 * - Navigating forward (into sub-menu): slides from right (+16px → 0)
                 * - Navigating back (to root): slides from left (-16px → 0)
                 * AnimatePresence mode="wait" ensures old page exits before new one enters.
                 */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={page ?? 'root'}
                    initial={{ opacity: 0, x: page ? 16 : -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: page ? -16 : 16 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                  >
                    {/* Root page content — stagger entrance re-triggers on staggerKey change */}
                    {!page && (
                      <motion.div
                        key={staggerKey}
                        variants={listVariants}
                        initial="hidden"
                        animate="visible"
                      >
                        {/* Contextual suggestions — shown at top of zero-query state */}
                        {isZeroQuery && suggestions.length > 0 && (
                          <CommandGroup heading="Suggestions">
                            {suggestions.map((s, index) => {
                              const Icon = ICON_MAP[s.icon];
                              return (
                                <motion.div
                                  key={s.id}
                                  variants={index < 8 ? itemVariants : undefined}
                                >
                                  <CommandItem
                                    value={s.id}
                                    onSelect={() => {
                                      if (s.action === 'openPulse') {
                                        handleFeatureAction('openPulse');
                                      } else if (s.action.startsWith('switchAgent:')) {
                                        const agentId = s.action.split(':')[1];
                                        const agent = allAgents.find((a) => a.id === agentId);
                                        if (agent) handleAgentSelect(agent);
                                      } else if (s.action.startsWith('continueSession:')) {
                                        closePalette();
                                      }
                                    }}
                                  >
                                    <motion.div
                                      whileHover={{ x: 2 }}
                                      transition={{ duration: 0.1, ease: EASE_OUT }}
                                      className="flex w-full items-center gap-2"
                                    >
                                      {Icon && <Icon className="size-4" />}
                                      <div className="min-w-0 flex-1">
                                        <span className="text-sm">{s.label}</span>
                                        <span className="text-muted-foreground ml-2 text-xs">
                                          {s.description}
                                        </span>
                                      </div>
                                    </motion.div>
                                  </CommandItem>
                                </motion.div>
                              );
                            })}
                          </CommandGroup>
                        )}

                        {/* Zero-query state: Recent Agents group */}
                        {isZeroQuery && recentAgents.length > 0 && (
                          <CommandGroup heading="Recent Agents">
                            <LayoutGroup id="cmd-palette-recent">
                              {recentAgents.map((agent, index) => (
                                <motion.div
                                  key={agent.id}
                                  variants={index < 8 ? itemVariants : undefined}
                                >
                                  <AgentCommandItem
                                    agent={agent}
                                    isActive={agent.projectPath === selectedCwd}
                                    isSelected={selectedValue === agent.name}
                                    onSelect={() => goToAgentActions(agent)}
                                  />
                                </motion.div>
                              ))}
                            </LayoutGroup>
                          </CommandGroup>
                        )}

                        {/* Search state: All Agents — always shown in @ mode or when searching */}
                        {!isZeroQuery && searchAgents.length > 0 && (
                          <CommandGroup heading="All Agents">
                            <LayoutGroup id="cmd-palette-all">
                              {searchAgents.map((agent, index) => (
                                <motion.div
                                  key={agent.id}
                                  variants={index < 8 ? itemVariants : undefined}
                                >
                                  <AgentCommandItem
                                    agent={agent}
                                    isActive={agent.projectPath === selectedCwd}
                                    isSelected={selectedValue === agent.name}
                                    onSelect={() => goToAgentActions(agent)}
                                    nameIndices={
                                      agentMatchMap.get(agent.id)?.find((m) => m.key === 'name')
                                        ?.indices as readonly [number, number][] | undefined
                                    }
                                  />
                                </motion.div>
                              ))}
                            </LayoutGroup>
                          </CommandGroup>
                        )}

                        {/* Features — hidden in @ and > mode; shown in zero-query and non-prefix search */}
                        {!isAtMode && !isCommandMode && searchFeatures.length > 0 && (
                          <>
                            <CommandSeparator />
                            <CommandGroup heading="Features">
                              {searchFeatures.map((f, index) => {
                                const Icon = ICON_MAP[f.icon];
                                return (
                                  <motion.div
                                    key={f.id}
                                    variants={index < 8 ? itemVariants : undefined}
                                  >
                                    <CommandItem
                                      value={f.label}
                                      onSelect={() => handleFeatureAction(f.action)}
                                    >
                                      <motion.div
                                        whileHover={{ x: 2 }}
                                        transition={{ duration: 0.1, ease: EASE_OUT }}
                                        className="flex w-full items-center gap-2"
                                      >
                                        {Icon && <Icon className="size-4" />}
                                        <span>{f.label}</span>
                                        {f.shortcut && (
                                          <span className="text-muted-foreground ml-auto text-xs">
                                            {f.shortcut}
                                          </span>
                                        )}
                                      </motion.div>
                                    </CommandItem>
                                  </motion.div>
                                );
                              })}
                            </CommandGroup>
                          </>
                        )}

                        {/* Commands — hidden in @ mode; shown in > mode or when searching */}
                        {!isAtMode &&
                          (isCommandMode || search.length > 0) &&
                          searchCommands.length > 0 && (
                            <>
                              <CommandSeparator />
                              <CommandGroup heading="Commands">
                                {searchCommands.map((cmd, index) => (
                                  <motion.div
                                    key={cmd.name}
                                    variants={index < 8 ? itemVariants : undefined}
                                  >
                                    <CommandItem value={cmd.name}>
                                      <motion.div
                                        whileHover={{ x: 2 }}
                                        transition={{ duration: 0.1, ease: EASE_OUT }}
                                        className="flex w-full items-center gap-2"
                                      >
                                        <span className="font-mono text-xs">{cmd.name}</span>
                                        {cmd.description && (
                                          <span className="text-muted-foreground ml-2 text-xs">
                                            {cmd.description}
                                          </span>
                                        )}
                                      </motion.div>
                                    </CommandItem>
                                  </motion.div>
                                ))}
                              </CommandGroup>
                            </>
                          )}

                        {/* Quick Actions — hidden in @ and > mode; shown in zero-query and non-prefix search */}
                        {!isAtMode && !isCommandMode && searchQuickActions.length > 0 && (
                          <>
                            <CommandSeparator />
                            <CommandGroup heading="Quick Actions">
                              {searchQuickActions.map((qa, index) => {
                                const Icon = ICON_MAP[qa.icon];
                                return (
                                  <motion.div
                                    key={qa.id}
                                    variants={index < 8 ? itemVariants : undefined}
                                  >
                                    <CommandItem
                                      value={qa.label}
                                      onSelect={() => handleQuickAction(qa.action)}
                                    >
                                      <motion.div
                                        whileHover={{ x: 2 }}
                                        transition={{ duration: 0.1, ease: EASE_OUT }}
                                        className="flex w-full items-center gap-2"
                                      >
                                        {Icon && <Icon className="size-4" />}
                                        <span>{qa.label}</span>
                                      </motion.div>
                                    </CommandItem>
                                  </motion.div>
                                );
                              })}
                            </CommandGroup>
                          </>
                        )}
                      </motion.div>
                    )}

                    {/* Agent actions sub-menu page */}
                    {page === 'agent-actions' && subMenuAgent && (
                      <AgentSubMenu
                        agent={subMenuAgent}
                        onOpenHere={() => handleAgentSelect(subMenuAgent)}
                        onOpenNewTab={() => {
                          const url = new URL(window.location.href);
                          url.searchParams.set('dir', subMenuAgent.projectPath);
                          window.open(url.toString(), '_blank');
                          recordUsage(subMenuAgent.id);
                          closePalette();
                        }}
                        onNewSession={() => {
                          setDir(subMenuAgent.projectPath);
                          recordUsage(subMenuAgent.id);
                          closePalette();
                        }}
                        recentSessions={previewData.recentSessions}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </ScrollArea>
            </CommandList>
            <PaletteFooter page={page} hasAgentSelected={hasAgentSelected} />
          </Command>

          {/* Agent preview panel — only shown on desktop when an agent item is selected */}
          <AnimatePresence>
            {hasAgentSelected && selectedAgent && (
              <AgentPreviewPanel key={selectedAgent.id} agent={selectedAgent} />
            )}
          </AnimatePresence>
        </motion.div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
