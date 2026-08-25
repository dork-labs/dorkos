import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore, useIsMobile, useNow } from '@/layers/shared/model';
import { cachedSessionForCwd } from '@/layers/entities/session';
import {
  cn,
  getAgentDisplayName,
  getPlatform,
  openLink,
  supportsNewTab,
  supportsSeparateWindow,
} from '@/layers/shared/lib';
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
import { usePaletteUsage } from '../model/use-palette-usage';
import { usePaletteActions } from '../model/use-palette-actions';
import { useLeadingRowPin } from '../model/use-leading-row-pin';
import { PaletteScopeChip } from './PaletteScopeChip';
import { scopeKey, type PaletteScope } from '../model/palette-scope';
import { searchHandoffTerm } from '../model/search-surface';
import type { RankedRow } from '../model/palette-ranking';
import type { SearchResult } from '../model/use-palette-search';
import { AgentPreviewPanel } from './AgentPreviewPanel';
import { AgentSubMenu } from './AgentSubMenu';
import { PaletteFooter } from './PaletteFooter';
import { PalettePrefixLegend } from './PalettePrefixLegend';
import { PaletteRootPage } from './PaletteRootPage';
import { usePreviewData } from '../model/use-preview-data';
import { dialogVariants } from './palette-constants';
import { useProfileStore } from '@/layers/features/profile';
import { resolveAgentVisual } from '@/layers/entities/agent';
import { useLegacyFrecencyMigration } from '@/layers/entities/interactions';
// Composition across features, which the layer rules permit for UI: the
// switcher is the sidebar's component, and ⌘K is one of the three doors BC-35
// says it opens from.
import { SessionSwitcher } from '@/layers/features/dashboard-sidebar';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

/**
 * How often the ranking re-reads the clock.
 *
 * A minute, matching the rows' own relative timestamps. Both of the ranker's
 * time-based signals halve over days, so a finer tick would repaint the list
 * without ever changing it — and a coarser one would leave a palette left open
 * on a second monitor ranking against a stale morning.
 */
const RANKING_CLOCK_TICK_MS = 60_000;

/**
 * Whether the caret sits before everything, with nothing selected.
 *
 * The condition that turns Backspace from "delete a character" into "drop the
 * scope". `null` — an input jsdom or a browser has not laid out yet — reads as
 * "at the start", because an input with no caret has no character to the left
 * of it either.
 *
 * **How a person gets the caret there, measured rather than assumed:** by
 * emptying the field, or by walking back with ArrowLeft. **Not** with Home —
 * cmdk's root handler claims Home and End for jumping the highlight to the
 * first and last row and calls `preventDefault` on them, so Home never reaches
 * the caret at all. Found in a browser; jsdom moves no caret and could not have
 * shown it.
 *
 * @param input - The search field, when it is mounted.
 */
function caretAtStart(input: HTMLInputElement | null): boolean {
  if (input === null) return true;
  return (input.selectionStart ?? 0) === 0 && (input.selectionEnd ?? 0) === 0;
}

/**
 * The scope the highlighted row stands for, or `null` when it stands for none.
 *
 * Read off the RANKED ROWS rather than off the corpus, so the offer can only
 * ever name something actually on screen — and so it disappears by itself once
 * a chip is up, because a scoped list holds no agent and no channel rows. That
 * is what makes "only one chip at a time" a fact about the list rather than a
 * rule somebody has to remember.
 *
 * The value it compares against is cmdk's, which is each row's own `value`
 * prop: an agent's display name (`AgentCommandItem`), a room's id
 * (`RoomCommandItem`). Matching on anything else here would silently never fire.
 *
 * @param selectedValue - What cmdk has highlighted.
 * @param bestMatch - The row lifted into its own section, when there is one.
 * @param rows - Everything else, in ranked order.
 */
