import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env mock, mirroring `lib/__tests__/posthog-server.test.ts`'s approach:
// each test flips the Linear vars on and off rather than re-mocking per test.
vi.mock('@/env', () => ({
  env: {
    LINEAR_API_KEY: undefined as string | undefined,
    LINEAR_TEAM_ID: undefined as string | undefined,
    LINEAR_FEEDBACK_PROJECT_ID: undefined as string | undefined,
    LINEAR_BUG_LABEL_ID: undefined as string | undefined,
    LINEAR_FEATURE_LABEL_ID: undefined as string | undefined,
  },
}));

import { env } from '@/env';

import { createFeedbackIssue } from '../linear';

let fetchSpy: ReturnType<typeof vi.spyOn>;

function okIssueCreate(overrides: Partial<{ success: boolean }> = {}): Response {
  return new Response(
    JSON.stringify({
      data: {
        issueCreate: {
          success: overrides.success ?? true,
          issue: {
            id: 'issue-uuid-1',
            identifier: 'DOR-999',
            url: 'https://linear.app/dor/issue/DOR-999',
          },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  env.LINEAR_API_KEY = undefined;
  env.LINEAR_TEAM_ID = undefined;
  env.LINEAR_FEEDBACK_PROJECT_ID = undefined;
  env.LINEAR_BUG_LABEL_ID = undefined;
  env.LINEAR_FEATURE_LABEL_ID = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('createFeedbackIssue — unconfigured degrade', () => {
  it('resolves null and makes no request when LINEAR_API_KEY is unset', async () => {
    env.LINEAR_TEAM_ID = 'team-1';
    const result = await createFeedbackIssue({ kind: 'bug', message: 'It crashed.' });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves null and makes no request when LINEAR_TEAM_ID is unset (key alone is not enough)', async () => {
    env.LINEAR_API_KEY = 'lin_api_key';
    const result = await createFeedbackIssue({ kind: 'bug', message: 'It crashed.' });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createFeedbackIssue — mutation shape and auth header', () => {
  beforeEach(() => {
    env.LINEAR_API_KEY = 'lin_api_key_raw';
    env.LINEAR_TEAM_ID = 'team-dor-uuid';
    fetchSpy.mockResolvedValue(okIssueCreate());
  });

  it('POSTs to the Linear GraphQL endpoint with the raw key, NOT a Bearer token', async () => {
    await createFeedbackIssue({ kind: 'feedback', message: 'Nice product.' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.linear.app/graphql');
    const headers = (init as RequestInit).headers as Record<string, string>;
    // The exact bug vector this test guards: `Bearer <key>` would silently
    // fail every real Linear request while looking correct in a diff.
    expect(headers.Authorization).toBe('lin_api_key_raw');
    expect(headers.Authorization).not.toMatch(/^Bearer /);
  });

  it('sends an issueCreate mutation with teamId, title, and description', async () => {
    await createFeedbackIssue({
      kind: 'feedback',
      message: 'The sidebar collapses unexpectedly.\nHappens every time I resize.',
      reporterEmail: 'kai@example.com',
      reporterName: 'Kai',
      route: '/session',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    expect(body.query).toContain('issueCreate');
    expect(body.variables.input.teamId).toBe('team-dor-uuid');
    expect(body.variables.input.title).toBe('The sidebar collapses unexpectedly.');
    expect(body.variables.input.description).toContain(
      'The sidebar collapses unexpectedly.\nHappens every time I resize.'
    );
    expect(body.variables.input.description).toContain('kai@example.com');
    expect(body.variables.input.description).toContain('/session');
  });

  it('omits projectId when LINEAR_FEEDBACK_PROJECT_ID is unset', async () => {
    await createFeedbackIssue({ kind: 'feedback', message: 'hi' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.projectId).toBeUndefined();
  });

  it('includes projectId when LINEAR_FEEDBACK_PROJECT_ID is set', async () => {
    env.LINEAR_FEEDBACK_PROJECT_ID = 'project-uuid-1';
    await createFeedbackIssue({ kind: 'feedback', message: 'hi' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.projectId).toBe('project-uuid-1');
  });

  it('resolves the issue id and url from a successful response', async () => {
    const result = await createFeedbackIssue({ kind: 'feedback', message: 'hi' });
    expect(result).toEqual({
      issueId: 'issue-uuid-1',
      issueUrl: 'https://linear.app/dor/issue/DOR-999',
    });
  });
});

describe('createFeedbackIssue — kind → label mapping', () => {
  beforeEach(() => {
    env.LINEAR_API_KEY = 'lin_api_key';
    env.LINEAR_TEAM_ID = 'team-dor-uuid';
    env.LINEAR_BUG_LABEL_ID = 'label-bug-uuid';
    env.LINEAR_FEATURE_LABEL_ID = 'label-feature-uuid';
    fetchSpy.mockResolvedValue(okIssueCreate());
  });

  it('maps kind "bug" to the bug label', async () => {
    await createFeedbackIssue({ kind: 'bug', message: 'It crashed.' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.labelIds).toEqual(['label-bug-uuid']);
  });

  it('maps kind "idea" to the feature label', async () => {
    await createFeedbackIssue({ kind: 'idea', message: 'Add dark mode.' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.labelIds).toEqual(['label-feature-uuid']);
  });

  it('applies no label for plain "feedback"', async () => {
    await createFeedbackIssue({ kind: 'feedback', message: 'General thoughts.' });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      variables: { input: Record<string, unknown> };
    };
    expect(body.variables.input.labelIds).toEqual([]);
  });
});

describe('createFeedbackIssue — error propagation (never swallowed here)', () => {
  beforeEach(() => {
    env.LINEAR_API_KEY = 'lin_api_key';
    env.LINEAR_TEAM_ID = 'team-dor-uuid';
  });

  it('throws on a non-2xx response', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 500 }));
    await expect(createFeedbackIssue({ kind: 'bug', message: 'x' })).rejects.toThrow(
      /Linear API error: 500/
    );
  });

  it('throws on a GraphQL errors[] response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'Team not found' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(createFeedbackIssue({ kind: 'bug', message: 'x' })).rejects.toThrow(
      /Team not found/
    );
  });

  it('throws when issueCreate.success is false', async () => {
    fetchSpy.mockResolvedValue(okIssueCreate({ success: false }));
    await expect(createFeedbackIssue({ kind: 'bug', message: 'x' })).rejects.toThrow(
      /did not report success/
    );
  });

  it('propagates a network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(createFeedbackIssue({ kind: 'bug', message: 'x' })).rejects.toThrow(
      'network down'
    );
  });
});
