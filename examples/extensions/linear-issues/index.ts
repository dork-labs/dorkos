// React is provided by the host — do not import it directly.
// Use React.createElement() and React.useState() etc. from the global.
import type { ExtensionAPI } from '@dorkos/extension-api';

const h = React.createElement;

// ---------------------------------------------------------------------------
// Types — mirrors server.ts LoopData shape
// ---------------------------------------------------------------------------

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  state?: { name: string; type: string; color: string };
  team?: { key: string; name: string };
  project?: { name: string };
  labels?: { nodes: Array<{ name: string }> };
  updatedAt: string;
  completedAt?: string;
}

interface LoopHealth {
  triage: number;
  ready: number;
  inProgress: number;
  monitoring: number;
  needsInput: number;
  completed: number;
}

interface LoopData {
  health: LoopHealth;
  categories: Record<keyof LoopHealth, LinearIssue[]>;
  updatedAt: number;
}

interface Settings {
  showDashboard: boolean;
  showSidebar: boolean;
  showCompleted: boolean;
  viewMode: 'loop' | 'project' | 'all';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_POLL_MS = 30_000;
const EXT_ID = 'linear-issues';

const DEFAULT_SETTINGS: Settings = {
  showDashboard: true,
  showSidebar: true,
  showCompleted: false,
  viewMode: 'loop',
};

const LOOP_SECTIONS: Array<{ label: string; keys: Array<keyof LoopHealth>; highlight?: boolean }> = [
  { label: 'Needs Attention', keys: ['triage', 'needsInput'], highlight: true },
  { label: 'Ready for Work', keys: ['ready'] },
  { label: 'In Progress', keys: ['inProgress'] },
  { label: 'Monitoring', keys: ['monitoring'] },
  { label: 'Recently Completed', keys: ['completed'] },
];

const HEALTH_BADGES: Array<{ key: keyof LoopHealth; label: string; color: string }> = [
  { key: 'triage', label: 'Triage', color: '#f59e0b' },
  { key: 'needsInput', label: 'Input', color: '#ef4444' },
  { key: 'ready', label: 'Ready', color: '#22c55e' },
  { key: 'inProgress', label: 'Active', color: '#3b82f6' },
  { key: 'monitoring', label: 'Monitor', color: '#14b8a6' },
];

// ---------------------------------------------------------------------------
// Settings parsing
// ---------------------------------------------------------------------------

function parseSettings(items: Array<{ key: string; value: unknown }>): Settings {
  const m = new Map(items.map((i) => [i.key, i.value]));
  return {
    showDashboard: (m.get('show_dashboard') as boolean) ?? true,
    showSidebar: (m.get('show_sidebar') as boolean) ?? true,
    showCompleted: (m.get('show_completed') as boolean) ?? false,
    viewMode: (m.get('view_mode') as Settings['viewMode']) ?? 'loop',
  };
}

// ---------------------------------------------------------------------------
// Shared data hook
// ---------------------------------------------------------------------------

function useLoopData(): { data: LoopData | null; settings: Settings; loading: boolean } {
  const [data, setData] = React.useState<LoopData | null>(null);
  const [settings, setSettings] = React.useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let disposed = false;
    const fetchAll = async () => {
      try {
        const [loopRes, settingsRes] = await Promise.all([
          fetch(`/api/ext/${EXT_ID}/loop`),
          fetch(`/api/extensions/${EXT_ID}/settings`),
        ]);
        if (disposed) return;
        const [loopJson, settingsJson] = await Promise.all([
          loopRes.ok ? loopRes.json() : Promise.resolve(null),
          settingsRes.ok ? settingsRes.json() : Promise.resolve(null),
        ]);
        if (disposed) return;
        if (loopJson) setData(loopJson);
        if (settingsJson) setSettings(parseSettings(settingsJson));
      } catch {
        // Non-blocking
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    fetchAll();
    const interval = setInterval(fetchAll, CLIENT_POLL_MS);
    return () => { disposed = true; clearInterval(interval); };
  }, []);

  return { data, settings, loading };
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

/**
 * Linear Loop extension — shows Loop-categorized issue status on the DorkOS
 * dashboard and sidebar. Settings tab is auto-generated from the manifest.
 */
export function activate(api: ExtensionAPI): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    api.registerComponent('dashboard.sections', 'linear-loop-dashboard', LoopDashboard, {
      priority: 6,
    }),
  );

  cleanups.push(
    api.registerComponent('sidebar.tabs', 'linear-loop-sidebar', LoopSidebar, {
      priority: 5,
    }),
  );

  cleanups.push(
    api.registerCommand('linear-quick-idea', 'Quick Idea to Linear', () => {
      api.notify('Use /linear:idea in the chat to capture a quick idea');
    }),
  );

