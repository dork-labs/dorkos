import { describe, expect, it } from 'vitest';
import {
  RELAY_DELIVERY_FAILURE_MESSAGES,
  RelayDeliveryReceiptSchema,
  RelayMessageIdSchema,
  SendMessageRequestSchema,
} from '../relay-schemas.js';

const accepted = {
  messageId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  scope: 'agent_delivery',
  state: 'accepted',
  acceptedAt: '2026-10-01T20:00:00.000Z',
  updatedAt: '2026-10-01T20:00:00.000Z',
  expiresAt: '2026-10-08T20:00:00.000Z',
};
const settledAt = '2026-10-01T20:01:00.000Z';
const failure = { code: 'at_capacity', message: RELAY_DELIVERY_FAILURE_MESSAGES.at_capacity };

describe('Relay delivery receipt public contract', () => {
  // A status locator must fit a real ULID; legacy abbreviated display IDs are not locators.
  it.each(['01ARZ3NDEKTSV4RRFFQ69G5FAV', '7ZZZZZZZZZZZZZZZZZZZZZZZZZ'])(
    'accepts valid message ID %s',
    (id) => expect(RelayMessageIdSchema.safeParse(id).success).toBe(true)
  );
  it.each([
    'msg-1',
    '01ARZ3NDEKTSV4RRFFQ69G5FAVX',
    '81ARZ3NDEKTSV4RRFFQ69G5FAV',
    '01arz3ndektsv4rrffq69g5fav',
    '01ARZ3NDEKTSV4RRFFQ69G5FAI',
  ])('rejects malformed locator %s', (id) =>
    expect(RelayMessageIdSchema.safeParse(id).success).toBe(false)
  );

  it.each([
    accepted,
    { ...accepted, state: 'delivered', settledAt },
    { ...accepted, state: 'failed', settledAt, failure },
    {
      ...accepted,
      state: 'outcome_unknown',
      settledAt,
      failure: {
        code: 'observation_lost',
        message: RELAY_DELIVERY_FAILURE_MESSAGES.observation_lost,
      },
    },
  ])('accepts the consistent $state observation', (receipt) => {
    expect(RelayDeliveryReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  // These malformed records would otherwise turn an uncertain observation into a false result.
  it.each([
    { ...accepted, settledAt },
    { ...accepted, failure },
    { ...accepted, state: 'delivered' },
    { ...accepted, state: 'delivered', settledAt, failure },
    { ...accepted, state: 'failed', settledAt },
    { ...accepted, state: 'failed', failure },
    { ...accepted, state: 'outcome_unknown', settledAt, failure },
    {
      ...accepted,
      state: 'failed',
      settledAt,
      failure: {
        code: 'observation_lost',
        message: RELAY_DELIVERY_FAILURE_MESSAGES.observation_lost,
      },
    },
    { ...accepted, expiresAt: 'yesterday' },
  ])('rejects inconsistent state/settlement fields', (receipt) => {
    expect(RelayDeliveryReceiptSchema.safeParse(receipt).success).toBe(false);
  });

  it('rejects arbitrary error interpolation and internal metadata', () => {
    const secret = 'SECRET_PAYLOAD_AND_CREDENTIAL';
    expect(
      RelayDeliveryReceiptSchema.safeParse({
        ...accepted,
        state: 'failed',
        settledAt,
        failure: { ...failure, message: secret },
      }).success
    ).toBe(false);
    expect(
      RelayDeliveryReceiptSchema.safeParse({
        ...accepted,
        state: 'failed',
        settledAt,
        failure: { code: secret, message: secret },
      }).success
    ).toBe(false);
    for (const field of ['payload', 'ownerUserId', 'subject', 'bootEpoch', 'replyTo', 'from']) {
      expect(RelayDeliveryReceiptSchema.safeParse({ ...accepted, [field]: secret }).success).toBe(
        false
      );
    }
  });

  it('keeps the legacy wire request while excluding trusted receipt context', () => {
    const request = {
      subject: 'relay.agent.backend',
      payload: { task: 'hello' },
      from: 'relay.human.console',
    };
    expect(
      SendMessageRequestSchema.parse({
        ...request,
        receiptContext: { ownerUserId: 'forged', onReceiptCreated: 'forged' },
      })
    ).toEqual(request);
  });
});
