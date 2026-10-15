/**
 * Managed remote access in `TunnelManager`, against a fake ngrok SDK and a fake
 * ingress: no network, no credentials. The fake records every session, listener
 * and close in one ordered log, so "BYO closes before managed opens" is an
 * assertion about order rather than about final state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedIngress } from '../remote/managed-ingress.js';

const fake = vi.hoisted(() => {
  const log: string[] = [];
  const state = {
    failDomains: new Set<string>(),
    connectGate: null as Promise<void> | null,
    /** Held by a session's close until released. */
    sessionCloseGate: null as Promise<void> | null,
    /** Session values whose close rejects. */
    sessionCloseFails: new Set<string>(),
    /** Whether `ngrok.disconnect` closes an own-account listener. */
    disconnectWorks: false,
    sessions: [] as FakeSession[],
  };
  let nextId = 0;

  class FakeListener {
    readonly listenerId = `l${++nextId}`;
    constructor(
      readonly host: string,
      readonly target: string
    ) {}
    id() {
      return this.listenerId;
    }
    url() {
      return `https://${this.host}`;
    }
    async close() {
      log.push(`listener.close ${this.host}`);
    }
  }

  class FakeSession {
    readonly listeners = new Map<string, FakeListener>();
    closed = false;
    constructor(readonly value: string) {}
    httpEndpoint() {
      let domain = '';
      const builder = {
        domain: (d: string) => {
          domain = d;
          return builder;
        },
        listenAndForward: async (target: string) => {
          if (state.failDomains.has(domain)) {
            log.push(`listen.fail ${domain}`);
            throw new Error(`refused ${domain}`);
          }
          const listener = new FakeListener(domain, target);
          this.listeners.set(listener.id(), listener);
          log.push(`listen ${domain} -> ${target}`);
          return listener;
        },
      };
      return builder;
    }
    async closeListener(id: string) {
      log.push(`closeListener ${this.listeners.get(id)?.host}`);
      this.listeners.delete(id);
    }
    async close() {
      log.push(`session.closing ${this.value}`);
      if (state.sessionCloseGate) await state.sessionCloseGate;
      if (state.sessionCloseFails.has(this.value)) throw new Error('ngrok would not close');
      this.closed = true;
      this.listeners.clear();
      log.push(`session.close ${this.value}`);
    }
  }

  class SessionBuilder {
    private value = '';
    authtoken(value: string) {
      this.value = value;
      return this;
    }
    handleDisconnection() {
      return this;
    }
    handleHeartbeat() {
      return this;
    }
    async connect() {
      log.push(`connect ${this.value}`);
      if (state.connectGate) await state.connectGate;
      const session = new FakeSession(this.value);
      state.sessions.push(session);
      return session;
    }
  }

  const byoListener = {
    url: () => 'https://byo.ngrok.app',
    close: async () => {
      log.push('byo.close');
    },
  };

  return { log, state, SessionBuilder, byoListener };
});

vi.mock('@ngrok/ngrok', () => ({
  SessionBuilder: fake.SessionBuilder,
  forward: vi.fn(async () => {
    fake.log.push('byo.forward');
    return fake.byoListener;
  }),
  disconnect: vi.fn(async (url: string) => {
    if (!fake.state.disconnectWorks) throw new Error('ngrok would not disconnect');
    fake.log.push(`byo.disconnect ${url}`);
  }),
}));

import { TunnelManager } from '../tunnel-manager.js';

const PROOF = { header: 'x-dorkos-edge', secret: 's'.repeat(48) };
const INGRESS_URL = 'http://127.0.0.1:5555';

function fakeIngress(): ManagedIngress & {
  hosts: string[];
  listening: boolean;
  openGate: Promise<void> | null;
} {
  const ingress = {
    hosts: [] as string[],
    listening: false,
    openGate: null as Promise<void> | null,
    open: vi.fn(async () => {
      if (ingress.openGate) await ingress.openGate;
      ingress.listening = true;
      return INGRESS_URL;
    }),
    setHosts: vi.fn((hosts: readonly string[]) => {
      ingress.hosts = [...hosts];
    }),
    setEdgeProof: vi.fn(),
    dropPreviousEdgeProof: vi.fn(),
    beginDrain: vi.fn(() => fake.log.push('ingress.drain')),
    draining: false,
    inFlight: 0,
    close: vi.fn(async ({ immediate }: { immediate: boolean }) => {
      ingress.listening = false;
      fake.log.push(`ingress.close ${immediate ? 'immediate' : 'gentle'}`);
      return { deadlineHit: false, usedLocalDeadline: !immediate };
    }),
  };
  return ingress;
}