  return () => cleanups.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// Dashboard Section
// ---------------------------------------------------------------------------

function LoopDashboard() {
  const { data, settings, loading } = useLoopData();

  if (!settings.showDashboard) return null;
  if (loading) return h('div', { style: s.card }, 'Loading Loop status...');
  if (!data) return h('div', { style: s.card }, 'Configure Linear API key to see Loop status');

  return h('div', { style: s.card },
    h('h3', { style: s.heading }, 'Linear Loop'),
    h(HealthBadges, { health: data.health }),
    h('div', { style: { marginTop: 12 } },
      settings.viewMode === 'loop' ? h(LoopView, { data, settings }) :
      settings.viewMode === 'project' ? h(ProjectView, { data }) :
      h(AllView, { data }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Sidebar Tab
// ---------------------------------------------------------------------------

function LoopSidebar() {
  const { data, settings, loading } = useLoopData();

  if (!settings.showSidebar) return null;
  if (loading) return h('div', { style: s.sidebar }, 'Loading...');
  if (!data) return h('div', { style: s.sidebar }, 'API key not configured');

  const attention = [
    ...data.categories.needsInput,
    ...data.categories.triage,
  ].slice(0, 8);

  return h('div', { style: s.sidebar },
    h(HealthGrid, { health: data.health }),
    attention.length > 0 && h('div', { style: { marginTop: 10 } },
      h('div', { style: s.sectionLabel }, 'Needs Attention'),
      attention.map((issue) => h(IssueRow, { key: issue.id, issue, compact: true })),
    ),
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function LoopView({ data, settings }: { data: LoopData; settings: Settings }) {
  return h(React.Fragment, null,
    ...LOOP_SECTIONS
      .filter((sec) => !sec.keys.includes('completed') || settings.showCompleted)
      .map((sec) => {
        const issues = sec.keys.flatMap((k) => data.categories[k]);
        if (!issues.length) return null;
        return h(CategorySection, {
          key: sec.label,
          label: sec.label,
          issues,
          highlight: sec.highlight,
        });
      })
      .filter(Boolean),
  );
}

function ProjectView({ data }: { data: LoopData }) {
  const allIssues = Object.values(data.categories).flat();
  const groups = new Map<string, LinearIssue[]>();
  for (const issue of allIssues) {
    const proj = issue.project?.name ?? 'Unassigned';
    if (!groups.has(proj)) groups.set(proj, []);
    groups.get(proj)!.push(issue);
  }
  return h(React.Fragment, null,
    ...[...groups.entries()].map(([name, issues]) =>
      h(CategorySection, { key: name, label: name, issues }),
    ),
  );
}

function AllView({ data }: { data: LoopData }) {
  // Linear priority: 1=Urgent, 2=High, 3=Medium, 4=Low, 0=None — sort 0 last
  const allIssues = Object.values(data.categories).flat()
    .sort((a, b) => (a.priority || 5) - (b.priority || 5));
  if (!allIssues.length) return h('div', { style: s.empty }, 'No active issues');
  return h('div', { style: s.list }, allIssues.map((i) => h(IssueRow, { key: i.id, issue: i })));
}

// ---------------------------------------------------------------------------
// Shared Components
// ---------------------------------------------------------------------------

function HealthBadges({ health }: { health: LoopHealth }) {
  return h('div', { style: s.badges },
    ...HEALTH_BADGES.map(({ key, label, color }) => {
      const count = health[key];
      const isAlert = key === 'needsInput' && count > 0;
      return h('span', {
        key,
        style: {
          ...s.badge,
          borderColor: count > 0 ? color : 'var(--border)',
          color: count > 0 ? color : 'var(--muted-foreground)',
          fontWeight: isAlert ? 700 : 500,
        },
      }, `${label} ${count}`);
    }),
  );
}

function HealthGrid({ health }: { health: LoopHealth }) {
  return h('div', { style: s.grid },
    ...HEALTH_BADGES.map(({ key, label, color }) => {
      const count = health[key];
      return h('div', { key, style: s.gridItem },
        h('span', { style: { ...s.gridCount, color: count > 0 ? color : 'var(--muted-foreground)' } }, String(count)),
        h('span', { style: s.gridLabel }, label),
      );
    }),
  );
}

function CategorySection({ label, issues, highlight }: {
  label: string;
  issues: LinearIssue[];
  highlight?: boolean;
}) {
  const [open, setOpen] = React.useState(true);
  return h('div', { style: { marginBottom: 8 } },
    h('div', {
      style: { ...s.sectionLabel, cursor: 'pointer', color: highlight ? '#ef4444' : undefined },
      onClick: () => setOpen(!open),
    }, `${open ? '\u25BE' : '\u25B8'} ${label} (${issues.length})`),
    open && h('div', { style: s.list }, issues.map((i) => h(IssueRow, { key: i.id, issue: i }))),
  );
}

function IssueRow({ issue, compact }: { issue: LinearIssue; compact?: boolean }) {
  return h('div', { style: compact ? s.issueRowCompact : s.issueRow },
    h('span', { style: { ...s.statusDot, backgroundColor: issue.state?.color ?? '#888' } }),
    h('span', { style: s.identifier }, issue.identifier),
    h('span', { style: s.title }, issue.title),
    !compact && h('span', { style: s.team }, issue.team?.key),
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  card: {
    padding: 16, borderRadius: 8,
    border: '1px solid var(--border)', marginBottom: 12,
  },
  sidebar: { padding: 12, fontSize: 13 },
  heading: { margin: '0 0 10px', fontSize: 14, fontWeight: 600 },
  badges: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  badge: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px', borderRadius: 12, fontSize: 11,
    border: '1px solid var(--border)',
  },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
  },
  gridItem: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
  },
  gridCount: { fontSize: 18, fontWeight: 600, lineHeight: 1 },
  gridLabel: { fontSize: 10, color: 'var(--muted-foreground)' },
  sectionLabel: {
    fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const,
    letterSpacing: '0.05em', color: 'var(--muted-foreground)',
    marginBottom: 4, userSelect: 'none' as const,
  },
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  issueRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
  issueRowCompact: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 },
  statusDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  identifier: {
    fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)',
    fontSize: 11, flexShrink: 0,
  },
  title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  team: { marginLeft: 'auto', fontSize: 11, color: 'var(--muted-foreground)', flexShrink: 0 },
  empty: { color: 'var(--muted-foreground)', fontSize: 13, padding: '8px 0' },
};
