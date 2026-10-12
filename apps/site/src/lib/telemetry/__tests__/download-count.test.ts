import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/env', () => ({
  env: {
    POSTHOG_PROJECT_KEY: undefined as string | undefined,
    NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
  },
}));

// `after()` only works inside a live request; run its callback right away here.
const pending: Array<Promise<unknown>> = [];
vi.mock('next/server', () => ({
  after: (task: () => Promise<unknown>) => {
    pending.push(task());
  },
}));

import { env } from '@/env';

import { buildDownloadEvent, countDownload } from '../download-count';

/** A download request with the given headers and query. */
function download(query = '', headers: Record<string, string> = {}): Request {
  return new Request(`https://dorkos.ai/download/mac${query}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', ...headers },
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  env.POSTHOG_PROJECT_KEY = 'phc_test';
  pending.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildDownloadEvent', () => {
  it('records the platform, whether a build was served, the referring host and the campaign', () => {
    const event = buildDownloadEvent(
      download('?utm_source=HN&utm_campaign=launch', {
        referer: 'https://news.ycombinator.com/item?id=123',
      }),
      'mac',
      true
    );
    expect(event).toMatchObject({
      event: 'desktop_download',
      properties: {
        platform: 'mac',
        served: true,
        referrer_host: 'news.ycombinator.com',
        utm_source: 'hn',
        utm_campaign: 'launch',
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
  });

  it('never sends a referring path, a person, or the same id twice', () => {
    const request = () => download('', { referer: 'https://example.com/secret/path?token=abc' });
    const first = buildDownloadEvent(request(), 'windows', false)!;
    const second = buildDownloadEvent(request(), 'windows', false)!;
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(JSON.stringify(first)).not.toContain('token');
    expect(first.distinct_id).not.toBe(second.distinct_id);
  });

  it('drops a campaign value that is long or carries odd characters', () => {
    const event = buildDownloadEvent(
      download(`?utm_source=${'a'.repeat(65)}&utm_campaign=%3Cscript%3E`),
      'mac',
      true
    )!;
    expect(event.properties).toMatchObject({ utm_source: null, utm_campaign: null });
  });

  it.each([
    ['Global Privacy Control', { 'sec-gpc': '1' }],
    ['Do Not Track', { dnt: '1' }],
    ['a link-preview bot', { 'user-agent': 'Slackbot-LinkExpanding 1.0' }],
    ['a crawler', { 'user-agent': 'Googlebot/2.1' }],
  ])('sends nothing for %s', (_label, headers) => {
    expect(buildDownloadEvent(download('', headers), 'mac', true)).toBeNull();
  });

  it('sends nothing when no project key is set', () => {
    env.POSTHOG_PROJECT_KEY = undefined;
    expect(buildDownloadEvent(download(), 'mac', true)).toBeNull();
  });
});

describe('countDownload', () => {
  it('posts one event to the batch endpoint after the response', async () => {
    countDownload(download(), 'mac', true);
    await Promise.all(pending);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://us.i.posthog.com/batch/');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.api_key).toBe('phc_test');
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0].event).toBe('desktop_download');
  });

  it('makes no request when the visitor declined', async () => {
    countDownload(download('', { 'sec-gpc': '1' }), 'mac', true);
    await Promise.all(pending);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs and drops a PostHog failure instead of throwing', async () => {
    fetchSpy.mockRejectedValue(new Error('posthog down'));
    countDownload(download(), 'windows', true);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(console.error).toHaveBeenCalled();
  });
});