let exposable: boolean;
let manager: TunnelManager;
let ingress: ReturnType<typeof fakeIngress>;

const open = (hosts: string[], extra: Partial<Parameters<TunnelManager['startManaged']>[0]> = {}) =>
  manager.startManaged({ value: 'cred-1', hosts, edgeProof: PROOF, generation: 1, ...extra });

beforeEach(() => {
  fake.log.length = 0;
  fake.state.failDomains.clear();
  fake.state.connectGate = null;
  fake.state.sessionCloseGate = null;
  fake.state.sessionCloseFails.clear();
  fake.state.disconnectWorks = false;
  fake.state.sessions.length = 0;
  exposable = true;
  manager = new TunnelManager({ canExpose: () => exposable });
  ingress = fakeIngress();
  manager.attachManagedIngress(ingress);
});

describe('refusals', () => {
  it('refuses when canExpose() says no, and connects nothing', async () => {
    exposable = false;
    const result = await open(['a.example']);
    expect(result).toMatchObject({ ok: false, reason: 'exposure_not_allowed' });
    expect(fake.log).toEqual([]);
    expect(manager.getMode()).toBe('off');
  });

  it.each([
    ['missing', undefined],
    ['too short a secret', { header: 'x-dorkos-edge', secret: 'short' }],
    ['a reserved header name', { header: 'cookie', secret: 's'.repeat(48) }],
    ['an x-forwarded-* header name', { header: 'x-forwarded-proof', secret: 's'.repeat(48) }],
  ])('refuses a credential whose edge proof is %s', async (_label, edgeProof) => {
    const result = await open(['a.example'], { edgeProof });
    expect(result).toMatchObject({ ok: false, reason: 'edge_proof_missing' });
    expect(fake.log).toEqual([]);
  });

  it('refuses a credential with no hostname', async () => {
    expect(await open(['  '])).toMatchObject({ ok: false, reason: 'no_hosts' });
  });

  it('refuses before the ingress is attached', async () => {
    const bare = new TunnelManager({ canExpose: () => true });
    const result = await bare.startManaged({
      value: 'v',
      hosts: ['a.example'],
      edgeProof: PROOF,
      generation: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'ingress_unavailable' });
  });
});

describe('opening', () => {
  it('opens one listener per host, all into the ingress, and reports mode managed', async () => {
    const statuses: unknown[] = [];
    manager.on('status_change', (status) => statuses.push(status));

    const result = await open(['A.example', 'custom.example.com']);

    expect(result).toEqual({
      ok: true,
      url: 'https://a.example',
      hosts: ['a.example', 'custom.example.com'],
      generation: 1,
    });
    expect(fake.log).toEqual([
      'connect cred-1',
      `listen a.example -> ${INGRESS_URL}`,
      `listen custom.example.com -> ${INGRESS_URL}`,
    ]);
    expect(ingress.setEdgeProof).toHaveBeenCalledWith(PROOF);
    expect(ingress.hosts).toEqual(['a.example', 'custom.example.com']);
    expect(manager.getMode()).toBe('managed');
    expect(manager.managedHosts).toEqual(['a.example', 'custom.example.com']);
    expect(manager.status).toMatchObject({
      mode: 'managed',
      isRunning: true,
      connected: true,
      url: 'https://a.example',
    });
    expect(statuses.at(-1)).toMatchObject({ mode: 'managed', connected: true });
  });

  it('a repeated open with the same credential creates no duplicate listener', async () => {
    await open(['a.example', 'b.example']);
    fake.log.length = 0;

    const again = await open(['b.example', 'a.example'], { generation: 2 });

    expect(again).toMatchObject({ ok: true, generation: 2 });
    expect(fake.log).toEqual([]);
    expect(fake.state.sessions).toHaveLength(1);
    expect(fake.state.sessions[0]!.listeners.size).toBe(2);
    expect(manager.getManagedGeneration()).toBe(2);
  });

  it('is all-or-nothing: a refused hostname closes everything this open made', async () => {
    fake.state.failDomains.add('b.example');
    const result = await open(['a.example', 'b.example']);
    expect(result).toMatchObject({ ok: false, reason: 'forward_failed' });
    expect(fake.state.sessions[0]!.closed).toBe(true);
    expect(ingress.close).toHaveBeenCalledWith({ immediate: true });
    expect(manager.getMode()).toBe('off');
    expect(manager.managedHosts).toEqual([]);
  });
});

