import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env mock so each test flips the PostHog keys/id on and off (mirrors
// the /api/telemetry/events route test's approach).
vi.mock('@/env', () => ({
  env: {
    POSTHOG_PROJECT_KEY: undefined as string | undefined,
    POSTHOG_PERSONAL_API_KEY: undefined as string | undefined,
    POSTHOG_PROJECT_ID: undefined as string | undefined,
    NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
  },
}));

import { env } from '@/env';

import { aliasInstanceToAccount, deletePostHogPerson } from '../posthog-server';

let fetchSpy: ReturnType<typeof vi.spyOn>;

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  env.POSTHOG_PROJECT_KEY = undefined;
  env.POSTHOG_PERSONAL_API_KEY = undefined;
  env.POSTHOG_PROJECT_ID = undefined;
  env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('aliasInstanceToAccount', () => {
  it('emits a $create_alias merging the telemetry instanceId into the account when configured', async () => {
    env.POSTHOG_PROJECT_KEY = 'phc_project';
    await aliasInstanceToAccount({ telemetryInstanceId: 'inst-abc', accountId: 'acct-1' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://us.i.posthog.com/batch/');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.api_key).toBe('phc_project');
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0].event).toBe('$create_alias');
    expect(body.batch[0].distinct_id).toBe('acct-1');
    expect(body.batch[0].properties.alias).toBe('inst-abc');
  });

  it('no-ops when the project key is unset', async () => {
    await aliasInstanceToAccount({ telemetryInstanceId: 'inst-abc', accountId: 'acct-1' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops when no telemetry instanceId was sent', async () => {
    env.POSTHOG_PROJECT_KEY = 'phc_project';
    await aliasInstanceToAccount({ telemetryInstanceId: undefined, accountId: 'acct-1' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows a fetch failure (never throws into the token exchange)', async () => {
    env.POSTHOG_PROJECT_KEY = 'phc_project';
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    await expect(
      aliasInstanceToAccount({ telemetryInstanceId: 'inst-abc', accountId: 'acct-1' })
    ).resolves.toBeUndefined();
  });
});

describe('deletePostHogPerson', () => {
  it('looks the person up by distinct_id then deletes them with delete_events=true', async () => {
    env.POSTHOG_PERSONAL_API_KEY = 'phx_personal';
    env.POSTHOG_PROJECT_ID = '4242';
    fetchSpy
      .mockResolvedValueOnce(okJson({ results: [{ id: 'person-uuid-9' }] }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await deletePostHogPerson('acct-1');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = fetchSpy.mock.calls[0];
    expect(lookupUrl).toBe('https://us.posthog.com/api/projects/4242/persons/?distinct_id=acct-1');
    expect((lookupInit as RequestInit).headers).toMatchObject({
      authorization: 'Bearer phx_personal',
    });
    const [deleteUrl, deleteInit] = fetchSpy.mock.calls[1];
    expect(deleteUrl).toBe(
      'https://us.posthog.com/api/projects/4242/persons/person-uuid-9/?delete_events=true'
    );
    expect((deleteInit as RequestInit).method).toBe('DELETE');
  });

  it('skips (no request) when the personal key or project id is unset', async () => {
    // Only the personal key set, no project id.
    env.POSTHOG_PERSONAL_API_KEY = 'phx_personal';
    await deletePostHogPerson('acct-1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not attempt a delete when no person exists for the account', async () => {
    env.POSTHOG_PERSONAL_API_KEY = 'phx_personal';
    env.POSTHOG_PROJECT_ID = '4242';
    fetchSpy.mockResolvedValueOnce(okJson({ results: [] }));

    await deletePostHogPerson('acct-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // lookup only, no DELETE
  });

  it('swallows API errors so account deletion never fails on PostHog', async () => {
    env.POSTHOG_PERSONAL_API_KEY = 'phx_personal';
    env.POSTHOG_PROJECT_ID = '4242';
    fetchSpy.mockRejectedValueOnce(new Error('posthog unreachable'));
    await expect(deletePostHogPerson('acct-1')).resolves.toBeUndefined();
  });
});
