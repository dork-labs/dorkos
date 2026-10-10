/**
 * The remote access slice of the {@link Transport} port (DOR-2086): the one
 * report every remote-access surface reads, and the actions a person takes on
 * DorkOS managed remote access. The person's own ngrok tunnel keeps its
 * `startTunnel`/`stopTunnel` on the port itself.
 *
 * Split out of `transport.ts` the way the rooms slice is: `Transport` extends
 * this, so nothing consuming the port sees a difference.
 *
 * @module shared/transport-remote-access
 */
import type { RemoteAccessMode } from './config-schema.js';
import type { RemoteAccessReport } from './schemas.js';

/** The remote access methods every Transport implements. Each write answers with the full report. */
export interface RemoteAccessTransport {
  /**
   * Read where remote access stands: the selected mode, its state, and whether
   * managed access can be offered here (DOR-2086). Every remote-access surface
   * reads this one report.
   */
  getRemoteAccessReport(): Promise<RemoteAccessReport>;
  /**
   * Start managed setup on this computer: ask DorkOS Cloud for a code the person
   * approves on their account. Resolves with the report, its enrolment `pending`.
   */
  startRemoteEnrolment(): Promise<RemoteAccessReport>;
  /**
   * Select how this computer is reachable. Choosing `managed` needs an approved
   * enrolment. Resolves with the report after the change.
   *
   * @param mode - `off`, `byo` (the person's own ngrok) or `managed`.
   */
  setRemoteAccessMode(mode: RemoteAccessMode): Promise<RemoteAccessReport>;
  /** Close the managed tunnel now. The mode stays selected. Resolves with the report. */
  closeRemoteAccess(): Promise<RemoteAccessReport>;
  /**
   * Withdraw managed access on this computer: close it, forget the enrolment and
   * its credential, and cancel a pending setup. Resolves with the report.
   */
  withdrawRemoteAccess(): Promise<RemoteAccessReport>;
}
