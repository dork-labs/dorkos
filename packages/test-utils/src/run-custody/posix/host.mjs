/** Main-side handle. Its exclusive writer is never returned to a worker. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
import { validateTerminalCleanupReceiptFd } from './terminal-cleanup-receipt.mjs';
import { requirePrivateSocketDirectory } from './scope-auth.mjs';

function latch() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lazily open a guardian after the owning main has admitted the existing caller gate. */
export async function openPosixGuardian({ directory, observer, signal, terminalCleanupReceiptFd }) {
  if (signal.aborted || !['darwin', 'linux'].includes(process.platform))
    throw new Error('POSIX guardian unavailable');
  await requirePrivateSocketDirectory(directory);
  if (signal.aborted) throw new Error('POSIX guardian acquisition cancelled');

  const hasTerminalReceipt = terminalCleanupReceiptFd !== undefined;
  if (hasTerminalReceipt) validateTerminalCleanupReceiptFd(terminalCleanupReceiptFd);

  const connection = Object.freeze({
    endpointId: randomBytes(16).toString('hex'),
    token: randomBytes(32).toString('hex'),
  });
  const script = fileURLToPath(new URL('./guardian.mjs', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      script,
      directory,
      connection.endpointId,
      ...(observer ? [observer] : hasTerminalReceipt ? [''] : []),
      ...(hasTerminalReceipt ? ['--fixture-terminal-cleanup-fd=3'] : []),
    ],
    {
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore', ...(hasTerminalReceipt ? [terminalCleanupReceiptFd] : [])],
      env: {},
    }
  );
  return bindPosixGuardian(child, connection, signal);
}

/** Keep an already acquired guardian handle through cancellation and reap. */
export async function bindPosixGuardian(child, connection, signal) {
  const ready = latch();
  const connected = latch();
  const scopeEnded = latch();
  const closed = latch();
  let receipt;
  let buffer = '';
  let ending = false;
  const closeMain = () => {
    if (ending) return;
    ending = true;
    ready.resolve(false);
    child.stdin.end();
  };
  signal.addEventListener('abort', closeMain, { once: true });
  child.stdin.on('error', closeMain);
  child.stdout.on('error', closeMain);
  child.stdout.setEncoding('utf8').on('data', (bytes) => {
    buffer += bytes;
    if (buffer.length > 512) {
      closeMain();
      return;
    }
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const fact = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (fact === 'ready') ready.resolve(true);
      if (fact === 'scope-connected') connected.resolve();
      if (fact === 'scope-ended') scopeEnded.resolve();
      if (['never-acquired', 'cleaned-owned', 'cleanup-uncertain'].includes(fact)) receipt = fact;
    }
  });
  child.once('error', () => ready.resolve(false));
  child.once('close', (code, signalName) => {
    signal.removeEventListener('abort', closeMain);
    ready.resolve(false);
    scopeEnded.resolve();
    closed.resolve({ code, signal: signalName });
  });
  if (signal.aborted) closeMain();
  else child.stdin.write(`${connection.token}\n`);
  const result = await ready.promise;
  if (!result || signal.aborted) closeMain();

  return {
    // Keep ownership on a failed launch handshake so the broker can observe join.
    connection: result && !ending && !signal.aborted ? connection : { endpointId: '', token: '' },
    scopeConnected: connected.promise,
    scopeEnded: scopeEnded.promise,
    closeMain,
    async join(deadline) {
      let timer;
      const limit = new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      });
      try {
        const fact = await Promise.race([closed.promise, limit]);
        return fact?.code === 0 && (receipt === 'never-acquired' || receipt === 'cleaned-owned')
          ? 'closed'
          : 'cleanup-uncertain';
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
