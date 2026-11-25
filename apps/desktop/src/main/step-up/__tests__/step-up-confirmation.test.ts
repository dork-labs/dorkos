/**
 * The Mac app's "Confirm it's you" confirmation (DOR-3234): the shell reads
 * the server's words, posts the password itself with the server's own
 * origin and the window's proof, and the app's page hears only how it ended.
 */
import { describe, expect, it, vi } from 'vitest';

import { isHeldActionId, StepUpConfirmation } from '../step-up-confirmation';

const ORIGIN = 'http://localhost:4242';
const ID = '01M66Q5GH0CX6W6HZPRTHM27CB';

type Call = { url: string; init: RequestInit };

/** A server answering by method and path suffix. */
function server(answers: Record<string, [number, unknown]>, pageStamp: string | null = null) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.slice(`${ORIGIN}/api/step-up/${ID}`.length) || '/'}`;
    const [status, body] = answers[key] ?? [
      404,
      { title: 'x', status: 404, code: 'expired', detail: 'That took too long. Nothing changed.' },
    ];
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  });
  const confirmation = new StepUpConfirmation(ID, {
    origin: ORIGIN,
    fetch,
    personProof: () => 'proof-1',
    pageStamp: async () => pageStamp,
  });
  return { confirmation, calls };
}

const VIEW = {
  reason: 'Confirm it’s you to add github for all your agents.',
  requestCode: 'K7MR-4XQ9-HT3W',
  notes: ['Not pinned.'],
};

describe('isHeldActionId', () => {
  it('takes a server id and nothing else', () => {
    expect(isHeldActionId(ID)).toBe(true);
    for (const bad of ['', '../config', 'a/b', 'x'.repeat(65), 42, null, undefined]) {
      expect(isHeldActionId(bad)).toBe(false);
    }
  });
});

describe('StepUpConfirmation', () => {
  it('reads the server’s own words, with the window’s proof, its cookie and the server’s origin', async () => {
    const { confirmation, calls } = server({ 'GET /': [200, { ...VIEW, methods: ['password'] }] });
    expect(await confirmation.view()).toEqual(VIEW);
    const [{ init }] = calls;
    expect(init.credentials).toBe('include');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-dorkos-person']).toBe('proof-1');
    // Without it Chromium sends `Sec-Fetch-Site: none`, which the read refuses.
    expect(headers.Origin).toBe(ORIGIN);
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['x-dorkos-page-stamp']).toBeUndefined();
  });

  it('sends the app window’s page stamp on every call, reads and writes (DOR-5026)', async () => {
    const { confirmation, calls } = server(
      {
        'GET /': [200, { ...VIEW, methods: ['password'] }],
        'POST /password': [200, { ok: true, status: 200, result: {} }],
      },
      'v1.made-up.stamp'
    );
    await confirmation.view();
    await confirmation.submit({ kind: 'password', password: 'pw' });
    expect(calls).toHaveLength(2);
    for (const { init } of calls) {
      expect((init.headers as Record<string, string>)['x-dorkos-page-stamp']).toBe(
        'v1.made-up.stamp'
      );
    }
  });

  it('passes on the mini apps that keep confirming off, in the sheet’s words', async () => {
    const { confirmation } = server({
      'GET /': [
        200,
        {
          ...VIEW,
          methods: [],
          passwordUnavailable: 'extension-risk',
          blockedBy: [
            {
              id: 'sq',
              name: 'Social queue',
              reason: 'agent-folder',
              agentName: 'dorkos-marketing',
            },
            { id: 'n', name: 'Notes', reason: 'changed' },
            { bogus: true },
          ],
        },
      ],
    });
    expect(await confirmation.view()).toEqual({
      ...VIEW,
      unavailable: 'extension-risk',
      blockedLines: [
        'Confirming is off while Social queue can be edited by dorkos-marketing.',
        'Confirming is off while Notes has changed since you approved it.',
      ],
    });
  });

  it('passes a mini app’s name on as plain text, markup and all (DOR-4906)', async () => {
    const name = '<img src="x" alt="planted">Notes';
    const { confirmation } = server({
      'GET /': [
        200,
        {
          ...VIEW,
          methods: [],
          passwordUnavailable: 'extension-risk',
          blockedBy: [{ id: 'n', name, reason: 'changed' }],
        },
      ],
    });
    // The window shows it with textContent (`preload/step-up.ts`), never as HTML.
    expect(await confirmation.view()).toMatchObject({
      blockedLines: [`Confirming is off while ${name} has changed since you approved it.`],
    });
  });

  it('passes on why no password is offered', async () => {
    const { confirmation } = server({
      'GET /': [200, { ...VIEW, methods: [], passwordUnavailable: 'insecure-connection' }],
    });
    expect(await confirmation.view()).toMatchObject({ unavailable: 'insecure-connection' });
  });

  it('posts the password with the server’s own origin, and ends confirmed with the action’s result', async () => {
    const { confirmation, calls } = server({
      'POST /password': [200, { ok: true, status: 201, result: { added: 'github' } }],
    });
    expect(await confirmation.submit({ kind: 'password', password: 'pw' })).toEqual({
      kind: 'confirmed',
    });
    const post = calls.find((call) => call.url.endsWith('/password'))!;
    expect(post.init.credentials).toBe('include');
    expect((post.init.headers as Record<string, string>).Origin).toBe(ORIGIN);
    expect(JSON.parse(String(post.init.body))).toEqual({ password: 'pw' });
    // Confirmed: nothing to cancel, and the page hears only the action's answer.
    expect(await confirmation.finish()).toEqual({
      kind: 'confirmed',
      status: 201,
      result: { added: 'github' },
    });
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(false);
  });

  it('asks again on the same form after a wrong password', async () => {
    const { confirmation } = server({
      'POST /password': [
        403,
        {
          title: 'x',
          status: 403,
          code: 'wrong_password',
          detail: 'That’s not your DorkOS password. Try again.',
        },
      ],
    });
    expect(await confirmation.submit({ kind: 'password', password: 'no' })).toEqual({
      kind: 'retry',
      message: 'That’s not your DorkOS password. Try again.',
    });
  });

  it('counts down from the problem’s retryAfterMs after too many wrong passwords', async () => {
    const { confirmation } = server({
      'POST /password': [
        429,
        {
          title: 'x',
          status: 429,
          code: 'rate_limited',
          detail: 'Too many wrong passwords. Try again in a few minutes.',
          retryAfterMs: 31_500,
        },
      ],
    });
    expect(await confirmation.submit({ kind: 'password', password: 'no' })).toEqual({
      kind: 'retry',
      message: 'Too many wrong passwords. Try again in a few minutes.',
      retryAfterSeconds: 32,
    });
  });

  it('asks again when the request changed after it was held', async () => {
    const { confirmation } = server({
      'POST /password': [
        412,
        {
          title: 'x',
          status: 412,
          code: 'precondition_failed',
          detail: 'That confirmation was for a different request. Confirm this one.',
        },
      ],
    });
    expect(await confirmation.submit({ kind: 'password', password: 'yes' })).toEqual({
      kind: 'ended',
      message: 'That confirmation was for a different request. Confirm this one.',
    });
    expect(await confirmation.finish()).toEqual({ kind: 'ask-again', reason: 'different-request' });
  });

  it('reads a refusal sent as a problem document', async () => {
    const { confirmation } = server({
      'POST /password': [
        403,
        {
          type: 'urn:dorkos:problem:forbidden',
          title: 'You can’t do this.',
          status: 403,
          code: 'forbidden',
          detail: 'Only the owner can confirm this.',
        },
      ],
    });
    expect(await confirmation.submit({ kind: 'password', password: 'no' })).toMatchObject({
      message: 'Only the owner can confirm this.',
    });
  });

  it('turns a too-short password into a change, and posts the change', async () => {
    const { confirmation, calls } = server({
      'POST /password': [
        409,
        { title: 'x', status: 409, code: 'password_too_short', detail: 'x', minLength: 8 },
      ],
      'POST /change-password': [200, { ok: true, status: 200, result: {} }],
    });
    expect(await confirmation.submit({ kind: 'password', password: 'short' })).toEqual({
      kind: 'too-short',
      minLength: 8,
    });
    await confirmation.submit({
      kind: 'change',
      currentPassword: 'short',
      newPassword: 'a longer one',
    });
    const change = calls.find((call) => call.url.endsWith('/change-password'))!;
    expect(JSON.parse(String(change.init.body))).toEqual({
      currentPassword: 'short',
      newPassword: 'a longer one',
    });
  });

  it('closed without confirming: tells the server to drop it, and nothing was confirmed', async () => {
    const { confirmation, calls } = server({ 'DELETE /': [204, null] });
    expect(await confirmation.finish()).toEqual({ kind: 'not-confirmed' });
    const drop = calls.find((call) => call.init.method === 'DELETE')!;
    expect((drop.init.headers as Record<string, string>).Origin).toBe(ORIGIN);
  });

  it('"Sign in again": drops this held action, and the page signs in and asks afresh', async () => {
    const { confirmation, calls } = server({ 'DELETE /': [204, null] });
    confirmation.signInAgain();
    expect(await confirmation.finish()).toEqual({ kind: 'sign-in-again' });
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(true);
  });

  it('"Reload": keeps this held action, so the reloaded page reopens it (DOR-5086)', async () => {
    const { confirmation, calls } = server({ 'DELETE /': [204, null] });
    confirmation.reload();
    expect(await confirmation.finish()).toEqual({ kind: 'reload' });
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(false);
  });

  it.each([
    ['a page too old', 'stale-page', { passwordUnavailable: 'stale-page', stale: 'stale-page' }],
    [
      'a sign-in too old, in the shape a stamp-less page gets',
      'stale-sign-in',
      { passwordUnavailable: 'extension-risk', blockedBy: [], stale: 'stale-sign-in' },
    ],
  ])('names %s and offers no password (DOR-5086)', async (_label, unavailable, shape) => {
    const { confirmation } = server({ 'GET /': [200, { ...VIEW, methods: [], ...shape }] });
    expect(await confirmation.view()).toEqual({ ...VIEW, unavailable });
  });

  it('closed while the password is being checked: waits for the answer, and never cancels an action that ran', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const calls: Call[] = [];
    const confirmation = new StepUpConfirmation(ID, {
      origin: ORIGIN,
      personProof: () => null,
      pageStamp: async () => null,
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (init.method === 'POST') {
          await answered;
          return new Response(JSON.stringify({ ok: true, status: 201, result: { added: 'x' } }), {
            status: 200,
          });
        }
        return new Response(null, { status: 204 });
      },
    });
    const submitted = confirmation.submit({ kind: 'password', password: 'pw' });
    // A second press while the first is in flight sends nothing more.
    const again = confirmation.submit({ kind: 'password', password: 'pw' });
    const finished = confirmation.finish();
    answer();
    await expect(submitted).resolves.toEqual({ kind: 'confirmed' });
    await expect(again).resolves.toEqual({ kind: 'confirmed' });
    await expect(finished).resolves.toEqual({
      kind: 'confirmed',
      status: 201,
      result: { added: 'x' },
    });
    expect(calls.filter((call) => call.init.method === 'POST')).toHaveLength(1);
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(false);
  });

  it('expired: the page asks for the action again', async () => {
    const { confirmation } = server({ 'DELETE /': [204, null] });
    expect(await confirmation.view()).toMatchObject({ askAgain: true });
    expect(await confirmation.finish()).toEqual({ kind: 'ask-again' });
  });
});