describe('host set changes', () => {
  it('moves {a,b} to {b,c}: closes a, opens c, leaves b alone', async () => {
    await open(['a.example', 'b.example']);
    fake.log.length = 0;

    const result = await manager.applyHosts(['b.example', 'C.example']);

    expect(result).toEqual({
      ok: true,
      hosts: ['b.example', 'c.example'],
      added: ['c.example'],
      removed: ['a.example'],
      failed: [],
    });
    expect(fake.log).toEqual([`listen c.example -> ${INGRESS_URL}`, 'closeListener a.example']);
    expect(manager.managedHosts).toEqual(['b.example', 'c.example']);
    expect(ingress.hosts).toEqual(['b.example', 'c.example']);
  });

  it('reports a hostname ngrok refuses and never admits it at the ingress', async () => {
    await open(['a.example']);
    fake.state.failDomains.add('b.example');
    const result = await manager.applyHosts(['a.example', 'b.example']);
    expect(result).toMatchObject({ ok: false, failed: ['b.example'], hosts: ['a.example'] });
    expect(ingress.hosts).toEqual(['a.example']);
  });

  it('a repeat open with a new host set applies the diff on the same session', async () => {
    await open(['a.example', 'b.example']);
    await open(['b.example', 'c.example']);
    expect(fake.state.sessions).toHaveLength(1);
    expect(manager.managedHosts).toEqual(['b.example', 'c.example']);
  });
});

describe('never both', () => {
  it('closes the own-account tunnel before the managed session connects', async () => {
    await manager.start({ port: 4242, authtoken: 't' });
    expect(manager.getMode()).toBe('byo');

    const result = await open(['a.example']);

    expect(result.ok).toBe(true);
    expect(fake.log.indexOf('byo.close')).toBeLessThan(fake.log.indexOf('connect cred-1'));
    expect(manager.getMode()).toBe('managed');
  });

  it('opens nothing managed when the own-account tunnel will not close', async () => {
    await manager.start({ port: 4242, authtoken: 't' });
    const close = vi
      .spyOn(fake.byoListener, 'close')
      .mockRejectedValueOnce(new Error('ngrok would not close'));

    const result = await open(['a.example']);

    expect(result).toMatchObject({ ok: false, reason: 'byo_close_failed' });
    expect(fake.log).not.toContain('connect cred-1');
    expect(manager.managedHosts).toEqual([]);
    close.mockRestore();
  });

  it('refuses to open the own-account tunnel over managed access', async () => {
    await open(['a.example']);
    await expect(manager.start({ port: 4242, authtoken: 't' })).rejects.toThrow(/Close it first/);
    expect(fake.log).not.toContain('byo.forward');
  });

  it('a new credential replaces the session; the ingress stays up for the proof overlap', async () => {
    await open(['a.example']);
    const next = { header: 'x-dorkos-edge', secret: 'n'.repeat(48) };
    const result = await open(['a.example'], { value: 'cred-2', edgeProof: next, generation: 2 });
    expect(result.ok).toBe(true);
    expect(fake.log.indexOf('session.close cred-1')).toBeLessThan(
      fake.log.indexOf('connect cred-2')
    );
    expect(ingress.close).not.toHaveBeenCalled();
    expect(ingress.setEdgeProof).toHaveBeenLastCalledWith(next);
  });
});

