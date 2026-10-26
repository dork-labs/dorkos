/**
 * @vitest-environment jsdom
 */
/**
 * `api.forward` in the browser (DOR-3325): every call goes to THIS mini app's
 * own routes, the forward carries the window's client id and only the three
 * fields the server takes, and a refusal throws a `ForwardError` with the
 * server's code.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ForwardError } from '@dorkos/extension-api';
import { createExtensionForwardApi } from '../model/extension-forward-api';
import {
  answerForwardConsent,
  currentForwardConsent,
  subscribeForwardConsent,
} from '../model/forward-consent';

/** Answer the next core prompt as soon as it shows. */
function answerPrompt(allowed: boolean) {
  const stop = subscribeForwardConsent(() => {
    const ask = currentForwardConsent();
    if (ask) {
      stop();
      answerForwardConsent(ask, allowed);
    }
  });
}

/** A fetch that answers each call in turn. */
function answers(...replies: Array<[number, unknown]>) {
  const fn = vi.fn();
  for (const [status, body] of replies) {
    fn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: vi.fn().mockResolvedValue(body),
    });
  }
  return fn;
}

const CONSENT = {
  code: 'no_agent',
  error: 'Not allowed yet.',
  consent: { id: 'p1', agent: { id: 'pm', name: 'DorkOS PM' }, appName: 'Dorian Desk' },
};

/** A fetch that answers once with this status and body. */
function answer(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.forward', () => {
  it('posts the typed text and the item to this mini app’s own route, with the window’s id', async () => {
    const fetchMock = answer(201, { id: 'f1', agent: { id: 'a', name: 'PM' }, sentAt: 'now' });
    vi.stubGlobal('fetch', fetchMock);
    const forward = createExtensionForwardApi('dorian-desk');

    const receipt = await forward.send({
      text: 'Yes',
      itemId: 'item-7',
      itemTitle: 'Pay it',
      // A field the API does not take never reaches the server.
      ...({ to: 'someone-else' } as object),
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/extensions/dorian-desk/forward');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Client-Id']).toMatch(/^web-/);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ text: 'Yes', itemId: 'item-7', itemTitle: 'Pay it' });
    expect(receipt.id).toBe('f1');
  });

  it('reads the agent’s replies to one forward', async () => {
    const fetchMock = answer(200, { replies: [{ id: 'r1', markdown: 'Done' }] });
    vi.stubGlobal('fetch', fetchMock);
    const replies = await createExtensionForwardApi('dorian-desk').replies('f 1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/extensions/dorian-desk/forward/f%201/replies');
    expect(replies).toEqual([{ id: 'r1', markdown: 'Done' }]);
  });

  it('throws the server’s refusal as a ForwardError with its code', async () => {
    vi.stubGlobal(
      'fetch',
      answer(409, { error: 'Pick an agent for this mini app first.', code: 'no_agent' })
    );
    const err = await createExtensionForwardApi('dorian-desk')
      .send({ text: 'hi', itemId: 'i' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForwardError);
    expect((err as ForwardError).code).toBe('no_agent');
  });

  it('asks in the core prompt the first time, then lets DorkOS send what it kept', async () => {
    const fetchMock = answers([409, CONSENT], [201, { id: 'f1', agent: { id: 'pm' } }]);
    vi.stubGlobal('fetch', fetchMock);
    answerPrompt(true);

    const receipt = await createExtensionForwardApi('dorian-desk').send({
      text: 'Yes',
      itemId: 'item-7',
      agentId: 'pm',
    });

    expect(receipt.id).toBe('f1');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/extensions/dorian-desk/forward/pending/p1/allow');
    // Nothing the page says reaches the Allow: the server sends what it kept.
    expect(init.body).toBe('{}');
  });

  it('sends nothing when the person says no', async () => {
    const fetchMock = answers([409, CONSENT], [204, {}]);
    vi.stubGlobal('fetch', fetchMock);
    answerPrompt(false);

    const err = await createExtensionForwardApi('dorian-desk')
      .send({ text: 'Yes', itemId: 'item-7', agentId: 'pm' })
      .catch((e: unknown) => e);

    expect((err as ForwardError).code).toBe('no_agent');
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/api/extensions/dorian-desk/forward/pending/p1/decline'
    );
  });

  it('reads the allowed agents', async () => {
    vi.stubGlobal('fetch', answer(200, { agents: [{ id: 'pm', name: 'DorkOS PM' }], missing: [] }));
    expect(await createExtensionForwardApi('dorian-desk').agents()).toEqual([
      { id: 'pm', name: 'DorkOS PM' },
    ]);
  });
});
