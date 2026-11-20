import { describe, expect, it } from 'vitest';
import { OPERATING_SKILLS_VERSION } from '../pack.js';
import { continuingOnAnotherAccount } from '../skills/continuing-on-another-account.js';

describe('continuing on another account', () => {
  it('teaches self-moves from another chat and preserves the usage and active-answer limits', () => {
    const body = continuingOnAnotherAccount.body;

    expect(body).toContain('From another chat, you can move your own seat');
    expect(body).toContain('once your account reaches the usage threshold');
    expect(body).toContain('reseat_room_agent');
    expect(body).toContain('not while you are answering in that room');
    expect(body).not.toContain('You cannot move yourself');
    expect(body).not.toContain('for people only');
    expect(body).toContain('DorkOS credits are never picked for you');
  });

  it('updates already-seeded agents with a newer pack stamp', () => {
    expect(OPERATING_SKILLS_VERSION).toBeGreaterThanOrEqual(62);
  });
});
