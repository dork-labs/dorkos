import { describe, expect, it } from 'vitest';
import type { ConnectionEventSubscription } from '@dorkos/shared/connector-event-schemas';
import { describeEventFilter, notificationStatus } from '../notification-copy';

type Status = Pick<ConnectionEventSubscription, 'state' | 'lastDelivery' | 'destination'>;
const agent = { kind: 'agent', id: 'a' } as const;
const room = { kind: 'room', id: 'r' } as const;
const at = new Date().toISOString();
const failed = (
  problem: NonNullable<ConnectionEventSubscription['lastDelivery']>['problem'],
  destination: Status['destination'] = agent
): Status => ({
  state: 'active',
  destination,
  lastDelivery: { outcome: 'failed', receivedAt: at, problem },
});

/** The sentences a status line ends with that tell the owner what to do next. */
const NEXT_STEPS = [
  /Open the chat to check\.$/,
  /Look there to check\.$/,
  /Fix the account above to start it again\.$/,
  /Remove it and set it up again to keep getting these\.$/,
  /Check that it still lets this agent post there\.$/,
  /Nothing to do: the next one comes as usual\.$/,
  /If it keeps happening, remove it and set it up again\.$/,
];

describe('notificationStatus', () => {
  const problems: Status[] = [
    { state: 'unavailable', destination: agent, lastDelivery: null },
    { state: 'revoked', destination: agent, lastDelivery: null },
    failed('unknown_outcome'),
    failed('unknown_outcome', room),
    failed('refused', room),
    failed('changed'),
    failed('cancelled'),
    failed('expired'),
    failed('unreachable'),
    failed(null),
  ];

  it.each(problems.map((status) => [status.state, status.lastDelivery?.problem, status]))(
    'ends a %s / %s problem line with its next step',
    (_state, _problem, status) => {
      const line = notificationStatus(status as Status, 'Researcher', 'cadence');
      expect(line.tone).toBe('problem');
      expect(NEXT_STEPS.some((step) => step.test(line.text))).toBe(true);
    }
  );

  it('offers the chat as the check only where the event went to a chat', () => {
    expect(notificationStatus(failed('unknown_outcome'), 'Researcher', '').checkInChat).toBe(true);
    expect(notificationStatus(failed('unknown_outcome', room), '#ops', '').checkInChat).toBe(false);
  });

  it('never calls DorkOS retrying on its own a problem', () => {
    const line = notificationStatus(
      {
        state: 'active',
        destination: agent,
        lastDelivery: { outcome: 'retrying', receivedAt: at, problem: 'unreachable' },
      },
      'Researcher',
      ''
    );
    expect(line.tone).toBe('plain');
    expect(line.text).toMatch(/DorkOS is trying again/);
  });
});

describe('describeEventFilter', () => {
  it('writes a filter as words, never JSON', () => {
    expect(describeEventFilter({ labelIds: ['INBOX', 'UNREAD'], unread: true })).toBe(
      'Only when Label ids is INBOX, UNREAD and Unread is yes'
    );
    expect(describeEventFilter({})).toBeNull();
  });
});
