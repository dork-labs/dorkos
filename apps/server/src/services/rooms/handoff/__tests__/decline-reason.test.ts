import { describe, expect, it } from 'vitest';
import type { Room } from '@dorkos/shared/room-schemas';
import { declineReason } from '../decline-reason.js';
import { buildHandoffNotice } from '../../notices/notice-copy.js';
const room = { archived: false } as Room;
describe('handoff decline safety', () => {
  it('uses fixed copy for a reply from an outsider-marked turn', () => {
    const reason = declineReason(room, {
      outcome: 'quiet',
      text: 'token=secret /private/account',
      replyOutsider: true,
    });
    expect(reason).toBe('it read words from outside your team. Its chat says why.');
    expect(buildHandoffNotice('Bo', 'author-bo', '#room', reason).text).not.toMatch(
      /token=|secret|private/
    );
  });
  it('retains a clean unmarked reply as the reason', () => {
    expect(declineReason(room, { outcome: 'quiet', text: 'Already done.' })).toBe('Already done.');
  });
  it('retains a protected refusal even when the adapter also says busy', () => {
    expect(
      declineReason(room, {
        outcome: 'busy',
        text: null,
        failure: { refusal: 'pending-interaction', detail: '/private/account secret' },
      })
    ).toBe('it needs an answer in its chat. Open the chat to continue.');
  });
  it('keeps admission expiry distinct from runtime failure', () => {
    expect(declineReason(room, { outcome: 'refused', why: 'deadline', text: null })).toBe(
      'it waited too long to start. Send the post again.'
    );
  });
  it('never shares arbitrary failure detail or refusal codes', () => {
    const reason = declineReason(room, {
      outcome: 'busy',
      text: null,
      failure: { refusal: 'unknown-private-code', detail: 'token=secret /private/account' },
    });
    expect(reason).toBe("it couldn't start. Open its chat to see what's wrong.");
    expect(reason).not.toMatch(/private|secret|token=/);
  });
  it('keeps the complete safe failure explanation in the actual room notice', () => {
    const reason = declineReason(room, {
      outcome: 'failed',
      text: null,
      failure: { code: 'exception', detail: 'fabricated private diagnostic' },
    });
    const notice = buildHandoffNotice('Bo', 'author-bo', '#room', reason);
    expect(notice.text).toContain(reason);
    expect(reason).toContain('Open');
    expect(notice.text).not.toContain('fabricated private diagnostic');
  });
});
