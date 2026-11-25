import {
  CONFIG_PATH,
  EMPTY_CONFIG,
  NEW_HOOK,
  VALID_CONFIG,
  fakeAdapter,
  freshHarness,
  initAndStart,
  lastSaved,
  mockDeps,
  secretStore,
  withConfig,
  createMockRegistry,
} from './adapter-manager.fixtures.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile, writeFile, rename } from 'node:fs/promises';
import chokidar from 'chokidar';
import { TelegramAdapter } from '@dorkos/relay';
import type { AdapterRegistry } from '@dorkos/relay';
import { AdapterManager, AdapterError } from '../../adapter-manager.js';

/** Make the next TelegramAdapter built behave like `extra` says. */
function nextTelegram(extra: Record<string, unknown>): void {
  vi.mocked(TelegramAdapter).mockImplementationOnce(function (id: string) {
    return fakeAdapter(id, 'relay.human.telegram', { setLogger: vi.fn(), ...extra });
  } as unknown as typeof TelegramAdapter);
}

describe('AdapterManager config and lifecycle', () => {
  let manager: AdapterManager;
  let registry: AdapterRegistry;

  beforeEach(() => {
    ({ manager, registry } = freshHarness());
  });

  it('initialize() starts only the enabled adapters; reload() reconciles a changed file', async () => {
    withConfig(VALID_CONFIG);
    await initAndStart(manager);
    expect(vi.mocked(registry.register).mock.calls.map(([a]) => a.id)).toEqual(['tg-main']);

    const flipped = JSON.parse(VALID_CONFIG);
    flipped.adapters[0].enabled = false;
    flipped.adapters[1].enabled = true;
    withConfig(JSON.stringify(flipped));
    await manager.reload();

    expect(registry.unregister).toHaveBeenCalledWith('tg-main');
    expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'wh-github' }));
  });

  it('enable() and disable() persist the flag and start or stop the adapter', async () => {
    withConfig(VALID_CONFIG);
    await initAndStart(manager);

    await manager.enable('wh-github');
    expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'wh-github' }));
    await manager.disable('tg-main');
    expect(registry.unregister).toHaveBeenCalledWith('tg-main');

    expect(lastSaved().map((a) => [a.id, a.enabled])).toEqual([
      ['tg-main', false],
      ['wh-github', true],
    ]);
  });

  it('answers NOT_FOUND for an id no adapter carries', async () => {
    withConfig(VALID_CONFIG);
    await initAndStart(manager);

    await expect(manager.enable('nope')).rejects.toThrow('Adapter not found: nope');
    await expect(manager.disable('nope')).rejects.toThrow('Adapter not found: nope');
    for (const attempt of [
      () => manager.updateConfig('nope', { key: 'value' }),
      () => manager.updateAdapterLabel('nope', 'x'),
      () => manager.removeAdapter('nope'),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  // DOR-3859: an old chat carried forward at `open` keeps answering while it
  // runs, but turning it back on comes back limited to the people listed.
  it('turns a paused chat that was open to anyone back on at allowlist', async () => {
    withConfig(
      JSON.stringify({
        adapters: [
          {
            id: 'tg-old',
            type: 'telegram',
            enabled: false,
            config: { token: 'bot-token-123', mode: 'polling' },
          },
        ],
      })
    );
    await initAndStart(manager);

    await manager.enable('tg-old');

    expect(lastSaved()[0].config.dmPolicy).toBe('allowlist');
  });

  // The live bot is only rebuilt when it was paused, so closing a running one
  // would save "only people I list" over a bot that still answers anyone.
  it('leaves an open chat that is already on alone when enable() is called again', async () => {
    withConfig(VALID_CONFIG);
    await initAndStart(manager);

    await manager.enable('tg-main');

    expect(lastSaved().find((a) => a.id === 'tg-main')?.config.dmPolicy).toBe('open');
  });

  // Persisting "disabled" and then swallowing a failed stop left the app
  // showing a disabled connection over a bot that was still answering.
  it('surfaces a stop that failed instead of reporting a clean disable', async () => {
    withConfig(VALID_CONFIG);
    const eventRecorder = { insertAdapterEvent: vi.fn() };
    const m = new AdapterManager(registry, CONFIG_PATH, { ...mockDeps, eventRecorder });
    await initAndStart(m);
    vi.mocked(registry.unregister).mockRejectedValueOnce(new Error('poller busy'));

    await expect(m.disable('tg-main')).rejects.toThrow('poller busy');

    expect(eventRecorder.insertAdapterEvent).toHaveBeenCalledWith(
      'tg-main',
      'adapter.error',
      expect.stringContaining('poller busy')
    );
    expect(eventRecorder.insertAdapterEvent).not.toHaveBeenCalledWith(
      'tg-main',
      'adapter.disconnected',
      expect.anything()
    );
  });

  it('masks every secret field, top-level and nested, in listAdapters() and getAdapter()', async () => {
    withConfig(VALID_CONFIG);
    await initAndStart(manager);

    const [tg, wh] = manager.listAdapters();
    expect(tg.config.config).toMatchObject({ token: '***', mode: 'polling' });
    expect(wh.config.config).toEqual({
      inbound: { subject: 'relay.webhook.github', secret: '***' },
      outbound: { url: 'https://example.com/hook', secret: '***' },
    });
    expect(wh.status.state).toBe('disconnected');
    expect(manager.getAdapter('wh-github')).toEqual(wh);
    expect(manager.getAdapter('nonexistent')).toBeUndefined();
  });

  it('does not expose or start an incomplete saved webhook', async () => {
    withConfig(
      JSON.stringify({
        adapters: [{ id: 'wh-flat', type: 'webhook', enabled: true, config: { someKey: 'v' } }],
      })
    );
    await initAndStart(manager);

    expect(manager.listAdapters()).toHaveLength(0);
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('getCatalog() lists the built-ins with each instance, its status and its label', async () => {
    const config = JSON.parse(VALID_CONFIG);
    config.adapters[0].label = 'My Bot';
    withConfig(JSON.stringify(config));
    await initAndStart(manager);

    const catalog = manager.getCatalog();
    expect(catalog.map((e) => e.manifest.type)).toEqual(
      expect.arrayContaining(['telegram', 'webhook', 'claude-code'])
    );
    expect(catalog.find((e) => e.manifest.type === 'claude-code')!.instances).toEqual([]);
    expect(catalog.find((e) => e.manifest.type === 'telegram')!.instances).toEqual([
      expect.objectContaining({
        id: 'tg-main',
        enabled: true,
        label: 'My Bot',
        status: expect.objectContaining({ state: 'connected' }),
      }),
    ]);
  });

  it('shutdown() stops every adapter and the config watcher', async () => {
    withConfig(VALID_CONFIG);
    await initAndStart(manager);
    const watcher = vi.mocked(chokidar.watch).mock.results[0].value;

    await manager.shutdown();

    expect(watcher.close).toHaveBeenCalledOnce();
    expect(registry.shutdown).toHaveBeenCalledOnce();
  });

  describe('setup guides', () => {
    it('reads docs/setup.md into the manifest', async () => {
      vi.mocked(readFile).mockImplementation(async (p: unknown) =>
        String(p).endsWith('setup.md') ? '# Slack Setup' : VALID_CONFIG
      );
      await initAndStart(manager);

      expect(manager.getManifest('slack')?.setupGuide).toBe('# Slack Setup');
    });

    it('does not overwrite an inline guide a plugin brought', async () => {
      vi.mocked(readFile).mockImplementation(async (p: unknown) =>
        String(p).endsWith('setup.md') ? 'Disk guide content' : EMPTY_CONFIG
      );
      manager.registerPluginManifest('custom', {
        type: 'custom',
        displayName: 'Custom',
        description: 'Custom connection',
        category: 'custom',
        builtin: false,
        configFields: [],
        multiInstance: false,
        setupGuide: 'Inline guide content',
      });
      await manager.initialize();

      expect(manager.getManifest('custom')?.setupGuide).toBe('Inline guide content');
    });
  });

  describe('testConnection()', () => {
    beforeEach(async () => {
      withConfig(VALID_CONFIG);
      await initAndStart(manager);
      vi.mocked(registry.register).mockClear();
    });

    it("uses the adapter's own testConnection() without starting or registering it", async () => {
      const start = vi.fn();
      nextTelegram({ start, testConnection: vi.fn().mockResolvedValue({ ok: true }) });

      await expect(manager.testConnection('telegram', { token: 't' })).resolves.toEqual({
        ok: true,
      });
      expect(start).not.toHaveBeenCalled();
      expect(registry.register).not.toHaveBeenCalled();
    });

    it("passes the adapter's failure through", async () => {
      nextTelegram({
        testConnection: vi.fn().mockResolvedValue({ ok: false, error: 'Unauthorized' }),
      });

      await expect(manager.testConnection('telegram', { token: 'bad' })).resolves.toEqual({
        ok: false,
        error: 'Unauthorized',
      });
      await expect(manager.testConnection('nonexistent', {})).resolves.toEqual({
        ok: false,
        error: 'Unknown adapter type: nonexistent',
      });
    });

    it('falls back to start/stop, and always stops, when there is no testConnection()', async () => {
      const okStop = vi.fn().mockResolvedValue(undefined);
      nextTelegram({ stop: okStop });
      await expect(manager.testConnection('telegram', { token: 't' })).resolves.toEqual({
        ok: true,
      });
      expect(okStop).toHaveBeenCalledOnce();

      const failStop = vi.fn().mockResolvedValue(undefined);
      nextTelegram({ start: vi.fn().mockRejectedValue(new Error('fail')), stop: failStop });
      await manager.testConnection('telegram', { token: 't' });
      expect(failStop).toHaveBeenCalledOnce();
    });

    it('times out after 15 seconds if the test hangs, and stops the adapter', async () => {
      vi.useFakeTimers();
      try {
        const stop = vi.fn().mockResolvedValue(undefined);
        nextTelegram({ stop, testConnection: vi.fn().mockReturnValue(new Promise(() => {})) });

        const result = manager.testConnection('telegram', { token: 't' });
        await vi.advanceTimersByTimeAsync(15_000);

        await expect(result).resolves.toEqual({ ok: false, error: 'Connection test timed out' });
        expect(stop).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('addAdapter()', () => {
    it('saves atomically (owner-only tmp file, then rename) and starts the adapter', async () => {
      withConfig(EMPTY_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.addAdapter('webhook', 'wh-new', NEW_HOOK);

      const [tmpPath, , options] = vi.mocked(writeFile).mock.calls[0];
      expect(tmpPath).toMatch(/\.tmp$/);
      expect(options).toEqual({ encoding: 'utf-8', mode: 0o600 });
      expect(rename).toHaveBeenCalledWith(tmpPath, CONFIG_PATH);
      expect(vi.mocked(rename).mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(writeFile).mock.invocationCallOrder[0]
      );
      expect(manager.listAdapters().map((a) => a.config.id)).toEqual(['wh-new']);
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'wh-new' }));
    });

    // DOR-604: a scripted POST with no `dmPolicy` reached disk without the key,
    // which loads back as 'open'.
    it('materializes dmPolicy on write for a Slack connection that did not name one', async () => {
      withConfig(EMPTY_CONFIG);
      await initAndStart(manager);

      await manager.addAdapter(
        'slack',
        'sl-new',
        { botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 'sec' },
        false
      );

      expect(lastSaved()[0].config.dmPolicy).toBe('allowlist');
    });

    it('rejects an entry its schema refuses instead of persisting it', async () => {
      withConfig(EMPTY_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      await expect(manager.addAdapter('slack', 'Bad_ID', { botToken: 'x' }, false)).rejects.toThrow(
        AdapterError
      );
      expect(writeFile).not.toHaveBeenCalled();
    });

    // DOR-2432: a webhook publishes whatever a signed request carries to its
    // inbound subject. An agent with a shell could otherwise aim one at the
    // scheduler's address.
    it.each(['relay.system.tasks.task-1', 'relay.control.task-cancel.run-1', 'relay.*.approval.a'])(
      'refuses a webhook whose inbound subject is the DorkOS address %s, naming the rule',
      async (subject) => {
        withConfig(EMPTY_CONFIG);
        await initAndStart(manager);
        vi.clearAllMocks();

        const attempt = manager.addAdapter('webhook', 'wh-forge', {
          ...NEW_HOOK,
          inbound: { subject, secret: 'secret-16-chars!!' },
        });
        await expect(attempt).rejects.toThrow(AdapterError);
        await expect(attempt).rejects.toThrow(
          'A webhook must use its own address under relay.webhook.'
        );
        // The field's key, for the form to mark; never its value (DOR-4979).
        await expect(attempt).rejects.toMatchObject({ fields: ['inbound.subject'] });
        expect(writeFile).not.toHaveBeenCalled();
        expect(registry.register).not.toHaveBeenCalled();
      }
    );

    it('refuses an edit that points an existing webhook at a DorkOS address', async () => {
      withConfig(EMPTY_CONFIG);
      await initAndStart(manager);
      await manager.addAdapter('webhook', 'wh-edit', NEW_HOOK, false);
      vi.clearAllMocks();

      await expect(
        manager.updateConfig('wh-edit', {
          ...NEW_HOOK,
          inbound: { subject: 'relay.system.approval.agent-1', secret: 'secret-16-chars!!' },
        })
      ).rejects.toThrow('A webhook must use its own address under relay.webhook.');
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('refuses a duplicate id, an unknown type and a second single-instance adapter', async () => {
      const config = JSON.parse(VALID_CONFIG);
      config.adapters.push({ id: 'cc-main', type: 'claude-code', enabled: false, config: {} });
      withConfig(JSON.stringify(config));
      await initAndStart(manager);

      await expect(manager.addAdapter('webhook', 'tg-main', {})).rejects.toMatchObject({
        code: 'DUPLICATE_ID',
      });
      await expect(manager.addAdapter('nonexistent-type', 'x', {})).rejects.toMatchObject({
        code: 'UNKNOWN_TYPE',
      });
      await expect(manager.addAdapter('claude-code', 'cc-second', {})).rejects.toMatchObject({
        code: 'MULTI_INSTANCE_DENIED',
      });
    });

    it('allows a second Telegram bot, listed under the one catalog entry', async () => {
      withConfig(VALID_CONFIG);
      await initAndStart(manager);

      await manager.addAdapter('telegram', 'tg-second', { token: 'tok2', mode: 'polling' });

      const telegram = manager.getCatalog().find((e) => e.manifest.type === 'telegram');
      expect(telegram!.instances.map((i) => i.id)).toEqual(['tg-main', 'tg-second']);
    });

    it('stores a label at the top level, never in the config the adapter is built from', async () => {
      withConfig(EMPTY_CONFIG);
      await initAndStart(manager);
      const built: Record<string, unknown>[] = [];
      vi.mocked(TelegramAdapter).mockImplementationOnce(function (
        id: string,
        cfg: Record<string, unknown>
      ) {
        built.push(cfg);
        return fakeAdapter(id, 'relay.human.telegram', { setLogger: vi.fn() });
      } as unknown as typeof TelegramAdapter);

      await manager.addAdapter('telegram', 'tg-labeled', { token: 'tok' }, true, '@MyBot');

      expect(lastSaved()[0]).toMatchObject({ id: 'tg-labeled', label: '@MyBot' });
      expect(lastSaved()[0].config.label).toBeUndefined();
      expect(built[0]).not.toHaveProperty('label');
    });

    // A start that fails after the save is not "nothing happened": the config is
    // on disk, so a retry would only meet DUPLICATE_ID (review on DOR-4979).
    it('records adapter.error and says it was saved but did not start', async () => {
      withConfig(EMPTY_CONFIG);
      const eventRecorder = { insertAdapterEvent: vi.fn() };
      const failing = createMockRegistry();
      vi.mocked(failing.register).mockRejectedValue(new Error('start failed'));
      const m = new AdapterManager(failing, CONFIG_PATH, { ...mockDeps, eventRecorder });
      await m.initialize();

      await expect(m.addAdapter('webhook', 'wh-fail', NEW_HOOK)).rejects.toMatchObject({
        code: 'START_FAILED',
        adapterId: 'wh-fail',
      });
      expect(m.listAdapters().map((a) => a.config.id)).toContain('wh-fail');
      expect(eventRecorder.insertAdapterEvent).toHaveBeenCalledWith(
        'wh-fail',
        'adapter.error',
        'start failed'
      );
    });
  });

  it('updateAdapterLabel() sets and clears a label, and the catalog follows', async () => {
    withConfig(VALID_CONFIG);
    await initAndStart(manager);

    await manager.updateAdapterLabel('tg-main', 'Production Bot');
    expect(lastSaved()[0].label).toBe('Production Bot');
    expect(
      manager.getCatalog().find((e) => e.manifest.type === 'telegram')!.instances[0].label
    ).toBe('Production Bot');

    await manager.updateAdapterLabel('tg-main', '');
    expect(lastSaved()[0].label).toBeUndefined();
  });

  describe('updateConfig()', () => {
    // The old adapter left the registry before its stop() was awaited, so a
    // Telegram poller that would not die was joined by a second one on the
    // same token, and the chat got every message twice (DOR-789).
    it('does not start a replacement when the running adapter will not stop', async () => {
      withConfig(VALID_CONFIG);
      const eventRecorder = { insertAdapterEvent: vi.fn() };
      const m = new AdapterManager(registry, CONFIG_PATH, { ...mockDeps, eventRecorder });
      await initAndStart(m);
      const registeredBefore = vi.mocked(registry.register).mock.calls.length;
      vi.mocked(registry.unregister).mockRejectedValueOnce(new Error('poller busy'));

      await expect(m.updateConfig('tg-main', { token: 'new', mode: 'webhook' })).rejects.toThrow(
        'poller busy'
      );

      expect(vi.mocked(registry.register).mock.calls.length).toBe(registeredBefore);
      expect(eventRecorder.insertAdapterEvent).toHaveBeenCalledWith(
        'tg-main',
        'adapter.error',
        expect.stringContaining('poller busy')
      );
    });

    it('restarts a running adapter with the new config', async () => {
      withConfig(VALID_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.updateConfig('tg-main', { token: 'new-token', mode: 'polling' });

      expect(registry.unregister).toHaveBeenCalledWith('tg-main');
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'tg-main' }));
    });

    // A masked or blank secret means "keep the one I have". At rest it is a
    // credential reference (DOR-280) that still resolves to the original.
    it.each(['', '***'])('keeps the stored token when %j is submitted', async (token) => {
      withConfig(VALID_CONFIG);
      await initAndStart(manager);

      await manager.updateConfig('tg-main', { token, mode: 'webhook' });

      expect(manager.getAdapter('tg-main')!.config.config).toMatchObject({
        token: '***',
        mode: 'webhook',
      });
      expect(lastSaved()[0].config.token).toBe('file:relay-adapter:tg-main:token');
      expect(secretStore.get('relay-adapter:tg-main:token')).toBe('bot-token-123');
    });

    it('keeps nested secrets too, each as a resolvable reference', async () => {
      withConfig(VALID_CONFIG);
      await initAndStart(manager);

      // Same outbound address; a NEW address carries nothing (DOR-3271).
      await manager.updateConfig('wh-github', {
        inbound: { subject: 'relay.webhook.new', secret: '' },
        outbound: { url: 'https://example.com/hook', secret: '***' },
      });

      const saved = lastSaved().find((a) => a.id === 'wh-github')!;
      expect(saved.config.inbound?.secret).toBe('file:relay-adapter:wh-github:inbound.secret');
      expect(saved.config.outbound?.secret).toBe('file:relay-adapter:wh-github:outbound.secret');
      expect(secretStore.get('relay-adapter:wh-github:inbound.secret')).toBe(
        'a-very-long-secret-16'
      );
      expect(secretStore.get('relay-adapter:wh-github:outbound.secret')).toBe(
        'another-long-secret-16'
      );
    });
  });

  describe('a config that cannot be used', () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    it.each([
      ['missing', () => vi.mocked(readFile).mockRejectedValue(missing)],
      ['malformed', () => withConfig('{ invalid json !!!')],
      [
        'invalid',
        () =>
          withConfig(
            JSON.stringify({ adapters: [{ id: '', type: 'x', enabled: true, config: {} }] })
          ),
      ],
    ])('a %s file leaves an empty list and no crash', async (_name, arrange) => {
      arrange();
      await initAndStart(manager);

      expect(manager.listAdapters()).toHaveLength(0);
      expect(registry.register).not.toHaveBeenCalled();
    });

    it('a dangling credential reference isolates to one adapter: the relay stays up (DOR-280)', async () => {
      withConfig(
        JSON.stringify({
          adapters: [
            {
              id: 'tg-broken',
              type: 'telegram',
              enabled: true,
              config: { token: 'file:relay-adapter:tg-broken:token', mode: 'polling' },
            },
            {
              id: 'tg-ok',
              type: 'telegram',
              enabled: true,
              config: { token: 'bot-token-ok', mode: 'polling' },
            },
          ],
        })
      );
      const eventRecorder = { insertAdapterEvent: vi.fn() };
      const m = new AdapterManager(registry, CONFIG_PATH, { ...mockDeps, eventRecorder });

      await expect(m.initialize()).resolves.toBeUndefined();
      await m.adaptersStarted();

      expect(vi.mocked(registry.register).mock.calls.map(([a]) => a.id)).toEqual(['tg-ok']);
      const errorCall = eventRecorder.insertAdapterEvent.mock.calls.find(
        (c) => c[0] === 'tg-broken' && c[1] === 'adapter.error'
      );
      expect(errorCall![2]).toContain('Failed to resolve credential');
      expect(errorCall![2]).toContain("'token'");
      expect(eventRecorder.insertAdapterEvent).toHaveBeenCalledWith(
        'tg-ok',
        'adapter.connected',
        expect.any(String)
      );
    });
  });
});
