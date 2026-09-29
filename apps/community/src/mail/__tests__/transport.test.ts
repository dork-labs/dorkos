import { describe, expect, it } from 'vitest';
import { classifySmtpFailure } from '../transport.js';

describe('classifySmtpFailure', () => {
  it('fails a message at once only on a permanent answer to its envelope or body', () => {
    // Purpose: fails if a 5xx answer to a recipient or to the message is retried for three
    // days, which would only delay the owner's longer wait.
    for (const code of ['EENVELOPE', 'EMESSAGE'])
      for (const responseCode of [500, 550, 554, 599])
        expect(classifySmtpFailure({ code, responseCode }), `${code} ${responseCode}`).toEqual({
          outcome: 'refused',
          errorClass: 'SMTP_REJECTED',
        });
  });

  it('retries a temporary answer, a timeout, a dropped connection, or a login the host can fix', () => {
    // Purpose: fails if a greylisting 4xx, a timeout after the body, a refused connection, a TLS
    // or login failure, or something that is not an SMTP error at all fails the notice for good.
    for (const error of [
      { code: 'EENVELOPE', responseCode: 421 },
      { code: 'EMESSAGE', responseCode: 451 },
      { code: 'ETIMEDOUT' },
      { code: 'ECONNECTION' },
      { code: 'ESOCKET' },
      { code: 'ETLS' },
      { code: 'EAUTH', responseCode: 535 },
      { code: 'EENVELOPE', responseCode: 600 },
      { responseCode: 550 },
      new Error('boom'),
      'text',
      null,
    ])
      expect(classifySmtpFailure(error), JSON.stringify(error)).toEqual({
        outcome: 'retrying',
        errorClass: 'SMTP_UNAVAILABLE',
      });
  });
});
