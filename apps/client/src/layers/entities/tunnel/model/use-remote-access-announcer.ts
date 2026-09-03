/**
 * Saying something when remote access changes on its own.
 *
 * A toast is an interruption, and the only thing worth interrupting somebody
 * for here is news. Flipping the switch yourself is not news — it produced the
 * very view you are looking at — so every action arms
 * {@link RemoteAccessState.userInitiated} and this stays quiet for the
 * transition it causes.
 *
 * **Mount this exactly once**, from the app shell. It lived inside the Remote
 * Access dialog's hook until DOR-1743, which worked only because that dialog is
 * mounted for the life of the app — an accident of `DialogHost`, not a decision.
 * Now that remote access has three surfaces, the announcement belongs to none of
 * them.
 *
 * @module entities/tunnel/model/use-remote-access-announcer
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useConfig } from '@/layers/entities/config';
import { readTunnelReport, type ReportedStatus } from './tunnel-report';
import { useRemoteAccessStore } from './remote-access-store';

/**
 * Announce remote-access changes the person did not make.
 *
 * Nothing is announced on load, however the tunnel already was: the baseline is
 * seeded only once the config query has actually answered, so opening the app
 * with a tunnel already up is not mistaken for it having just come up.
 */
export function useRemoteAccessAnnouncer(): void {
  const { data: serverConfig } = useConfig();
  const hasServerReport = serverConfig !== undefined;
  const { status: reportedStatus, url: reportedUrl } = readTunnelReport(serverConfig?.tunnel);

  const previousStatusRef = useRef<ReportedStatus | undefined>(undefined);

  useEffect(() => {
    // Say nothing until the server has actually spoken. `reportedStatus` is
    // `off` while the config read is in flight, so seeding the baseline from
    // that placeholder made the first real answer look like a transition.
    if (!hasServerReport) return;

    const previous = previousStatusRef.current;
    previousStatusRef.current = reportedStatus;
    if (previous === undefined || previous === reportedStatus) return;

    // Consumed on the first real transition either way, so a stop the server
    // never reports cannot leave the next genuine drop silent.
    if (useRemoteAccessStore.getState().consumeSuppression()) return;

    if (reportedStatus === 'reconnecting') {
      // "Reconnecting" is a promise, and this is the one state in which DorkOS
      // can keep it: ngrok's own agent retries a dropped session and emits
      // `connected` again on recovery. An older version said it on every drop,
      // including a permanent one, where nothing was retrying anything.
      toast.warning('Remote access is reconnecting', {
        id: 'tunnel-status',
        description: 'Your other devices may not reach DorkOS until it is back.',
      });
    } else if (reportedStatus === 'off') {
      toast.error('Remote access turned off', {
        id: 'tunnel-status',
        description: 'Your other devices can no longer reach DorkOS. Turn it back on to restore.',
      });
    } else if (reportedUrl) {
      toast.success('Remote access is on', { id: 'tunnel-status', description: reportedUrl });
    }
  }, [hasServerReport, reportedStatus, reportedUrl]);
}
