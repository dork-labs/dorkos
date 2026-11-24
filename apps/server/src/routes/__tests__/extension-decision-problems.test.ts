/**
 * How an inbox refusal goes out on the wire (DOR-4979): a list code, a fixed
 * sentence, and the inbox's own word as `reason`. The inbox's message is
 * never sent.
 */
import { describe, expect, it } from 'vitest';
import { decisionRefusal } from '../extension-decision-problems.js';

describe('decisionRefusal', () => {
  it('answers an offer whose project is gone as a conflict with its reason', () => {
    const { status, body } = decisionRefusal({
      status: 409,
      code: 'offer_project_unavailable',
      message: 'That project is no longer available.',
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'conflict',
      reason: 'offer_project_unavailable',
      detail: 'That project is no longer available.',
    });
  });

  it('answers a settings store that threw as the server’s fault, with a fixed sentence', () => {
    const { status, body } = decisionRefusal({
      status: 500,
      code: 'offer_failed',
      message: 'EACCES: permission denied, open /home/sample/.dork/settings.json',
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({
      code: 'internal_error',
      reason: 'offer_failed',
      detail: 'Couldn’t change that. Try again.',
    });
    expect(JSON.stringify(body)).not.toContain('EACCES');
  });

  it('never sends the inbox’s own message for a word it does not know', () => {
    const { status, body } = decisionRefusal({
      status: 409,
      code: 'something_new',
      message: 'internal words',
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'conflict' });
    expect(JSON.stringify(body)).not.toContain('internal words');
  });
});
