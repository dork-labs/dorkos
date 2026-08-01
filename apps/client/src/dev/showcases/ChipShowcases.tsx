import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { MessagePart } from '@dorkos/shared/types';
import { ChipPile, ChipTray, TouchChip, TouchChipStrip } from '@/layers/features/chat/ui/chips';
import type {
  TouchChip as TouchChipData,
  TouchChipVerb,
} from '@/layers/features/chat/lib/touch-chips';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

// ---------------------------------------------------------------------------
// Chip fixtures
// ---------------------------------------------------------------------------

/** Build one chip model, with the fields every chip needs already filled in. */
function chip(overrides: Partial<TouchChipData> & Pick<TouchChipData, 'key'>): TouchChipData {
  return {
    kind: 'file',
    label: 'session-store.ts',
    fullTarget: '/repo/src/session-store.ts',
    verb: 'read',
    live: false,
    error: false,
    touches: 1,
    firstSeq: 0,
    lastSeq: 0,
    history: ['read'],
    ...overrides,
  };
}

/**
 * One chip per verb, in the canonical reading order, each carrying the settled
 * anatomy the design record gives it: a repeat count, a diffstat, a hit count.
 */
const VERB_CHIPS: TouchChipData[] = [
  chip({ key: 'read', verb: 'read', touches: 2, history: ['read', 'read'] }),
  chip({
    key: 'search',
    verb: 'search',
    kind: 'command',
    label: '"Last-Event-ID"',
    fullTarget: 'Last-Event-ID',
    hits: 14,
    history: ['searched (14 hits)'],
  }),
  chip({
    key: 'edit',
    verb: 'edit',
    label: 'event-mapper.ts',
    fullTarget: '/repo/src/event-mapper.ts',
    additions: 12,
    deletions: 4,
    history: ['edited +12 −4'],
  }),
  chip({
    key: 'create',
    verb: 'create',
    label: 'use-touch-chips.ts',
    fullTarget: '/repo/src/use-touch-chips.ts',
    additions: 86,
    history: ['created +86'],
  }),
  chip({
    key: 'delete',
    verb: 'delete',
    label: 'legacy-mapper.ts',
    fullTarget: '/repo/src/legacy-mapper.ts',
    history: ['deleted'],
  }),
  chip({
    key: 'fetch',
    verb: 'fetch',
    kind: 'url',
    label: 'anthropic.com',
    fullTarget: 'https://anthropic.com/engineering',
    history: ['fetched'],
  }),
  chip({
    key: 'run',
    verb: 'run',
    kind: 'command',
    label: 'pnpm vitest run',
    fullTarget: 'pnpm vitest run',
    history: ['ran'],
  }),
];

/** The same seven, mid-flight: this is what the verb signatures animate. */
const LIVE_VERB_CHIPS: TouchChipData[] = VERB_CHIPS.map((entry) => ({ ...entry, live: true }));

/** A read that failed and an edit that failed — the destructive tint, twice. */
const ERROR_CHIPS: TouchChipData[] = [
  chip({ key: 'err-read', error: true, history: ['read'] }),
  chip({
    key: 'err-edit',
    verb: 'edit',
    label: 'event-mapper.ts',
    fullTarget: '/repo/src/event-mapper.ts',
    additions: 3,
    deletions: 1,
    error: true,
    history: ['edited +3 −1'],
  }),
];

/** A file that was read twice and then changed: the chip that morphed in place. */
const UPGRADED_CHIP = chip({
  key: 'upgraded',
  verb: 'edit',
  label: 'schemas.ts',
  fullTarget: '/repo/src/schemas.ts',
  touches: 3,
  additions: 12,
  deletions: 4,
  upgraded: true,
  history: ['read', 'read', 'edited +12 −4'],
});

/** A glob: a chip that names many files, so there is nothing single to open. */
const PATTERN_CHIP = chip({
  key: 'pattern',
  label: 'src/**/*.ts',
  fullTarget: 'src/**/*.ts',
  pattern: true,
  history: ['globbed'],
});

/** Names for a roster big enough to need the tray's filters. */
const ROSTER_FILES = [
  'session-store.ts',
  'event-mapper.ts',
  'transport.ts',
  'use-chat-session.ts',
  'MessageList.tsx',
  'chip-motion.ts',
  'touch-chips.ts',
  'agent-runtime.ts',
];

