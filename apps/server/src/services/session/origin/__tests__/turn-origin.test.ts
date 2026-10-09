/**
 * The one mapping from a turn origin to the power a new session row is born
 * with (DOR-2105).
 *
 * Two things are being pinned, and only the first needs a runtime assertion.
 *
 * 1. **The table itself** — which origin follows the operator's configured
 *    stop and which starts with no opinion. Read it as the spec: changing a row
 *    here is changing how much power a surface starts at, and it should be as
 *    hard to do by accident as editing this file makes it.
 * 2. **That the table is EXHAUSTIVE** — which the compiler already enforces
 *    through the `never` binding in `permissionSeedForOrigin`. The case below
 *    does not re-prove that; it proves the companion fact a compiler cannot,
 *    that the table in this file names every member of the union rather than a
 *    convenient subset of it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  permissionSeedForOrigin,
  relayTurnOrigin,
  type OriginPermissionSeed,
  type TurnOrigin,
} from '../turn-origin.js';

/**
 * Every origin, with the power it starts a session at.
 *
 * The second element is the whole claim: `'configured-stop'` means the
 * operator's own trust stop is resolved against the runtime being bound,
 * `'configured-stop-on-insert'` means the same but only for a row this write
 * MINTS, and `'none'` means the column is left NULL and the runtime decides.
 */
const TABLE: ReadonlyArray<readonly [TurnOrigin, OriginPermissionSeed]> = [
  // A person is holding the stream open, so a stop they set is one they can
  // answer — including on a row their own pre-launch settings change created.
  [{ kind: 'interactive' }, 'configured-stop'],
  // Nobody is watching a room turn, which is the reason it follows the
  // operator's level rather than the reason it may not (DOR-1917). On a NEW
  // row only: an existing one is a conversation somebody already configured,
  // and ADR 260908-170643 promises it is untouched.
  [{ kind: 'room', externalAuthor: false }, 'configured-stop-on-insert'],
  // Except from off this machine: that message belongs to the binding it was
  // bridged from, and a binding's absent grant is not consent (DOR-604).
  [{ kind: 'room', externalAuthor: true }, 'none'],
  // A run's power is already decided, on the schedule row (DOR-2100 is the
  // separate question of whether it should reach this row too).
  [{ kind: 'schedule' }, 'none'],
  // These three each carry a grant somebody set on the thing that triggered
  // them, and the operator's own level is not a second one (DOR-604).
  [{ kind: 'relay-binding' }, 'none'],
  [{ kind: 'agent-dm' }, 'none'],
  // A sender from outside on an agent subject (the A2A gateway): never
  // anything, whatever a later change does to our own agents' DMs.
  [{ kind: 'outside-sender' }, 'none'],
  [{ kind: 'connector-event' }, 'none'],
  // An agent started it through `session_start`: the agent is not the person
  // the operator's stop was set for, so power comes only from the tool's own
  // clamped mode.
  [{ kind: 'agent-launch' }, 'none'],
  // An extension started work in a brand-new chat in the person's project:
  // the new-session default a person's own chat gets, on the row it inserts.
  [{ kind: 'extension-start' }, 'configured-stop-on-insert'],
  // An extension sent an agent a message: app data, not a person's request,
  // so the chat it opens seeds no operator stop.
  [{ kind: 'extension-message' }, 'none'],
  // Another chat sent this one a message (spec `spin-off-chats` §2): the
  // sending chat's work, held to its level by the launch ceiling, so the
  // operator's stop (a promise to a person) is not seeded for it.
  [{ kind: 'chat-message' }, 'none'],
  // A limited session's work carried over to another account: the settings
  // row copied from the source session is its power, and the origin adds none.
  [{ kind: 'account-handoff' }, 'none'],
  // A limited session resumed by itself after its account's reset: already
  // bound, so its own row is its power.
  [{ kind: 'account-resume' }, 'none'],
  // Not a surface anybody ships to.
  [{ kind: 'test-harness' }, 'none'],
];

describe('permissionSeedForOrigin', () => {
  it.each(TABLE)('%o → %s', (origin, expected) => {
    expect(permissionSeedForOrigin(origin)).toBe(expected);
  });

  it('names every member of the union, so the table cannot be a subset', () => {
    // The compiler makes the SWITCH exhaustive. Nothing makes this FILE
    // exhaustive, and a table that quietly stopped covering a member would
    // leave a surface's power untested while every case still passed. So the
    // union's own members are read off the source it is declared in and
    // compared with what the table exercises.
    const source = readFileSync(
      fileURLToPath(new URL('../turn-origin.ts', import.meta.url)),
      'utf8'
    );
    const declared = new Set(
      [...source.matchAll(/readonly kind: '([a-z-]+)'/g)].map((match) => match[1])
    );
    expect(declared.size).toBeGreaterThan(0);
    expect([...new Set(TABLE.map(([origin]) => origin.kind))].sort()).toEqual([...declared].sort());
  });
});

describe('relayTurnOrigin', () => {
  it('calls a message from one of our agents an agent DM', () => {
    expect(relayTurnOrigin('relay.agent.default.agent-01')).toEqual({ kind: 'agent-dm' });
  });

  // The A2A gateway publishes to the same agent subjects an agent's
  // `relay_send` does; the stamped sender is the only fact that tells them
  // apart, and it must not read as one of ours.
  it.each([
    'a2a-gateway',
    'relay.external.mcp',
    'relay.session.project-1a2b3c4d',
    'relay.human.telegram.4242',
    'relay.system.tasks',
    'relay.agentx.default.agent-01',
    '',
  ])('calls a message from %o an outside sender', (from) => {
    expect(relayTurnOrigin(from)).toEqual({ kind: 'outside-sender' });
  });
});
