import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import { WidgetRenderer, WidgetErrorCard, WidgetSkeleton } from '@/layers/features/gen-ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

const STAT_CARD: WidgetDocument = {
  version: 1,
  title: 'Weather',
  root: {
    type: 'card',
    title: 'San Francisco',
    description: 'Updated just now',
    children: [
      {
        type: 'stat',
        label: 'Temperature',
        value: '64°F',
        delta: { value: '+2°', direction: 'up' },
        hint: 'Clear skies',
      },
      { type: 'divider' },
      { type: 'progress', label: 'Humidity', value: 72 },
    ],
  },
};

const TABLE: WidgetDocument = {
  version: 1,
  root: {
    type: 'table',
    columns: [
      { key: 'id', label: 'Issue' },
      { key: 'title', label: 'Title' },
      { key: 'points', label: 'Points', align: 'right' },
    ],
    rows: [
      { id: 'DOR-1', title: 'Ship widgets', points: 5 },
      { id: 'DOR-2', title: 'Wire the canvas', points: 3 },
      { id: 'DOR-3', title: 'Triage backlog', points: null },
    ],
  },
};

const CHART: WidgetDocument = {
  version: 1,
  root: {
    type: 'stack',
    direction: 'vertical',
    gap: 'lg',
    children: [
      {
        type: 'chart',
        kind: 'bar',
        data: [
          { label: 'Mon', value: 12 },
          { label: 'Tue', value: 19 },
          { label: 'Wed', value: 7 },
          { label: 'Thu', value: 22 },
          { label: 'Fri', value: 15 },
        ],
      },
      {
        type: 'chart',
        kind: 'line',
        height: 120,
        data: [
          { label: 'W1', value: 4 },
          { label: 'W2', value: 11 },
          { label: 'W3', value: 8 },
          { label: 'W4', value: 17 },
        ],
      },
      {
        type: 'chart',
        kind: 'area',
        height: 120,
        data: [
          { label: 'Q1', value: 20 },
          { label: 'Q2', value: 35 },
          { label: 'Q3', value: 28 },
          { label: 'Q4', value: 42 },
        ],
      },
      {
        type: 'chart',
        kind: 'pie',
        data: [
          { label: 'Claude', value: 60 },
          { label: 'Codex', value: 30 },
          { label: 'OpenCode', value: 10 },
        ],
      },
      // Single-datum pie — regression guard for the full-circle special case.
      {
        type: 'chart',
        kind: 'pie',
        height: 100,
        data: [{ label: 'All traffic', value: 100 }],
      },
    ],
  },
};

/** A tiny inline thumbnail so the List showcase renders offline (no network). */
const THUMB =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' rx='6' fill='%236366f1'/><circle cx='20' cy='16' r='7' fill='white' opacity='0.9'/><rect x='8' y='26' width='24' height='8' rx='4' fill='white' opacity='0.7'/></svg>";

const LIST: WidgetDocument = {
  version: 1,
  root: {
    type: 'list',
    items: [
      {
        title: 'Mechanical keyboard',
        subtitle: 'Tactile, hot-swappable',
        image: THUMB,
        meta: '$129.00',
        badge: { text: 'in stock', tone: 'success' },
      },
      {
        title: 'Deploy to production',
        subtitle: 'main → prod',
        icon: 'rocket',
        badge: { text: 'done', tone: 'success' },
      },
      {
        title: 'Run migrations',
        subtitle: 'pending approval',
        icon: 'database',
        badge: { text: 'blocked', tone: 'warning' },
        actions: [{ kind: 'url', href: 'https://dorkos.ai' }],
      },
      {
        title: 'Rotate secrets',
        icon: 'lock',
        badge: { text: 'overdue', tone: 'error' },
      },
    ],
  },
};

const TIMELINE: WidgetDocument = {
  version: 1,
  root: {
    type: 'timeline',
    items: [
      { time: '08:15', title: 'Depart San Francisco', subtitle: 'SFO → JFK', status: 'done' },
      { time: '16:40', title: 'Arrive New York', subtitle: 'Check in at hotel', status: 'done' },
      { time: 'Now', title: 'Team dinner', subtitle: 'Little Italy', status: 'active' },
      {
        time: 'Tomorrow',
        title: 'Conference keynote',
        subtitle: 'Javits Center',
        status: 'upcoming',
      },
    ],
  },
};

