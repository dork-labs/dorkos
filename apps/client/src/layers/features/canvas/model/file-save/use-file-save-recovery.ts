/** Finite UI observation of the original hook's serialized proof lane; no replay owner or polling. */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { FileSaveDiscovery, FileSaveRecoveryEntry } from '@dorkos/shared/file-save/recovery';
import type { FileSaveRecoveryActions } from './recovery-ui-types';
import type { FileSaveBinding } from './receipt-operation';
type Observation = 'pending' | 'ready' | 'unavailable';
type State = {
  identity: object;
  phase: 'pending' | 'ready' | 'unavailable' | 'refused' | 'local_uncertain';
  discovery?: FileSaveDiscovery;
  historical?: FileSaveRecoveryEntry;
  busy: boolean;
};
/** The phase a call that observed nothing leaves behind. */
function failed(result: { status: string }): State['phase'] {
  return result.status === 'refused' || result.status === 'local_uncertain'
    ? result.status
    : 'unavailable';
}
/** Observe explicit receipt recovery through the existing committed save owner. */
export function useFileSaveRecovery(
  actions: FileSaveRecoveryActions,
  observation: Observation,
  bindingObservation?: FileSaveBinding
) {
  const latest = useRef(actions),
    active = useRef<object | null>(null);
  const inspection = useRef<object | null>(null);
  const [state, setState] = useState<State>({
    identity: actions.identity,
    phase: 'pending',
    busy: false,
  });
  useLayoutEffect(() => {
    latest.current = actions;
  }, [actions]);
  const publish = useCallback((identity: object, next: Omit<State, 'identity'>) => {
    if (
      active.current === identity &&
      latest.current.identity === identity &&
      latest.current.current()
    )
      setState((previous) => ({
        identity,
        ...next,
        historical:
          next.historical ?? (previous.identity === identity ? previous.historical : undefined),
      }));
  }, []);
  // Idle is not evidence. Clear only this committed view's spinner into a blocked state.
  const settleIdle = useCallback((identity: object) => {
    if (active.current !== identity || latest.current.identity !== identity) return;
    setState((previous) =>
      previous.identity === identity
        ? { ...previous, phase: 'unavailable', busy: false }
        : { identity, phase: 'unavailable', busy: false }
    );
  }, []);
  const identity = actions.identity,
    supportedPort = actions.supported;
  useLayoutEffect(() => {
    const action = latest.current;
    inspection.current = null;
    active.current = identity;
    let disposed = false;
    if (supportedPort && observation === 'ready') {
      void action.discover().then((result) => {
        if (disposed) return;
        if (result.status === 'observed')
          publish(identity, { phase: 'ready', discovery: result.value, busy: false });
        else if (result.status !== 'idle')
          publish(identity, { phase: failed(result), busy: false });
        else settleIdle(identity);
      });
    }
    return () => {
      disposed = true;
      inspection.current = null;
      if (active.current === identity) active.current = null;
    };
  }, [identity, supportedPort, observation, bindingObservation, publish, settleIdle]);
  const current = state.identity === actions.identity ? state : undefined;
  const refresh = useCallback(async () => {
    const action = latest.current,
      identity = action.identity;
    if (active.current !== identity || !action.current()) return;
    inspection.current = null;
    setState((previous) => ({
      identity,
      phase: 'pending',
      busy: true,
      historical: previous.identity === identity ? previous.historical : undefined,
    }));
    const result = await action.discover(true);
    if (result.status === 'observed')
      publish(identity, { phase: 'ready', discovery: result.value, busy: false });
    else if (result.status !== 'idle') publish(identity, { phase: failed(result), busy: false });
    else settleIdle(identity);
  }, [publish, settleIdle]);
  const recover = useCallback(
    async (eventId: string) => {
      const action = latest.current,
        identity = action.identity;
      if (active.current !== identity || !action.current()) return;
      inspection.current = null;
      setState((previous) => ({
        identity,
        phase: 'pending',
        busy: true,
        discovery: previous.identity === identity ? previous.discovery : undefined,
        historical: previous.identity === identity ? previous.historical : undefined,
      }));
      const result = await action.recover(eventId);
      if (result.status === 'observed')
        publish(identity, {
          phase: 'ready',
          discovery: result.value.discovery,
          historical: result.value.result.entry,
          busy: false,
        });
      else if (result.status !== 'idle') publish(identity, { phase: failed(result), busy: false });
      else settleIdle(identity);
    },
    [publish, settleIdle]
  );
  const inspectCurrent = useCallback(async () => {
    const action = latest.current,
      identity = action.identity;
    if (active.current !== identity || !action.current()) return { status: 'idle' } as const;
    const token = {};
    inspection.current = token;
    setState((previous) =>
      previous.identity === identity ? { ...previous, phase: 'pending', busy: true } : previous
    );
    const result = await action.inspectCurrent();
    // A newer observation/action owns the UI and the right to adopt inspected bytes.
    if (inspection.current !== token) return { status: 'idle' } as const;
    inspection.current = null;
    if (result.status === 'idle') settleIdle(identity);
    if (
      active.current === identity &&
      latest.current.identity === identity &&
      action.current() &&
      result.status !== 'idle'
    )
      setState((previous) =>
        previous.identity === identity
          ? {
              ...previous,
              phase: result.status === 'observed' ? 'ready' : failed(result),
              busy: false,
            }
          : previous
      );
    return result;
  }, [settleIdle]);
  const supported = actions.supported && observation === 'ready';
  const phase = observation === 'pending' ? 'pending' : (current?.phase ?? 'pending');
  const editBlocked =
    supported && (phase !== 'ready' || current?.discovery?.admission === 'blocked');
  return {
    supported,
    phase,
    editBlocked,
    busy: current?.busy ?? phase === 'pending',
    discovery: current?.discovery,
    historical: current?.historical,
    refresh,
    recover,
    inspectCurrent,
  };
}