describe('drain and close', () => {
  it('beginDrain refuses new requests at the ingress and reports draining', async () => {
    await open(['a.example']);
    manager.beginDrain();
    expect(ingress.beginDrain).toHaveBeenCalled();
    expect(manager.getManagedPhase()).toBe('draining');
    expect(manager.getMode()).toBe('managed');
  });

  it('a gentle close lets the ingress finish before the ngrok session closes', async () => {
    await open(['a.example']);
    fake.log.length = 0;
    await manager.closeManaged({ immediate: false });
    expect(fake.log).toEqual([
      'ingress.drain',
      'ingress.close gentle',
      'session.closing cred-1',
      'session.close cred-1',
    ]);
    expect(manager.getMode()).toBe('off');
    expect(manager.managedHosts).toEqual([]);
    expect(manager.status).toMatchObject({ mode: 'off', isRunning: false, url: null });
  });

  it('a close during an open supersedes it and leaves nothing open', async () => {
    let release!: () => void;
    fake.state.connectGate = new Promise((resolve) => (release = resolve));
    const pending = open(['a.example']);
    await vi.waitFor(() => expect(fake.log).toContain('connect cred-1'));

    await manager.closeManaged({ immediate: true });
    release();

    expect(await pending).toMatchObject({ ok: false, reason: 'superseded' });
    expect(fake.state.sessions[0]!.closed).toBe(true);
    expect(fake.log.some((line) => line.startsWith('listen '))).toBe(false);
    expect(manager.getMode()).toBe('off');
  });

  it('stop() closes managed access too', async () => {
    await open(['a.example']);
    await manager.stop();
    expect(fake.state.sessions[0]!.closed).toBe(true);
    expect(manager.getMode()).toBe('off');
  });
});

describe('races', () => {
  /** At most one kind of tunnel is live, and getMode()/status agree with it. */
  function expectConsistent(): void {
    const byoLive = fake.log.includes('byo.forward') && !fake.log.includes('byo.close');
    const managedLive = fake.state.sessions.some((session) => !session.closed);
    expect(byoLive && managedLive).toBe(false);
    const mode = manager.getMode();
    expect(manager.status.mode).toBe(mode);
    expect(mode).toBe(managedLive ? 'managed' : byoLive ? 'byo' : 'off');
  }

  it('own-account then managed, concurrently: managed wins, the own tunnel is closed', async () => {
    const byo = manager.start({ port: 4242, authtoken: 't' });
    const managed = open(['a.example']);
    await expect(byo).resolves.toBe('https://byo.ngrok.app');
    expect((await managed).ok).toBe(true);
    expectConsistent();
    expect(manager.getMode()).toBe('managed');
  });

  it('managed then own-account, concurrently: the own tunnel is refused', async () => {
    const managed = open(['a.example']);
    const byo = manager.start({ port: 4242, authtoken: 't' });
    expect((await managed).ok).toBe(true);
    await expect(byo).rejects.toThrow(/Close it first/);
    expect(fake.log).not.toContain('byo.forward');
    expectConsistent();
  });

  it('a stop() issued while an own-account open waits in the queue wins', async () => {
    let release!: () => void;
    fake.state.connectGate = new Promise((resolve) => (release = resolve));
    const managed = open(['a.example']);
    const byo = manager.start({ port: 4242, authtoken: 't' });
    await manager.stop();
    release();
    await managed;
    await expect(byo).rejects.toThrow();
    expect(fake.log).not.toContain('byo.forward');
    expect(manager.getMode()).toBe('off');
  });

  it('a close while the open awaits the exposure check leaves no ingress listening', async () => {
    let allow!: (value: boolean) => void;
    const gated = new TunnelManager({
      canExpose: () => new Promise<boolean>((resolve) => (allow = resolve)),
    });
    gated.attachManagedIngress(ingress);
    const pending = gated.startManaged({
      value: 'cred-1',
      hosts: ['a.example'],
      edgeProof: PROOF,
      generation: 1,
    });
    await vi.waitFor(() => expect(allow).toBeTypeOf('function'));
    await gated.closeManaged({ immediate: true });
    allow(true);
    expect(await pending).toMatchObject({ ok: false, reason: 'superseded' });
    expect(ingress.listening).toBe(false);
    expect(fake.log).not.toContain('connect cred-1');
    expect(gated.getMode()).toBe('off');
  });

  it('a close while the ingress is opening does not leave it listening with the secret', async () => {
    let release!: () => void;
    ingress.openGate = new Promise((resolve) => (release = resolve));
    const pending = open(['a.example']);
    await vi.waitFor(() => expect(ingress.open).toHaveBeenCalled());
    await manager.closeManaged({ immediate: true });
    release();
    expect(await pending).toMatchObject({ ok: false, reason: 'superseded' });
    expect(ingress.listening).toBe(false);
    expect(fake.log).not.toContain('connect cred-1');
  });

  it('changing hosts never reopens the ingress', async () => {
    await open(['a.example']);
    await manager.applyHosts(['a.example', 'b.example']);
    await open(['b.example'], { generation: 2 });
    expect(ingress.open).toHaveBeenCalledTimes(1);
  });
});

