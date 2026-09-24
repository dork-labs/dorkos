import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommunityWireHandleSchema } from '@dorkos/shared/community-wire';
import {
  ERASED_MENTION,
  randomHuskHandle,
  rewriteHandleTokens,
  tombstonePayloadHash,
} from '../erasure/erasure.js';
import { parseErasureJournal } from '../erasure/reapply.js';
import { resolveCommunityMentions } from '../mentions.js';
import { reauthenticationDecision, REAUTH_WINDOW_MS } from '../routes/erasures.js';

// Purpose: an erased person's handle is released, so every token the mention resolver would
// read as them must become @[erased], and nothing else may change. Each case names the
// failure it catches.
describe('rewriteHandleTokens (AC-3)', () => {
  const rewrite = (text: string) => rewriteHandleTokens(text, ['zq']);

  it('keeps punctuation after the handle (a greedy rewrite would eat it)', () => {
    expect(rewrite('thanks @zq, see you')).toBe(`thanks ${ERASED_MENTION}, see you`);
    expect(rewrite('bye @zq.')).toBe(`bye ${ERASED_MENTION}.`);
  });

  it("applies the resolver's trailing strip and keeps the stripped characters", () => {
    expect(rewrite('@zq_ and @zq-')).toBe(`${ERASED_MENTION}_ and ${ERASED_MENTION}-`);
    expect(rewrite('@zq...')).toBe(`${ERASED_MENTION}...`);
  });

  it('matches handles case-insensitively, as the resolver does', () => {
    expect(rewrite('hi @ZQ')).toBe(`hi ${ERASED_MENTION}`);
  });

  it('leaves longer handles that merely start with the erased one', () => {
    expect(rewrite('@zq2 and @zqx')).toBe('@zq2 and @zqx');
  });

  it('leaves email-shaped strings alone (left boundary)', () => {
    expect(rewrite('x@zq and bob@zq.com')).toBe('x@zq and bob@zq.com');
    expect(rewrite('a.@zq b-@zq c_@zq')).toBe('a.@zq b-@zq c_@zq');
  });

  it('leaves code and quotes untouched, even when a handle names a package scope', () => {
    const fenced = '```\nimport x from "@types/node";\n```';
    expect(rewriteHandleTokens(fenced, ['types'])).toBe(fenced);
    expect(rewriteHandleTokens('use `@types/node` here', ['types'])).toBe('use `@types/node` here');
    expect(rewrite('> @zq said so\n@zq')).toBe(`> @zq said so\n${ERASED_MENTION}`);
  });

  it('rewrites at the start of the text and after any non-address character', () => {
    expect(rewrite('@zq')).toBe(ERASED_MENTION);
    expect(rewrite('(@zq)\n@zq!')).toBe(`(${ERASED_MENTION})\n${ERASED_MENTION}!`);
  });

  it('rewrites every one of several handles, and nothing when there are none', () => {
    expect(rewriteHandleTokens('@zq and @bot', ['zq', 'bot'])).toBe(
      `${ERASED_MENTION} and ${ERASED_MENTION}`
    );
    expect(rewriteHandleTokens('@zq', [])).toBe('@zq');
  });

  it('writes a token the resolver can never read as a mention again', () => {
    const rewritten = rewrite('@zq thanks');
    expect(resolveCommunityMentions(rewritten, [{ id: 'erased', handle: 'erased' }])).toEqual([]);
  });

  it('rewrites exactly the tokens the resolver resolves to the person, outside the boundary rule', () => {
    const texts = ['@zq hi', '@zq_ ok', 'hey @ZQ.', '`@zq`', '> @zq', '@zqx', '(@zq)'];
    for (const text of texts) {
      const resolved = resolveCommunityMentions(text, [{ id: 'p', handle: 'zq' }]).length > 0;
      expect(rewrite(text) !== text, text).toBe(resolved);
    }
  });
});

describe('tombstones', () => {
  // Purpose: an erased entry's payload hash must be the hash a post of the tombstone text
  // would have, so nothing about the stored hash reveals the erased payload.
  it('hashes the tombstone payload in the shape a post hashes its own', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          text: 'This message was erased.',
          mentions: [],
          parentEntryId: 'parent-1',
          attachmentIds: [],
        })
      )
      .digest('hex');
    expect(tombstonePayloadHash('parent-1')).toBe(expected);
    expect(tombstonePayloadHash(null)).not.toBe(expected);
  });

  // Purpose: the husk handle must be a legal handle (the wire refuses anything else) and
  // unguessable, so it cannot lead back to the person.
  it('mints legal, distinct husk handles', () => {
    const handles = new Set(Array.from({ length: 200 }, () => randomHuskHandle()));
    expect(handles.size).toBe(200);
    for (const handle of handles) {
      expect(handle).toMatch(/^erased-[a-z2-7]{12}$/);
      expect(CommunityWireHandleSchema.safeParse(handle).success).toBe(true);
    }
  });
});

describe('reauthenticationDecision', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  // Purpose: a password account must always type its password, however fresh the session.
  it('asks a password account for its password', () => {
    const fresh = { hasPassword: true, sessionCreatedAt: ago(1000), now };
    expect(reauthenticationDecision({ ...fresh, passwordGiven: true })).toBe('check-password');
    expect(reauthenticationDecision({ ...fresh, passwordGiven: false })).toBe('password-required');
  });

  // Purpose: a provider-only account proves presence with a sign-in under five minutes old.
  it('accepts a fresh provider-only session and refuses a stale one', () => {
    const base = { hasPassword: false, passwordGiven: false, now };
    expect(
      reauthenticationDecision({ ...base, sessionCreatedAt: ago(REAUTH_WINDOW_MS - 1000) })
    ).toBe('fresh-session');
    expect(reauthenticationDecision({ ...base, sessionCreatedAt: ago(REAUTH_WINDOW_MS) })).toBe(
      'sign-in-again'
    );
  });
});

describe('parseErasureJournal', () => {
  const community = '11111111-1111-4111-8111-111111111111';
  const member = '22222222-2222-4222-8222-222222222222';

  // Purpose: a host re-applies erasures from either the log lines or the journal file.
  it('reads the JSON lines the server writes and the short forms', () => {
    expect(
      parseErasureJournal(
        [
          JSON.stringify({
            event: 'community.member_erased',
            communityId: community,
            memberId: member,
          }),
          '',
          JSON.stringify({ event: 'community.account_erased', userId: 'user_1' }),
          `member ${community} ${member}`,
          'account user_2',
        ].join('\n')
      )
    ).toEqual([
      { kind: 'member', communityId: community, memberId: member },
      { kind: 'account', userId: 'user_1' },
      { kind: 'member', communityId: community, memberId: member },
      { kind: 'account', userId: 'user_2' },
    ]);
  });

  // Purpose: a stray line must stop the run rather than be skipped silently.
  it('refuses a line that is not an erasure record, naming only its number', () => {
    expect(() => parseErasureJournal(`member ${community}\n`)).toThrow('Line 1 ');
    expect(() => parseErasureJournal('{"event":"other"}')).toThrow('Line 1 ');
    expect(() => parseErasureJournal('account a b')).toThrow('Line 1 ');
  });
});
