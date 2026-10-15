import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';

const warn = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { classifyRequest, noteForeignOrigin, resetForeignOriginNoteForTests, FORWARDING_HEADERS } =
  await import('../request-classifier.js');
type ClassifierFacts = import('../request-classifier.js').ClassifierFacts;
type RequestClass = import('../request-classifier.js').RequestClass;

/** A request from a browser tab at `http://localhost:4242`, the plainest local caller. */
function local(overrides: Partial<ClassifierFacts> = {}, headers: IncomingHttpHeaders = {}) {
  return {
    peerAddress: '127.0.0.1',
    ingress: 'direct' as const,
    ...overrides,
    headers: { host: 'localhost:4242', ...headers },
  } satisfies ClassifierFacts;
}

const THIS_COMPUTER: RequestClass = { kind: 'this-computer', route: 'local' };
const otherDevice = (route: string, reason: string) => ({ kind: 'other-device', route, reason });

describe('classifyRequest', () => {
  // Purpose: every caller kind DOR-2965 names gets one row, so a rule that
  // moves (or a new shortcut) changes a named row instead of slipping past.
  const rows: { caller: string; facts: ClassifierFacts; expected: unknown }[] = [
    {
      caller: 'a browser tab at localhost, loopback Origin',
      facts: local({}, { origin: 'http://localhost:4242' }),
      expected: THIS_COMPUTER,
    },
    {
      caller: 'the CLI or a local MCP client: loopback, no Origin',
      facts: local(),
      expected: THIS_COMPUTER,
    },
    {
      caller: 'the desktop window, served by the server',
      facts: local({}, { origin: 'http://localhost:4242', referer: 'http://localhost:4242/' }),
      expected: THIS_COMPUTER,
    },
    {
      caller: 'the desktop window in development, on the renderer dev server',
      facts: local({}, { origin: 'http://localhost:5173' }),
      expected: THIS_COMPUTER,
    },
    {
      caller: 'the dev app on Vite, proxied with changeOrigin and no forwarding headers',
      facts: local({}, { host: 'localhost:6242', origin: 'http://localhost:6241' }),
      expected: THIS_COMPUTER,
    },
    {
      caller: 'a phone on Wi-Fi, through the Wi-Fi listener',
      facts: local(
        { peerAddress: '192.168.1.40', ingress: 'wifi' },
        { host: 'dorians-mac.local:4242' }
      ),
      expected: otherDevice('wifi', 'ingress'),
    },
    {
      caller: 'the own tunnel, through its ingress, with the public Host',
      facts: local({ ingress: 'own-tunnel' }, { host: 'abc.ngrok.app' }),
      expected: otherDevice('own-tunnel', 'ingress'),
    },
    {
      caller: 'the own tunnel, through its ingress, with Host rewritten to localhost',
      facts: local({ ingress: 'own-tunnel' }, { host: 'localhost:4242' }),
      expected: otherDevice('own-tunnel', 'ingress'),
    },
    {
      caller: 'managed remote access',
      facts: local({ ingress: 'managed' }, { host: 'dorian.dorkos.run' }),
      expected: otherDevice('managed', 'ingress'),
    },
    {
      caller: 'the session relay',
      facts: local({ ingress: 'relay' }),
      expected: { kind: 'relayed', route: 'relay' },
    },
    {
      caller: 'a non-loopback bind, a device on the LAN',
      facts: local({ peerAddress: '192.168.1.40' }, { host: '192.168.1.10:4242' }),
      expected: otherDevice('network', 'peer-not-loopback'),
    },
    {
      caller: 'Docker: a browser through the published port, from the bridge gateway',
      facts: local({ peerAddress: '::ffff:172.17.0.1' }, { host: 'localhost:4242' }),
      expected: otherDevice('network', 'peer-not-loopback'),
    },
    {
      caller: 'Docker with an owner: the CLI inside the container',
      facts: local({ peerAddress: '127.0.0.1' }, { host: '127.0.0.1:4242' }),
      expected: THIS_COMPUTER,
    },
    {
      caller: 'a same-host proxy with no forwarding headers, Host rewritten, public Origin',
      facts: local({}, { host: '127.0.0.1:4242', origin: 'https://dorkos.example.com' }),
      expected: otherDevice('network', 'foreign-origin'),
    },
    {
      caller: 'the same proxy, with only a public Referer',
      facts: local({}, { host: '127.0.0.1:4242', referer: 'https://dorkos.example.com/session' }),
      expected: otherDevice('network', 'foreign-origin'),
    },
    {
      caller: 'Origin: null (a sandboxed frame, a file:// page)',
      facts: local({}, { origin: 'null' }),
      expected: otherDevice('network', 'foreign-origin'),
    },
    {
      caller: 'an Origin that is not a URL',
      facts: local({}, { origin: 'localhost' }),
      expected: otherDevice('network', 'foreign-origin'),
    },
    {
      caller: 'a loopback Origin on another scheme (a browser extension page)',
      facts: local({}, { origin: 'chrome-extension://abcdef' }),
      expected: otherDevice('network', 'foreign-origin'),
    },
    {
      caller: 'DNS rebinding: loopback peer, the page names evil.example',
      facts: local({}, { host: 'evil.example:4242', origin: 'http://evil.example:4242' }),
      expected: otherDevice('network', 'host-not-loopback'),
    },
    {
      caller: 'a raw socket from the LAN forging Host: localhost',
      facts: local({ peerAddress: '192.168.86.200' }, { host: 'localhost' }),
      expected: otherDevice('network', 'peer-not-loopback'),
    },
    {
      caller: 'no TCP peer (a socket already torn down)',
      facts: local({ peerAddress: undefined }),
      expected: otherDevice('network', 'peer-not-loopback'),
    },
    {
      caller: 'IPv6 loopback with an [::1] Host and Origin',
      facts: local({ peerAddress: '::1' }, { host: '[::1]:4242', origin: 'http://[::1]:4242' }),
      expected: THIS_COMPUTER,
    },
    {
      caller: 'an IPv4-mapped loopback peer',
      facts: local({ peerAddress: '::ffff:127.0.0.1' }),
      expected: THIS_COMPUTER,
    },
    {
      caller: 'a 127.0.0.2 peer',
      facts: local({ peerAddress: '127.0.0.2' }),
      expected: THIS_COMPUTER,
    },
  ];

  it.each(rows)('$caller', ({ facts, expected }) => {
    expect(classifyRequest(facts, 'computer')).toEqual(expected);
  });

  // Purpose: a proxy on this machine connects from loopback, and a
  // misconfigured one rewrites Host to localhost, so the socket and Host both
  // pass. Each header a proxy adds must decide it alone, even sent empty.
  it.each(
    FORWARDING_HEADERS.flatMap((name) => [
      { name, value: '203.0.113.9' },
      { name, value: '' },
    ])
  )('a same-host proxy sending $name ("$value") is another device', ({ name, value }) => {
    const facts = local(
      {},
      { host: 'localhost:4242', origin: 'http://localhost:4242', [name]: value }
    );
    expect(classifyRequest(facts, 'computer')).toEqual(otherDevice('network', 'forwarded'));
  });

  // Purpose: X-Forwarded-Proto names no address, and the desktop shell and
  // dev proxy never send it; it is not one of the five on purpose.
  it('does not treat X-Forwarded-Proto alone as a proxy', () => {
    expect(classifyRequest(local({}, { 'x-forwarded-proto': 'https' }), 'computer')).toEqual(
      THIS_COMPUTER
    );
  });

  // Purpose: ngrok adds X-Forwarded-For, so an own tunnel aimed past the
  // ingress (development, TUNNEL_PORT) is still another device.
  it('reads a tunnel that skipped its ingress as forwarded, not local', () => {
    const facts = local({}, { host: 'localhost:6242', 'x-forwarded-for': '198.51.100.7' });
    expect(classifyRequest(facts, 'computer')).toEqual(otherDevice('network', 'forwarded'));
  });

  // Purpose: a hub has no "this computer" at all; every request is remote,
  // even one that looks local in every other way.
  it('calls every request on a hub a hub request', () => {
    expect(classifyRequest(local(), 'hub')).toEqual({ kind: 'hub', route: 'hub' });
    expect(classifyRequest(local({ ingress: 'relay' }), 'hub')).toEqual({
      kind: 'hub',
      route: 'hub',
    });
  });

  // Purpose: the relay mark wins over every header fact, so a relayed caller
  // can never read as this computer.
  it('calls a relayed request relayed, whatever it carries', () => {
    const facts = local({ ingress: 'relay' }, { 'x-forwarded-for': '1.2.3.4' });
    expect(classifyRequest(facts, 'computer')).toEqual({ kind: 'relayed', route: 'relay' });
  });
});