describe('review fixes (DOR-2086 S1)', () => {
  const NEXT = { header: 'x-dorkos-edge', secret: 'n'.repeat(48) };
  const openNext = () => open(['a.example'], { value: 'cred-2', edgeProof: NEXT, generation: 2 });

  it('a close while another credential replaces the session reopens nothing', async () => {
    await open(['a.example']);
    let release!: () => void;
    fake.state.sessionCloseGate = new Promise((resolve) => (release = resolve));
    const pending = openNext();
    await vi.waitFor(() => expect(fake.log).toContain('session.closing cred-1'));

    const closing = manager.closeManaged({ immediate: true });
    release();
    await closing;

    expect(await pending).toMatchObject({ ok: false, reason: 'superseded' });
    expect(fake.log).not.toContain('connect cred-2');
    expect(manager.getMode()).toBe('off');
    expect(manager.managedHosts).toEqual([]);
  });

  it('a close while a draining session is finished for a new open reopens nothing', async () => {
    await open(['a.example']);
    manager.beginDrain();
    let release!: () => void;
    fake.state.sessionCloseGate = new Promise((resolve) => (release = resolve));
    const pending = openNext();
    await vi.waitFor(() => expect(fake.log).toContain('session.closing cred-1'));

    const closing = manager.closeManaged({ immediate: true });
    release();
    await closing;

    expect(await pending).toMatchObject({ ok: false, reason: 'superseded' });
    expect(fake.log).not.toContain('connect cred-2');
    expect(manager.getMode()).toBe('off');
  });

  it('a replacement whose old session will not close fails honestly', async () => {
    await open(['a.example']);
    fake.state.sessionCloseFails.add('cred-1');

    expect(await openNext()).toMatchObject({ ok: false, reason: 'forward_failed' });
    expect(fake.log).not.toContain('connect cred-2');
    expect(manager.getMode()).toBe('off');
    expect(manager.status).toMatchObject({ connected: false, isRunning: false });
  });

  it('adding a host asks the exposure guard; removing one does not', async () => {
    await open(['a.example', 'b.example']);
    fake.log.length = 0;
    exposable = false;

    const result = await manager.applyHosts(['b.example', 'c.example']);

    expect(result).toEqual({
      ok: false,
      hosts: ['b.example'],
      added: [],
      removed: ['a.example'],
      failed: ['c.example'],
    });
    expect(fake.log).toEqual(['closeListener a.example']);
    expect(ingress.hosts).toEqual(['b.example']);
  });

  it('an own tunnel ngrok would not close blocks managed access until it closes', async () => {
    await manager.start({ port: 4242, authtoken: 't' });
    const close = vi
      .spyOn(fake.byoListener, 'close')
      .mockRejectedValue(new Error('ngrok would not close'));

    await expect(manager.stop()).rejects.toThrow('ngrok would not close');
    expect(manager.getMode()).toBe('byo');

    expect(await open(['a.example'])).toMatchObject({ ok: false, reason: 'byo_close_failed' });
    expect(fake.log).not.toContain('connect cred-1');
    expect(manager.getMode()).toBe('byo');

    close.mockRestore();
    expect((await open(['a.example'])).ok).toBe(true);
    expect(fake.log.indexOf('byo.close')).toBeLessThan(fake.log.indexOf('connect cred-1'));
    expect(manager.getMode()).toBe('managed');
  });

  it('falls back to disconnect when the own tunnel will not close', async () => {
    await manager.start({ port: 4242, authtoken: 't' });
    const close = vi
      .spyOn(fake.byoListener, 'close')
      .mockRejectedValue(new Error('ngrok would not close'));
    fake.state.disconnectWorks = true;

    await expect(manager.stop()).resolves.toBeUndefined();
    expect(fake.log).toContain('byo.disconnect https://byo.ngrok.app');
    expect(manager.getMode()).toBe('off');
    close.mockRestore();
  });

  it('stop() closes the own tunnel even when managed access will not close', async () => {
    await manager.start({ port: 4242, authtoken: 't' });
    const closeManaged = vi
      .spyOn(manager, 'closeManaged')
      .mockRejectedValue(new Error('managed would not close'));

    await expect(manager.stop()).rejects.toThrow('managed would not close');
    expect(fake.log).toContain('byo.close');
    expect(manager.getMode()).toBe('off');
    closeManaged.mockRestore();
  });

  it('stopOwnTunnel() leaves managed access open', async () => {
    await open(['a.example']);
    await manager.stopOwnTunnel();
    expect(fake.state.sessions[0]!.closed).toBe(false);
    expect(manager.getMode()).toBe('managed');
  });

  it('passes a gentle close its drain deadline', async () => {
    await open(['a.example']);
    await manager.closeManaged({ immediate: false, drainDeadlineMs: 5_000 });
    expect(ingress.close).toHaveBeenCalledWith({ immediate: false, drainDeadlineMs: 5_000 });
  });
});