function scopableRow(
  selectedValue: string,
  bestMatch: RankedRow<SearchResult> | null,
  rows: readonly RankedRow<SearchResult>[]
): PaletteScope | null {
  if (!selectedValue) return null;
  const candidates = bestMatch === null ? rows : [bestMatch, ...rows];
  for (const row of candidates) {
    const { item } = row.item;
    if (item.type === 'agent' && getAgentDisplayName(item.data) === selectedValue) {
      return { kind: 'agent', agent: item.data };
    }
    if ((item.type === 'room' || item.type === 'dm') && item.id === selectedValue) {
      return { kind: 'room', room: item.data };
    }
  }
  return null;
}

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
  // The door to the OTHER search surface — ⌘K's hand-off row opens it with
  // whatever was typed here, so nobody types the same words twice.
  const openMessageSearch = useAppStore((s) => s.openMessageSearch);
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
  // What the palette is looking inside, or `null` (design-decisions §15).
  //
  // **One chip, never two, and that is a decision rather than a limit of the
  // state shape.** The two kinds of scope select disjoint sets — an agent's
  // conversations and a channel's are different conversations — so a second
  // chip could only ever intersect two disjoint sets and empty the list.
  // Rather than offer a combination whose only outcome is "no results", the
  // corpus under a chip contains no agent and no channel row at all, so there
  // is nothing left to scope BY: the second chip is unreachable by
  // construction rather than blocked by a rule somebody has to remember.
  const [scope, setScope] = useState<PaletteScope | null>(null);
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
    setScope(null);
  }, [setGlobalPaletteOpen, clearGlobalPaletteInitialSearch]);

  const {
    handleAgentSelect,
    startNewSession,
    handleFeatureAction,
    handleQuickAction,
    handleRoomSelect,
    handleSessionSelect,
    handleCommandSelect,
    recordAgentOpened,
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
      recordAgentOpened(agent.projectPath);
      closePalette();
    },
    [agentHref, handleAgentSelect, recordAgentOpened, closePalette]
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
      recordAgentOpened(agent.projectPath);
      closePalette();
    },
    [agentHref, recordAgentOpened, closePalette]
  );

  // Whether to offer the "New Window" choice at all. In a browser it is not a
  // distinct destination — a window.open there is just another tab, which the
  // row above already offers — so the row is left out rather than shown greyed
  // or quietly remapped. Two rows that do the same thing is a lie (DOR-568).
  const canOpenSeparateWindow = supportsSeparateWindow();

  // What this person actually uses, and the clock every time-based claim in the
  // palette is measured against. Both are read here and passed down: the scorer
  // takes an injected `now` and reads no store, which is what makes its
  // ordering assertable against a fixed corpus (`palette-ranking`), and the
  // corpus takes the same clock so a row can say it is archived.
  const usage = usePaletteUsage();
  const now = useNow(RANKING_CLOCK_TICK_MS);

  const { allAgents, newActions, rooms, sessions, continueRows, recent, searchableItems } =
    usePaletteItems(selectedCwd, now);

  // Fold ⌘K's retired agent-frecency key into the one interaction store, once,
  // and delete it from the browser. Here because this dialog is mounted at the
  // app root for the whole life of the app and the roster it needs is already
  // in hand — the earliest point at which the translation can be made at all.
  useLegacyFrecencyMigration(allAgents);

  const { bestMatch, rows, prefix, term } = usePaletteSearch(searchableItems, search, {
    usage,
    now,
    scope,
  });

  const isRoomMode = prefix === '#';

  // The one row that leaves ⌘K, and only when there is something to hand
  // across. `term` rather than the raw search string: `#` and `@` are how a
  // person narrowed this list, not part of what they want looked for.
  //
  // It opens a sibling dialog rather than navigating: the message-search box is
  // a surface, not a page, so there is no href to follow and nothing for the
  // Obsidian embed's router-less shell to trip over.
  //
  // **Not in the Obsidian embed**, where there is no message index and
  // `MessageSearchDialog` deliberately does not mount: a row offering to search
  // messages there is a door onto an empty room, which is the exact dead end
  // this row was built to avoid pointing at.
  const handoffTerm = getPlatform().isEmbedded ? null : searchHandoffTerm(term);
  const searchHandoff = handoffTerm
    ? {
        term: handoffTerm,
        isScoped: scope !== null,
        onSelect: () => {
          closePalette();
          openMessageSearch(handoffTerm);
        },
      }
    : null;

  // Derive the currently selected agent from the cmdk selected value.
  // Agents are identified by name (cmdk uses the value prop of CommandItem).
  const selectedAgent = useMemo<AgentPathEntry | null>(() => {
    if (!selectedValue) return null;
    return allAgents.find((a) => a.name === selectedValue) ?? null;
  }, [selectedValue, allAgents]);

  // What the highlighted row could be scoped to, or `null` when it is not a
  // thing you can look inside. Derived rather than memoized: it is a scan over
  // rows already in hand, and nothing downstream needs its identity to hold —
  // the footer reads a boolean off it and the key handler reads it once.
  const scopableSelection = scopableRow(selectedValue, bestMatch, rows);

  // Pick up a scope, and start the query over.
  //
  // The residual query is cleared rather than kept, because what was typed was
  // how the person FOUND the chip (`@dor`, `#ship`) — carrying it forward would
  // immediately search inside the scope for the name of the scope. The mockup
  // shows exactly this: chip, then a fresh word.
  const applyScope = useCallback((next: PaletteScope) => {
    setScope(next);
    setSearch('');
    setSelectedValue('');
  }, []);

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
        setScope(null);
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
    // The scope is part of "the list started over": picking or dropping a chip
    // replaces every row, so a highlight held from the previous list would be
    // aimed at a row that is no longer there.
    resetKey: JSON.stringify([globalPaletteOpen, page ?? null, search, scope && scopeKey(scope)]),
  });

  // Zero-query state: the command center, not a ranked list of everything.
  //
  // A chip counts as having asked something, even with nothing typed after it:
  // picking a scope IS the question "what is in here", and answering it with
  // the global Continue/Recent list would ignore the chip on screen.
  const isZeroQuery = !search && scope === null;

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
              // Tab scopes the palette to the highlighted agent or channel
              // (P3 AC-3). Tab rather than Enter, because Enter already means
              // "go there" on every row in this list and one key cannot mean
              // both — and because it is the key Linear and Raycast use for
              // exactly this. Stopped as well as prevented: the dialog's focus
              // trap would otherwise move focus out of the input on the same
              // keystroke.
              //
              // **Tab still means Tab when there is nothing to scope to**, and
              // that is worth knowing rather than discovering: with a chip up
              // the list holds only conversations, so this branch does not fire
              // and Tab falls through to the dialog's focus trap, which moves
              // focus to the close button. The caret leaves the field silently.
              // Swallowing Tab unconditionally would fix that by taking away
              // the only keyboard route out of the dialog for anyone not using
              // Escape, which is the worse trade.
              if (e.key === 'Tab' && !e.shiftKey && !page && scopableSelection) {
                e.preventDefault();
                e.stopPropagation();
                applyScope(scopableSelection);
                return;
              }
              // Backspace with the caret at the very start pops the chip, and
              // leaves what was typed after it (P3 AC-3, verbatim: "without
              // clearing the residual query"). The caret test is what makes
              // the two readings one rule: an empty input has the caret at 0,
              // so the usual "backspace out of an empty box" works, and a
              // person who has typed can walk back to the start and drop the
              // scope without losing the word they came for.
              //
              // **Walk back with ArrowLeft — Home does not do it**, measured in
              // a browser: cmdk's root claims Home for jumping the highlight to
              // the first row and calls `preventDefault`, so `selectionStart`
              // never moves. See `caretAtStart`.
              if (e.key === 'Backspace' && scope && !page && caretAtStart(inputRef.current)) {
                e.preventDefault();
                setScope(null);
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
              leading={scope && !page ? <PaletteScopeChip scope={scope} /> : undefined}
              placeholder={
                page === 'agent-actions'
                  ? `${subMenuAgent?.name ?? 'Agent'} actions...`
                  : scope && !page
                    ? // The chip beside it already says what is being searched,
                      // so the placeholder says the one thing left to say.
                      'Search within…'
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
                        isRoomMode={isRoomMode}
                        scope={scope}
                        hasQuery={term.length > 0}
                        selectedCwd={selectedCwd}
                        selectedValue={selectedValue}
                        continueRows={continueRows}
                        recent={recent}
                        newActions={newActions}
                        bestMatch={bestMatch}
                        rows={rows}
                        rooms={rooms}
                        searchHandoff={searchHandoff}
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
                          recordAgentOpened(subMenuAgent.projectPath);
                          closePalette();
                        }}
                        onEditSettings={() => {
                          useProfileStore.getState().openProfileDocked(subMenuAgent.projectPath);
                          closePalette();
                        }}
                        // Offered only when there is something to browse. The
                        // count is already in hand here, and a row that opens a
                        // dialog saying "no conversations yet" is a dead end
                        // dressed as a destination — "New Session" above it is
                        // what that operator actually wants.
                        onBrowseSessions={
                          previewData.sessionCount > 0
                            ? () => {
                                setSwitcherAgent(subMenuAgent);
                                recordAgentOpened(subMenuAgent.projectPath);
                                closePalette();
                              }
                            : undefined
                        }
                        recentSessions={previewData.recentSessions}
                        // The AGENT's directory, not the one on screen: the
                        // durable stream resolves a session's history from
                        // `?cwd=`, so inheriting the current one would read
                        // another project's transcript.
                        // `handleSessionSelect` records both the conversation
                        // and the agent whose directory it travels with, so
                        // there is nothing to add here.
                        onSelectSession={(sessionId) =>
                          handleSessionSelect(sessionId, subMenuAgent.projectPath)
                        }
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </ScrollArea>
            </CommandList>
            <PaletteFooter
              page={page}
              hasAgentSelected={hasAgentSelected}
              canScope={!page && scopableSelection !== null}
              isScoped={scope !== null}
            />
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
