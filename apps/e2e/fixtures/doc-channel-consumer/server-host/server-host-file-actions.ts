import { requireOriginalHostOperations } from '../server-host.js';

/** Original finite host file-actions controls, selected only by private constructor key. */
export function createOriginalHostFileActions(ownerKey: object) {
  const context = requireOriginalHostOperations(ownerKey);
  const { launched, target, widgetDiagnostic } = context;
  let savedSequence = 0,
    savedPending = false;
  const savedAction = (action: 'open' | 'arm-failure' | 'pump') =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (
        context.retired ||
        context.failed ||
        !launched.connected ||
        target !== 'session' ||
        savedPending ||
        action !== ['open', 'pump', 'arm-failure'][savedSequence]
      ) {
        reject(new Error('Original saved FILE action refused'));
        return;
      }
      savedPending = true;
      const id = ++savedSequence;
      const cleanup = () => {
        savedPending = false;
        launched.off('message', receive);
        launched.off('close', unavailable);
      };
      const unavailable = () => {
        cleanup();
        reject(new Error('Original saved FILE child closed'));
      };
      const receive = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
        if (row.kind !== 'native-saved-result' || row.id !== id) return;
        cleanup();
        if (row.ok === true && row.data && typeof row.data === 'object')
          resolve(row.data as Record<string, unknown>);
        else reject(new Error('Original saved FILE action failed'));
      };
      launched.on('message', receive);
      launched.once('close', unavailable);
      try {
        launched.send({ kind: 'native-saved-action', action, id }, (cause) => {
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
  let reviewedSequence = 0,
    reviewedPending = false;
  const reviewedAction = (action: 'open' | 'expire' | 'pump') =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (
        context.retired ||
        context.failed ||
        !launched.connected ||
        target !== 'session' ||
        reviewedPending ||
        action !== ['open', 'expire', 'pump'][reviewedSequence]
      ) {
        reject(new Error('Original reviewed replay action refused'));
        return;
      }
      reviewedPending = true;
      const id = ++reviewedSequence;
      const cleanup = () => {
        reviewedPending = false;
        launched.off('message', receive);
        launched.off('close', unavailable);
      };
      const unavailable = () => {
        cleanup();
        reject(new Error('Original reviewed replay child closed'));
      };
      const receive = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
        if (row.kind !== 'native-reviewed-replay-result' || row.id !== id) return;
        cleanup();
        if (row.ok === true && row.data && typeof row.data === 'object')
          resolve(row.data as Record<string, unknown>);
        else reject(new Error('Original reviewed replay action failed'));
      };
      launched.on('message', receive);
      launched.once('close', unavailable);
      try {
        launched.send({ kind: 'native-reviewed-replay-action', action, id }, (cause) => {
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
  let mcpSequence = 0,
    mcpPending = false;
  const mcpAction = (action: 'open' | 'pump' | 'emit') =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (
        context.retired ||
        context.failed ||
        !launched.connected ||
        target !== 'session' ||
        mcpPending ||
        action !== ['open', 'pump', 'emit'][mcpSequence]
      ) {
        reject(new Error('Original MCP App action refused'));
        return;
      }
      mcpPending = true;
      const id = ++mcpSequence;
      const cleanup = () => {
        mcpPending = false;
        launched.off('message', receive);
        launched.off('close', unavailable);
      };
      const unavailable = () => {
        cleanup();
        reject(new Error('Original MCP App child closed'));
      };
      const receive = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
        if (row.kind !== 'native-mcp-app-result' || row.id !== id) return;
        cleanup();
        if (row.ok === true && row.data && typeof row.data === 'object')
          resolve(row.data as Record<string, unknown>);
        else reject(new Error('Original MCP App action failed'));
      };
      launched.on('message', receive);
      launched.once('close', unavailable);
      try {
        launched.send({ kind: 'native-mcp-app-action', action, id }, (cause) => {
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
  let selectionSequence = 0,
    selectionPending = false;
  const selectionAction = (action: 'open' | 'pump') =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (
        context.retired ||
        context.failed ||
        !launched.connected ||
        target !== 'session' ||
        selectionPending ||
        action !== ['open', 'pump'][selectionSequence]
      ) {
        reject(new Error('Original selection action refused'));
        return;
      }
      selectionPending = true;
      const id = ++selectionSequence;
      const cleanup = () => {
        selectionPending = false;
        launched.off('message', receive);
        launched.off('close', unavailable);
      };
      const unavailable = () => {
        cleanup();
        reject(new Error('Original selection child closed'));
      };
      const receive = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as { kind?: unknown; id?: unknown; ok?: unknown; data?: unknown };
        if (row.kind !== 'native-selection-result' || row.id !== id) return;
        cleanup();
        if (row.ok === true && row.data && typeof row.data === 'object')
          resolve(row.data as Record<string, unknown>);
        else reject(new Error('Original selection action failed'));
      };
      launched.on('message', receive);
      launched.once('close', unavailable);
      try {
        launched.send({ kind: 'native-selection-action', action, id }, (cause) => {
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
  let widgetControlSequence = 0,
    widgetControlPending = false;
  const widgetAction = (action: 'open' | 'patch' | 'disconnect' | 'next' | 'reset' | 'revoke') =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (
        context.retired ||
        context.failed ||
        !launched.connected ||
        target !== 'session' ||
        widgetControlPending ||
        widgetControlSequence >= 6
      ) {
        reject(new Error('Owned native widget action refused'));
        return;
      }
      widgetControlPending = true;
      const id = ++widgetControlSequence;
      const cleanup = () => {
        widgetControlPending = false;
        launched.off('message', receive);
        launched.off('close', unavailable);
      };
      const unavailable = () => {
        cleanup();
        reject(new Error('Owned native widget action closed'));
      };
      const receive = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as {
          kind?: unknown;
          id?: unknown;
          ok?: unknown;
          data?: unknown;
          undefinedCause?: unknown;
        };
        if (row.kind !== 'native-widget-result' || row.id !== id) return;
        cleanup();
        if (row.ok !== true || !row.data || typeof row.data !== 'object') {
          widgetDiagnostic.undefinedCause = row.undefinedCause === true;
          reject(new Error('Owned native widget action failed', { cause: widgetDiagnostic }));
        } else resolve(row.data as Record<string, unknown>);
      };
      launched.on('message', receive);
      launched.once('close', unavailable);
      try {
        launched.send({ kind: 'native-widget-action', action, id }, (cause) => {
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

  return { savedAction, reviewedAction, mcpAction, selectionAction, widgetAction };
}