describe('drain deadline and the end of a session (DOR-2086 S5)', () => {
  it('reports when a gentle close cuts the rest, and that Cloud set it', async () => {
    await open(['a.example']);
    let release!: () => void;
    vi.mocked(ingress.close).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { deadlineHit: false, usedLocalDeadline: false };
    });
    const before = Date.now();
    const closing = manager.closeManaged({ immediate: false, drainDeadlineMs: 20_000 });
    const drain = manager.getManagedDrain();
    expect(manager.getManagedPhase()).toBe('draining');
    expect(drain?.deadline).toBe('cloud');
    expect(Date.parse(drain!.until)).toBeGreaterThanOrEqual(before + 20_000);
    expect(Date.parse(drain!.until)).toBeLessThanOrEqual(Date.now() + 20_000);
    release();
    await closing;
    expect(manager.getManagedDrain()).toBeNull();
  });

  it('says the local default applies when the close named no deadline', async () => {
    await open(['a.example']);
    let release!: () => void;
    vi.mocked(ingress.close).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { deadlineHit: false, usedLocalDeadline: true };
    });
    const closing = manager.closeManaged({ immediate: false });
    expect(manager.getManagedDrain()?.deadline).toBe('local');
    release();
    await closing;
  });

  it('has no deadline to report for an immediate close or a bare drain', async () => {
    await open(['a.example']);
    manager.beginDrain();
    expect(manager.getManagedDrain()).toBeNull();
    await manager.closeManaged({ immediate: true });
    expect(manager.getManagedDrain()).toBeNull();
  });

  it('says the deadline is local when a local cap names it (shutdown)', async () => {
    await open(['a.example']);
    let release!: () => void;
    vi.mocked(ingress.close).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { deadlineHit: false, usedLocalDeadline: false };
    });
    const closing = manager.closeManaged({
      immediate: false,
      drainDeadlineMs: 2_000,
      deadlineFrom: 'local',
      reason: 'shutdown',
    });
    expect(manager.getManagedDrain()?.deadline).toBe('local');
    release();
    await closing;
  });

  it('announces the end of a session once, with the reason that actually ended it', async () => {
    const ended = vi.fn();
    manager.on('managed_closed', ended);
    await open(['a.example'], { generation: 7 });
    let release!: () => void;
    vi.mocked(ingress.close).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { deadlineHit: false, usedLocalDeadline: true };
    });
    const idle = manager.closeManaged({ immediate: false, reason: 'idle' });
    // A withdrawal cuts the idle close short: the withdrawal is what ended it.
    const withdraw = manager.closeManaged({ immediate: true, reason: 'withdrawn' });
    // A later forced close does not take that away.
    const stop = manager.closeManaged({ immediate: true, reason: 'stopped' });
    release();
    await Promise.all([idle, withdraw, stop]);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]![0]).toMatchObject({ generation: 7, reason: 'withdrawn' });
    // Two gentle closes: the first one's reason stands.
    await open(['a.example'], { generation: 8 });
    await Promise.all([
      manager.closeManaged({ immediate: false, reason: 'idle' }),
      manager.closeManaged({ immediate: false, reason: 'closed_by_cloud' }),
    ]);
    expect(ended.mock.calls[1]![0]).toMatchObject({ generation: 8, reason: 'idle' });
    // Nothing open: nothing to announce.
    await manager.closeManaged({ immediate: true, reason: 'withdrawn' });
    expect(ended).toHaveBeenCalledTimes(2);
  });
});
