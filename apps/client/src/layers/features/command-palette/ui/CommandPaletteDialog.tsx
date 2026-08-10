import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { cachedSessionForCwd } from '@/layers/entities/session';
import { cn, openLink, supportsNewTab, supportsSeparateWindow } from '@/layers/shared/lib';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  ScrollArea,
} from '@/layers/shared/ui';
import { usePaletteItems } from '../model/use-palette-items';
import { useGlobalPalette } from '../model/use-global-palette';
import { usePaletteSearch } from '../model/use-palette-search';
import { usePaletteActions } from '../model/use-palette-actions';
import { useLeadingRowPin } from '../model/use-leading-row-pin';
import { AgentPreviewPanel } from './AgentPreviewPanel';
import { AgentSubMenu } from './AgentSubMenu';
import { PaletteFooter } from './PaletteFooter';
import { PalettePrefixLegend } from './PalettePrefixLegend';
import { PaletteRootPage } from './PaletteRootPage';
import { usePreviewData } from '../model/use-preview-data';
import { dialogVariants } from './palette-constants';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { resolveAgentVisual } from '@/layers/entities/agent';
// Composition across features, which the layer rules permit for UI: the
// switcher is the sidebar's component, and ⌘K is one of the three doors BC-35
// says it opens from.
import { SessionSwitcher } from '@/layers/features/dashboard-sidebar';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { FuseResultMatch } from 'fuse.js';

/**
 * Global command palette dialog.
 *
 * Rendered at the app root (App.tsx). Activated via Cmd+K / Ctrl+K.
 * Uses ResponsiveDialog (Dialog on desktop, Drawer on mobile).
 * Content powered by usePaletteItems() which assembles all groups.
 *
 * Three prefixes narrow it: `#` to channels, `@` to agents and the
 * direct messages they are in, `>` to slash commands. Each hides every group it
 * does not name.
 */
