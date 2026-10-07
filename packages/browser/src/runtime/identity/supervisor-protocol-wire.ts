import {
  createSupervisorUncertaintyDiagnostic,
  type SupervisorUncertaintyCode,
} from '../supervisor-uncertainty-diagnostic.js';
import type { ConnectOverCDPTransport } from 'playwright-core';
const retained = new Set<object>();
type OriginalWireCloseOutcome = Readonly<
  | { kind: 'ordinary'; wire: object }
  | { kind: 'failed' | 'cooperative-socket-terminal'; wire: object; primary: unknown }
>;
const originalCloseOutcomes = new WeakMap<object, OriginalWireCloseOutcome>();
/** Constructor-private membership and exact original reason; no participant property reads. */
export function acceptsOriginalWireRetirementCandidate(wire: object, reason: unknown): boolean {
  const outcome = originalCloseOutcomes.get(wire);
  return outcome?.kind === 'cooperative-socket-terminal' && Object.is(outcome.primary, reason);
}
/** Launcher-private final release; caller must first retain complete original retirement qualification. */
export function releaseOriginalWireRetirement(wire: object, reason: unknown): boolean {
  if (!acceptsOriginalWireRetirementCandidate(wire, reason)) return false;
  return retained.delete(wire);
}
/** Supervisor-private loopback wire; caller must first attribute endpoint to its original owned child.
 * Its protocol envelope is bounded; this is not preallocation or public CDP access evidence.
 */
