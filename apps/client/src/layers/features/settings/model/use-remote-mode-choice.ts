/**
 * Which way of reaching this computer Settings shows as chosen (DOR-2086).
 *
 * The report's `mode` is the truth, and every other surface reads it. Settings
 * adds one thing of its own: a person can pick "DorkOS" before this computer
 * is set up for it, which selects nothing on the server yet (it cannot: setup
 * comes first) but must still show the setup steps. That pick is held here,
 * and dropped the moment the report's mode moves, so a change made on another
 * surface is never hidden behind a stale local choice.
 *
 * @module features/settings/model/use-remote-mode-choice
 */

import { useState } from 'react';
import type { RemoteAccessMode } from '@dorkos/shared/config-schema';
import { useRemoteAccessActions, type ManagedRemoteAccess } from '@/layers/entities/tunnel';

/** What {@link useRemoteModeChoice} returns. */
export interface RemoteModeChoice {
  /** The choice to draw as selected. */
  shown: RemoteAccessMode;
  /** Whether "DorkOS" is offered at all: only while the report says `available`. */
  offerManaged: boolean;
  /** A mode change is in flight. */
  busy: boolean;
  /** Why the last change was refused, or `null`. */
  error: string | null;
  /** Pick a mode. Picking DorkOS before setup only shows the setup steps. */
  choose: (mode: RemoteAccessMode) => void;
}

/**
 * The mode choice Settings draws over the report.
 *
 * @param managed - The report's managed view, from `useRemoteAccess()`.
 */
export function useRemoteModeChoice(managed: ManagedRemoteAccess): RemoteModeChoice {
  const actions = useRemoteAccessActions();
  const [picked, setPicked] = useState<RemoteAccessMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A setup waiting for approval is a DorkOS choice in progress, wherever it
  // was started, so it shows as one.
  const fromReport: RemoteAccessMode =
    managed.enrolment.status === 'pending' ? 'managed' : managed.selected;

  // Drop a local pick once the server's answer moves (React's "adjust state
  // while rendering" pattern, not an effect, so no frame shows the stale pick).
  //
  // One move keeps DorkOS shown instead: a setup that was showing and has now
  // been declined or timed out. The server's mode never moved, but the person
  // is mid-setup and needs to read what happened and start again, not be
  // dropped back to a choice with no word about it.
  const setupEnded =
    managed.enrolment.status === 'denied' || managed.enrolment.status === 'expired';
  const [seen, setSeen] = useState(fromReport);
  if (seen !== fromReport) {
    setSeen(fromReport);
    setPicked(seen === 'managed' && setupEnded ? 'managed' : null);
  }

  const shown = picked ?? fromReport;

  const choose = (mode: RemoteAccessMode) => {
    setError(null);
    setPicked(mode);
    // Not set up for DorkOS yet: the pick shows the setup steps, and the
    // server hears nothing until the person starts setup there.
    if (mode === 'managed' && managed.enrolment.status !== 'enrolled') return;
    if (mode === managed.selected) return;
    setBusy(true);
    actions
      .chooseMode(mode)
      .catch((err: unknown) => {
        setPicked(null);
        setError(err instanceof Error ? err.message : 'Couldn’t change remote access. Try again.');
      })
      .finally(() => setBusy(false));
  };

  return {
    shown,
    offerManaged: managed.availability === 'available',
    busy,
    error,
    choose,
  };
}
