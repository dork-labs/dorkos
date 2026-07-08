import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TerminalManager, type PtyLike, type SpawnPtyOptions } from '../terminal-manager.js';
import {
  authorizeTerminalUpgrade,
  bindTerminalSocket,
  type TerminalWebSocket,
} from '../terminal-websocket.js';
import { resolveTrustedOrigins } from '../../../lib/trusted-origins.js';

/**
 * Terminal WebSocket auth + binding tests. The bearer-of-id + Origin gate is the
 * code-execution security surface, so it is tested directly: unknown ids and
 * cross-origin handshakes are refused, allowed/absent origins pass, and a bound
 * socket attaches (flushing buffered output) and routes control frames.
 */

/** A controllable mock PTY, so tests never spawn a real shell. */
function makeMockPty() {
  const dataListeners: ((d: string) => void)[] = [];
  return {
    pid: 1,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData(cb: (d: string) => void) {
      dataListeners.push(cb);
    },
    onExit() {},
    emit(data: string) {
      dataListeners.forEach((l) => l(data));
    },
  };
}

/** A fake WebSocket capturing sends and exposing a `fire` to drive events. */
function makeFakeWs() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const ws = {
    readyState: 1, // OPEN
    binaryType: 'blob',
    send: vi.fn(),
    close: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
    },
  };
  const fire = (event: string, ...args: unknown[]) =>
    (listeners[event] ?? []).forEach((cb) => cb(...args));
  return { ws: ws as unknown as TerminalWebSocket, fire };
}

describe('terminal websocket auth + binding', () => {
  let boundary: string;
  let lastPty: ReturnType<typeof makeMockPty>;
  let manager: TerminalManager;

  beforeEach(() => {
    boundary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term-ws-')));
    const spawn = (_opts: SpawnPtyOptions): PtyLike => {
      lastPty = makeMockPty();
      return lastPty;
    };
    manager = new TerminalManager({ spawn, boundary, idleTimeoutMs: 60_000 });
  });

  describe('authorizeTerminalUpgrade', () => {
    it('rejects a non-terminal upgrade path (close silently)', () => {
      const decision = authorizeTerminalUpgrade({ url: '/api/events', headers: {} }, manager);
      expect(decision).toEqual({ ok: false, reason: 'not-terminal' });
    });

    it('rejects an unknown/expired terminal id', () => {
      const decision = authorizeTerminalUpgrade(
        { url: '/api/terminal/does-not-exist/socket', headers: {} },
        manager
      );
      expect(decision).toEqual({ ok: false, reason: 'unknown-id' });
    });

    it('accepts a valid id with no Origin (non-browser client)', async () => {
      const id = await manager.create({ cwd: boundary });
      const decision = authorizeTerminalUpgrade(
        { url: `/api/terminal/${id}/socket`, headers: {} },
        manager
      );
      expect(decision).toEqual({ ok: true, id });
    });

    it('accepts a valid id with a trusted Origin', async () => {
      const id = await manager.create({ cwd: boundary });
      const trusted = resolveTrustedOrigins()[0];
      const decision = authorizeTerminalUpgrade(
        { url: `/api/terminal/${id}/socket`, headers: { origin: trusted } },
        manager
      );
      expect(decision).toEqual({ ok: true, id });
    });

    it('rejects a valid id from an untrusted Origin (DNS-rebinding guard)', async () => {
      const id = await manager.create({ cwd: boundary });
      const decision = authorizeTerminalUpgrade(
        { url: `/api/terminal/${id}/socket`, headers: { origin: 'http://evil.example' } },
        manager
      );
      expect(decision).toEqual({ ok: false, reason: 'forbidden-origin' });
    });
  });

  describe('bindTerminalSocket', () => {
    it('attaches and flushes output buffered before the socket connected', async () => {
      const id = await manager.create({ cwd: boundary });
      lastPty.emit('booting\r\n'); // arrives pre-attach → buffered
      const { ws } = makeFakeWs();
      bindTerminalSocket(ws, id, manager);
      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(
        Buffer.from((ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toString(
          'utf8'
        )
      ).toBe('booting\r\n');
    });

    it('routes an input control frame to the PTY', async () => {
      const id = await manager.create({ cwd: boundary });
      const { ws, fire } = makeFakeWs();
      bindTerminalSocket(ws, id, manager);
      fire('message', Buffer.from(JSON.stringify({ type: 'input', data: 'whoami\r' })), false);
      expect(lastPty.write).toHaveBeenCalledWith('whoami\r');
    });

    it('routes a resize control frame to the PTY', async () => {
      const id = await manager.create({ cwd: boundary });
      const { ws, fire } = makeFakeWs();
      bindTerminalSocket(ws, id, manager);
      fire('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })), false);
      expect(lastPty.resize).toHaveBeenCalledWith(120, 40);
    });

    it('ignores malformed and non-terminal frames without tearing down', async () => {
      const id = await manager.create({ cwd: boundary });
      const { ws, fire } = makeFakeWs();
      bindTerminalSocket(ws, id, manager);
      fire('message', Buffer.from('not json'), false);
      fire('message', Buffer.from(JSON.stringify({ type: 'bogus' })), false);
      fire('message', Buffer.from([1, 2, 3]), true); // binary — not a control frame
      expect(lastPty.write).not.toHaveBeenCalled();
      expect(lastPty.resize).not.toHaveBeenCalled();
    });

    it('detaches on socket close (id remains for reconnect until idle teardown)', async () => {
      const id = await manager.create({ cwd: boundary });
      const detach = vi.spyOn(manager, 'detach');
      const { ws, fire } = makeFakeWs();
      bindTerminalSocket(ws, id, manager);
      fire('close');
      expect(detach).toHaveBeenCalledWith(id, expect.anything());
      expect(manager.has(id)).toBe(true);
    });
  });
});
