import { describe, it, expect } from 'vitest';
import {
  ADDRESS_NOTICES,
  isThisAppsAddress,
  normalizeAddressInput,
  type AddressInput,
} from '../browser-address';

/** The DuckDuckGo search for `text`. */
function search(text: string): AddressInput {
  return { kind: 'search', url: `https://duckduckgo.com/?${new URLSearchParams({ q: text })}` };
}

/** Opened with no fallback: plain `http://` in front, as the spec's private-host rows say. */
function http(text: string): AddressInput {
  return { kind: 'open', url: `http://${text}` };
}

// DOR-4419: one test per row of the spec's address rules, in the spec's order.
describe('normalizeAddressInput', () => {
  it('1. reloads on empty input or the address already open', () => {
    expect(normalizeAddressInput('')).toEqual({ kind: 'reload' });
    expect(normalizeAddressInput('   ')).toEqual({ kind: 'reload' });
    const current = 'https://example.com/docs';
    expect(normalizeAddressInput(' https://example.com/docs ', { current })).toEqual({
      kind: 'reload',
    });
    // A bare host that reads as the page already open is a reload too.
    expect(normalizeAddressInput('example.com', { current: 'https://example.com' })).toEqual({
      kind: 'reload',
    });
  });

  it('2. opens https:// and http:// exactly as typed, with no fallback', () => {
    expect(normalizeAddressInput('https://example.com/a?b=1')).toEqual({
      kind: 'open',
      url: 'https://example.com/a?b=1',
    });
    expect(normalizeAddressInput('HTTP://example.com')).toEqual({
      kind: 'open',
      url: 'HTTP://example.com',
    });
  });

  it('3. opens about:blank as a new empty page', () => {
    expect(normalizeAddressInput('about:blank')).toEqual({ kind: 'open', url: 'about:blank' });
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'chrome://settings',
    'mailto:kai@example.com',
    'about:config',
    'blob:https://example.com/1',
    'view-source:https://example.com',
  ])('4. refuses another scheme with a notice (%s)', (typed) => {
    expect(normalizeAddressInput(typed)).toEqual({
      kind: 'refused',
      notice: ADDRESS_NOTICES.otherScheme,
    });
  });

  it.each([
    'file:///Users/kai/notes.html',
    'FILE:///etc/hosts',
    '/tmp/a.html',
    './index.html',
    '../up.html',
    '~/site/index.html',
  ])('4. refuses a file with the files notice (%s)', (typed) => {
    expect(normalizeAddressInput(typed)).toEqual({
      kind: 'refused',
      notice: ADDRESS_NOTICES.file,
    });
  });

  it.each([
    'localhost',
    'localhost:5173',
    'localhost:5173/app?x=1',
    'app.localhost:3000',
    '127.0.0.1',
    '127.4.5.6:8080',
    '[::1]:3000',
    '0.0.0.0:8000',
    '10.0.0.5',
    '172.16.0.1:9000',
    '172.31.255.1',
    '192.168.1.1/admin',
  ])('5. puts http:// in front of this machine or a private address (%s)', (typed) => {
    expect(normalizeAddressInput(typed)).toEqual(http(typed));
  });

  it.each(['8.8.8.8', '172.32.0.1', '203.0.113.9:8443', '[2001:db8::1]', '[2001:db8::1]:8080/x'])(
    '6. puts http:// in front of any other bare IP address (%s)',
    (typed) => {
      expect(normalizeAddressInput(typed)).toEqual(http(typed));
    }
  );

  it.each(['myserver:8080', 'nas:5000/photos', 'dev-box:3000'])(
    '7. puts http:// in front of word:port (%s)',
    (typed) => {
      expect(normalizeAddressInput(typed)).toEqual(http(typed));
    }
  );

  it.each(['how to bake bread', 'node.js tutorial', 'google.com is down', 'localhost 3000'])(
    '8. searches anything with a space (%s)',
    (typed) => {
      expect(normalizeAddressInput(typed)).toEqual(search(typed));
    }
  );

  it.each(['weather', 'dorkos', 'demo/index.html'])(
    '9. searches a word with no dot and no port (%s)',
    (typed) => {
      expect(normalizeAddressInput(typed)).toEqual(search(typed));
    }
  );

  it.each(['google.com', 'www.example.com/docs', 'example.co.uk:8443/a', 'xn--bcher-kva.example'])(
    '10. puts https:// in front of a dotted host with a letters TLD, http:// as the fallback (%s)',
    (typed) => {
      expect(normalizeAddressInput(typed)).toEqual({
        kind: 'open',
        url: `https://${typed}`,
        httpFallback: `http://${typed}`,
      });
    }
  );

  it.each(['1.2', 'version.2', 'a..b', 'kai@example.com', 'foo.-bar.com'])(
    '11. searches anything else (%s)',
    (typed) => {
      expect(normalizeAddressInput(typed)).toEqual(search(typed));
    }
  );

  it.each([
    'Error: ENOENT no such file',
    'python: list comprehension',
    'note: buy milk',
    'javascript: what is a closure',
  ])('searches text that starts like a scheme but has a space (%s)', (typed) => {
    expect(normalizeAddressInput(typed)).toEqual(search(typed));
  });

  it('reads a trailing dot, a non-ASCII host and a leading // as the host they name', () => {
    expect(normalizeAddressInput('example.com.')).toMatchObject({ url: 'https://example.com.' });
    expect(normalizeAddressInput('münchen.de')).toMatchObject({ url: 'https://münchen.de' });
    expect(normalizeAddressInput('//example.com/a')).toMatchObject({
      url: 'https://example.com/a',
    });
  });

  it('searches an IPv4 lookalike out of range, and a port with words after it', () => {
    for (const typed of ['999.1.1.1', 'localhost:3000 foo', 'mybox:80 x']) {
      expect(normalizeAddressInput(typed)).toEqual(search(typed));
    }
  });

  it('says http: or https: missing its // is not complete', () => {
    for (const typed of ['http:/example.com', 'https:example.com']) {
      expect(normalizeAddressInput(typed)).toEqual({
        kind: 'refused',
        notice: ADDRESS_NOTICES.incomplete,
      });
    }
  });

  it('opens local files as typed where local files are allowed (the canvas browser)', () => {
    for (const typed of [
      'file:///proj/index.html',
      '/abs/index.html',
      './index.html',
      '../up.html',
      '~/site/index.html',
      'demo/index.html',
    ]) {
      expect(normalizeAddressInput(typed, { allowLocalPaths: true })).toEqual({
        kind: 'open',
        url: typed,
      });
    }
    // Hosts still read as hosts, and words still search.
    expect(normalizeAddressInput('localhost:3000/a', { allowLocalPaths: true })).toEqual(
      http('localhost:3000/a')
    );
    expect(normalizeAddressInput('weather', { allowLocalPaths: true })).toEqual(search('weather'));
  });

  it('drops the http:// fallback when that one is DorkOS’s own address', () => {
    const isOwnAddress = (url: string) => url.startsWith('http://mybox.lan');
    expect(normalizeAddressInput('mybox.lan', { isOwnAddress })).toEqual({
      kind: 'open',
      url: 'https://mybox.lan',
    });
  });

  it('sends a search to DuckDuckGo with the text as the query', () => {
    const result = normalizeAddressInput('a & b?');
    expect(result.kind).toBe('search');
    const url = new URL((result as { url: string }).url);
    expect(url.origin).toBe('https://duckduckgo.com');
    expect(url.searchParams.get('q')).toBe('a & b?');
  });

  it('says an address is not complete when it cannot be parsed', () => {
    for (const typed of ['http://', 'https://[bad', 'localhost:99999']) {
      expect(normalizeAddressInput(typed)).toEqual({
        kind: 'refused',
        notice: ADDRESS_NOTICES.incomplete,
      });
    }
  });

  it('refuses DorkOS’s own address, however it was typed', () => {
    const isOwnAddress = (url: string) => new URL(url).host === 'localhost:4242';
    for (const typed of ['localhost:4242', 'http://localhost:4242/connections']) {
      expect(normalizeAddressInput(typed, { isOwnAddress })).toEqual({
        kind: 'refused',
        notice: ADDRESS_NOTICES.ownAddress,
      });
    }
    expect(normalizeAddressInput('localhost:5173', { isOwnAddress })).toEqual(
      http('localhost:5173')
    );
  });

  it('never checks a search against the own-address rule', () => {
    const isOwnAddress = () => true;
    expect(normalizeAddressInput('weather', { isOwnAddress })).toEqual(search('weather'));
  });
});

