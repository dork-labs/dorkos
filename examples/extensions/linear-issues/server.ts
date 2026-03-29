import type { ServerExtensionRegister } from '@dorkos/extension-api/server';

const LINEAR_API = 'https://api.linear.app/graphql';

// ---------------------------------------------------------------------------
// Types
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

// ---------------------------------------------------------------------------
// GraphQL Queries
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = `
  id identifier title priority
  state { name type color }
  team { key name }
  project { name }
  labels { nodes { name } }
  updatedAt completedAt
`;

/** Fetch active + recently completed issues for Loop categorization. */
const LOOP_QUERY = `
  query LoopIssues($teamKey: String!) {
    active: issues(
      first: 100
      filter: {
        team: { key: { eq: $teamKey } }
        state: { type: { nin: ["completed", "canceled"] } }
      }
      orderBy: updatedAt
    ) {
      nodes { ${ISSUE_FIELDS} }
    }
    completed: issues(
      first: 20
      filter: {
        team: { key: { eq: $teamKey } }
        state: { type: { eq: "completed" } }
      }
      orderBy: updatedAt
    ) {
      nodes { ${ISSUE_FIELDS} }
    }
  }
`;

/** Legacy query — viewer's assigned issues only. */
const MY_ISSUES_QUERY = `
  query MyIssues {
    viewer {
      assignedIssues(
        first: 50,
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
      ) {
        nodes {
          id identifier title priority
          state { name type color }
          team { key name }
          project { name }
          updatedAt
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gql(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API error: ${res.status}`);
  const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json;
}

function hasLabel(issue: LinearIssue, label: string): boolean {
  return issue.labels?.nodes?.some((l) => l.name === label) ?? false;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Categorize raw issues into Loop stages by state type and labels.
 *
 * Priority: needs-input > triage > monitoring > ready > in-progress.
 * An issue appears in exactly one category.
 */
function categorizeIssues(
  active: LinearIssue[],
  completed: LinearIssue[],
  maxPerSection: number,
): LoopData {
  const cats: Record<keyof LoopHealth, LinearIssue[]> = {
    triage: [],
    ready: [],
    inProgress: [],
    monitoring: [],
    needsInput: [],
    completed: [],
  };

  for (const issue of active) {
    if (hasLabel(issue, 'needs-input')) {
      cats.needsInput.push(issue);
    } else if (issue.state?.type === 'triage') {
      cats.triage.push(issue);
    } else if (hasLabel(issue, 'monitor')) {
      cats.monitoring.push(issue);
    } else if (hasLabel(issue, 'ready')) {
      cats.ready.push(issue);
    } else if (issue.state?.type === 'started') {
      cats.inProgress.push(issue);
    }
    // backlog/unstarted issues don't map to a Loop category
  }

  // Filter completed to last 7 days
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  cats.completed = completed.filter(
    (i) => i.completedAt && new Date(i.completedAt).getTime() > cutoff,
  );

  // Apply per-section limit
  for (const key of Object.keys(cats) as Array<keyof LoopHealth>) {
    cats[key] = cats[key].slice(0, maxPerSection);
  }

  return {
    health: {
      triage: cats.triage.length,
      ready: cats.ready.length,
      inProgress: cats.inProgress.length,
      monitoring: cats.monitoring.length,
      needsInput: cats.needsInput.length,
      completed: cats.completed.length,
    },
    categories: cats,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

interface StoredData {
  loop?: LoopData;
  loopHash?: string;
  /** Legacy field — raw API response for /cached backward compat. */
  data?: unknown;
  hash?: string;
  updatedAt?: number;
}

const register: ServerExtensionRegister = async (router, ctx) => {
  // refreshInterval is read once — changing it requires extension reload
  const refreshInterval = (await ctx.settings.get<number>('refresh_interval')) ?? 60;

  // Legacy on-demand endpoint — viewer's assigned issues, fresh from Linear
  router.get('/issues', async (_req, res) => {
    const apiKey = await ctx.secrets.get('linear_api_key');
    if (!apiKey) return res.status(503).json({ error: 'Linear API key not configured' });
    try {
      const data = await gql(apiKey, MY_ISSUES_QUERY);
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  // Legacy cached endpoint — returns last polled result
  router.get('/cached', async (_req, res) => {
    const cached = await ctx.storage.loadData<StoredData>();
    res.json(cached ?? { data: null });
  });

  // Loop endpoint — returns categorized data for the Loop dashboard
  router.get('/loop', async (_req, res) => {
    const cached = await ctx.storage.loadData<StoredData>();
    res.json(cached?.loop ?? null);
  });

  // Background polling — fetches Loop data at configurable interval
  // teamKey and maxPerSection are re-read each tick so changes take effect without reload
  ctx.schedule(refreshInterval, async () => {
    const apiKey = await ctx.secrets.get('linear_api_key');
    if (!apiKey) return;
    const currentTeamKey = (await ctx.settings.get<string>('team_key')) ?? 'DOR';
    const currentMax = (await ctx.settings.get<number>('max_issues')) ?? 25;
    try {
      const json = (await gql(apiKey, LOOP_QUERY, { teamKey: currentTeamKey })) as {
        data?: { active?: { nodes: LinearIssue[] }; completed?: { nodes: LinearIssue[] } };
      };
      const active = json.data?.active?.nodes ?? [];
      const completed = json.data?.completed?.nodes ?? [];
      const loop = categorizeIssues(active, completed, currentMax);

      // Only persist + emit if health changed
      const prev = await ctx.storage.loadData<StoredData>();
      const loopHash = JSON.stringify(loop.health);
      if (loopHash !== prev?.loopHash) {
        await ctx.storage.saveData({ loop, loopHash, updatedAt: Date.now() });
        ctx.emit('loop.updated', loop);
      }
    } catch (err) {
      console.error('[linear-issues] Loop polling error:', err);
    }
  });
};

export default register;
