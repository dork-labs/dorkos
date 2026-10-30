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
function server(answers: Record<string, [number, unknown]>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.slice(`${ORIGIN}/api/step-up/${ID}`.length) || '/'}`;
    const [status, body] = answers[key] ?? [
      404,
      { code: 'expired', error: 'That took too long. Nothing changed.' },
    ];
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  });
  const confirmation = new StepUpConfirmation(ID, {
    origin: ORIGIN,
    fetch,
    personProof: () => 'proof-1',
  });
  return { confirmation, calls };
}

const VIEW = {
  reason: 'Confirm it’s you to add github for all your agents.',
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
  it('reads the server’s own words, with the window’s proof and its cookie', async () => {
    const { confirmation, calls } = server({ 'GET /': [200, { ...VIEW, methods: ['password'] }] });
    expect(await confirmation.view()).toEqual(VIEW);
    const [{ init }] = calls;
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['x-dorkos-person']).toBe('proof-1');
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
        { code: 'wrong-password', error: 'That’s not your DorkOS password. Try again.' },
      ],
    });
    expect(await confirmation.submit({ kind: 'password', password: 'no' })).toEqual({
      kind: 'retry',
      message: 'That’s not your DorkOS password. Try again.',
    });
  });

  it('turns a too-short password into a change, and posts the change', async () => {
    const { confirmation, calls } = server({
      'POST /password': [409, { code: 'password-too-short', error: 'x', minLength: 8 }],
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

  it('expired: the page asks for the action again', async () => {
    const { confirmation } = server({ 'DELETE /': [204, null] });
    expect(await confirmation.view()).toMatchObject({ askAgain: true });
    expect(await confirmation.finish()).toEqual({ kind: 'ask-again' });
  });
});
