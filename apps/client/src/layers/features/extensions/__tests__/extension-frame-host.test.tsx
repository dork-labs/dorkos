import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionManifest } from '@dorkos/extension-api';
import {
  isolatedExtensionModule,
  extensionRequestPath,
  EXTENSION_FRAME_PATH,
  EXTENSION_FRAME_SANDBOX,
} from '../frame/host';

import { setRunningApps } from '../frame/running-apps';

vi.mock('virtual:dorkos-extension-frame', () => ({ default: '' }));
vi.mock('../model/extension-api-url', () => ({ extensionApiUrl: (path: string) => `/api${path}` }));

class FakePort {
  onmessage?: (event: { data: unknown }) => unknown;
  messages: unknown[] = [];
  closed = false;
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  start() {}
  close() {
    this.closed = true;
  }
  async receive(data: unknown) {
    await this.onmessage?.({ data });
  }
}
let port: FakePort;
let stop: undefined | (() => void);
const manifest: ExtensionManifest = {
  id: 'atlas',
  name: 'Atlas',
  version: '1.0.0',
  clientApiVersion: 2,
};
const state = {
  currentCwd: null,
  activeSessionId: null,
  agentId: null,
  requireLogin: false,
  currentProject: null,
};
let api: ExtensionAPI;
let requestId = 0;
async function call(method: string, args: unknown[], extensionId = 'atlas') {
  const id = ++requestId;
  await port.receive({ type: 'call', extensionId, requestId: id, method, args });
  return port.messages.find((message) => (message as { requestId?: number }).requestId === id);
}
async function start(extra: Partial<ExtensionManifest> = {}) {
  const result = isolatedExtensionModule('globalThis.executed = true', {
    ...manifest,
    ...extra,
  }).activate(api);
  await port.receive({ type: 'ready' });
  stop = (await result) || undefined;
}
beforeEach(() => {
  requestId = 0;
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = new FakePort();
      port2 = new FakePort();
      constructor() {
        port = this.port1;
      }
    }
  );
  api = {
    id: 'atlas',
    getState: () => state,
    subscribe: vi.fn(() => vi.fn()),
    isSlotAvailable: vi.fn(() => true),
    registerPage: vi.fn(() => vi.fn()),
    registerComponent: vi.fn(() => vi.fn()),
    registerSettingsTab: vi.fn(() => vi.fn()),
    registerStatusBarItem: vi.fn(() => vi.fn()),
    saveData: vi.fn(),
    loadData: vi.fn(async () => ({ own: true })),
    executeCommand: vi.fn(),
    navigate: vi.fn(),
  } as unknown as ExtensionAPI;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ own: true })))
  );
});
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('isolated app host', () => {
  it('creates a script-only sandbox and never evaluates bundle code in the host', async () => {
    await start();
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe(EXTENSION_FRAME_SANDBOX);
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    // Never a srcdoc frame, which would inherit the shell's 'unsafe-inline' policy:
    // DorkOS's own frame route sends the document and its policy.
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.getAttribute('src')).toBe(`/api${EXTENSION_FRAME_PATH}`);
    expect((globalThis as Record<string, unknown>).executed).toBeUndefined();
    stop?.();
    expect(port.closed).toBe(true);
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('refuses an identity change before executing a scoped write', async () => {
    await start();
    expect(await call('saveData', [{ value: 1 }], 'quill')).toHaveProperty('error');
    expect(fetch).not.toHaveBeenCalled();
    expect(await call('saveData', [{ value: 1 }])).toHaveProperty('value', null);
    expect(fetch).toHaveBeenCalledWith(
      '/api/extensions/atlas/prefs',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ value: 1 }) })
    );
  });
  it('keeps screen data in its own store, never the server half’s ctx.storage (item 7)', async () => {
    await start();
    await call('saveData', [{ theme: 'compact' }]);
    expect(await call('loadData', [])).toHaveProperty('value', { own: true });
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(['/api/extensions/atlas/prefs', '/api/extensions/atlas/prefs']);
    // The /data blob is the server half's storage: the frame never reaches it.
    expect(urls.some((url) => url.endsWith('/data'))).toBe(false);
    expect(api.saveData).not.toHaveBeenCalled();
    expect(api.loadData).not.toHaveBeenCalled();
  });
  it('refuses core commands and raw host fetch operations', async () => {
    await start();
    expect(await call('executeCommand', [{ action: 'open_settings' }])).toHaveProperty('error');
    expect(await call('fetch', ['/api/connectors/mini-app-access/quill/revoke'])).toHaveProperty(
      'error'
    );
    expect(api.executeCommand).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('passes a light or dark switch on to the open frame', async () => {
    await start();
    document.documentElement.className = 'dark';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.messages).toContainEqual({
      type: 'theme',
      theme: { className: 'dark', style: '' },
    });
    document.documentElement.className = '';
  });
  it('hands an app its own route’s failure as status and body, with no headers', async () => {
    await start({ capabilities: { http: true } });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'locked' }), {
        status: 423,
        headers: { 'Set-Cookie': 'session=secret' },
      })
    );
    const reply = await call('request', ['/loop', {}]);
    expect(reply).toMatchObject({ failure: { status: 423, body: { error: 'locked' } } });
    expect(JSON.stringify(reply)).not.toContain('secret');
  });
  it('brings a picture from the app’s own route as a Blob, only with its declared capability', async () => {
    await start();
    expect(await call('media', ['/cover.png'])).toHaveProperty('error');
    expect(fetch).not.toHaveBeenCalled();
    stop?.();
    await start({ capabilities: { http: true } });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } })
    );
    const reply = (await call('media', ['/cover.png'])) as { value: Blob };
    expect(reply.value).toBeInstanceOf(Blob);
    expect(reply.value.type).toBe('image/png');
    expect(fetch).toHaveBeenCalledWith(
      '/api/ext/atlas/cover.png',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-DorkOS-Extension': 'atlas' }),
      })
    );
    expect(await call('media', ['/../quill/cover.png'])).toHaveProperty('error');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  describe('calling another app (DOR-3293)', () => {
    const ledger = {
      id: 'ledger',
      status: 'compiled',
      approvedToRun: true,
      manifest: {
        id: 'ledger',
        name: 'Ledger',
        version: '1.0.0',
        exports: {
          http: [
            { path: '/entries', methods: ['GET'] },
            { path: '/entries/:id', methods: ['GET', 'PATCH'] },
            { path: '/approvals', methods: ['GET'] },
          ],
          personOnly: ['/approve', { path: '/approvals', methods: ['POST'] }],
        },
      },
    };
    beforeEach(() => {
      setRunningApps([ledger] as never);
      // The caller token this frame load is given, then each route's answer.
      vi.mocked(fetch).mockImplementation(async (url) =>
        String(url).endsWith('/extension-frame/caller-token')
          ? new Response(JSON.stringify({ token: `token-${++minted}` }), { status: 201 })
          : new Response(JSON.stringify({ own: true }))
      );
    });
    let minted = 0;
    /** The calls that reached a route, leaving out asking for the token. */
    const routeCalls = () =>
      vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).endsWith('/caller-token'));
    afterEach(() => setRunningApps([]));
    const callsLedger: Partial<ExtensionManifest> = {
      capabilities: { http: { apps: ['ledger'] } },
    };

    it('reaches an exported route with this frame load’s token, asked for once', async () => {
      minted = 0;
      await start(callsLedger);
      expect(await call('request', ['/entries', { app: 'ledger' }])).toHaveProperty('value');
      expect(await call('request', ['/entries/e-1', { app: 'ledger' }])).toHaveProperty('value');
      expect(fetch).toHaveBeenCalledWith(
        '/api/extension-frame/caller-token',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ appId: 'atlas' }) })
      );
      expect(routeCalls()).toHaveLength(2);
      for (const [, init] of routeCalls()) {
        expect(init?.headers).toMatchObject({
          'X-DorkOS-Extension': 'atlas',
          'X-DorkOS-Caller-App': 'atlas',
          'X-DorkOS-Caller-Token': 'token-1',
        });
      }
    });
    it('asks for a new token once when the server has forgotten it', async () => {
      minted = 0;
      let forgotten = true;
      vi.mocked(fetch).mockImplementation(async (url) => {
        if (String(url).endsWith('/caller-token')) {
          return new Response(JSON.stringify({ token: `token-${++minted}` }), { status: 201 });
        }
        if (forgotten) {
          forgotten = false;
          return new Response(JSON.stringify({ code: 'caller_token_invalid' }), { status: 403 });
        }
        return new Response(JSON.stringify({ own: true }));
      });
      await start(callsLedger);
      expect(await call('request', ['/entries', { app: 'ledger' }])).toHaveProperty('value', {
        own: true,
      });
      expect(minted).toBe(2);
    });
    it('refuses a target this app does not list', async () => {
      await start({ capabilities: { http: true } });
      expect(await call('request', ['/entries', { app: 'ledger' }])).toHaveProperty('error');
      expect(fetch).not.toHaveBeenCalled();
    });
    it('refuses a route the target does not export, and a personOnly one', async () => {
      await start(callsLedger);
      expect(await call('request', ['/secrets', { app: 'ledger' }])).toHaveProperty('error');
      expect(await call('request', ['/approve', { app: 'ledger', method: 'POST' }])).toHaveProperty(
        'error'
      );
      expect(fetch).not.toHaveBeenCalled();
    });
    it('sends a read on a path whose write is personOnly, and never the write', async () => {
      await start(callsLedger);
      expect(await call('request', ['/approvals', { app: 'ledger' }])).toHaveProperty('value');
      expect(
        await call('request', ['/approvals', { app: 'ledger', method: 'POST', body: {} }])
      ).toHaveProperty('error');
      expect(routeCalls()).toHaveLength(1);
    });
    it('refuses a write the export does not list', async () => {
      await start(callsLedger);
      expect(
        await call('request', ['/entries', { app: 'ledger', method: 'POST', body: {} }])
      ).toHaveProperty('error');
      expect(
        await call('request', ['/entries/e-17', { app: 'ledger', method: 'PATCH', body: {} }])
      ).toHaveProperty('value');
      expect(routeCalls()).toHaveLength(1);
    });
    it('refuses a target that is not running', async () => {
      setRunningApps([]);
      await start(callsLedger);
      expect(await call('request', ['/entries', { app: 'ledger' }])).toHaveProperty('error');
      expect(fetch).not.toHaveBeenCalled();
    });
    it('never takes a header from the frame, so a forged caller header goes nowhere', async () => {
      await start(callsLedger);
      const forged = { app: 'ledger', headers: { 'X-DorkOS-Caller-App': 'quill' } };
      expect(await call('request', ['/entries', forged])).toHaveProperty('error');
      expect(fetch).not.toHaveBeenCalled();
      // An own call never carries a caller header at all.
      await call('request', ['/loop', { app: 'atlas' }]);
      const [, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(init?.headers).not.toHaveProperty('X-DorkOS-Caller-App');
      expect(init?.headers).not.toHaveProperty('X-DorkOS-Caller-Token');
    });
  });
  it('refuses a room reply or a forward to an app that does not declare them (BRIDGE_WRITES)', async () => {
    await start();
    expect(await call('rooms.reply', ['room-1', 'entry-1', 'hello'])).toHaveProperty('error');
    expect(await call('forward.send', [{ text: 'hi', itemId: 'i' }])).toHaveProperty('error');
  });
  it('refuses prototype names as bridge operations', async () => {
    await start();
    for (const method of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(await call(method, [])).toHaveProperty('error');
    }
  });
  it('binds custom requests to this app and requires its declared capability', async () => {
    await start();
    expect(await call('request', ['/loop', {}])).toHaveProperty('error');
    expect(fetch).not.toHaveBeenCalled();
    stop?.();
    await start({ capabilities: { http: true } });
    expect(await call('request', ['/loop', {}])).toHaveProperty('value', { own: true });
    expect(fetch).toHaveBeenCalledWith(
      '/api/ext/atlas/loop',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-DorkOS-Extension': 'atlas' }),
        method: 'GET',
      })
    );
    for (const path of [
      '/../quill',
      '/%2e%2e/quill',
      '//evil.example',
      '/x/%2f../quill',
      '/loop#x',
    ]) {
      expect(await call('request', [path, {}])).toHaveProperty('error');
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('registers pages, panels, and Activity views using host wrappers', async () => {
    await start();
    const records = [
      { kind: 'page', key: 'page::', id: '', options: { title: 'Atlas' } },
      { kind: 'component', key: 'component:right-panel:tools', id: 'tools', slot: 'right-panel' },
      {
        kind: 'component',
        key: 'component:dashboard.sections:summary',
        id: 'summary',
        slot: 'dashboard.sections',
      },
    ];
    for (const record of records)
      expect(await call('register', [record])).toHaveProperty('value', null);
    expect(api.registerPage).toHaveBeenCalledWith('', expect.any(Function), {
      title: 'Atlas',
      menu: undefined,
    });
    expect(api.registerComponent).toHaveBeenCalledWith(
      'right-panel',
      'tools',
      expect.any(Function),
      {}
    );
    expect(api.registerComponent).toHaveBeenCalledWith(
      'dashboard.sections',
      'summary',
      expect.any(Function),
      {}
    );
    expect(
      await call('register', [{ kind: 'component', key: 'x', id: 'x', slot: 'sidebar.body' }])
    ).toHaveProperty('error');
  });
  it('ignores malformed calls and stops listening after disposal', async () => {
    await start();
    await port.receive({
      type: 'call',
      extensionId: 'atlas',
      requestId: 1,
      method: 'loadData',
      args: [],
      extra: true,
    });
    expect(fetch).not.toHaveBeenCalled();
    stop?.();
    await call('saveData', [{}]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('keeps request paths under their bound app', () => {
  expect(extensionRequestPath('atlas', '/loop?state=open')).toBe('/ext/atlas/loop?state=open');
  expect(() => extensionRequestPath('atlas', '/%2e%2e/quill')).toThrow();
});
