/**
 * The server's remote access report (DOR-2086), read once and shared.
 *
 * `GET /api/remote-access/report` says which mode a person selected (their own
 * ngrok tunnel, or an address from DorkOS) and where it stands. Every
 * remote-access surface reads it through the shared store, so Settings, the
 * Control Center row, the beacon and ⌘K cannot disagree.
 *
 * ## Hidden means "today's app, unchanged"
 *
 * Managed access ships dormant. Until the server says `availability:
 * 'available'`, the report is ignored outright: {@link usableReport} turns it
 * into `null`, and a `null` report leaves every surface reading the person's own
 * ngrok setup exactly as it did before. A server too old to have the route
 * answers 404, which reads the same way, so nothing here can break a BYO tunnel.
 *
 * @module entities/tunnel/model/remote-access-report
 */

import { useQuery } from '@tanstack/react-query';
import type { RemoteAccessReport, RemoteAccessState } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import type { TunnelState } from './remote-access-store';

/** Query keys for the remote access report. */
export const remoteAccessKeys = {
  all: ['remote-access'] as const,
  report: () => [...remoteAccessKeys.all, 'report'] as const,
};

/**
 * How often the report is re-read while nothing pushes a change.
 *
 * The server's event stream invalidates it on every tunnel change, so this is
 * only the floor for Cloud-side changes (a close) that arrive without a local
 * event. A server where managed access is hidden is never polled at all.
 */
const REPORT_REFETCH_MS = 30_000;

/** Faster while a person is approving setup on another screen, so the approval lands promptly. */
const PENDING_REFETCH_MS = 3_000;

/**
 * The report, when it is one the app should act on.
 *
 * `available` always counts. `unavailable` counts only while managed access is
 * the selected mode: that is how a report says DorkOS Cloud could not be
 * reached just now, and the person still needs to see the last-known local
 * truth (with `cloudStale`) rather than have their managed setup vanish. A
 * computer that never chose managed access reads `unavailable` like `hidden`.
 *
 * @param report - What the server answered, or `null`/`undefined` when it has
 *   not answered or has no route for it.
 * @returns The report while it should drive the surfaces, otherwise `null`.
 */
export function usableReport(
  report: RemoteAccessReport | null | undefined
): RemoteAccessReport | null {
  if (!report || typeof report !== 'object') return null;
  if (report.availability === 'available') return report;
  if (report.availability === 'unavailable' && report.mode === 'managed') return report;
  return null;
}

/**
 * Whether a usable report puts managed access in charge of every surface.
 *
 * @param report - A report already passed through {@link usableReport}.
 */
export function isManagedReport(report: RemoteAccessReport | null): report is RemoteAccessReport {
  return report !== null && report.mode === 'managed';
}

/**
 * The app state a managed report puts remote access in.
 *
 * `opening` reads as `starting`, the state every surface already treats as
 * "pending". `asleep` stays its own state on purpose: the tunnel is closed but
 * the address still answers, which is neither off nor a failure.
 *
 * @param state - The report's `state`.
 */
export function stateFromReport(state: RemoteAccessState): TunnelState {
  switch (state) {
    case 'opening':
      return 'starting';
    case 'open':
      return 'connected';
    case 'reconnecting':
    case 'asleep':
    case 'draining':
    case 'blocked':
    case 'off':
      return state;
  }
}

/**
 * The URL a managed report lets a surface show.
 *
 * Only while `open`, or `asleep` with an address: the report carries a URL in
 * no other state, and this repeats the rule rather than trusting it, so no
 * surface can offer a link that cannot work.
 *
 * @param report - A managed report.
 */
export function urlFromReport(report: RemoteAccessReport): string | null {
  const usable = report.state === 'open' || report.state === 'asleep';
  return usable ? (report.url ?? null) : null;
}

/**
 * Read the remote access report.
 *
 * A failed read is not an error anyone sees: an older server has no route, and
 * the honest reading of "no report" is "managed access is not offered here".
 *
 * @returns The query; its `data` is `null` when there is no usable answer.
 */
export function useRemoteAccessReport() {
  const transport = useTransport();
  return useQuery({
    queryKey: remoteAccessKeys.report(),
    queryFn: async () => {
      try {
        return (await transport.getRemoteAccessReport()) ?? null;
      } catch {
        return null;
      }
    },
    retry: false,
    refetchInterval: (query) => {
      const report = usableReport(query.state.data);
      if (!report) return false;
      return report.enrolment.status === 'pending' ? PENDING_REFETCH_MS : REPORT_REFETCH_MS;
    },
  });
}