export function CommandPaletteDialog() {
  const { globalPaletteOpen, setGlobalPaletteOpen } = useGlobalPalette();
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedValue, setSelectedValue] = useState('');
  const commandRootRef = useRef<HTMLDivElement>(null);
  // cmdk pages stack: each entry is a page name; last entry is the active page
  const [pages, setPages] = useState<string[]>([]);
  // The agent that was drilled into (set when navigating to 'agent-actions' page)
  const [subMenuAgent, setSubMenuAgent] = useState<AgentPathEntry | null>(null);
  // The agent whose session switcher is up, or `null`. Held OUTSIDE the palette
  // dialog's own state: "Browse sessions…" closes the palette, and the surface
  // it opens has to outlive the one it was launched from.
  const [switcherAgent, setSwitcherAgent] = useState<AgentPathEntry | null>(null);
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
    startNewSession,
    handleFeatureAction,
    handleQuickAction,
    handleRoomSelect,
    handleSessionSelect,
    handleCommandSelect,
    recordUsage,
    selectedCwd,
  } = usePaletteActions(closePalette);

  const queryClient = useQueryClient();

  // Where an agent should open, as a `/session` href.
  //
  // It names the session up front WHEN THIS WINDOW ALREADY KNOWS IT. The route
  // loader would get there anyway — it declares its inputs, so it re-runs — but
  // only by redirecting, which costs a second navigation and a history `REPLACE`
  // the tab reconciler then has to absorb, and leaves a frame where a new tab is
  // named after an href it is about to lose. So naming it is worth doing when it
  // is free.
  //
  // When it is not known, `?session=` is left OFF and the loader resolves it on
  // arrival. An href is a string at render time and this renders for the whole
  // roster, so the alternative — asking the server per agent, per keystroke —
  // is not one; and inventing an id here is the bug this all exists to avoid
  // (DOR-928).
  //
  // It also carries ONLY this agent's directory. Inheriting the current
  // `?session=` would aim the new view at the session you were already reading,
  // under a different project — and the durable stream resolves history from
  // `?cwd=`, so that mismatch reads the wrong project's transcript.
  const agentHref = useCallback(
    (agent: AgentPathEntry) => {
      const session = cachedSessionForCwd(queryClient, agent.projectPath);
      return `/session?${new URLSearchParams({
        dir: agent.projectPath,
        ...(session ? { session } : {}),
      }).toString()}`;
    },
    [queryClient]
  );

  // "Open in New Tab" — this agent in another tab (DOR-540). The seam picks
  // whose tab: the cockpit's own strip in the desktop app, a real browser tab in
  // a browser, so the label is honest on both. Where there is no second view at
  // all (the Obsidian embed), open the agent here rather than dropping the
  // action.
  const openAgentInNewTab = useCallback(
    (agent: AgentPathEntry) => {
      if (!supportsNewTab()) {
        handleAgentSelect(agent);
        return;
      }
      openLink(agentHref(agent), { target: 'tab' });
      recordUsage(agent.id);
      closePalette();
    },
    [agentHref, handleAgentSelect, recordUsage, closePalette]
  );

  // "Open in New Window" — the same target, in a second cockpit window instead
  // of a tab. Kept as its own action rather than a modifier on the tab one:
  // parking an agent on a second monitor is a different intent from wanting
  // another tab, and this list is where a person already chooses where an agent
  // lands. It needs no surface fallback of its own — the row exists only where
  // a separate window is a real destination (see `canOpenSeparateWindow`).
  const openAgentInNewWindow = useCallback(
    (agent: AgentPathEntry) => {
      openLink(agentHref(agent), { target: 'window' });
      recordUsage(agent.id);
      closePalette();
    },
    [agentHref, recordUsage, closePalette]
  );

  // Whether to offer the "New Window" choice at all. In a browser it is not a
  // distinct destination — a window.open there is just another tab, which the
  // row above already offers — so the row is left out rather than shown greyed
  // or quietly remapped. Two rows that do the same thing is a lie (DOR-568).
  const canOpenSeparateWindow = supportsSeparateWindow();

  const {
    recentAgents,
    allAgents,
    features,
    commands,
    quickActions,
    newActions,
    rooms,
    sessions,
    continueRows,
    recent,
    searchableItems,
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

  // Which rooms the current query matches. Rooms are two item types, not one:
  // `#` addresses a channel by its name, `@` a DM by who is in it (spec `rooms`
  // §13.2), so the visible sets are derived separately and each group filters
  // its own already-ordered list — which keeps unread first rather than
  // adopting Fuse's relevance order.
  const visibleRoomIds = useMemo(() => {
    if (!search) return null;
    return new Set(results.filter((r) => r.item.type === 'room').map((r) => r.item.id));
  }, [results, search]);

  const visibleDmIds = useMemo(() => {
    if (!search) return null;
    return new Set(results.filter((r) => r.item.type === 'dm').map((r) => r.item.id));
  }, [results, search]);

  // Conversations keep Fuse's own relevance order rather than the recency order
  // they arrived in: a person who typed something is asking "which one is this",
  // not "which one is newest".
  const searchSessions = useMemo(() => {
    if (!search) return [];
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return results.flatMap((r) => {
      if (r.item.type !== 'session') return [];
      const session = byId.get(r.item.id);
      return session ? [session] : [];
    });
  }, [results, search, sessions]);

  const isAtMode = prefix === '@';
  const isCommandMode = prefix === '>';
  const isRoomMode = prefix === '#';

  // Derive the currently selected agent from the cmdk selected value.
  // Agents are identified by name (cmdk uses the value prop of CommandItem).
  const selectedAgent = useMemo<AgentPathEntry | null>(() => {
    if (!selectedValue) return null;
    const allVisibleAgents = [...recentAgents, ...allAgents];
    return allVisibleAgents.find((a) => a.name === selectedValue) ?? null;
  }, [selectedValue, recentAgents, allAgents]);

  const hasAgentSelected = !isMobile && selectedAgent !== null;

  // The conversation cmdk has highlighted, if the highlighted row is one. Both
  // lists are searched because a live conversation can be in Continue before
  // the recent-sessions query has refetched it into the window.
  const selectedSession = useMemo(() => {
    if (!selectedValue) return null;
    return (
      sessions.find((session) => session.id === selectedValue) ??
      continueRows.find((row) => row.session.id === selectedValue)?.session ??
      null
    );
  }, [selectedValue, sessions, continueRows]);

  // Preview data for the sub-menu (agent-actions page); always call hook but use subMenuAgent
  const previewData = usePreviewData(subMenuAgent?.id ?? '', subMenuAgent?.projectPath ?? '');
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const setActiveRightPanelTab = useAppStore((s) => s.setActiveRightPanelTab);

  // Navigate back one page in the pages stack
  const goBack = useCallback(() => {
    setPages((prev) => prev.slice(0, -1));
    setSubMenuAgent((prev) => (pages.length <= 1 ? null : prev));
    // Reset selected value so cmdk auto-selects the landing page's first row,
    // exactly as the forward path below does. Left at the sub-menu's row, cmdk's
    // `state.value || selectFirstItem()` guard blocks re-selection and the
    // landing page shows no highlight at all until something re-renders.
    setSelectedValue('');
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

  // Consume initial search text when palette opens (e.g. "@" from an external trigger).
  // Uses useEffect because globalPaletteInitialSearch and globalPaletteOpen are set
  // simultaneously in the store, so the value isn't available in handleOpenChange's closure.
  useEffect(() => {
    if (globalPaletteOpen && globalPaletteInitialSearch != null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- consuming initial search text injected by external trigger
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

  // Keep the highlight on the row that leads the list until the operator moves
  // it themselves — the palette's leading rows are live, and a message arriving
  // must not leave Enter aimed at a row that has slid out from under it
  // (DOR-699). The highlight goes back to following the list whenever the list
  // starts over: the palette opens, the query changes, or a page does.
  const leadingRowPin = useLeadingRowPin({
    rootRef: commandRootRef,
    activePage: page ?? 'root',
    onPin: setSelectedValue,
    resetKey: JSON.stringify([globalPaletteOpen, page ?? null, search]),
  });

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

  // Which channels and DMs to show during search
  const searchChannels = useMemo(() => {
    if (!visibleRoomIds) return rooms.channels;
    return rooms.channels.filter((room) => visibleRoomIds.has(room.id));
  }, [rooms.channels, visibleRoomIds]);

  const searchDms = useMemo(() => {
    if (!visibleDmIds) return rooms.dms;
    return rooms.dms.filter((room) => visibleDmIds.has(room.id));
  }, [rooms.dms, visibleDmIds]);

  const palette = (
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
            ref={commandRootRef}
            loop
            shouldFilter={false}
            value={selectedValue}
            onValueChange={setSelectedValue}
            onPointerMove={leadingRowPin.onPointerMove}
            className={cn(
              'min-w-0 flex-1',
              isMobile &&
                'flex flex-col [&_[cmdk-list]]:max-h-none [&_[cmdk-list]]:flex-1 [&_[cmdk-list]]:overflow-y-auto'
            )}
            onKeyDown={(e) => {
              // First, so the highlight stops following the leading row the
              // moment this keystroke is one that moves it.
              leadingRowPin.onKeyDown(e);
              // Cmd+Enter on a conversation starts a FRESH one with the same
              // agent (§15's "search + act"). It is checked before the agent
              // branch below because a session row is not an agent row and the
              // two shortcuts mean different things on them.
              if (
                e.key === 'Enter' &&
                (e.metaKey || e.ctrlKey) &&
                !page &&
                selectedSession?.cwd != null
              ) {
                e.preventDefault();
                startNewSession(selectedSession.cwd);
                closePalette();
                return;
              }
              // Cmd+Enter (or Ctrl+Enter) on root page opens selected agent in new tab
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !page && selectedAgent) {
                e.preventDefault();
                openAgentInNewTab(selectedAgent);
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
                openAgentInNewTab(subMenuAgent);
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
              // Browser tests find this input by test id, never by its placeholder.
              // The placeholder is user-facing copy and the app has several other
              // cmdk roots (the Tasks pickers, the relay popover), so neither the
              // copy nor `[cmdk-root] input` is a stable handle. Changing the
              // placeholder once already broke two chat tests silently — a
              // `getByPlaceholder` that matches nothing waits and times out rather
              // than saying what it could not find.
              data-testid="command-palette-input"
              placeholder={
                page === 'agent-actions'
                  ? `${subMenuAgent?.name ?? 'Agent'} actions...`
                  : 'Search rooms, agents, commands...'
              }
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <ScrollArea className="h-full">
                {/* Nothing matched — say so, then say what else could have been
                    typed. A dead end is the one place a legend is worth the room. */}
                <CommandEmpty>
                  <p>No results found.</p>
                  <PalettePrefixLegend className="justify-center pb-0" />
                </CommandEmpty>

                {/*
                 * Directional page transition:
                 * - Navigating forward (into sub-menu): slides from right (+16px → 0)
                 * - Navigating back (to root): slides from left (-16px → 0)
                 * AnimatePresence mode="wait" ensures old page exits before new one enters.
                 */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={page ?? 'root'}
                    // The pin scopes its leading-row read to this attribute. An
                    // exiting wrapper keeps the page name it was rendered with,
                    // so during the exit animation the active page has no rows
                    // in the DOM and the pin holds off (DOR-699 review).
                    data-palette-page={page ?? 'root'}
                    initial={{ opacity: 0, x: page ? 16 : -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: page ? -16 : 16 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                  >
                    {/* Root page content — stagger entrance re-triggers on staggerKey change */}
                    {!page && (
                      <PaletteRootPage
                        staggerKey={staggerKey}
                        isZeroQuery={isZeroQuery}
                        isAtMode={isAtMode}
                        isCommandMode={isCommandMode}
                        isRoomMode={isRoomMode}
                        search={search}
                        selectedCwd={selectedCwd}
                        selectedValue={selectedValue}
                        continueRows={continueRows}
                        recent={recent}
                        newActions={newActions}
                        searchAgents={searchAgents}
                        searchSessions={searchSessions}
                        searchFeatures={searchFeatures}
                        searchCommands={searchCommands}
                        searchQuickActions={searchQuickActions}
                        rooms={rooms}
                        searchChannels={searchChannels}
                        searchDms={searchDms}
                        agentMatchMap={agentMatchMap}
                        onFeatureAction={handleFeatureAction}
                        onQuickAction={handleQuickAction}
                        onGoToAgentActions={goToAgentActions}
                        onRoomSelect={handleRoomSelect}
                        // The conversation's OWN directory, never the one on
                        // screen: the durable stream resolves a session's
                        // history from `?cwd=`, so opening it under the wrong
                        // one reads another project's transcript (DOR-928).
                        onSessionSelect={(session) => handleSessionSelect(session.id, session.cwd)}
                        onCommandSelect={handleCommandSelect}
                      />
                    )}

                    {/* Agent actions sub-menu page */}
                    {page === 'agent-actions' && subMenuAgent && (
                      <AgentSubMenu
                        agent={subMenuAgent}
                        onOpenHere={() => handleAgentSelect(subMenuAgent)}
                        onOpenNewTab={() => openAgentInNewTab(subMenuAgent)}
                        onOpenNewWindow={
                          canOpenSeparateWindow
                            ? () => openAgentInNewWindow(subMenuAgent)
                            : undefined
                        }
                        onNewSession={() => {
                          // A NEW conversation, not this agent's latest one —
                          // otherwise this row and "Open Here" above it do the
                          // same thing (DOR-928).
                          startNewSession(subMenuAgent.projectPath);
                          recordUsage(subMenuAgent.id);
                          closePalette();
                        }}
                        onEditSettings={() => {
                          useAgentHubStore.getState().openHub(subMenuAgent.projectPath);
                          setActiveRightPanelTab('agent-hub');
                          setRightPanelOpen(true);
                          closePalette();
                        }}
                        onBrowseSessions={() => {
                          setSwitcherAgent(subMenuAgent);
                          recordUsage(subMenuAgent.id);
                          closePalette();
                        }}
                        recentSessions={previewData.recentSessions}
                        // The AGENT's directory, not the one on screen: the
                        // durable stream resolves a session's history from
                        // `?cwd=`, so inheriting the current one would read
                        // another project's transcript.
                        onSelectSession={(sessionId) => {
                          handleSessionSelect(sessionId, subMenuAgent.projectPath);
                          recordUsage(subMenuAgent.id);
                        }}
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

  // ⌘K's door into the switcher (BC-35). A sibling of the palette rather than
  // a child of it: the palette closes on select, and a surface nested inside it
  // would be torn down in the same commit that opened it. Rendering a sibling
  // feature's component is composition, which is the one cross-feature reach the
  // layer rules allow.
  return (
    <>
      {palette}
      {switcherAgent !== null && (
        <SessionSwitcher
          agentPath={switcherAgent.projectPath}
          agentName={switcherAgent.displayName ?? switcherAgent.name}
          agentVisual={resolveAgentVisual(switcherAgent)}
          open
          onOpenChange={(open) => {
            if (!open) setSwitcherAgent(null);
          }}
          onSelectSession={(sessionId) => handleSessionSelect(sessionId, switcherAgent.projectPath)}
          onNewSession={() => startNewSession(switcherAgent.projectPath)}
        />
      )}
    </>
  );
}
