import { describe, expect, it } from 'vitest';
import { browserErrorMessage } from '../lib/browser-error-message';

const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('browserErrorMessage (DOR-4325)', () => {
  it('points at the open sign-in window for signing_in', () => {
    expect(browserErrorMessage(refusal('signing_in', 'Finish signing in first.'))).toBe(
      'Finish signing in first. The sign-in window is open.'
    );
  });
  it.each([
    ['local_only', 'Use DorkOS on this computer to control its browser.'],
    ['person_only', 'Only you can do this, from DorkOS.'],
    ['bad_request', 'Check your browser choice and try again.'],
    ['unsupported', 'Opening the Agent browser in DorkOS needs the desktop app.'],
  ])('shows the server’s own words for %s', (code, message) => {
    expect(browserErrorMessage(refusal(code, message))).toBe(message);
  });
  it('falls back to a plain line when one of those comes back with no words', () => {
    expect(browserErrorMessage(refusal('unsupported', ''))).toBe('This browser can’t open here.');
  });
  it('still keeps unknown codes’ words out of the app', () => {
    expect(browserErrorMessage(refusal('browser_error', 'stack trace at line 4'))).toBe(
      'Couldn’t reach the browser. Reconnect and try again.'
    );
  });
});
