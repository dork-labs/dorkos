import { describe, expect, it } from 'vitest';
import { decideLink, type LinkDecision } from '../link-gate.js';
import { signInLinkComposers, signInName } from '../linked.js';

describe('the sign-in link gate', () => {
  const base = {
    providerId: 'oidc',
    creatingUser: false,
    settingsLinkUserId: null as string | null,
    userId: 'user-1',
    trustOidc: false,
  };

  it('decides every account row by the documented table', () => {
    // Purpose: fails if any provider other than the host's trusted issuer can link without a
    // password, if trust applies to Google or GitHub, or if a session alone (no Settings-link
    // state for this very account) exempts a sign-in.
    const cases: [Partial<typeof base>, LinkDecision][] = [
      [{ providerId: 'credential' }, 'allow'],
      [{ providerId: 'credential', trustOidc: true }, 'allow'],
      [{ creatingUser: true }, 'allow'],
      [{ providerId: 'github', creatingUser: true }, 'allow'],
      [{ settingsLinkUserId: 'user-1' }, 'allow'],
      [{ providerId: 'google', settingsLinkUserId: 'user-1' }, 'allow'],
      // A Settings link started by another account never exempts this one.
      [{ settingsLinkUserId: 'user-2' }, 'password'],
      [{ settingsLinkUserId: 'user-2', trustOidc: true }, 'trusted'],
      [{}, 'password'],
      [{ trustOidc: true }, 'trusted'],
      [{ providerId: 'google' }, 'password'],
      [{ providerId: 'google', trustOidc: true }, 'password'],
      [{ providerId: 'github', trustOidc: true }, 'password'],
    ];
    for (const [input, decision] of cases)
      expect(decideLink({ ...base, ...input }), JSON.stringify(input)).toBe(decision);
  });
});

describe('the linked sign-in notice', () => {
  const config = {
    publicUrl: 'https://spaces.example.com',
    oidc: { label: 'DorkOS' } as Parameters<typeof signInName>[1]['oidc'],
  };
  /** Compose the message for an audit event with these changed fields. */
  async function compose(changed: string[]) {
    const pool = {
      query: async () => ({
        rows: [{ changed_fields: changed, created_at: new Date('2026-10-04T12:30:00Z') }],
      }),
    };
    const composer = signInLinkComposers(config)['account.sign_in_linked']!;
    return composer({
      pool: pool as never,
      notice: {
        id: 'n',
        communityId: 'c',
        kind: 'account.sign_in_linked',
        subjectId: 's',
        recipientUserId: 'u',
        attempt: 1,
        createdAt: new Date(),
      },
      now: new Date(),
    });
  }

  it('names the sign-in, says what was removed, and how to undo it', async () => {
    // Purpose: fails if the mail hides that a takeover cleared the old password, or leaves out
    // how to undo a link the person did not make.
    const cleared = await compose(['oidc', 'cleared']);
    expect(cleared?.subject).toBe('A sign-in was linked to your account');
    expect(cleared?.text).toContain('DorkOS sign-in was linked to your account');
    expect(cleared?.text).toContain('old password and other sign-ins were removed');
    expect(cleared?.text).toContain('open Settings, Account and remove it');
    const password = await compose(['github', 'password']);
    expect(password?.text).toContain('GitHub sign-in was linked');
    expect(password?.text).toContain('password was entered');
    expect(password?.text).not.toContain('removed,');
  });

  it('sends nothing for an event that no longer exists', async () => {
    // Purpose: fails if a notice about a vanished audit event is mailed with made-up details.
    const composer = signInLinkComposers(config)['account.sign_in_linked']!;
    const pool = { query: async () => ({ rows: [] }) };
    expect(
      await composer({
        pool: pool as never,
        notice: {
          id: 'n',
          communityId: 'c',
          kind: 'account.sign_in_linked',
          subjectId: 's',
          recipientUserId: 'u',
          attempt: 1,
          createdAt: new Date(),
        },
        now: new Date(),
      })
    ).toBeNull();
  });
});