/** A turn that touched a lot: eight files, three searches, two links, two commands. */
const ROSTER: TouchChipData[] = [
  ...ROSTER_FILES.map((name, index) =>
    chip({
      key: `roster-file-${index}`,
      label: name,
      fullTarget: `/repo/src/${name}`,
      verb: index % 4 === 0 ? 'edit' : 'read',
      touches: (index % 3) + 1,
      additions: index % 4 === 0 ? 6 + index : undefined,
      deletions: index % 4 === 0 ? index : undefined,
      firstSeq: index,
      lastSeq: index,
      history: ['read'],
    })
  ),
  chip({
    key: 'roster-search-1',
    verb: 'search',
    kind: 'command',
    label: '"Last-Event-ID"',
    fullTarget: 'Last-Event-ID',
    hits: 14,
    firstSeq: 8,
    lastSeq: 8,
    history: ['searched (14 hits)'],
  }),
  chip({
    key: 'roster-search-2',
    verb: 'search',
    kind: 'command',
    label: '"accumulate"',
    fullTarget: 'accumulate',
    hits: 1,
    firstSeq: 9,
    lastSeq: 9,
    history: ['searched (1 hits)'],
  }),
  chip({
    key: 'roster-create',
    verb: 'create',
    label: 'use-touch-chips.ts',
    fullTarget: '/repo/src/use-touch-chips.ts',
    additions: 86,
    firstSeq: 10,
    lastSeq: 10,
    history: ['created +86'],
  }),
  chip({
    key: 'roster-delete',
    verb: 'delete',
    label: 'legacy-mapper.ts',
    fullTarget: '/repo/src/legacy-mapper.ts',
    firstSeq: 11,
    lastSeq: 11,
    history: ['deleted'],
  }),
  chip({
    key: 'roster-fetch-1',
    verb: 'fetch',
    kind: 'url',
    label: 'anthropic.com',
    fullTarget: 'https://anthropic.com/engineering',
    touches: 2,
    firstSeq: 12,
    lastSeq: 12,
    history: ['fetched', 'fetched'],
  }),
  chip({
    key: 'roster-fetch-2',
    verb: 'fetch',
    kind: 'url',
    label: 'developer.mozilla.org',
    fullTarget: 'https://developer.mozilla.org/en-US/docs/Web/CSS/animation',
    firstSeq: 13,
    lastSeq: 13,
    history: ['fetched'],
  }),
  chip({
    key: 'roster-run-1',
    verb: 'run',
    kind: 'command',
    label: 'pnpm vitest run',
    fullTarget: 'pnpm vitest run',
    firstSeq: 14,
    lastSeq: 14,
    history: ['ran'],
  }),
  chip({
    key: 'roster-run-2',
    verb: 'run',
    kind: 'command',
    label: 'git status --short',
    fullTarget: 'git status --short',
    firstSeq: 15,
    lastSeq: 15,
    history: ['ran'],
  }),
];

/** A turn's worth of tool calls, for the strip to fold on its own. */
function toolCall(
  toolName: string,
  input: unknown,
  options: { result?: string; status?: 'running' | 'complete' | 'error' } = {}
): MessagePart {
  return {
    type: 'tool_call',
    toolCallId: `showcase-${toolName}-${JSON.stringify(input)}`,
    toolName,
    input: JSON.stringify(input),
    result: options.result,
    status: options.status ?? 'complete',
  };
}

/** The parts a working turn has produced so far — the strip's live state. */
const WORKING_PARTS: MessagePart[] = [
  toolCall('Read', { file_path: '/repo/src/session-store.ts' }),
  toolCall('Grep', { pattern: 'Last-Event-ID' }, { result: 'Found 14 matches' }),
  toolCall('Read', { file_path: '/repo/src/event-mapper.ts' }),
  toolCall('Read', { file_path: '/repo/src/transport.ts' }),
  toolCall('Edit', {
    file_path: '/repo/src/event-mapper.ts',
    old_string: 'a\nb\nc',
    new_string: 'a\nX\nY\nZ',
  }),
  toolCall('Bash', { command: 'pnpm vitest run' }, { status: 'running' }),
];

/** The same turn, finished — every tool settled, so the strip collapses. */
const SETTLED_PARTS: MessagePart[] = WORKING_PARTS.map((part) =>
  part.type === 'tool_call' ? { ...part, status: 'complete' as const } : part
);

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
          <ChipRow
            label="Tombstone"
            chips={[VERB_CHIPS.find((entry) => entry.verb === 'delete') as TouchChipData]}
          />
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
