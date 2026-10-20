import { parentPort, workerData } from 'node:worker_threads';
import { startReaderShare, type ReaderShareInput, type ToReaderShare } from './reader-share.js';

/**
 * A reader thread: one share of the run's streams on its own event loop. Readers run off the main
 * thread because one event loop cannot parse the frames of 20,000 streams at 50 posts a second.
 */
if (!parentPort) throw new Error('reader-worker.ts runs only as a worker thread.');
const port = parentPort;
const handle = startReaderShare(workerData as ReaderShareInput, (message) => {
  port.postMessage(message);
  if (message.type === 'done') port.close();
});
port.on('message', (message: ToReaderShare) => handle(message));
