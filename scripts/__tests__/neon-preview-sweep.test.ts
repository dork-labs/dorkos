/**
 * Pins scripts/neon-preview-sweep.ts, the nightly delete of leaked Neon preview
 * databases. Its failure mode is deleting a database somebody is using, so the
 * keep side is pinned at least as hard as the delete side: every keep rule has
 * a case that is otherwise deletable, and every listing failure keeps all.
 * The network is a stub that routes by URL; nothing here reaches Neon or GitHub.
 */
import { describe, expect, it } from 'vitest';

import {
  planSweep,
  runSweep,
  type Fetch,
  type NeonBranch,
  type NeonEndpoint,
  type SweepInput,
} from '../neon-preview-sweep.ts';

const NOW = new Date('2026-09-25T12:00:00Z');
const OLD = '2026-09-01T00:00:00Z'; // 24.5 days before NOW
const RECENT = '2026-09-23T00:00:00Z'; // 2.5 days before NOW
const PROD = 'br-production';

/** A branch that passes every rule, so each keep case flips exactly one field. */
function stale(name: string, over: Partial<NeonBranch> = {}): NeonBranch {
  return {
    id: `br-${name.replace(/\W+/g, '-')}`,
    name: `preview/${name}`,
    creation_source: 'vercel',
    default: false,
    protected: false,
    primary: false,
    parent_id: PROD,
    created_at: OLD,
    ...over,
  };
}

const production: NeonBranch = {
  id: PROD,
  name: 'production',
  creation_source: 'console',
  default: true,
  protected: false,
  primary: true,
  created_at: '2026-07-03T20:05:13Z',
};
const vercelDev: NeonBranch = {
  id: 'br-vercel-dev',
  name: 'vercel-dev',
  creation_source: 'vercel',
  default: false,
  protected: false,
  parent_id: PROD,
  created_at: '2026-07-03T20:05:41Z',
};

function plan(over: Partial<SweepInput> = {}) {
  return planSweep({
    branches: [],
    endpoints: [],
    openPrHeads: new Set(),
    now: NOW,
    minAgeDays: 7,
    maxDeletions: 25,
    ...over,
  });
}

function actionOf(p: ReturnType<typeof planSweep>, name: string) {
  const d = p.decisions.find((x) => x.branch.name === name);
  if (!d) throw new Error(`no decision for ${name}`);
  return d;
}

describe('planSweep: deletes what it should', () => {
  it('deletes a stale preview branch of a git branch with no open PR', () => {
    const p = plan({ branches: [production, stale('codex/abandoned')] });
    expect(actionOf(p, 'preview/codex/abandoned').action).toBe('delete');
  });

  it('deletes a merge-queue branch, whose head is never an open PR', () => {
    const name = 'gh-readonly-queue/main/pr-2126-fc032be03dccb4b5565863ea7dacfea8bf94ddbf';
    const p = plan({ branches: [stale(name)], openPrHeads: new Set(['feat/x']) });
    expect(actionOf(p, `preview/${name}`).action).toBe('delete');
  });

  it('deletes when the only compute went idle long ago', () => {
    const b = stale('old-idle');
    const endpoints = [{ branch_id: b.id, last_active: OLD, current_state: 'idle' }];
    const p = plan({ branches: [b], endpoints });
    expect(actionOf(p, b.name).action).toBe('delete');
  });

  it('deletes when a compute never ran', () => {
    const b = stale('never-ran');
    const p = plan({ branches: [b], endpoints: [{ branch_id: b.id }] });
    expect(actionOf(p, b.name).action).toBe('delete');
  });
});

