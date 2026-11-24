import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../http-transport';

afterEach(() => vi.unstubAllGlobals());

describe('HttpTransport.restartExtension', () => {
  it('posts the named app through the authenticated HTTP client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"compiled"}'));
    vi.stubGlobal('fetch', fetchMock);
    await new HttpTransport('/api').restartExtension('notes app');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/extensions/notes%20app/restart',
      expect.objectContaining({ method: 'POST', body: '{}', credentials: 'include' })
    );
  });

  it('preserves the server refusal instead of reporting a restart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'urn:dorkos:problem:needs_approval',
            title: 'This waits for a person to approve it.',
            status: 403,
            code: 'needs_approval',
            detail: 'Review the app first.',
          }),
          { status: 403, headers: { 'Content-Type': 'application/problem+json' } }
        )
      )
    );
    await expect(new HttpTransport('/api').restartExtension('notes')).rejects.toMatchObject({
      message: 'Review the app first.',
      code: 'needs_approval',
      status: 403,
    });
  });
});
