/**
 * The commitments slice of the mock Transport (spec `heartbeats` §12), spread
 * into `createMockTransport` the way the Transport port extends
 * `CommitmentTransport`.
 *
 * @module test-utils/mock-commitments
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';

/** The commitment methods of the Transport port. */
type CommitmentMethods = Pick<
  Transport,
  'listCommitments' | 'createCommitment' | 'updateCommitment'
>;

/**
 * Mock commitment methods: an empty list, a create that echoes an open
 * commitment, and an update a test must stub before using.
 */
export function commitmentTransportMocks(): CommitmentMethods {
  return {
    listCommitments: vi.fn().mockResolvedValue({ commitments: [] }),
    createCommitment: vi.fn().mockImplementation((agentId: string, body: { what: string }) =>
      Promise.resolve({
        id: 'commitment-1',
        agentId,
        to: null,
        what: body.what,
        dueAt: null,
        state: 'open',
        overdue: false,
        sourceSessionId: null,
        sourceRoomEntryId: null,
        createdAt: new Date(0).toISOString(),
        closedAt: null,
        note: null,
      })
    ),
    updateCommitment: vi.fn().mockRejectedValue(new Error('updateCommitment not mocked')),
  };
}