describe('planSweep: keeps each keep case', () => {
  const cases: [string, NeonBranch, Partial<SweepInput>?][] = [
    ['production', production],
    ['vercel-dev (no preview/ prefix)', vercelDev],
    ['a bare preview/ name', stale('', { name: 'preview/' })],
    ['a branch made by hand', stale('by-hand', { creation_source: 'console' })],
    ['a branch with unknown creation source', stale('no-source', { creation_source: undefined })],
    ['a default branch', stale('default', { default: true })],
    ['a branch whose default flag is missing', stale('default-unknown', { default: undefined })],
    ['a protected branch', stale('protected', { protected: true })],
    [
      'a branch whose protected flag is missing',
      stale('protected-unknown', { protected: undefined }),
    ],
    ['a primary branch', stale('primary', { primary: true })],
    ['a branch created within 7 days', stale('young', { created_at: RECENT })],
    ['a branch with no creation date', stale('undated', { created_at: undefined })],
    ['a branch with a garbage creation date', stale('garbage-date', { created_at: 'yesterday' })],
    [
      'a branch with an open PR',
      stale('feat/in-review'),
      { openPrHeads: new Set(['feat/in-review']) },
    ],
  ];

  it.each(cases)('keeps %s', (_label, branch, over) => {
    const p = plan({ branches: [production, vercelDev, branch], ...over });
    expect(actionOf(p, branch.name).action).toBe('keep');
  });

  it('keeps an old branch whose compute was active within 7 days', () => {
    const b = stale('recently-used');
    const endpoints: NeonEndpoint[] = [
      { branch_id: b.id, last_active: OLD },
      { branch_id: b.id, last_active: RECENT },
    ];
    expect(actionOf(plan({ branches: [b], endpoints }), b.name).action).toBe('keep');
  });

  it('keeps a branch whose compute is running now, whatever its last_active says', () => {
    const b = stale('running');
    const endpoints = [{ branch_id: b.id, last_active: OLD, current_state: 'active' }];
    expect(actionOf(plan({ branches: [b], endpoints }), b.name)).toMatchObject({
      action: 'keep',
      reason: 'compute is active',
    });
  });

  it('keeps a branch whose compute activity is unreadable', () => {
    const b = stale('bad-activity');
    const endpoints = [{ branch_id: b.id, last_active: 'not a date' }];
    expect(actionOf(plan({ branches: [b], endpoints }), b.name).action).toBe('keep');
  });

  it('keeps a branch that has a child branch', () => {
    const parent = stale('parent');
    const child = stale('child', { parent_id: parent.id, created_at: RECENT });
    const p = plan({ branches: [parent, child] });
    expect(actionOf(p, parent.name)).toMatchObject({
      action: 'keep',
      reason: 'has child branches',
    });
  });

  it('matches the open PR on the exact git branch, not a prefix', () => {
    const p = plan({ branches: [stale('feat/a-longer-name')], openPrHeads: new Set(['feat/a']) });
    expect(actionOf(p, 'preview/feat/a-longer-name').action).toBe('delete');
  });
});

describe('planSweep: keep on unknown', () => {
  const branches = [production, stale('would-go')];

  it('refuses to plan when branches cannot be listed', () => {
    const p = plan({ branches: null });
    expect(p.refused).toMatch(/branches/);
    expect(p.decisions).toEqual([]);
  });

  it('keeps everything when computes cannot be listed', () => {
    const p = plan({ branches, endpoints: null });
    expect(p.refused).toMatch(/computes/);
    expect(p.decisions.every((d) => d.action === 'keep')).toBe(true);
  });

  it('keeps everything when open pull requests cannot be listed', () => {
    const p = plan({ branches, openPrHeads: null });
    expect(p.refused).toMatch(/pull requests/);
    expect(p.decisions.every((d) => d.action === 'keep')).toBe(true);
  });

  it('deletes at most maxDeletions, oldest first', () => {
    const many = [
      stale('c', { created_at: '2026-09-10T00:00:00Z' }),
      stale('a', { created_at: '2026-08-01T00:00:00Z' }),
      stale('b', { created_at: '2026-08-15T00:00:00Z' }),
    ];
    const p = plan({ branches: many, maxDeletions: 2 });
    expect(p.decisions.filter((d) => d.action === 'delete').map((d) => d.branch.name)).toEqual([
      'preview/a',
      'preview/b',
    ]);
    expect(actionOf(p, 'preview/c').reason).toMatch(/limit/);
  });
});

/** A stub network: Neon and GitHub answers by URL, every DELETE recorded. */
function stubNetwork(opts: {
  branches?: NeonBranch[];
  endpoints?: NeonEndpoint[];
  openHeads?: string[];
  fail?: RegExp;
  pageSize?: number;
  graphqlErrors?: boolean;
}) {
  const deleted: string[] = [];
  let calls = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const prPage = (after: string | null) => {
    const all = opts.openHeads ?? [];
    const size = opts.pageSize ?? Math.max(all.length, 1);
    const start = Number(after ?? 0);
    const more = start + size < all.length;
    return {
      data: {
        repository: {
          pullRequests: {
            nodes: all.slice(start, start + size).map((headRefName) => ({ headRefName })),
            pageInfo: { hasNextPage: more, endCursor: more ? String(start + size) : null },
          },
        },
      },
    };
  };
  const fetchFn: Fetch = async (url, init) => {
    calls++;
    // A failure still carries a well-formed, EMPTY body, so the status code alone
    // must make it a failure: an empty list read as "nothing open" would delete.
    if (opts.fail?.test(url)) {
      if (!url.includes('api.github.com')) return json({ branches: [], endpoints: [] }, 500);
      const empty = prPage(null);
      empty.data.repository.pullRequests.nodes = [];
      return json(empty, 500);
    }
    const u = new URL(url);
    if (u.hostname === 'api.github.com') {
      // GraphQL can answer 200 with partial data AND errors; partial must not read as complete.
      if (opts.graphqlErrors) {
        const partial = prPage(null);
        partial.data.repository.pullRequests.nodes = [];
        return json({ ...partial, errors: [{ message: 'rate limited' }] });
      }
      const { variables } = JSON.parse(String(init?.body)) as {
        variables: { after: string | null };
      };
      return json(prPage(variables.after));
    }
    if (init?.method === 'DELETE') {
      deleted.push(u.pathname.split('/').pop() ?? '');
      return json({});
    }
    if (u.pathname.endsWith('/branches')) {
      const all = opts.branches ?? [];
      const size = opts.pageSize ?? all.length;
      const start = Number(u.searchParams.get('cursor') ?? 0);
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return json({ branches: page, pagination: next ? { next } : {} });
    }
    if (u.pathname.endsWith('/endpoints')) return json({ endpoints: opts.endpoints ?? [] });
    return json({}, 404);
  };
  return { fetchFn, deleted, calls: () => calls };
}

