import type { Server } from 'node:http';
import type { MainRequestAdmission } from './main-request-admission.js';

/** Acquisition boundary for the main HTTP listener, not a drain of active work. */
interface MainListenerOptions {
  admission: MainRequestAdmission;
  /** Begin Node's asynchronous listen and return its handle immediately. */
  listen: () => Server;
  /** Startup announcements and registrations, only for an admitted listening event. */
  onListening: (server: Server) => void;
}

/**
 * Refuse late main-listener acquisition or close a listener that becomes ready too late.
 * Once its listening callback has run, terminal admission leaves it bound so existing
 * work can finish and later requests receive 503. No close callback is awaited.
 *
 * @param options - The shared gate, listener acquisition and startup callback.
 */
export function startMainListener({
  admission,
  listen,
  onListening,
}: MainListenerOptions): Server | undefined {
  if (admission.isClosed) return undefined;
  const server = listen();
  server.once('listening', () => {
    if (admission.isClosed) {
      server.close();
      return;
    }
    onListening(server);
  });
  // A supplied listen factory can close admission during acquisition. Retain and
  // close its handle now; the event check also catches a bind completing afterward.
  if (admission.isClosed) server.close();
  return server;
}
