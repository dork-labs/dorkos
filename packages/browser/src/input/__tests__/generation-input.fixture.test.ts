import '../../__tests__/native-fixture-preflight.js';
import { createServer } from 'node:http';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { BrowserLifecycleEngine } from '../../index.js';
import { configuration, requestId } from '../../__tests__/lifecycle-fixture.js';
import type { BrowserBinding, BrowserInputStep } from '../../contracts.js';

type Event = { type: string; value: string; key: string; shift: boolean; buttons: number };

it.each(['native-journal', 'legacy-process-fixture'] as const)(
  'serializes genuine input, reset and stale binding refusal with %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'browser-input-private-'));
    const events: Event[] = [];
    const server = createServer((request, response) => {
      if (request.url === '/events') {
        let body = '';
        request.on('data', (bytes) => {
          body += bytes;
        });
        request.on('end', () => {
          events.push(JSON.parse(body));
          response.end();
        });
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><style>body{margin:0}input{width:600px;height:200px}</style><input autofocus><script>
      const input=document.querySelector('input');
      for(const type of ['keydown','keyup','mousedown','mouseup','input'])document.addEventListener(type,event=>{
        fetch('/events',{method:'POST',body:JSON.stringify({type,value:input.value,key:event.key||'',shift:!!event.shiftKey,buttons:event.buttons||0})});
      });
    </script>`);
    });
    let ownedEngine: BrowserLifecycleEngine | undefined;
    let observed = false;
    let primaryFailure = false;
    try {
      const builtRoot = new URL('../../../dist/', import.meta.url);
      const { createBrowserEngine } = (await import(
        new URL('index.js', builtRoot).href
      )) as typeof import('../../index.js');
      const { loadPackagedDarwinJournal } = (await import(
        new URL('runtime/darwin-packaged-observer.js', builtRoot).href
      )) as typeof import('../../runtime/darwin-packaged-observer.js');
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('FIXTURE_ADDRESS_REQUIRED');
      const config = await configuration(
        join(root, 'data'),
        `http://127.0.0.1:${address.port}`,
        true
      );
      let entered: (() => void) | undefined;
      let blocked: Promise<'allowed'> | undefined;
      let authority: 'allowed' | 'refused' = 'allowed';
      config.policy.authorizeAction = async () => {
        if (blocked) {
          const wait = blocked;
          entered?.();
          return wait;
        }
        return authority;
      };
      const engine = createBrowserEngine(
        mode === 'native-journal'
          ? { ...config, nativeJournal: await loadPackagedDarwinJournal() }
          : config
      );
      ownedEngine = engine;
      const opened = await engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
      const command = (binding: BrowserBinding, steps: BrowserInputStep[]) => ({
        kind: 'input',
        requestId,
        binding,
        steps,
      });
      let binding = opened.tab;
      expect(
        await engine.input(command(binding, [{ kind: 'click', x: 100, y: 100, button: 'left' }]))
      ).toMatchObject({ outcome: 'completed' });
      await expect.poll(() => events.filter((event) => event.type === 'mouseup').length).toBe(1);
      let release!: (value: 'allowed') => void;
      let admission!: () => void;
      const admitted = new Promise<void>((resolve) => {
        admission = resolve;
      });
      entered = admission;
      blocked = new Promise((resolve) => {
        release = resolve;
      });
      const first = engine.input(command(binding, [{ kind: 'text', text: 'A' }]));
      await admitted;
      const second = engine.input(command(binding, [{ kind: 'text', text: 'B' }]));
      expect(events.filter((event) => event.type === 'input')).toEqual([]);
      blocked = undefined;
      release('allowed');
      expect(await first).toMatchObject({ outcome: 'completed' });
      expect(await second).toMatchObject({ outcome: 'completed' });
      await expect
        .poll(() => events.filter((event) => event.type === 'input').map((event) => event.value))
        .toEqual(['A', 'AB']);

      expect(
        await engine.input(
          command(binding, [
            { kind: 'keyDown', key: 'Shift' },
            { kind: 'mouseDown', button: 'left' },
          ])
        )
      ).toMatchObject({ outcome: 'completed' });
      await expect
        .poll(() =>
          events.some((event) => event.type === 'mousedown' && event.shift && event.buttons === 1)
        )
        .toBe(true);
      const resetAdmitted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      blocked = new Promise((resolve) => {
        release = resolve;
      });
      const old = engine.input(command(binding, [{ kind: 'text', text: 'OLD' }]));
      await resetAdmitted;
      const queued = engine.input(command(binding, [{ kind: 'text', text: 'QUEUED' }]));
      const started = performance.now();
      const reset = await engine.resetInput(binding);
      expect(reset.status).toBe('ready');
      expect(performance.now() - started).toBeLessThan(2000);
      expect(await old).toMatchObject({ outcome: 'rejected' });
      expect(await queued).toMatchObject({ outcome: 'rejected', reason: 'staleBinding' });
      blocked = undefined;
      release('allowed');
      await expect
        .poll(() =>
          events.some((event) => event.type === 'keyup' && event.key === 'Shift' && !event.shift)
        )
        .toBe(true);
      await expect.poll(() => events.filter((event) => event.type === 'mouseup').length).toBe(2);
      expect(await engine.input(command(binding, [{ kind: 'text', text: 'STALE' }]))).toMatchObject(
        {
          outcome: 'rejected',
          reason: 'staleBinding',
        }
      );
      binding = reset.binding;
      expect(binding.inputGeneration).toBe(opened.tab.inputGeneration + 1);
      expect(binding.epoch).toBe(opened.tab.epoch + 1);
      expect(
        await engine.input(
          command(binding, [
            { kind: 'click', x: 100, y: 100, button: 'left' },
            { kind: 'keyDown', key: 'Enter' },
            { kind: 'keyUp', key: 'Enter' },
            { kind: 'text', text: 'C' },
          ])
        )
      ).toMatchObject({ outcome: 'completed' });
      await expect
        .poll(() => events.filter((event) => event.type === 'input').map((event) => event.value))
        .toEqual(['A', 'AB', 'ABC']);
      expect(
        events.find((event) => event.type === 'keydown' && event.key === 'Enter')
      ).toMatchObject({ shift: false, buttons: 0 });

      const deadlineEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      blocked = new Promise((resolve) => {
        release = resolve;
      });
      const deadlineStart = performance.now();
      const deadlineWork = engine.input(command(binding, [{ kind: 'text', text: 'EXPIRED' }]));
      await deadlineEntered;
      const cancel = new AbortController();
      const cancelled = engine.input(
        command(binding, [{ kind: 'text', text: 'CANCELLED' }]),
        cancel.signal
      );
      cancel.abort();
      expect(await cancelled).toMatchObject({ outcome: 'rejected' });
      expect(await deadlineWork).toMatchObject({ outcome: 'rejected' });
      expect(performance.now() - deadlineStart).toBeLessThan(2300);
      blocked = undefined;
      release('allowed');
      const before = events.length;
      for (const field of [
        'browserGeneration',
        'navigationGeneration',
        'viewportVersion',
        'epoch',
        'inputGeneration',
      ] as const) {
        const stale = { ...binding, [field]: binding[field] + 1 };
        const refused = await Promise.resolve()
          .then(() => engine.input(command(stale, [{ kind: 'text', text: 'WRONG' }])))
          .catch((error: { code: string }) => error);
        expect(refused).toSatisfy(
          (result: { outcome?: string; code?: string }) =>
            result.outcome === 'rejected' || result.code === 'STALE_BINDING'
        );
      }
      const wrongTab = {
        ...binding,
        tabId: 'canonical_tab_wrong_0000000000000' as BrowserBinding['tabId'],
      };
      expect(
        await engine.input(command(wrongTab, [{ kind: 'text', text: 'WRONG' }]))
      ).toMatchObject({
        outcome: 'rejected',
      });
      const wrongBrowser = {
        ...binding,
        browserId: 'browser_wrong_000000000000000000' as BrowserBinding['browserId'],
      };
      await expect(
        Promise.resolve().then(() =>
          engine.input(command(wrongBrowser, [{ kind: 'text', text: 'WRONG' }]))
        )
      ).rejects.toMatchObject({ code: 'STALE_BINDING' });
      authority = 'refused';
      expect(
        await engine.input(command(binding, [{ kind: 'text', text: 'DENIED' }]))
      ).toMatchObject({
        outcome: 'rejected',
        reason: 'policyRefused',
      });
      expect(events.length).toBe(before);
      expect(events.filter((event) => event.type === 'input').map((event) => event.value)).toEqual([
        'A',
        'AB',
        'ABC',
      ]);
      const stopped = await engine.shutdown();
      expect(
        await engine.input(command(binding, [{ kind: 'text', text: 'STOPPED' }]))
      ).toMatchObject({ outcome: 'rejected', reason: 'stopped' });
      expect(events.length).toBe(before);
      expect(stopped).toHaveLength(1);
      expect(stopped[0]).toMatchObject({ cleanup: 'observed' });
      observed = true;
    } catch (error) {
      primaryFailure = true;
      throw error;
    } finally {
      const stopped = ownedEngine ? await ownedEngine.shutdown() : [];
      console.error('Input fixture shutdown:', stopped);
      observed =
        observed || !ownedEngine || (stopped.length === 1 && stopped[0]!.cleanup === 'observed');
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (observed) {
        await rm(root, { recursive: true });
        await expect(access(root)).rejects.toThrow();
      } else console.error('Retained uncertain private input fixture:', root);
      if (!primaryFailure) expect(observed).toBe(true);
    }
  },
  30_000
);