const ENV = {
  NEON_API_KEY: 'k',
  NEON_PROJECT_ID: 'p',
  GITHUB_TOKEN: 't',
  GITHUB_REPOSITORY: 'o/r',
};

async function run(
  net: ReturnType<typeof stubNetwork>,
  env: Record<string, string | undefined> = ENV,
  dryRun = false
) {
  const lines: string[] = [];
  const code = await runSweep({
    env,
    fetchFn: net.fetchFn,
    now: NOW,
    dryRun,
    log: (l) => lines.push(l),
  });
  return { code, out: lines.join('\n') };
}

describe('runSweep', () => {
  const branches = [production, vercelDev, stale('abandoned'), stale('feat/open')];

  it('deletes exactly the stale branch, across pages, and reports it', async () => {
    const net = stubNetwork({ branches, openHeads: ['feat/open'], pageSize: 1 });
    const { code, out } = await run(net);
    expect(code).toBe(0);
    expect(net.deleted).toEqual(['br-abandoned']);
    expect(out).toContain('4 branches before, deleted 1, 3 remain');
  });

  it('reads every page of open PRs: an open PR on the last page still keeps', async () => {
    const openHeads = ['feat/a', 'feat/b', 'feat/c', 'feat/open'];
    const net = stubNetwork({ branches, openHeads, pageSize: 1 });
    await run(net);
    expect(net.deleted).toEqual(['br-abandoned']);
  });

  it('deletes nothing when GitHub answers 200 with GraphQL errors', async () => {
    const net = stubNetwork({ branches, graphqlErrors: true });
    expect((await run(net)).code).toBe(1);
    expect(net.deleted).toEqual([]);
  });

  it('deletes nothing in a dry run', async () => {
    const net = stubNetwork({ branches, openHeads: ['feat/open'] });
    const { code, out } = await run(net, ENV, true);
    expect(code).toBe(0);
    expect(net.deleted).toEqual([]);
    expect(out).toContain('would delete 1');
  });

  it('skips green, reading nothing, when the secret is absent', async () => {
    const net = stubNetwork({ branches });
    const { code, out } = await run(net, { ...ENV, NEON_API_KEY: '' });
    expect(code).toBe(0);
    expect(net.calls()).toBe(0);
    expect(out).toContain('NEON_API_KEY');
  });

  it('skips green when the project variable is absent', async () => {
    const { NEON_PROJECT_ID: _omit, ...env } = ENV;
    const { code, out } = await run(stubNetwork({ branches }), env);
    expect(code).toBe(0);
    expect(out).toContain('NEON_PROJECT_ID');
  });

  it.each([/\/branches/, /\/endpoints/, /api\.github\.com/])(
    'deletes nothing and goes red when %s fails',
    async (fail) => {
      const net = stubNetwork({ branches, fail });
      const { code, out } = await run(net);
      expect(code).toBe(1);
      expect(net.deleted).toEqual([]);
      expect(out).toContain('Deleted nothing');
    }
  );

  it('deletes nothing when there is no GitHub token to ask about open PRs', async () => {
    const net = stubNetwork({ branches });
    const { code } = await run(net, { ...ENV, GITHUB_TOKEN: '' });
    expect(code).toBe(1);
    expect(net.deleted).toEqual([]);
  });

  it('goes red when a deletion fails', async () => {
    const net = stubNetwork({ branches, openHeads: ['feat/open'], fail: /br-abandoned/ });
    const { code, out } = await run(net);
    expect(code).toBe(1);
    expect(out).toContain('FAILED');
  });
});
