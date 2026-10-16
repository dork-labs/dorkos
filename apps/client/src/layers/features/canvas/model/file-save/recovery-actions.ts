/** Proof orchestration preserves the effect tail without retaining obsolete file reads. */
import {
  FileSaveDiscoverySchema,
  FileSaveRecoverResultSchema,
  type FileSaveDiscovery,
} from '@dorkos/shared/file-save/recovery';
import { sameCanvasDocIncarnation } from '@dorkos/shared/canvas-doc-frame-wire';
import type { Transport } from '@dorkos/shared/transport';
import type { FileSaveBinding } from './receipt-operation';
import type { FileSaveRecoveryActions, RecoveryCall } from './recovery-ui-types';
export interface FileSaveRecoveryRecord<Owner> {
  identity: Owner;
  active: boolean;
  recoveryBinding?: FileSaveBinding;
  recoveryGate: 'unsupported' | 'pending' | 'observed_clear' | 'blocked' | 'unavailable';
  discovery?: Promise<RecoveryCall<FileSaveDiscovery>>;
  pendingDiscovery?: Promise<RecoveryCall<FileSaveDiscovery>>;
  discoveryBinding?: FileSaveBinding;
  recoveryBusy?: boolean;
  recoveryWork?: object;
}
/** Build serialized proof-only actions for one committed file-save owner. */
export function createFileSaveRecoveryActions<Owner extends object>({
  owner,
  getOwner,
  readTail,
  writeTail,
  transport,
  cwd,
  sourcePath,
  documentId,
  pending,
}: {
  owner: Owner;
  getOwner: () => FileSaveRecoveryRecord<Owner> | null;
  readTail: () => Promise<void>;
  writeTail: (tail: Promise<void>) => void;
  transport: Transport;
  cwd: string | null;
  sourcePath: string | undefined;
  documentId: string | undefined;
  pending: () => boolean;
}): FileSaveRecoveryActions {
  const recoveryWritable = () =>
    getOwner()?.recoveryGate === 'unsupported' || getOwner()?.recoveryGate === 'observed_clear';
  const observeDiscovery = (raw: unknown): FileSaveDiscovery => {
    const value = FileSaveDiscoverySchema.parse(raw),
      binding = getOwner()?.recoveryBinding;
    if (
      !binding ||
      value.documentId !== documentId ||
      !sameCanvasDocIncarnation(value.incarnation, binding.incarnation)
    )
      throw new Error('Original save scope changed');
    return value;
  };
  const port = transport.originalFileSaveRecovery;
  const current = () => {
    try {
      const record = getOwner();
      return record?.identity === owner && record.active && !!record.recoveryBinding?.current();
    } catch {
      return false;
    }
  };
  const enqueue = <T>(
    call: () => Promise<T>,
    expectedObservation?: FileSaveBinding,
    readOnlyInspection = false
  ): Promise<RecoveryCall<T>> => {
    if (!port || !current()) return Promise.resolve({ status: 'idle' });
    const record = getOwner()!;
    const work = {};
    const requestCurrent = () =>
      getOwner() === record &&
      current() &&
      (!expectedObservation || record.recoveryBinding === expectedObservation) &&
      (!readOnlyInspection || record.recoveryWork === work);
    const priorDiscovery = record.discovery;
    let observed = false;
    record.recoveryWork = work;
    record.recoveryGate = 'pending';
    record.recoveryBusy = true;
    const next = readTail()
      .catch(() => {})
      .then(async (): Promise<RecoveryCall<T>> => {
        try {
          if (!requestCurrent()) return { status: 'idle' };
          const value = await call();
          if (!requestCurrent()) return { status: 'idle' };
          if (readOnlyInspection) record.recoveryGate = 'observed_clear';
          observed = true;
          return { status: 'observed', value };
        } catch {
          if (!requestCurrent()) return { status: 'idle' };
          record.recoveryGate = 'unavailable';
          return { status: 'unavailable' };
        } finally {
          // An old observed cache cannot satisfy a recheck after work lost currentness.
          if (!observed && record.discovery === priorDiscovery) record.discovery = undefined;
          // An older settlement cannot release a newer queued operation's busy state.
          if (record.recoveryWork === work) {
            record.recoveryBusy = false;
            record.recoveryWork = undefined;
          }
        }
      });
    // A read must await earlier effects, but cannot hold the effect lane across
    // a suspended presenter or replacement observation. It never writes or adopts bytes.
    if (!readOnlyInspection) writeTail(next.then(() => {}));
    return next;
  };
  const discover = (fresh = false): Promise<RecoveryCall<FileSaveDiscovery>> => {
    if (!port || !current()) return Promise.resolve({ status: 'idle' });
    const record = getOwner()!;
    const observation = record.recoveryBinding!;
    if (
      record.discoveryBinding === observation &&
      record.discovery &&
      (record.pendingDiscovery === record.discovery ||
        (!fresh && record.recoveryGate === 'observed_clear'))
    )
      return record.discovery;
    const request = enqueue(async () => {
      const value = observeDiscovery(await port.discover(documentId!));
      if (getOwner() === record && record.recoveryBinding === observation && current())
        record.recoveryGate = value.admission === 'blocked' ? 'blocked' : 'observed_clear';
      return value;
    }, observation);
    record.discoveryBinding = observation;
    record.discovery = request;
    record.pendingDiscovery = request;
    // Idle proves no observation. Keep the gate blocked, but do not cache it as a discovery.
    void request.then((result) => {
      if (record.pendingDiscovery === request) record.pendingDiscovery = undefined;
      if (result.status === 'idle' && record.discovery === request) record.discovery = undefined;
    });
    return request;
  };
  return {
    identity: owner,
    supported: !!port,
    current,
    discover,
    recover(eventId) {
      if (pending()) return Promise.resolve({ status: 'local_uncertain' });
      const record = getOwner();
      return enqueue(async () => {
        if (!record || pending()) throw new Error('Mounted original still uncertain');
        const binding = record.recoveryBinding!;
        const result = FileSaveRecoverResultSchema.parse(
          await port!.recover(documentId!, eventId, binding.incarnation)
        );
        if (
          getOwner() !== record ||
          !current() ||
          result.documentId !== documentId ||
          result.entry.eventId !== eventId ||
          !sameCanvasDocIncarnation(result.incarnation, binding.incarnation)
        )
          throw new Error('Original recovery scope changed');
        const discovery = observeDiscovery(await port!.discover(documentId!));
        if (getOwner() === record && current())
          record.recoveryGate = discovery.admission === 'blocked' ? 'blocked' : 'observed_clear';
        return { result, discovery };
      });
    },
    inspectCurrent() {
      const record = getOwner();
      if (!record || !current() || pending() || !recoveryWritable())
        return Promise.resolve({ status: 'local_uncertain' });
      return enqueue(
        async () => {
          const value = await transport.readFileContent(cwd!, sourcePath!);
          if (
            !value ||
            typeof value.content !== 'string' ||
            typeof value.hash !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(value.hash)
          )
            throw new Error('Current file evidence missing');
          return { content: value.content, hash: value.hash };
        },
        record.recoveryBinding,
        true
      );
    },
  };
}
