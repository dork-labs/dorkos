import { requireOriginalHostOperations } from '../server-host.js';

/** Original finite host room-actions controls, selected only by private constructor key. */
export function createOriginalHostRoomActions(ownerKey: object) {
  const context = requireOriginalHostOperations(ownerKey);
  const { launched, target, standalone } = context;
  let controlSequence = 0,
    controlPending = false;
  let canonicalSequence = 0,
    canonicalPending = false;
  const canonicalAction = (action: 'pause' | 'capture' | 'restart') =>
    new Promise<{ canonicalId?: string; closed?: boolean }>((resolve, reject) => {
      const expected = ['pause', 'capture', 'restart'][canonicalSequence];
      if (
        standalone !== 'canonical' ||
        target !== 'room' ||
        context.retired ||
        context.failed ||
        canonicalPending ||
        !launched.connected ||
        action !== expected
      )
        return reject(new Error('Original canonical fixture action unavailable'));
      canonicalPending = true;
      const id = ++canonicalSequence;
      const cleanup = () => {
        canonicalPending = false;
        launched.off('message', receive);
        launched.off('close', unavailable);
      };
      const unavailable = () => {
        cleanup();
        reject(new Error('Original canonical fixture child closed'));
      };
      const receive = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
        if (row.kind !== 'native-canonical-result' || row.id !== id) return;
        cleanup();
        const data = row.data as { canonicalId?: unknown; closed?: unknown } | undefined;
        if (
          row.ok !== true ||
          !data ||
          (action !== 'pause' &&
            (typeof data.canonicalId !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.canonicalId))) ||
          (action === 'restart' && data.closed !== true)
        )
          return reject(new Error('Original canonical fixture action unconfirmed'));
        resolve(data as { canonicalId?: string; closed?: boolean });
      };
      launched.on('message', receive);
      launched.once('close', unavailable);
      try {
        launched.send({ kind: 'native-canonical-action', id, action }, (cause) => {
          if (cause) {
            cleanup();
            reject(cause);
          }
        });
      } catch (cause) {
        cleanup();
        reject(cause);
      }
    });
  const loseNextWriterResponse = () =>
    new Promise<void>((resolve, reject) => {
      if (
        context.retired ||
        context.failed ||
        !launched.connected ||
        controlPending ||
        controlSequence >= 16
      ) {
        reject(new Error('Owned writer fault control refused'));
        return;
      }
      controlPending = true;
      const id = ++controlSequence;
      const cleanup = () => {
        controlPending = false;
        launched.off('message', receive);
        launched.off('close', unavailable);
      };
      const unavailable = () => {
        cleanup();
        reject(new Error('Owned writer fault control closed'));
      };
      const receive = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as { kind?: unknown; id?: unknown; ok?: unknown };
        if (row.kind !== 'writer-fault-armed' || row.id !== id) return;
        cleanup();
        if (row.ok === true) resolve();
        else reject(new Error('Owned writer fault control unavailable'));
      };
      launched.on('message', receive);
      launched.once('close', unavailable);
      try {
        launched.send({ kind: 'lose-writer-response', id }, (cause) => {
          if (cause) {
            cleanup();
            reject(cause);
          }
        });
      } catch (cause) {
        cleanup();
        reject(cause);
      }
    });
  let checkboxControlSequence = 0,
    checkboxControlPending = false;
  const checkboxAction = (action: 'open' | 'pump') =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (
        context.retired ||
        context.failed ||
        !launched.connected ||
        (target !== 'room' && target !== 'session') ||
        checkboxControlPending ||
        checkboxControlSequence >= 2
      ) {
        reject(new Error('Owned native checkbox action refused'));
        return;
      }
      checkboxControlPending = true;
      const id = ++checkboxControlSequence;
      const cleanup = () => {
        checkboxControlPending = false;
        launched.off('message', receive);
        launched.off('close', unavailable);
      };
      const unavailable = () => {
        cleanup();
        reject(new Error('Owned native checkbox action closed'));
      };
      const receive = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
        if (row.kind !== 'native-checkbox-result' || row.id !== id) return;
        cleanup();
        if (row.ok !== true || !row.data || typeof row.data !== 'object')
          reject(new Error('Owned native checkbox action failed'));
        else resolve(row.data as Record<string, unknown>);
      };
      launched.on('message', receive);
      launched.once('close', unavailable);
      try {
        launched.send({ kind: 'native-checkbox-action', action, id }, (cause) => {
          if (cause) {
            cleanup();
            reject(cause);
          }
        });
      } catch (cause) {
        cleanup();
        reject(cause);
      }
    });

  return { canonicalAction, loseNextWriterResponse, checkboxAction };
}
