/**
 * The remote access slice of the mock Transport (DOR-2086), spread into
 * `createMockTransport` the way the Transport port extends
 * `RemoteAccessTransport`, plus the reports tests pose.
 *
 * @module test-utils/mock-remote-access
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';
import type { RemoteAccessReport } from '@dorkos/shared/types';

/**
 * A remote access report from a server where managed access is not offered:
 * nothing selected, nothing running, no enrolment. Surfaces read it exactly as
 * they read a server that has no report at all.
 */
export const HIDDEN_REMOTE_ACCESS_REPORT: RemoteAccessReport = {
  mode: 'off',
  state: 'off',
  alwaysAvailable: false,
  cloudStale: false,
  availability: 'hidden',
  enrolment: { status: 'none' },
};

/**
 * A remote access report where managed access IS offered, for tests of the
 * managed surfaces: DorkOS selected, this computer set up, the address open.
 * Pass what a test is about; the rest stays this one coherent picture.
 *
 * @param overrides - Fields to replace.
 */
export function createRemoteAccessReport(
  overrides: Partial<RemoteAccessReport> = {}
): RemoteAccessReport {
  return {
    mode: 'managed',
    state: 'open',
    url: 'https://calm-otter.example.com',
    alwaysAvailable: false,
    cloudStale: false,
    availability: 'available',
    enrolment: { status: 'enrolled' },
    ...overrides,
  };
}

/** The remote access methods of the Transport port, the ngrok pair included. */
type RemoteAccessMethods = Pick<
  Transport,
  | 'startTunnel'
  | 'stopTunnel'
  | 'getRemoteAccessReport'
  | 'startRemoteEnrolment'
  | 'setRemoteAccessMode'
  | 'closeRemoteAccess'
  | 'withdrawRemoteAccess'
>;

/**
 * Mock remote access methods: the person's own ngrok start and stop, and the
 * managed remote access slice. Managed access is HIDDEN by default, so every
 * surface renders the person's own ngrok setup exactly as it did before
 * DOR-2086; a test about managed access answers with
 * {@link createRemoteAccessReport}.
 */
export function remoteAccessTransportMocks(): RemoteAccessMethods {
  return {
    // The person's own ngrok tunnel.
    startTunnel: vi.fn().mockResolvedValue({ url: 'https://test.ngrok.io' }),
    stopTunnel: vi.fn().mockResolvedValue(undefined),
    getRemoteAccessReport: vi.fn().mockResolvedValue(HIDDEN_REMOTE_ACCESS_REPORT),
    startRemoteEnrolment: vi.fn().mockResolvedValue(HIDDEN_REMOTE_ACCESS_REPORT),
    setRemoteAccessMode: vi.fn().mockResolvedValue(HIDDEN_REMOTE_ACCESS_REPORT),
    closeRemoteAccess: vi.fn().mockResolvedValue(HIDDEN_REMOTE_ACCESS_REPORT),
    withdrawRemoteAccess: vi.fn().mockResolvedValue(HIDDEN_REMOTE_ACCESS_REPORT),
  };
}