// DOR-3370: the frame fallback must know this app's own server when it sees it,
// under every name the server answers to, or it frames it with same-origin powers.
describe('isThisAppsAddress', () => {
  const local = {
    origin: 'http://localhost:4242',
    hostname: 'localhost',
    port: '4242',
    protocol: 'http:',
  };
  const tunnel = {
    origin: 'https://box.tail.ts.net',
    hostname: 'box.tail.ts.net',
    port: '',
    protocol: 'https:',
  };

  it('knows the page’s own origin', () => {
    expect(isThisAppsAddress('http://localhost:4242/api/health', local)).toBe(true);
    expect(isThisAppsAddress('https://box.tail.ts.net/x', tunnel)).toBe(true);
  });

  it('knows every loopback name for the page’s own port', () => {
    for (const host of ['127.0.0.1', '0.0.0.0', '[::1]', 'app.localhost']) {
      expect(isThisAppsAddress(`http://${host}:4242/`, local)).toBe(true);
    }
  });

  it('treats a relative or unparseable source as the page’s own', () => {
    expect(isThisAppsAddress('/api/files', local)).toBe(true);
    expect(isThisAppsAddress('http://[bad', local)).toBe(true);
  });

  it('leaves another port, and another site, alone', () => {
    expect(isThisAppsAddress('http://localhost:5173/', local)).toBe(false);
    expect(isThisAppsAddress('http://127.0.0.1:4243/', local)).toBe(false);
    expect(isThisAppsAddress('https://example.com/', local)).toBe(false);
    // From a tunnel, localhost:443 is the viewer's own machine, not this app.
    expect(isThisAppsAddress('https://localhost/', tunnel)).toBe(false);
  });

  // DOR-4132: the server answers to more names than the page's own. Made-up addresses.
  const own = ['https://box.tail.ts.net', 'http://192.168.1.20:4242', 'https://hub.example.com'];

  it('knows a trailing-dot loopback name for the page’s own port', () => {
    expect(isThisAppsAddress('http://localhost.:4242/', local)).toBe(true);
    expect(isThisAppsAddress('http://app.localhost.:4242/', local)).toBe(true);
    expect(isThisAppsAddress('http://localhost.:5173/', local)).toBe(false);
  });

  it('knows this server’s own tunnel, Wi-Fi and hub addresses from a local page', () => {
    for (const src of [
      'https://box.tail.ts.net/api/health',
      'http://192.168.1.20:4242/',
      'https://hub.example.com/x',
      'https://BOX.tail.ts.net./x',
    ]) {
      expect(isThisAppsAddress(src, local, own)).toBe(true);
    }
  });

  it('leaves other ports and sites alone when it knows the server’s own addresses', () => {
    expect(isThisAppsAddress('http://192.168.1.20:5173/', local, own)).toBe(false);
    expect(isThisAppsAddress('http://box.tail.ts.net/', local, own)).toBe(false);
    expect(isThisAppsAddress('https://example.com/', local, own)).toBe(false);
  });
});
