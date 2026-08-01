import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { ChipPile, ChipTray, TouchChip, TouchChipStrip } from '@/layers/features/chat/ui/chips';
import type {
  TouchChip as TouchChipData,
  TouchChipVerb,
} from '@/layers/features/chat/lib/touch-chips';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  DELETED_CHIP,
  ERROR_CHIPS,
  LIVE_VERB_CHIPS,
  PATTERN_CHIP,
  ROSTER,
  SETTLED_PARTS,
  UPGRADED_CHIP,
  VERB_CHIPS,
  WORKING_PARTS,
} from './chip-showcase-data';

// ---------------------------------------------------------------------------
// Interactive sections
// ---------------------------------------------------------------------------

/** No chip in a showcase goes anywhere: there is no canvas behind the playground. */
function noop() {}

/**
 * The seven live signatures, with a replay control.
 *
 * Create and delete are single shots — they play as the chip lands and then
 * stay put — so the only way to watch one twice is to make the chip land again.
 * Remounting the row is exactly that.
 */
function LiveVerbRow() {
  const [take, setTake] = useState(0);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setTake((n) => n + 1)}
        className="border-border hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
      >
        <RotateCcw className="size-3" />
        Replay the arrivals
      </button>
      <div key={take} className="flex flex-wrap items-center gap-2">
        {LIVE_VERB_CHIPS.map((entry) => (
          <TouchChip key={entry.key} chip={entry} onOpen={noop} animated />
        ))}
      </div>
    </div>
  );
}

/**
 * The pile, and a way to land another chip on it.
 *
 * The wobble is spent once per arrival, so watching it fire twice means adding
 * to the pile twice — which is also the only thing that ever grows it.
 */
function PileDemo() {
  const [landed, setLanded] = useState(3);
  const stacked = ROSTER.slice(0, landed);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setLanded((n) => Math.min(n + 1, ROSTER.length))}
          className="border-border hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
        >
          Land a chip on the pile
        </button>
        <button
          type="button"
          onClick={() => setLanded(3)}
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          Reset
        </button>
      </div>
      <ChipPile chips={stacked} expanded={false} controls="playground-chip-tray" onExpand={noop} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Showcases
// ---------------------------------------------------------------------------

/** One labelled row of chips. */
function ChipRow({ label, chips }: { label: string; chips: TouchChipData[] }) {
  return (
    <div>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((entry) => (
          <TouchChip key={entry.key} chip={entry} onOpen={noop} />
        ))}
      </div>
    </div>
  );
}

/**
 * Touch-chip showcases: the verb vocabulary in every state, the pile, the tray,
 * and the whole strip end to end.
 */
export function ChipShowcases() {
  const [verb, setVerb] = useState<TouchChipVerb | 'all'>('all');
  const shown = verb === 'all' ? LIVE_VERB_CHIPS : LIVE_VERB_CHIPS.filter((c) => c.verb === verb);

  return (
    <>
      <PlaygroundSection
        title="TouchChip — every verb, live"
        description="The seven signatures, running. Read sweeps, search beams, edit scribbles with a blinking caret, create pens its own border, delete is swallowed by the bin, fetch pings, run blinks a block cursor."
      >
        <ShowcaseDemo>
          <LiveVerbRow />
        </ShowcaseDemo>

        <ShowcaseLabel>One at a time</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1">
              {(['all', ...LIVE_VERB_CHIPS.map((c) => c.verb)] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setVerb(option)}
                  aria-pressed={verb === option}
                  className={
                    verb === option
                      ? 'bg-accent text-accent-foreground rounded-md px-2 py-1 text-xs'
                      : 'text-muted-foreground hover:text-foreground rounded-md px-2 py-1 text-xs'
                  }
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {shown.map((entry) => (
                <TouchChip key={entry.key} chip={entry} onOpen={noop} animated />
              ))}
            </div>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Reduced motion</ShowcaseLabel>
        <ShowcaseDemo>
          <p className="text-muted-foreground text-sm">
            Turn on the system&apos;s reduce-motion setting and reload: every signature above stops,
            and a working chip keeps only the app&apos;s quiet breath — the same one the thinking
            label wears. There is no in-app toggle for this on purpose; the browser has to be asked,
            because that is what the real setting does.
          </p>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="TouchChip — every verb, settled"
        description="The same seven with nothing left to do. A settled chip is a fact: repeat counts, diffstats and hit counts, and no motion at all."
      >
        <ShowcaseDemo>
          <ChipRow label="Settled" chips={VERB_CHIPS} />
        </ShowcaseDemo>

        <ShowcaseDemo>
          <ChipRow
            label="Read, then changed — the chip that morphed in place"
            chips={[UPGRADED_CHIP]}
          />
        </ShowcaseDemo>

        <ShowcaseDemo>
          <div>
            <ShowcaseLabel>A pattern, not a file</ShowcaseLabel>
            <div className="flex flex-wrap items-center gap-2">
              <TouchChip chip={PATTERN_CHIP} onOpen={noop} />
            </div>
            <p className="text-muted-foreground mt-2 text-sm">
              A glob names a set of files, so this chip has nothing to open. Hover it: the tooltip
              says so rather than leaving the click to fail quietly.
            </p>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="TouchChip — failures and tombstones"
        description="A tool that failed tints its chip. A deleted file keeps its chip as a struck-through tombstone — a deletion is never invisible."
      >
        <ShowcaseDemo>
          <ChipRow label="Failed" chips={ERROR_CHIPS} />
        </ShowcaseDemo>

        <ShowcaseDemo>
          <ChipRow label="Tombstone" chips={[DELETED_CHIP]} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ChipPile — where a chip goes when it ages out"
        description="The turn's growing record as a thing rather than a number. The stack wobbles once each time a chip lands on it, and never shrinks."
      >
        <ShowcaseDemo>
          <PileDemo />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ChipTray — the full roster"
        description="Everything a busy turn touched: filterable by what happened to it, sortable by kind or by when, and bounded so it scrolls itself instead of growing the transcript."
      >
        <ShowcaseDemo>
          <ChipTray id="playground-chip-tray" chips={ROSTER} onOpen={noop} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="TouchChipStrip — a turn, working and finished"
        description="The whole strip, folding real tool calls on its own: a bounded live row with a pile while the turn works, one quiet summary line once it stops."
      >
        <ShowcaseLabel>Working</ShowcaseLabel>
        <ShowcaseDemo>
          <TouchChipStrip parts={WORKING_PARTS} />
        </ShowcaseDemo>

        <ShowcaseLabel>Finished</ShowcaseLabel>
        <ShowcaseDemo>
          <TouchChipStrip parts={SETTLED_PARTS} />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
