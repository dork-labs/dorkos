/**
 * The touch-chip strip — a turn's record of what it handled, kept at the turn
 * level so it survives the tool cards auto-hiding underneath it.
 *
 * @module features/chat/ui/chips/TouchChipStrip
 */
import { Fragment, useCallback, useId, useMemo } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { MessagePart } from '@dorkos/shared/types';
import { cn, getPlatform, openExternalLink, revealCanvas } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { accumulateTouchChips, type TouchChip as TouchChipData } from '../../lib/touch-chips';
import { trayExpansionKey, useTrayExpansion } from '../../model/view/use-tray-expansion';
import { CHIP_FADE, CHIP_SETTLE, LIVE_WINDOW } from './chip-motion';
import { groupChipsByVerb, VERB_ICON, VERB_LABEL, type VerbGroup } from './chip-verbs';
import { ChipPile } from './ChipPile';
import { ChipTray } from './ChipTray';
import { TouchChip } from './TouchChip';
import { useUpgradePulses } from './use-upgrade-pulse';

export interface TouchChipStripProps {
  /** The assistant message's parts, in transcript order. */
  parts: MessagePart[];
  /**
   * The session this turn belongs to — what scopes the tray's arrangement, so
   * two sessions never share one.
   */
  sessionId: string;
  /**
   * Whether the turn this strip belongs to is still running.
   *
   * The strip's live layout follows the TURN, not whichever tool happens to be
   * in flight this millisecond. Between two tool calls nothing is pending, and
   * gating on that made the row unmount and remount its way through a turn —
   * a dozen or more collapses, each one a chip strip flickering into a summary
   * line and back. A settled turn is the one thing that ends the live row, and
   * it ends it once.
   */
  turnActive?: boolean;
}

/**
 * Split the roster into what the live row shows and what has aged out of it.
 *
 * Recency is `lastSeq`, not `firstSeq`: a file touched again belongs back in the
 * row, because that is what is happening now. The window is the tail of the
 * ascending sort, so the newest touch sits on the right — chips arrive where the
 * eye already is and travel left as they age, which is the direction the pile
 * sits in.
 *
 * The pile's COUNT only ever grows — a turn accumulates chips and never loses
 * them, so `chips.length - LIVE_WINDOW` climbs and never falls. Its MEMBERSHIP
 * churns: a file touched again returns to the row and something else takes its
 * place in the pile. Nothing is ever unreachable either way, because the tray
 * holds the whole roster regardless of where a chip currently sits.
 */
function splitLiveWindow(chips: TouchChipData[]): {
  visible: TouchChipData[];
  absorbed: TouchChipData[];
} {
  const byRecency = [...chips].sort((a, b) => a.lastSeq - b.lastSeq);
  return {
    visible: byRecency.slice(-LIVE_WINDOW),
    absorbed: byRecency.slice(0, Math.max(0, byRecency.length - LIVE_WINDOW)),
  };
}

/**
 * The collapsed line as one spoken sentence: `2 read; 1 edited, 12 added, 4
 * removed; 1 fetched`.
 *
 * The line itself is glyphs and bare numbers with the words hidden beside them,
 * which a screen reader reads as a run of disconnected fragments. This gives the
 * container a single name that says the same thing in order.
 */
function summaryName(groups: VerbGroup[]): string {
  return groups
    .map((group) => {
      const said = [`${group.chips.length} ${VERB_LABEL[group.verb].toLowerCase()}`];
      if (group.additions !== undefined) said.push(`${group.additions} added`);
      if (group.deletions !== undefined) said.push(`${group.deletions} removed`);
      return said.join(', ');
    })
    .join('; ');
}

