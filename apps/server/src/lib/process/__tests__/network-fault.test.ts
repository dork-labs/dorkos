/**
 * The process-level safety net (DOR-3229): an outbound connection that drops or
 * is reset leaves the server running; anything else ends it non-zero.
 *
 * The child-process cases install the real handlers in a real process, because
 * what Node does with an uncaught error is exactly what a mock cannot show.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createProcessFaultHandlers,
  faultOrigin,
  isSurvivableNetworkFault,
} from '../network-fault.js';

const MODULE = fileURLToPath(new URL('../network-fault.ts', import.meta.url));

/** A Node-style system error, as a socket or the resolver reports one. */
function systemError(code: string, syscall?: string): Error {
  return Object.assign(new Error(`${syscall ?? 'op'} ${code}`), {
    code,
    ...(syscall ? { syscall } : {}),
  });
}

describe('isSurvivableNetworkFault', () => {
  it.each([
    ['ECONNRESET', 'read'],
    ['ECONNREFUSED', 'connect'],
    ['ETIMEDOUT', 'connect'],
    ['EHOSTUNREACH', 'connect'],
    ['ENETUNREACH', 'connect'],
    ['ENOTFOUND', 'getaddrinfo'],
    ['EAI_AGAIN', 'getaddrinfo'],
    ['EPIPE', 'write'],
  ])('survives %s on %s', (code, syscall) => {
    expect(isSurvivableNetworkFault(systemError(code, syscall))).toBe(true);
  });

  it.each(['EADDRNOTAVAIL', 'ENETDOWN', 'EHOSTDOWN'])(
    'survives %s on connect, the link going away',
    (code) => {
      expect(isSurvivableNetworkFault(systemError(code, 'connect'))).toBe(true);
    }
  );

  it.each([
    ['EADDRNOTAVAIL', 'bind'],
    ['EADDRNOTAVAIL', 'listen'],
    ['EADDRNOTAVAIL', 'read'],
    ['ENETDOWN', 'bind'],
    ['ENETDOWN', 'write'],
    ['EHOSTDOWN', 'listen'],
    ['EHOSTDOWN', 'read'],
  ])('does not survive %s on %s, which is not the link going away', (code, syscall) => {
    expect(isSurvivableNetworkFault(systemError(code, syscall))).toBe(false);
  });

  it.each(['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])(
    'survives undici %s, which names no syscall',
    (code) => {
      expect(isSurvivableNetworkFault(systemError(code))).toBe(true);
    }
  );

  it('survives a fetch that failed on the network', () => {
    const failed = new TypeError('fetch failed', { cause: systemError('ECONNRESET', 'read') });
    expect(isSurvivableNetworkFault(failed)).toBe(true);
  });

  it.each([
    ['a TypeError', new TypeError('x is not a function')],
    ['a TypeError whose cause is not the network', new TypeError('bad', { cause: new Error('x') })],
    ['an assertion', Object.assign(new Error('assert'), { code: 'ERR_ASSERTION' })],
    ['a database error', Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' })],
    ['a network code from a file write', systemError('EPIPE', 'open')],
    ['a network code with no syscall', systemError('ECONNRESET')],
    ['a string', 'boom'],
    ['nothing', undefined],
  ])('does not survive %s', (_name, value) => {
    expect(isSurvivableNetworkFault(value)).toBe(false);
  });
});

describe('createProcessFaultHandlers', () => {
  it('warns once per network failure and counts it, for both events', () => {
    const warn = vi.fn();
    const fatal = vi.fn();
    const handlers = createProcessFaultHandlers({ warn, fatal });
    handlers.onUncaughtException(systemError('EHOSTUNREACH', 'connect'));
    handlers.onUnhandledRejection(
      new TypeError('fetch failed', { cause: systemError('ECONNRESET', 'read') })
    );
    expect(fatal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[1]).toMatchObject({
      kind: 'unhandledRejection',
      code: 'ECONNRESET',
      survived: 2,
    });
    expect(handlers.survivedCount()).toBe(2);
  });

  it('stays up for EADDRNOTAVAIL on connect, and exits for it on bind', () => {
    const warn = vi.fn();
    const fatal = vi.fn();
    const handlers = createProcessFaultHandlers({ warn, fatal });
    handlers.onUncaughtException(systemError('EADDRNOTAVAIL', 'connect'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fatal).not.toHaveBeenCalled();

    const ownPort = systemError('EADDRNOTAVAIL', 'bind');
    handlers.onUncaughtException(ownPort);
    expect(fatal).toHaveBeenCalledWith('uncaughtException', ownPort);
  });

  it('hands everything else to the fatal path, for both events', () => {
    const warn = vi.fn();
    const fatal = vi.fn();
    const handlers = createProcessFaultHandlers({ warn, fatal });
    const error = new TypeError('x is not a function');
    handlers.onUncaughtException(error);
    handlers.onUnhandledRejection('boom');
    expect(fatal.mock.calls).toEqual([
      ['uncaughtException', error],
      ['unhandledRejection', 'boom'],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('faultOrigin', () => {
  it('names the first frame outside Node, as the crash log needed', () => {
    const error = new Error('connect EHOSTUNREACH');
    error.stack = [
      'Error: connect EHOSTUNREACH',
      '    at internalConnect (node:net:1110:16)',
      '    at lookup5 (server-entry.mjs:42:7)',
      '    at lookupAndConnectMultiple (node:net:1300:3)',
    ].join('\n');
    expect(faultOrigin(error)).toBe('lookup5 (server-entry.mjs:42:7)');
  });

  it('says unknown when there is no stack', () => {
    expect(faultOrigin('boom')).toBe('unknown');
  });
});

/**
 * Run `body` in a child process that installed the real handlers, ending non-zero on the
 * fatal path as the server does, and print ALIVE if it is still running 500 ms later.
 */
async function runWithHandlers(body: string) {
  const source = `
    import net from 'node:net';
    import { createProcessFaultHandlers } from ${JSON.stringify(MODULE)};
    const handlers = createProcessFaultHandlers({
      warn: (message, data) => process.stdout.write('WARN ' + data.code + '\\n'),
      fatal: () => process.exit(1),
    });
    process.on('uncaughtException', handlers.onUncaughtException);
    process.on('unhandledRejection', handlers.onUnhandledRejection);
    ${body}
    setTimeout(() => { process.stdout.write('ALIVE\\n'); process.exit(0); }, 500);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stdout, stderr };
}

describe.skipIf(process.platform === 'win32')('in a real process', () => {
  it('stays up when a host resets an outbound connection nobody listened on', async () => {
    // The server resets every connection; the client socket has no error listener, so the
    // reset reaches the process handler exactly as the crash in the log did.
    const run = await runWithHandlers(`
      const server = net.createServer((socket) => socket.resetAndDestroy());
      server.listen(0, '127.0.0.1', () => {
        const socket = net.connect(server.address().port, '127.0.0.1');
        socket.on('connect', () => socket.write('hello'));
      });
      setTimeout(() => server.close(), 400);
    `);
    expect(run.stdout, run.stderr).toContain('WARN ECONNRESET');
    expect(run.stdout).toContain('ALIVE');
    expect(run.code).toBe(0);
  }, 20_000);

  it('exits non-zero on a thrown TypeError', async () => {
    const run = await runWithHandlers(`
      setTimeout(() => { null.boom(); }, 10);
    `);
    expect(run.stdout).not.toContain('ALIVE');
    expect(run.code, run.stderr).toBe(1);
  }, 20_000);
});
