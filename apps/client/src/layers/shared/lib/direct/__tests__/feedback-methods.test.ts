/**
 * Tests for the in-process (Obsidian) feedback methods (DOR-317; degradation
 * notes per feedback-pipeline spec Part 1).
 *
 * Proves the DEGRADATION guarantee: even when a caller passes the full
 * diagnostics/identity-adjacent submission shape (interface parity with
 * `HttpTransport`), only `kind`/`message`/`contact`/`route` ever reach the
 * built event — Obsidian has no local server to source a log excerpt or
 * resolve an account identity from.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDirectFeedbackMethods } from '../feedback-methods';

describe('createDirectFeedbackMethods', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends only kind/message/contact/route — diagnostics/sessionId/etc never leave the process', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const { sendFeedback } = createDirectFeedbackMethods();

    const result = await sendFeedback({
      kind: 'bug',
      message: 'it crashed',
      contact: 'a@b.com',
      route: '/agents',
      sessionId: 'sess_123',
      includeServerLogs: true,
      transcriptExcerpt: 'a transcript excerpt',
      screenshotUploadId: 'upload_abc',
      diagnostics: {
        clientReport: { version: '0.47.0', platform: 'darwin-arm64', runtimes: [], flags: {} },
        breadcrumbs: [{ at: new Date().toISOString(), kind: 'console_error', message: 'boom' }],
      },
    });

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      events: Array<{ properties: Record<string, unknown> }>;
    };
    const properties = body.events[0].properties;
    expect(properties).toMatchObject({
      kind: 'bug',
      message: 'it crashed',
      contact: 'a@b.com',
      route: '/agents',
    });
    // None of the server-only / diagnostics fields ride the wire event.
    for (const forbidden of [
      'diagnostics',
      'sessionId',
      'includeServerLogs',
      'transcriptExcerpt',
      'screenshotUploadId',
      'clientReport',
      'breadcrumbs',
      'reporterEmail',
      'reporterName',
    ]) {
      expect(properties).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(body)).not.toContain('upload_abc');
    expect(JSON.stringify(body)).not.toContain('sess_123');
  });

  it('returns ok:false (never throws) on a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const { sendFeedback } = createDirectFeedbackMethods();

    const result = await sendFeedback({ kind: 'feedback', message: 'hi' });

    expect(result).toEqual({ ok: false });
  });
});