/** One verb's tally in the collapsed line: `📖 21`, or `✏️ 3 +34 −11`. */
function SummaryGroup({
  verb,
  count,
  additions,
  deletions,
}: {
  verb: TouchChipData['verb'];
  count: number;
  additions?: number;
  deletions?: number;
}) {
  return (
    <span data-testid={`chip-summary-${verb}`} className="inline-flex items-center gap-1">
      <span aria-hidden="true">{VERB_ICON[verb]}</span>
      <span className="sr-only">{VERB_LABEL[verb]}</span>
      <span className="tabular-nums">{count}</span>
      {(additions !== undefined || deletions !== undefined) && (
        <span className="tabular-nums">
          {additions !== undefined && (
            <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
          )}
          {additions !== undefined && deletions !== undefined && ' '}
          {deletions !== undefined && (
            <span className="text-red-600 dark:text-red-400">−{deletions}</span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * Derive the turn's chips and show them.
 *
 * While the turn is working, that is a bounded row of the newest few touches —
 * the strip's live state. Once nothing is live any more it is one quiet line of
 * tallies, and behind a disclosure, the full roster.
 *
 * The chips are derived on render from `parts` rather than accumulated into a
 * store, so a replayed or rehydrated transcript can never disagree with what is
 * on screen. A turn that touched nothing renders nothing at all.
 *
 * How the tray is arranged — open, filtered to one verb, in one order — is
 * deliberately NOT this component's own state. The row a strip lives in is
 * rebuilt when the turn finishes and the message trades its in-progress id for
 * its real one, which used to shut an open tray, drop its filter and re-sort it
 * at the exact moment the reader was reading it (DOR-827). It lives in
 * {@link useTrayExpansion}, filed under an identity that survives that swap
 * ({@link trayExpansionKey}), so it also survives a route change and back and
 * the virtualizer recycling the row.
 *
 * That store is per session and lives for the tab: nothing is written to disk,
 * so a reload starts every tray shut and grouped again, and no eviction is
 * needed because an entry only ever appears where a person clicked.
 *
 * **On the virtualizer.** The strip changes height three times in a turn's life:
 * when the first chip arrives, when the row collapses into the summary line, and
 * when the tray opens. Nothing here tells the transcript about any of it, and
 * nothing needs to: every virtual row is handed to `virtualizer.measureElement`,
 * which observes the row with a `ResizeObserver`, so a height change anywhere
 * inside it is re-measured on its own (`@tanstack/virtual-core`, `measureElement`
 * → `observer.observe(node)` → `resizeItem`). What this component owes the
 * virtualizer is boundedness rather than notification, and it pays that: the
 * live row is a single clipped line, the tray is capped and scrolls itself, and
 * the only animated height is the row's own 300ms collapse.
 *
 * @param props - The message's parts, the session it belongs to, and whether its
 *   turn is still running.
 */
export function TouchChipStrip({ parts, sessionId, turnActive = false }: TouchChipStripProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const chips = useMemo(() => accumulateTouchChips(parts), [parts]);
  const pulses = useUpgradePulses();
  const trayId = useId();
  const tray = useTrayExpansion(
    useMemo(() => trayExpansionKey(sessionId, parts), [sessionId, parts])
  );
  const handleOpen = useCallback((chip: TouchChipData) => {
    const embedded = getPlatform().isEmbedded;

    // A glob names a set of files, so there is no one file to open — handing
    // `src/**/*.ts` to the canvas opens an empty document named after the
    // pattern. The chip says so in its tooltip and does nothing here.
    if (chip.pattern === true) return;

    // Opening a document and SHOWING it are two different acts, and a chip owes
    // the reader both: the canvas lives in the right panel, which stays shut at
    // width zero unless something opens it (DOR-97). `revealCanvas` is the one
    // path that does all of it, shared with every agent-driven open — a chip
    // that wrote `canvasOpen` alone put the document somewhere nobody could see
    // it (DOR-829). `'user'` because a person pressed the chip, so the canvas
    // tab is their choice and is remembered as one.
    const store = useAppStore.getState();

    if (chip.kind === 'url') {
      // A url chip's target is the agent's own `WebFetch` input, so both
      // branches below are handed a string this app did not author. They clear
      // two different gates, each the right one for where the target is going.
      //
      // In the plugin there is no canvas, so the page leaves for the browser —
      // and leaving is what `openExternalLink` gates, against the scheme
      // allowlist every other exit in the app shares. This used to be a bare
      // `window.open`, which is the allowlist bypass DOR-921 named
      // (`contributing/link-dispatch-policy.md`). A refused scheme is a no-op
      // here, the same answer every other caller of the seam gives; the chip's
      // tooltip still carries the full target, so the record is not lost.
      if (embedded) {
        openExternalLink(chip.fullTarget);
        return;
      }
      // Everywhere else the target is FRAMED rather than opened, and framing has
      // its own, differently-shaped policy: `classifyBrowserTarget`
      // (`canvas/lib/browser-url.ts`) frames `http(s)` and serves `file:`, and
      // renders a refusal the reader can see for everything else. Routing this
      // branch through the link seam instead would swap that sentence for a chip
      // that does nothing, and would refuse the `file:` targets the canvas
      // serves on purpose — so the canvas keeps its own gate.
      store.openCanvasDocument({ type: 'url', url: chip.fullTarget });
      revealCanvas(store, 'user');
      return;
    }

    if (chip.kind === 'file') {
      // A file chip in the plugin is a record with a tooltip and nothing more —
      // there is no pane to open it into. Revisit when that surface is verified.
      if (embedded) return;
      store.openCanvasDocument({ type: 'file', sourcePath: chip.fullTarget });
      revealCanvas(store, 'user');
    }

    // A bare command or a search pattern has no target to open.
  }, []);

  const groups = useMemo(() => groupChipsByVerb(chips), [chips]);
  // The turn is the authority. A tool still in flight keeps the row up for a
  // strip whose caller does not track the turn (a showcase, a test), but a
  // running turn holds it up on its own — including through the gaps between
  // tool calls, where nothing is pending and the row used to collapse.
  const live = turnActive || chips.some((chip) => chip.live);
  const { visible, absorbed } = useMemo(() => splitLiveWindow(chips), [chips]);

  if (chips.length === 0) return null;

  return (
    <div data-testid="touch-chip-strip" className="mt-2 flex flex-col gap-2">
      {/* The turn finishing is a transition, not a swap: the row collapses into
          the line that replaces it, on the same curve a tool card auto-hides. */}
      <AnimatePresence initial={false} mode="wait">
        {live ? (
          <motion.div
            key="live"
            data-testid="chip-live-row"
            role="group"
            // Not "being handled now": the row holds the newest few touches,
            // and most of them have already finished.
            aria-label="Latest activity"
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={reducedMotion ? CHIP_FADE : CHIP_SETTLE}
            className="flex min-w-0 items-center gap-1.5 overflow-hidden"
          >
            {absorbed.length > 0 && (
              <ChipPile
                chips={absorbed}
                expanded={tray.expanded}
                controls={trayId}
                onExpand={tray.toggleExpanded}
              />
            )}
            {/* The chip leaving the window is not simply dropped: it shrinks away
                toward the pile, which is where it has gone. */}
            <AnimatePresence initial={false}>
              {visible.map((chip) => (
                <TouchChip
                  key={chip.key}
                  chip={chip}
                  onOpen={handleOpen}
                  animated
                  pulseUpgrade={pulses.shouldPulse(chip.key, chip.upgraded)}
                  onUpgradeSeen={pulses.acknowledge}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        ) : (
          <motion.div
            key="settled"
            data-testid="chip-summary-line"
            role="group"
            aria-label={summaryName(groups)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reducedMotion ? CHIP_FADE : CHIP_SETTLE}
            className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
          >
            {groups.map((group, index) => (
              <Fragment key={group.verb}>
                {index > 0 && <span aria-hidden="true">·</span>}
                <SummaryGroup
                  verb={group.verb}
                  count={group.chips.length}
                  additions={group.additions}
                  deletions={group.deletions}
                />
              </Fragment>
            ))}
            <span aria-hidden="true">—</span>
            <button
              type="button"
              aria-expanded={tray.expanded}
              aria-controls={trayId}
              onClick={tray.toggleExpanded}
              className={cn(
                'hover:text-foreground rounded-sm underline underline-offset-2',
                'focus-visible:ring-ring/50 outline-none focus-visible:ring-2'
              )}
            >
              {tray.expanded ? 'hide' : 'show all'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {tray.expanded && (
        <ChipTray
          id={trayId}
          chips={chips}
          onOpen={handleOpen}
          verbFilter={tray.verbFilter}
          onVerbFilterChange={tray.setVerbFilter}
          order={tray.order}
          onOrderChange={tray.setOrder}
        />
      )}
    </div>
  );
}