const CHECKLIST: WidgetDocument = {
  version: 1,
  title: 'Packing list',
  root: {
    type: 'checklist',
    items: [
      { label: 'Passport', checked: true },
      { label: 'Laptop + charger', checked: true, note: 'Plus a spare USB-C cable' },
      { label: 'Noise-cancelling headphones' },
      { label: 'Reusable water bottle', note: 'Empty it before security' },
    ],
    action: { kind: 'agent', id: 'confirm-packing' },
    submitLabel: 'Confirm packed',
  },
};

const COMPARE: WidgetDocument = {
  version: 1,
  root: {
    type: 'compare',
    options: [{ name: 'Air 13"' }, { name: 'Pro 14"', recommended: true }, { name: 'Pro 16"' }],
    rows: [
      { label: 'Price', values: ['$1,099', '$1,999', '$2,499'] },
      { label: 'Memory (GB)', values: [16, 18, 36] },
      { label: 'Battery (hrs)', values: [18, 22, 24] },
      { label: 'ProMotion display', values: [false, true, true] },
      { label: 'Ports', values: [2, 3, 3] },
    ],
  },
};

const RATING: WidgetDocument = {
  version: 1,
  root: {
    type: 'rating',
    value: 4.6,
    count: 2384,
    label: 'Average customer rating',
  },
};

/** Four moods (no `celebrating` — its confetti burst isn't a static-showcase citizen) plus a celebrate command demo. */
const MOOD: WidgetDocument = {
  version: 1,
  root: {
    type: 'stack',
    direction: 'horizontal',
    gap: 'lg',
    children: [
      { type: 'mood', emotion: 'happy' },
      { type: 'mood', emotion: 'thinking' },
      { type: 'mood', emotion: 'sheepish', message: "Oops, that wasn't quite right." },
      { type: 'mood', emotion: 'determined' },
    ],
  },
};

const CELEBRATE_DEMO: WidgetDocument = {
  version: 1,
  root: {
    type: 'button',
    label: 'Celebrate',
    action: { kind: 'ui', command: { action: 'celebrate' } },
  },
};

/**
 * A tic-tac-toe board mid-game — empty cells carry an agent action (disabled
 * here: no session). Deliberately has NO completed line (X threatens the
 * diagonal but (2,2) is open), so no victory stroke draws — the previous
 * arrangement accidentally contained a finished X diagonal.
 */
const BOARD: WidgetDocument = {
  version: 1,
  title: 'Tic-tac-toe',
  root: {
    type: 'board',
    label: 'Your move — X to play',
    rows: [
      [{ glyph: 'X' }, { glyph: 'O' }, { action: { kind: 'agent', id: 'move-0-2' } }],
      [{ action: { kind: 'agent', id: 'move-1-0' } }, { glyph: 'X' }, { glyph: 'O' }],
      [
        { glyph: 'O' },
        { action: { kind: 'agent', id: 'move-2-1' } },
        { action: { kind: 'agent', id: 'move-2-2' } },
      ],
    ],
  },
};

/**
 * A finished game — X completed the top row, so the victory stroke draws
 * through it (toneless win → success green). Kept here so the win-line's
 * geometry and color stay eyeballable in both themes forever (it once rendered
 * as a giant black pill).
 */
const BOARD_WON: WidgetDocument = {
  version: 1,
  title: 'Tic-tac-toe',
  root: {
    type: 'board',
    label: 'X wins — top row',
    rows: [
      [{ glyph: 'X' }, { glyph: 'X' }, { glyph: 'X' }],
      [{ glyph: 'O' }, { glyph: 'O' }, {}],
      [{}, {}, {}],
    ],
  },
};

/** A won game whose winning cells carry a tone — the stroke inherits it (info blue). */
const BOARD_WON_TONED: WidgetDocument = {
  version: 1,
  title: 'Connect the line',
  root: {
    type: 'board',
    label: 'Diagonal win, info tone',
    rows: [
      [{ glyph: 'O', tone: 'info' }, { glyph: 'X' }, {}],
      [{ glyph: 'X' }, { glyph: 'O', tone: 'info' }, {}],
      [{}, { glyph: 'X' }, { glyph: 'O', tone: 'info' }],
    ],
  },
};

