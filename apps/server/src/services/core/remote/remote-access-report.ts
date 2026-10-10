/**
 * The remote access report (DOR-2086): the one answer Settings, the Control
 * Center row, the beacon and the command palette all read, so they cannot
 * disagree about whether this computer is reachable and how.
 *
 * Pure: {@link buildRemoteAccessReport} takes the facts and returns the report,
 * and `managed-remote-coordinator.ts` gathers the facts. Keeping the decision
 * here, away from every effect, is what lets one table of tests pin it.
 *
 * ## The rules it applies
 *
 * - **The live listener is truth for `state`.** Whatever is actually forwarding
 *   right now decides `open`, `opening`, `draining` and `reconnecting`, never a
 *   saved preference and never Cloud.
 * - **`asleep` is narrow.** Managed mode selected, an enrolment in place, no
 *   local listener, and Cloud reporting the tunnel `closed`. It describes the
 *   tunnel, never the computer. When Cloud could not be asked, the report says
 *   `off` with `cloudStale` rather than guessing.
 * - **The address is shown only where it works**: while `open`, and while
 *   `asleep`, where it is the address the computer answers at once reopened.
 * - **`alwaysAvailable` is only ever Cloud's word**, and only in managed mode.
 *
 * Nothing secret reaches it: it reads references and hostnames, never values.
 *
 * @module services/core/remote/remote-access-report
 */
import type { RemoteStatus } from '@dork-labs/cloud-api';
import type { RemoteAccessMode } from '@dorkos/shared/config-schema';
import type {
  RemoteAccessEnrolment,
  RemoteAccessReport,
  RemoteAccessState,
  TunnelStatus,
} from '@dorkos/shared/types';

import type { AvailabilitySnapshot } from './managed-availability.js';
import type { ManagedPhase } from './managed-forwarding.js';
import { isRemoteEnrolmentActive, type RemoteState } from './remote-state.js';

/** Where a setup started on this computer stands, as the coordinator holds it. */
export type SetupView =
  | { status: 'pending'; userCode: string; approveUrl: string; expiresAt: string }
  | { status: 'denied' }
  | { status: 'expired' }
  | null;

/** Everything the report is computed from. */
export interface RemoteAccessFacts {
  /** The combined tunnel status, as `tunnelManager.status` reports it. */
  tunnel: TunnelStatus;
  /** Which forwarding is open right now. */
  liveMode: RemoteAccessMode;
  /** Where the managed session is, or `null` when none is open. */
  managedPhase: ManagedPhase | null;
  /** The saved `cloud.remote` record. */
  remote: RemoteState;
  /** Whether the person's own tunnel is set to open (`tunnel.enabled`). */
  ownTunnelEnabled: boolean;
  /** What the availability check last found. */
  availability: AvailabilitySnapshot;
  /** Where a setup started here stands, or `null`. */
  setup: SetupView;
  /** Something a person should know that no state names, or `undefined`. */
  note: string | undefined;
}

/** The reason shown when managed mode is selected but setup never finished. */
export const SETUP_UNFINISHED_REASON = 'Setup did not finish. Start it again.';

/** The reason shown when Cloud holds the address closed for a reason of its own. */
export const CLOUD_BLOCKED_REASON = 'DorkOS Cloud is not opening this address right now.';

/** The reason shown when Cloud reports the address open and this computer is not serving it. */
export const NOT_SERVING_REASON =
  'DorkOS Cloud reports this address open. This computer is not serving it yet.';

/**
 * Compute the report from the facts.
 *
 * @param facts - What the coordinator gathered. Not mutated.
 * @returns The report every remote access surface renders.
 */
export function buildRemoteAccessReport(facts: RemoteAccessFacts): RemoteAccessReport {
  const mode = selectedMode(facts);
  const cloud = facts.availability.cloudStatus;
  const { state, reason } = stateOf(facts, mode, cloud);
  const url = urlFor(state, facts, cloud);

  return {
    mode,
    state,
    ...(url ? { url } : {}),
    ...((facts.note ?? reason) ? { reason: facts.note ?? reason } : {}),
    alwaysAvailable: mode === 'managed' && cloud?.alwaysAvailable === true,
    cloudStale: facts.availability.cloudStale,
    availability: facts.availability.availability,
    enrolment: enrolmentOf(facts),
  };
}

/**
 * The mode to report: what is actually forwarding wins, then the saved
 * selection, then the person's own tunnel preference (a computer that never
 * chose a managed mode and keeps its own tunnel on is in BYO mode).
 */
function selectedMode(facts: RemoteAccessFacts): RemoteAccessMode {
  if (facts.liveMode !== 'off') return facts.liveMode;
  if (facts.remote.mode !== 'off') return facts.remote.mode;
  return facts.ownTunnelEnabled ? 'byo' : 'off';
}

function stateOf(
  facts: RemoteAccessFacts,
  mode: RemoteAccessMode,
  cloud: RemoteStatus | null
): { state: RemoteAccessState; reason?: string } {
  if (facts.liveMode === 'byo') {
    return { state: facts.tunnel.connected ? 'open' : 'reconnecting' };
  }
  if (facts.liveMode === 'managed') {
    if (facts.managedPhase === 'opening') return { state: 'opening' };
    if (facts.managedPhase === 'draining') return { state: 'draining' };
    return { state: facts.tunnel.connected ? 'open' : 'reconnecting' };
  }
  if (mode !== 'managed' || !isRemoteEnrolmentActive(facts.remote)) return { state: 'off' };
  if (facts.remote.credentialId === null) {
    return { state: 'blocked', reason: SETUP_UNFINISHED_REASON };
  }
  switch (cloud?.state) {
    case 'closed':
      return { state: 'asleep' };
    case 'opening':
      return { state: 'opening' };
    case 'blocked':
      return { state: 'blocked', reason: CLOUD_BLOCKED_REASON };
    case 'open':
    case 'draining':
      // Cloud and this computer disagree. Name it rather than pick a side.
      return { state: 'reconnecting', reason: NOT_SERVING_REASON };
    default:
      // Cloud was not asked, or did not answer: nothing is forwarding here,
      // and that much is certain.
      return { state: 'off' };
  }
}

function urlFor(
  state: RemoteAccessState,
  facts: RemoteAccessFacts,
  cloud: RemoteStatus | null
): string | undefined {
  if (state === 'open') return usableUrl(facts.tunnel.url);
  if (state !== 'asleep') return undefined;
  return (
    usableUrl(cloud?.url) ??
    usableUrl(cloud?.address ? `https://${cloud.address}` : undefined) ??
    usableUrl(facts.remote.hosts[0] ? `https://${facts.remote.hosts[0]}` : undefined)
  );
}

/** The value when it is an absolute http(s) URL, else `undefined`. */
function usableUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function enrolmentOf(facts: RemoteAccessFacts): RemoteAccessEnrolment {
  if (facts.setup) return facts.setup;
  return isRemoteEnrolmentActive(facts.remote) ? { status: 'enrolled' } : { status: 'none' };
}