describe('noteForeignOrigin', () => {
  beforeEach(() => {
    warn.mockClear();
    resetForeignOriginNoteForTests();
  });

  // Purpose: one warning per process, naming the page, and only for the
  // foreign-origin reason; it must never repeat on every request.
  it('warns once, for a foreign page only', () => {
    const facts = local({}, { origin: 'https://dorkos.example.com' });
    noteForeignOrigin(facts, THIS_COMPUTER);
    noteForeignOrigin(facts, otherDevice('network', 'forwarded') as RequestClass);
    expect(warn).not.toHaveBeenCalled();

    noteForeignOrigin(facts, otherDevice('network', 'foreign-origin') as RequestClass);
    noteForeignOrigin(facts, otherDevice('network', 'foreign-origin') as RequestClass);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ page: 'https://dorkos.example.com' });
  });

  // Purpose: a Referer carries the path and query, where an invite link or an
  // OAuth code can sit; the log line must keep only the origin.
  it('logs only the origin of a Referer, never its path or query', () => {
    const facts = local({}, { referer: 'https://dorkos.example.com/invite?token=secret-123' });
    noteForeignOrigin(facts, otherDevice('network', 'foreign-origin') as RequestClass);
    expect(warn.mock.calls[0]?.[1]).toEqual({ page: 'https://dorkos.example.com' });
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('secret-123');
  });
});
