/** Inert adapter. Called only inside the live, attested packaged utility custody. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { ChatPage } from '../../../apps/e2e/pages/ChatPage.js';
import { setupOwnedFirstRunUi } from '../../../apps/e2e/pages/local-browser-installed-proof.js';
import { createChromeHost } from './chrome-host.js';
import { runInstalledExistingAcceptance } from './acceptance.js';
import { assertPromptSeed, type createPromptSeed } from './prompt-fixture.js';
import { root } from './options.js';
export interface NativeCustody {
  pid: number;
  base: string;
  renderer: Page;
  guardLog: string;
  attest(): Promise<unknown>;
  noteNativeOpenAttempt(): void;
  stage<T>(run: () => Promise<T>, maximum?: number): Promise<T>;
}
export interface AcceptanceOptions {
  promptSeed: ReturnType<typeof createPromptSeed>;
  sandbox: string;
  fixtureHome: string;
  dataDirectory: string;
  output: string;
  environment: Record<string, string>;
  deadline: number;
  registerClose(close: () => Promise<void>): void;
  record(name: string, value: unknown): void;
}
/** Exercise the installed native service and real scripted tools on the actual renderer. */
export async function runNativeAcceptance(c: NativeCustody, o: AcceptanceOptions) {
  const stage = <T>(label: string, run: () => Promise<T>) =>
    c.stage(
      async () => {
        await c.attest();
        assert(Date.now() < o.deadline, 'Expired native stage: ' + label);
        const value = await run();
        await c.attest();
        return value;
      },
      Math.max(1, o.deadline - Date.now())
    );
  const poll = <T>(label: string, read: () => Promise<T | undefined>) =>
    stage(label, async () => {
      for (;;) {
        const value = await c.stage(read, 2000);
        if (value !== undefined) return value;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });
  await c.attest();
  assert.equal(new URL(c.renderer.url()).origin, c.base);
  const origin = new URL(c.base);
  assert.equal(origin.protocol, 'http:');
  assert(['127.0.0.1', 'localhost'].includes(origin.hostname));
  assert(/^6[0-9]{3}$/.test(origin.port));
  // Keep the actual renderer origin; the shared guarded HTTP helper requires
  // numeric loopback. Both origins bind the same attested utility LISTEN port.
  const apiBase = 'http://127.0.0.1:' + origin.port;
  // Guard renderer mutations too; a revoked inspector/fork fence never admits
  // a fresh UI request. Reads used by attest() use host fetch and cannot recurse.
  const routeGuard = async (route: import('playwright-core').Route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      url.origin === c.base &&
      url.pathname.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
    ) {
      try {
        await c.attest();
      } catch {
        await route.abort();
        return;
      }
    }
    await route.continue();
  };
  await c.renderer.route('**/api/**', routeGuard);
  // Keep this refusal route installed through physical page closure.
  const host = await createChromeHost({
    ...o,
    surface: 'desktop',
    root,
    attest: () => c.attest(),
    stage,
    poll,
  });
  const { fixture, alive, extensionProbe } = host;
  const api = (route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    stage(route, async () => {
      await c.attest();
      if (route === '/api/local-browser/open') {
        c.noteNativeOpenAttempt();
        o.record('nativeOpenAttempt', { utilityPid: c.pid, route, body });
      }
      const response = await fetch(new URL(route, apiBase), {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(45000, o.deadline - Date.now()))),
      });
      assert.equal(response.status, 200, route);
      return response.json();
    });
  // Electron's actual context has no baseURL. This host proxy only resolves
  // POM-relative URLs against the actual renderer; it creates no second page.
  const guardedRequest = (requestBase: string) =>
    new Proxy(c.renderer.request, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          await c.attest();
          if (typeof args[0] === 'string') {
            const url = new URL(args[0], requestBase);
            assert.equal(url.origin, requestBase);
            args[0] = url.href;
          }
          const result = await Reflect.apply(value, target, args);
          await c.attest();
          return result;
        };
      },
    });
  const fixtureRequest = guardedRequest(apiBase),
    pomRequest = guardedRequest(c.base);
  const pomPage = new Proxy(c.renderer, {
    get(target, key) {
      if (key === 'request') return pomRequest;
      if (key === 'goto')
        return (url: string, options?: Parameters<Page['goto']>[1]) =>
          target.goto(new URL(url, c.base).href, options);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let detachedId = '';
  const evidence = await runInstalledExistingAcceptance({
    stage: (_label, run) => stage(_label, run),
    attestInstalledServer: async () => {
      await c.attest();
    },
    createScriptedChat: async () => {
      await api('/api/test/reset', {});
      await setupOwnedFirstRunUi(fixtureRequest, apiBase, o.dataDirectory);
      await c.attest();
      o.record(
        'firstRunPromptAfterSetup',
        assertPromptSeed(await api('/api/config'), o.promptSeed)
      );
      const seeded = await api('/api/test/seed-agent', {});
      assert.equal(
        await realpath(seeded.agentDir),
        await realpath(path.join(o.fixtureHome, 'tmp/dorkos-e2e-agent')),
        'Seed route must use the exact private boundary-derived shared agent'
      );
      const sessionId = randomUUID();
      await api('/api/test/scenario', { name: 'local-browser-driving', sessionId });
      const chat = new ChatPage(pomPage);
      await stage('Actual candidate chat', () =>
        chat.goto(sessionId, { dir: seeded.agentDir, draft: true, runtime: 'test-mode' })
      );
      return {
        sessionId,
        sendAndLand: (text, timeout) => chat.sendAndLand(text, timeout),
        waitForTurnToEnd: (timeout) => chat.waitForTurnToEnd(timeout),
        lastAssistantText: () =>
          c.renderer
            .locator('[data-testid="message-item"][data-role="assistant"]')
            .last()
            .innerText(),
      };
    },
    post: (route, body) => api(route, body),
    beforeAttachUrl: fixture.beforeAttachUrl,
    duringAttachUrl: fixture.duringAttachUrl,
    extensionProbe,
    guardProof: async () => {
      const entries = (await readFile(c.guardLog, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert(entries.every((entry) => entry.pid === c.pid));
      return {
        ownedPortReads: entries.filter((entry) => entry.ownedPortRead).length,
        violations: entries.filter((entry) => entry.violation).length,
      };
    },
    savedCallbacks: fixture.savedCallbacks,
    waitForSavedCallbacks: (count) =>
      poll('Exact fixture Save callbacks', async () => fixture.callbacksAtCount(count)),
    assertOwnedChromeAndTabAlive: async (id) => {
      await alive();
      assert.equal((await api('/api/local-browser/state')).status, 'disconnected');
      detachedId = id;
    },
    humanAfterDetachSameTab: async () => {
      await host.humanAfterDetachSameTab(detachedId);
    },
    assertAfterDetachCookie: async () => fixture.assertAfterDetachCookie(),
  });
  fixture.assertSameTabWitness('during-attach');
  await stage('Actual candidate evidence', () =>
    c.renderer.screenshot({ path: path.join(o.output, 'desktop-native-chat.png') })
  );
  o.record('fixture', fixture.metadata());
  o.record('nativeAcceptance', evidence);
  return {
    ...evidence,
    fixture: fixture.metadata(),
    actualCandidateRenderer: true,
    mappedDiscoveryOnly: true,
    paidInference: false,
  };
}