const REVEAL: WidgetDocument = {
  version: 1,
  root: {
    type: 'stack',
    direction: 'horizontal',
    gap: 'lg',
    children: [
      { type: 'reveal', kind: 'coin', result: 'Heads', label: 'Coin flip' },
      { type: 'reveal', kind: '8ball', result: 'Outlook good', label: 'Magic 8-ball' },
    ],
  },
};

/** Showcases for the Tier-1 generative-UI widget renderer. */
export function GenUiShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Generative UI — Loading State"
        description="Shown while a dorkos-ui fence is still streaming — a card silhouette with a soft shimmer sweep. Honors reduced motion."
      >
        <ShowcaseLabel>widget skeleton</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-sm">
            <WidgetSkeleton />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Stat Card"
        description="A card composing stat, divider, and progress nodes."
      >
        <ShowcaseLabel>card + stat + progress</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-sm">
            <WidgetRenderer document={STAT_CARD} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Table"
        description="Columnar data with aligned cells."
      >
        <ShowcaseDemo>
          <WidgetRenderer document={TABLE} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Charts"
        description="Dependency-free bar, line, area, and pie charts (including a single-slice pie), themed via chart tokens."
      >
        <ShowcaseDemo>
          <div className="max-w-md">
            <WidgetRenderer document={CHART} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — List"
        description="List items with thumbnails, icons, right-aligned meta, and toned badges."
      >
        <ShowcaseDemo>
          <div className="max-w-md">
            <WidgetRenderer document={LIST} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Timeline"
        description="A vertical rail of events with done / active / upcoming statuses; the active stop pulses."
      >
        <ShowcaseDemo>
          <div className="max-w-sm">
            <WidgetRenderer document={TIMELINE} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Checklist"
        description="Toggleable items seeded from the widget; the submit posts checked/unchecked labels back to the agent."
      >
        <ShowcaseDemo>
          <div className="max-w-sm">
            <WidgetRenderer document={CHECKLIST} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Compare"
        description="An option-comparison matrix with a recommended column, boolean check/cross cells, and numeric rows."
      >
        <ShowcaseDemo>
          <div className="max-w-md">
            <WidgetRenderer document={COMPARE} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Rating"
        description="Five stars with a fractional fill, the numeric value, and a review count."
      >
        <ShowcaseDemo>
          <div className="max-w-sm">
            <WidgetRenderer document={RATING} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Mood"
        description="A compact SVG face that blinks on a calm cadence, plus a per-emotion idle tell. The celebrate command (below) fires the same confetti burst a celebrating mood plays on mount."
      >
        <ShowcaseLabel>four emotions, one with a message</ShowcaseLabel>
        <ShowcaseDemo>
          <WidgetRenderer document={MOOD} />
        </ShowcaseDemo>
        <ShowcaseLabel>{'{ kind: "ui", command: { action: "celebrate" } }'}</ShowcaseLabel>
        <ShowcaseDemo>
          <WidgetRenderer document={CELEBRATE_DEMO} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Board"
        description="A CSS grid of glyph cells, some clickable. Paired with an agent action re-emitted each turn, this is the primitive behind turn-based games like tic-tac-toe — the empty cells below carry an action but render disabled here (the playground has no session to send a move to)."
      >
        <ShowcaseLabel>mid-game</ShowcaseLabel>
        <ShowcaseDemo>
          <WidgetRenderer document={BOARD} />
        </ShowcaseDemo>
        <ShowcaseLabel>won — victory stroke (toneless → success green)</ShowcaseLabel>
        <ShowcaseDemo>
          <WidgetRenderer document={BOARD_WON} />
        </ShowcaseDemo>
        <ShowcaseLabel>won — stroke inherits the winning cells&apos; tone</ShowcaseLabel>
        <ShowcaseDemo>
          <WidgetRenderer document={BOARD_WON_TONED} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Reveal"
        description="An animated coin flip and magic-8-ball reveal. The agent supplies the result; the client just performs the suspense animation. Click the object to replay it."
      >
        <ShowcaseDemo>
          <WidgetRenderer document={REVEAL} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — Error Card (D5)"
        description="Invalid widget JSON degrades to a compact error card; chat never crashes."
      >
        <ShowcaseDemo>
          <div className="max-w-md">
            <WidgetErrorCard error="root: invalid node type" raw={'{ "version": 1, "root": {} }'} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
