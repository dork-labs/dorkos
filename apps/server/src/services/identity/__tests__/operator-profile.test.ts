/**
 * The operator's name, in the two contexts that must disagree (spec
 * `identity-consistency` §W2.2 G5).
 *
 * `author-registry.ts` mints the operator's row with `displayName = 'You'` and
 * `bindOwner` never rewrites it — deliberately, because that column is a render
 * cache with one value per author, so writing the account name into it would
 * relabel every message they had ever written. A ROOM is the seat where `'You'`
 * is the right word. A roster is not: it lists everyone, so the operator's row
 * has to say who they actually are.
 *
 * **Both halves are asserted in the same test, or the divergence is not
 * pinned.** A roster test alone passes if somebody later "fixes" the room path
 * by rewriting the stored name; a room test alone passes if the roster never
 * learned the real name in the first place.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { AuthorRegistry, toAuthorRef } from '../../rooms/author-registry.js';
import { aggregateTeamRoster } from '../aggregate-team.js';
import { IDENTITY_MAX_LENGTH } from '@dorkos/shared/untrusted-text';
import {
  OPERATOR_FALLBACK_DISPLAY_NAME,
  resolveAnswererName,
  resolveOperatorProfile,
} from '../operator-profile.js';

const OWNER_USER_ID = 'user-1';

describe('the operator name diverges between a room and the roster', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
  });

  it('renders `Dorian` on the roster while a room still renders `You`', async () => {
    const operatorAuthor = registry.bindOwner(OWNER_USER_ID);

    const { members } = await aggregateTeamRoster({
      listPeople: () => registry.listActive('human'),
      listAgentAuthors: () => [],
      listAgents: () => [],
      listClaims: () => [],
      listRooms: () => [],
      sessionActivity: () => ({}),
      account: () => ({ id: OWNER_USER_ID, name: 'Dorian', email: 'dorian@dorkos.ai' }),
      configDisplayName: () => null,
      defaultAgentName: () => null,
    });

    // The roster half: the real name, from the owner account.
    expect(members.find((m) => m.isSelf)?.displayName).toBe('Dorian');

    // The room half, unchanged: `toAuthorRef` is exactly what a room roster
    // puts on the wire, and the stored literal is still what it carries.
    expect(toAuthorRef(registry.getById(operatorAuthor.id)!).displayName).toBe('You');
  });
});

describe('resolveOperatorProfile', () => {
  it('prefers the owner account name over everything else', () => {
    expect(
      resolveOperatorProfile(
        {
          account: () => ({ id: 'user-1', name: 'Dorian', email: null }),
          configDisplayName: () => 'Dork',
        },
        'You'
      ).displayName
    ).toBe('Dorian');
  });

  it('falls back to the profile display name when there is no account', () => {
    expect(
      resolveOperatorProfile({ account: () => null, configDisplayName: () => 'Dork' }, 'You')
        .displayName
    ).toBe('Dork');
  });

  it('falls back to the stored author name only when nothing else knows one', () => {
    expect(
      resolveOperatorProfile(
        {
          account: () => ({ id: 'user-1', name: '  ', email: null }),
          configDisplayName: () => null,
        },
        'Someone'
      ).displayName
    ).toBe('Someone');
  });

  it('falls back to the literal last, never first', () => {
    expect(
      resolveOperatorProfile({ account: () => null, configDisplayName: () => null }, null)
        .displayName
    ).toBe(OPERATOR_FALLBACK_DISPLAY_NAME);
  });

  it('sanitizes the agent-writable profile name before it is rendered as an identity', () => {
    expect(
      resolveOperatorProfile(
        { account: () => null, configDisplayName: () => 'Dor<script>ian' },
        null
      ).displayName
    ).not.toContain('<');
  });

  it('sanitizes the ACCOUNT name too, which the Ask receipt now broadcasts', () => {
    // DOR-1355 review. The account name used to be exempt on the grounds that a
    // person typed it at signup. Better Auth enforces no cap and strips no
    // control character, and the name is now printed inside a sentence DorkOS
    // wrote in every open window, so "typed by a person" is not a guarantee
    // about length or about what is in it.
    const hostile = `Ada\u0000<script>\nLovelace ${'x'.repeat(200)}`;

    const { displayName } = resolveOperatorProfile(
      {
        account: () => ({ id: OWNER_USER_ID, name: hostile, email: null }),
        configDisplayName: () => null,
      },
      null
    );

    expect(displayName).toHaveLength(IDENTITY_MAX_LENGTH);
    expect(displayName).not.toContain('<');
    expect(displayName).not.toContain('>');
    expect([...displayName].filter((ch) => ch.codePointAt(0)! < 0x20)).toEqual([]);
    expect(displayName.startsWith('Ada script')).toBe(true);
  });

  it('gives the Ask receipt the same sanitized name, and nothing to fall back on', () => {
    // The receipt shares the ladder's two real rungs and stops before its
    // fallbacks: "Already answered by You" in a window that did not answer
    // would be flatly wrong, so an install that knows no name gets no name.
    const account = { id: OWNER_USER_ID, name: 'Ada<script>', email: null };

    expect(resolveAnswererName({ account: () => account, configDisplayName: () => null })).toBe(
      'Ada script'
    );
    expect(
      resolveAnswererName({ account: () => null, configDisplayName: () => null })
    ).toBeUndefined();
    // A name that is nothing but control characters is not a name, so it falls
    // through rather than winning and then vanishing.
    expect(
      resolveAnswererName({
        account: () => ({ id: OWNER_USER_ID, name: '<<<', email: null }),
        configDisplayName: () => 'Ada',
      })
    ).toBe('Ada');
  });

  it('carries the account email, and nothing when there is no account', () => {
    expect(
      resolveOperatorProfile(
        {
          account: () => ({ id: OWNER_USER_ID, name: 'Dorian', email: 'dorian@dorkos.ai' }),
          configDisplayName: () => null,
        },
        null
      ).email
    ).toBe('dorian@dorkos.ai');
    expect(
      resolveOperatorProfile({ account: () => null, configDisplayName: () => 'Dork' }, null).email
    ).toBeUndefined();
  });
});
