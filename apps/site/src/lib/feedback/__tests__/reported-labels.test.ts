import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reportedLabelIdsForKind, resetReportedLabelCache } from '../reported-labels';

const TEAM_ID = 'team-fb-uuid';
const OTHER_TEAM_ID = 'team-dor-uuid';

/**
 * The `reported` group as Linear actually returns it: GraphQL strips the group
 * prefix, so a child reads back with a bare `name` and the group is visible
 * only on `parent`. There is no `"reported/idea"` string anywhere in the API.
 */
const REPORTED_NODES = [
  { id: 'group-reported', name: 'reported', parent: null },
  { id: 'id-defect', name: 'defect', parent: { name: 'reported' } },
  { id: 'id-idea', name: 'idea', parent: { name: 'reported' } },
  { id: 'id-feedback', name: 'feedback', parent: { name: 'reported' } },
];

function okLabels(nodes: unknown[] = REPORTED_NODES): Response {
  return new Response(JSON.stringify({ data: { team: { labels: { nodes } } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  resetReportedLabelCache();
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('reportedLabelIdsForKind — resolution', () => {
  beforeEach(() => {
    fetchSpy.mockResolvedValue(okLabels());
  });

  it.each([
    ['bug', 'id-defect'],
    ['idea', 'id-idea'],
    ['feedback', 'id-feedback'],
  ] as const)('resolves %s to its reported/* child', async (kind, expected) => {
    await expect(reportedLabelIdsForKind('key', TEAM_ID, kind)).resolves.toEqual([expected]);
  });

  it('maps "bug" to `defect`, never to `bug`', async () => {
    // Linear refuses a group child named `Bug` while the workspace-level `Bug`
    // exists, so `defect` is forced. A rename back would silently unlabel every
    // bug report.
    fetchSpy.mockResolvedValue(
      okLabels([{ id: 'id-bug', name: 'bug', parent: { name: 'reported' } }])
    );
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'bug')).resolves.toEqual([]);
  });

  it('ignores a top-level label with a matching name', async () => {
    fetchSpy.mockResolvedValue(
      okLabels([
        { id: 'workspace-bug', name: 'Bug', parent: null },
        { id: 'orphan-idea', name: 'idea', parent: null },
      ])
    );
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'idea')).resolves.toEqual([]);
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'bug')).resolves.toEqual([]);
  });

  it('ignores a same-named child of a different group', async () => {
    fetchSpy.mockResolvedValue(
      okLabels([
        { id: 'type-idea', name: 'idea', parent: { name: 'type' } },
        { id: 'id-idea', name: 'idea', parent: { name: 'reported' } },
      ])
    );
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'idea')).resolves.toEqual(['id-idea']);
  });

  it('matches case-insensitively, so a capitalized group still resolves', async () => {
    fetchSpy.mockResolvedValue(
      okLabels([{ id: 'id-defect', name: 'Defect', parent: { name: 'Reported' } }])
    );
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'bug')).resolves.toEqual(['id-defect']);
  });

  it('never returns more than one id, because the group rejects two members', async () => {
    for (const kind of ['bug', 'idea', 'feedback'] as const) {
      const ids = await reportedLabelIdsForKind('key', TEAM_ID, kind);
      expect(ids.length).toBeLessThanOrEqual(1);
    }
  });

  it('sends the raw API key, the team id and a bounded page size', async () => {
    await reportedLabelIdsForKind('lin_api_key_raw', TEAM_ID, 'bug');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.linear.app/graphql');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('lin_api_key_raw');
    expect(headers.Authorization).not.toMatch(/^Bearer /);

    const body = JSON.parse((init as RequestInit).body as string) as {
      query: string;
      variables: { teamId: string; first: number };
    };
    expect(body.variables.teamId).toBe(TEAM_ID);
    expect(body.variables.first).toBe(250);
    // Never a literal `reported/idea`: the API does not spell the prefix.
    expect(body.query).not.toContain('reported/');
  });

  it('bounds the lookup with a timeout so a slow query cannot outlive the caller', async () => {
    await reportedLabelIdsForKind('key', TEAM_ID, 'bug');
    // Asserting the signal is present, not that it fires: `AbortSignal.timeout`
    // runs on a platform timer vitest's fake clock does not intercept.
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

describe('reportedLabelIdsForKind — failure never costs the report', () => {
  it.each([
    ['a non-2xx response', () => new Response('', { status: 500 })],
    [
      'a GraphQL errors[] response',
      () =>
        new Response(JSON.stringify({ errors: [{ message: 'Team not found' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'an unknown team',
      () => new Response(JSON.stringify({ data: { team: null } }), { status: 200 }),
    ],
    ['a team with no labels at all', () => okLabels([])],
    [
      'a group that was renamed by hand',
      () => okLabels([{ id: 'x', name: 'defect', parent: { name: 'claimed' } }]),
    ],
  ])('resolves an empty array on %s', async (_label, respond) => {
    fetchSpy.mockResolvedValue(respond());
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'bug')).resolves.toEqual([]);
  });

  it('resolves an empty array when the request rejects outright', async () => {
    fetchSpy.mockRejectedValue(new Error('socket hang up'));
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'bug')).resolves.toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('recovers once Linear comes back, without a process restart', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('down'));
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'bug')).resolves.toEqual([]);

    // The failure TTL is a minute, so the very next submission still reads the
    // cached miss — the recovery has to survive a cache reset, not bypass it.
    resetReportedLabelCache();
    fetchSpy.mockResolvedValue(okLabels());
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'bug')).resolves.toEqual(['id-defect']);
  });
});

describe('reportedLabelIdsForKind — caching', () => {
  it('queries once and serves later submissions from memory', async () => {
    fetchSpy.mockResolvedValue(okLabels());

    await reportedLabelIdsForKind('key', TEAM_ID, 'bug');
    await reportedLabelIdsForKind('key', TEAM_ID, 'idea');
    await reportedLabelIdsForKind('key', TEAM_ID, 'feedback');

    // A web form must not query Linear once per submission.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight query across a burst of concurrent submissions', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchSpy.mockImplementation(async () => {
      await gate;
      return okLabels();
    });

    const inFlight = Promise.all([
      reportedLabelIdsForKind('key', TEAM_ID, 'bug'),
      reportedLabelIdsForKind('key', TEAM_ID, 'idea'),
      reportedLabelIdsForKind('key', TEAM_ID, 'feedback'),
    ]);
    release?.();

    expect(await inFlight).toEqual([['id-defect'], ['id-idea'], ['id-feedback']]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-queries when the team id changes, rather than serving another team’s ids', async () => {
    fetchSpy.mockResolvedValueOnce(okLabels());
    await expect(reportedLabelIdsForKind('key', TEAM_ID, 'bug')).resolves.toEqual(['id-defect']);

    fetchSpy.mockResolvedValueOnce(
      okLabels([{ id: 'other-defect', name: 'defect', parent: { name: 'reported' } }])
    );
    await expect(reportedLabelIdsForKind('key', OTHER_TEAM_ID, 'bug')).resolves.toEqual([
      'other-defect',
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('caches a miss too, so a misconfigured workspace does not query per submission', async () => {
    fetchSpy.mockResolvedValue(okLabels([]));

    await reportedLabelIdsForKind('key', TEAM_ID, 'bug');
    await reportedLabelIdsForKind('key', TEAM_ID, 'idea');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