export function createSupervisorProtocolWire(endpoint: string) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    Number(url.port) > 65535 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/devtools\/browser\/[a-fA-F0-9-]{36}$/.test(url.pathname) ||
    url.href !== endpoint
  )
    throw new Error('CHROME_FIXTURE_ENDPOINT_INVALID');
  const OriginalSocket = globalThis.WebSocket;
  let socket: WebSocket | undefined, send: ((value: string) => void) | undefined;
  let stop: (() => void) | undefined;
  let opening: Promise<void> | undefined, closing: Promise<void> | undefined;
  let originalPeerCloseEntered = false;
  let originalSocketReturned = false;
  let primaryOrigin: SupervisorUncertaintyCode | undefined;
  let laterProducerFault: Readonly<{ value: unknown }> | undefined;
  let originalCloseOutcome: OriginalWireCloseOutcome | undefined;
  let opened = false;
  let stopped = false,
    failed = false,
    primary: unknown;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let originalWrite: ((value: string) => unknown) | undefined;
  try {
    originalWrite = process.stderr.write.bind(process.stderr);
  } catch {
    /* Optional sink only. */
  }
  let primaryCode = 'unknown';
  const diagnostic = createSupervisorUncertaintyDiagnostic((line) => {
    originalWrite?.(line + 'SUPERVISOR_CLOSE: ' + primaryCode + '\n');
  });
  const blockSettlement = (value: unknown) => {
    laterProducerFault ??= Object.freeze({ value });
    if (originalCloseOutcome?.kind === 'cooperative-socket-terminal') {
      originalCloseOutcome = Object.freeze({ kind: 'failed', wire: owner, primary });
      originalCloseOutcomes.set(owner, originalCloseOutcome);
    }
  };
  const note = (error: unknown, origin: SupervisorUncertaintyCode, ownedCode = 'unknown') => {
    if (!failed) {
      failed = true;
      primary = error;
      primaryOrigin = origin;
      primaryCode = ownedCode;
      diagnostic.note(origin);
    } else {
      const propagation =
        (origin === 'WIRE_OPEN_PROMISE' ||
          origin === 'WIRE_OPEN_JOIN' ||
          origin === 'WIRE_CLOSE_PROMISE') &&
        Object.is(error, primary);
      if (!propagation) blockSettlement(error);
    }
  };
  const transport: ConnectOverCDPTransport = {
    open() {
      void open().catch((error) => note(error, 'WIRE_OPEN_PROMISE'));
    },
    send(value) {
      if (stopped || failed || !socket || socket.readyState !== OriginalSocket.OPEN || !send) {
        const error = failed ? primary : new Error('CHROME_FIXTURE_WIRE_UNAVAILABLE');
        blockSettlement(error);
        throw error;
      }
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(value);
      } catch (error) {
        blockSettlement(error);
        throw error;
      }
      if (
        typeof encoded !== 'string' ||
        Buffer.byteLength(encoded) > 65536 ||
        socket.bufferedAmount + Buffer.byteLength(encoded) > 262144
      ) {
        const error = new Error('CHROME_FIXTURE_WIRE_CAPACITY');
        blockSettlement(error);
        throw error;
      }
      try {
        send(encoded);
      } catch (error) {
        note(error, 'WIRE_SEND_CALL');
        throw error;
      }
    },
    close() {
      return close();
    },
  };
  const owner = Object.freeze({
    transport,
    open,
    close,
    closedOriginal: closed,
    /** Private immutable original result; this does not settle or clear failed custody. */
    readOriginalCloseOutcome: () => originalCloseOutcome,
    /** Exact launcher calls this immediately before its original cooperative Browser.close. */
    enterOriginalPeerClose() {
      if (failed) throw primary;
      originalPeerCloseEntered = true;
    },
    isKnown: () => !stopped && !failed && socket?.readyState === OriginalSocket.OPEN,
  });
  retained.add(owner);
  function open() {
    if (opening) return opening;
    opening = Promise.resolve().then(() => {
      if (stopped) throw new Error('CHROME_FIXTURE_WIRE_ADMISSION_CLOSED');
      socket = new OriginalSocket(endpoint);
      const original = socket;
      send = original.send.bind(original);
      stop = original.close.bind(original);
      original.addEventListener('message', (event) => {
        let dispatching = false;
        try {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 8 * 1024 * 1024)
            throw new Error('CHROME_FIXTURE_WIRE_FRAME_INVALID');
          const parsed: unknown = JSON.parse(event.data);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('CHROME_FIXTURE_WIRE_FRAME_INVALID');
          dispatching = true;
          transport.onmessage?.(parsed);
        } catch (error) {
          note(error, dispatching ? 'WIRE_MESSAGE_CALLBACK' : 'WIRE_MESSAGE_PAYLOAD');
        }
      });
      original.addEventListener(
        'close',
        (event) => {
          if (!stopped && !originalPeerCloseEntered)
            note(
              new Error('CHROME_FIXTURE_WIRE_UNEXPECTED_CLOSE'),
              'WIRE_UNEXPECTED_CLOSE',
              'CHROME_FIXTURE_WIRE_UNEXPECTED_CLOSE'
            );
          try {
            transport.onclose?.(JSON.stringify({ code: event.code, wasClean: event.wasClean }));
          } catch (error) {
            note(error, 'WIRE_CLOSE_CALLBACK');
          } finally {
            // Original socket closure returns independently of the original SDK callback.
            originalSocketReturned = true;
            resolveClosed();
          }
          if (!failed) retained.delete(owner);
        },
        { once: true }
      );
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error('CHROME_FIXTURE_WIRE_OPEN_UNKNOWN');
          note(error, 'WIRE_OPEN_WAIT', 'CHROME_FIXTURE_WIRE_OPEN_UNKNOWN');
          reject(error);
        }, 3000);
        original.addEventListener(
          'open',
          () => {
            clearTimeout(timer);
            opened = true;
            resolve();
          },
          { once: true }
        );
        original.addEventListener(
          'error',
          () => {
            clearTimeout(timer);
            const error = new Error('CHROME_FIXTURE_WIRE_OPEN_FAILED');
            note(
              error,
              !opened
                ? 'WIRE_SOCKET_ERROR_OPENING'
                : originalPeerCloseEntered
                  ? 'WIRE_SOCKET_ERROR_COOPERATIVE'
                  : stopped
                    ? 'WIRE_SOCKET_ERROR_LOCAL_CLOSE'
                    : 'WIRE_SOCKET_ERROR_ACTIVE',
              'CHROME_FIXTURE_WIRE_OPEN_FAILED'
            );
            reject(error);
          },
          { once: true }
        );
        original.addEventListener(
          'close',
          () => {
            clearTimeout(timer);
            reject(new Error('CHROME_FIXTURE_WIRE_CLOSED_BEFORE_OPEN'));
          },
          { once: true }
        );
      });
    });
    void opening.catch((error) => note(error, 'WIRE_OPEN_PROMISE'));
    return opening;
  }
  function close() {
    if (closing) return closing;
    stopped = true;
    closing = Promise.resolve().then(async () => {
      // Pending open remains an independently retained original, not a fabricated close receipt.
      if (!socket) {
        if (opening) {
          const joined = await Promise.allSettled([opening]);
          for (const result of joined)
            if (result.status === 'rejected') note(result.reason, 'WIRE_OPEN_JOIN');
          if (failed) throw primary;
          throw new Error('CHROME_FIXTURE_WIRE_ACQUISITION_UNKNOWN');
        }
        resolveClosed();
        retained.delete(owner);
        return;
      }
      try {
        stop!();
      } catch (error) {
        note(error, 'WIRE_STOP_CALL');
      }
      // A failed original close call cannot skip the independent observed close bank.
      await closed;
      if (opening) {
        const joined = await Promise.allSettled([opening]);
        for (const result of joined)
          if (result.status === 'rejected') note(result.reason, 'WIRE_OPEN_JOIN');
      }
      if (failed) throw primary;
    });
    void closing.then(
      () => {
        originalCloseOutcome = Object.freeze({ kind: 'ordinary', wire: owner });
        originalCloseOutcomes.set(owner, originalCloseOutcome);
      },
      (error) => {
        note(error, 'WIRE_CLOSE_PROMISE');
        const candidate =
          opened &&
          originalPeerCloseEntered &&
          originalSocketReturned &&
          primaryOrigin === 'WIRE_SOCKET_ERROR_COOPERATIVE' &&
          primaryCode === 'CHROME_FIXTURE_WIRE_OPEN_FAILED' &&
          !laterProducerFault;
        originalCloseOutcome = Object.freeze({
          kind: candidate ? 'cooperative-socket-terminal' : 'failed',
          wire: owner,
          primary,
        });
        originalCloseOutcomes.set(owner, originalCloseOutcome);
        diagnostic.emit();
      }
    );
    return closing;
  }
  return owner;
}
