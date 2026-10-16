/** Fixed proof-only endpoint orchestration; shares the owning hook's one dispatch tail. */
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
  recoveryBusy?: boolean;
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
  const enqueue = <T>(call: () => Promise<T>): Promise<RecoveryCall<T>> => {
    if (!port || !current()) return Promise.resolve({ status: 'idle' });
    const record = getOwner()!;
    record.recoveryGate = 'pending';
    record.recoveryBusy = true;
    const next = readTail()
      .catch(() => {})
      .then(async (): Promise<RecoveryCall<T>> => {
        if (getOwner() !== record || !current()) return { status: 'idle' };
        try {
          const value = await call();
          if (getOwner() !== record || !current()) return { status: 'idle' };
          return { status: 'observed', value };
        } catch {
          if (getOwner() !== record || !current()) return { status: 'idle' };
          record.recoveryGate = 'unavailable';
          return { status: 'unavailable' };
        } finally {
          record.recoveryBusy = false;
        }
      });
    writeTail(next.then(() => {}));
    return next;
  };
  const discover = (fresh = false): Promise<RecoveryCall<FileSaveDiscovery>> => {
    if (!port || !current()) return Promise.resolve({ status: 'idle' });
    const record = getOwner()!;
    if (record.discovery && (!fresh || record.recoveryBusy)) return record.discovery;
    const request = enqueue(async () => {
      const value = observeDiscovery(await port.discover(documentId!));
      if (getOwner() === record && current())
        record.recoveryGate = value.admission === 'blocked' ? 'blocked' : 'observed_clear';
      return value;
    });
    record.discovery = request;
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
      return enqueue(async () => {
        const value = await transport.readFileContent(cwd!, sourcePath!);
        if (
          !value ||
          typeof value.content !== 'string' ||
          typeof value.hash !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(value.hash)
        )
          throw new Error('Current file evidence missing');
        if (getOwner() === record && current()) record.recoveryGate = 'observed_clear';
        return { content: value.content, hash: value.hash };
      });
    },
  };
}
