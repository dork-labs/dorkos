import type { WebContents } from 'electron';
import type { ConnectOverCDPTransport } from 'playwright-core';

interface Message {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** Adapts one real guest debugger to Playwright, never the shell's target tree. */
export function pageTransport(contents: WebContents): ConnectOverCDPTransport {
  const debuggerApi = contents.debugger;
  debuggerApi.attach('1.3');
  const rootSession = `dorkos-page-${contents.id}`;
  const children = new Set<string>();
  let closed = false;
  let attached = false;
  let targetId: string | undefined;
  let focusReady = Promise.resolve();
  let focusFailure: unknown;
  const resetFocus = (): void => {
    focusReady = focusReady
      .then(async () => {
        if (closed) return;
        // noDefaults preserves the native viewport but skips Playwright's normal focus setup.
        // Chromium needs this renewed after navigation to render a genuinely hidden guest.
        await debuggerApi.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
        if (closed) return;
        await debuggerApi.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      })
      .catch((error: unknown) => {
        focusFailure = error;
      });
  };
  const waitForFocus = async (): Promise<void> => {
    let pending: Promise<void>;
    do {
      pending = focusReady;
      await pending;
    } while (pending !== focusReady);
    if (closed) throw new Error('Browser closed');
    if (focusFailure) throw focusFailure;
  };
  const transport: ConnectOverCDPTransport = {
    send(raw) {
      const message = raw as Message;
      void (async () => {
        await Promise.resolve();
        try {
          if (closed) throw new Error('Browser closed');
          await waitForFocus();
          let result: unknown;
          if (!message.sessionId) {
            switch (message.method) {
              case 'Browser.getVersion':
                result = await debuggerApi.sendCommand(message.method);
                break;
              case 'Target.getTargetInfo':
                result = await debuggerApi.sendCommand(message.method);
                break;
              case 'Target.setAutoAttach': {
                if (!attached) {
                  attached = true;
                  resetFocus();
                  await waitForFocus();
                  const { targetInfo } = await debuggerApi.sendCommand('Target.getTargetInfo');
                  targetId = targetInfo.targetId;
                  transport.onmessage?.({
                    method: 'Target.attachedToTarget',
                    params: {
                      sessionId: rootSession,
                      targetInfo: { ...targetInfo, type: 'page' },
                      waitingForDebugger: false,
                    },
                  });
                }
                result = {};
                break;
              }
              default:
                throw new Error('Browser-wide control is unavailable');
            }
          } else {
            if (message.sessionId !== rootSession && !children.has(message.sessionId)) {
              throw new Error('Page session is unavailable');
            }
            // Browser and storage commands can reach sibling contexts even from a page session.
            if (
              message.method.startsWith('Browser.') ||
              message.method.startsWith('Storage.') ||
              (message.method.startsWith('Target.') &&
                !['Target.setAutoAttach', 'Target.getTargetInfo'].includes(message.method))
            ) {
              throw new Error('Browser-wide control is unavailable');
            }
            if (
              message.method === 'Target.getTargetInfo' &&
              message.params?.targetId &&
              message.params.targetId !== targetId
            ) {
              throw new Error('Page target is unavailable');
            }
            result = await debuggerApi.sendCommand(
              message.method,
              message.params,
              message.sessionId === rootSession ? undefined : message.sessionId
            );
          }
          transport.onmessage?.({ id: message.id, sessionId: message.sessionId, result });
        } catch (error) {
          transport.onmessage?.({
            id: message.id,
            sessionId: message.sessionId,
            error: { message: error instanceof Error ? error.message : 'Browser did not answer' },
          });
        }
      })();
    },
    close() {
      if (closed) return;
      closed = true;
      debuggerApi.removeListener('message', onMessage);
      debuggerApi.removeListener('detach', onDetach);
      contents.removeListener('did-navigate', onNavigate);
      if (!contents.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
      transport.onclose?.();
    },
  };
  const onMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): void => {
    if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string')
      children.add(params.sessionId);
    if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string')
      children.delete(params.sessionId);
    transport.onmessage?.({ method, params, sessionId: sessionId || rootSession });
  };
  const onDetach = (): void => transport.close();
  const onNavigate = (): void => {
    if (attached && !closed) resetFocus();
  };
  debuggerApi.on('message', onMessage);
  debuggerApi.once('detach', onDetach);
  contents.on('did-navigate', onNavigate);
  return transport;
}
