import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import { WidgetRenderer, WidgetErrorCard } from '@/layers/features/gen-ui';
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
        kind: 'pie',
        data: [
          { label: 'Claude', value: 60 },
          { label: 'Codex', value: 30 },
          { label: 'OpenCode', value: 10 },
        ],
      },
    ],
  },
};

const LIST: WidgetDocument = {
  version: 1,
  root: {
    type: 'list',
    items: [
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

/** Showcases for the Tier-1 generative-UI widget renderer. */
export function GenUiShowcases() {
  return (
    <>
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
        description="Dependency-free bar and pie charts, themed via chart tokens."
      >
        <ShowcaseDemo>
          <div className="max-w-md">
            <WidgetRenderer document={CHART} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Generative UI — List"
        description="List items with icons and toned badges."
      >
        <ShowcaseDemo>
          <div className="max-w-md">
            <WidgetRenderer document={LIST} />
          </div>
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
