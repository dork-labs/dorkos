import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { assertLocalBrowserUrl, httpFallbackAllowed, navigationRefusal } from '../../errors.js';
import { CLOUD_ORIGIN_REFUSAL } from '@dorkos/shared/cloud-origin';
import { create, selectOwned } from './service.fixtures.js';

describe('the Cloud origin (DOR-3196)', () => {
  const refused = { code: 'cloud_origin', message: CLOUD_ORIGIN_REFUSAL };

  it.each([
    'https://cloud.dorkos.ai/',
    'https://cloud.dorkos.ai/any/path',
    'https://x.cloud.dorkos.ai/',
    'https://dorkos.ai/any/path',
  ])('refuses an agent navigation to %s before it is dispatched', async (target) => {
    const { service, page } = await create();
    await selectOwned(service);
    const observed = await service.observe();
    vi.mocked(page.goto).mockClear();
    await expect(
      service.action({ kind: 'navigate', url: target, revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect(page.goto).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('pauses and never observes when a click lands on the Cloud origin', async () => {
    const { service, click, navigate, page } = await create();
    await selectOwned(service);
    const observed = await service.observe();
    click.mockImplementationOnce(async () => {
      navigate('https://cloud.dorkos.ai/some/page');
      return undefined;
    });
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    vi.mocked(page.evaluateHandle).mockClear();
    await expect(service.observe()).rejects.toMatchObject(refused);
    await expect(service.screenshot()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('refuses an agent navigation that a redirect carries onto the Cloud origin', async () => {
    const { service, page, navigate } = await create();
    await selectOwned(service);
    const observed = await service.observe();
    vi.mocked(page.goto).mockImplementationOnce(async () => {
      navigate('https://app.cloud.dorkos.ai/');
      return null;
    });
    await expect(
      service.action({
        kind: 'navigate',
        url: 'http://fixture.test/redirect',
        revision: observed.revision,
      })
    ).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });

  it('does not observe a page that frames the Cloud origin', async () => {
    const { service, addFrame, page } = await create();
    await selectOwned(service);
    addFrame('https://cloud.dorkos.ai/frame');
    await expect(service.observe()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('never describes a Cloud tab to the agent, even one the person opened', async () => {
    const { service, navigate } = await create();
    await selectOwned(service);
    navigate('https://cloud.dorkos.ai/some/page?token=secret');
    await expect(service.agentState()).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });

  // DOR-4419: the address bar's refusals are UX. With the app's check skipped, a typed
  // refused address sent straight to the person's navigate still never reaches the page.
  it.each([
    'file:///etc/hosts',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'chrome://settings',
    'mailto:kai@example.com',
    'about:config',
  ])('refuses %s from the person even when the app check is bypassed', async (url) => {
    const { service, page } = await create();
    await selectOwned(service);
    vi.mocked(page.goto).mockClear();
    await expect(service.navigate(url)).rejects.toMatchObject({ code: 'unsupported_address' });
    expect(page.goto).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('lets the person open about:blank, and never an agent', async () => {
    const { service, page } = await create();
    await selectOwned(service);
    await service.navigate('about:blank');
    expect(page.goto).toHaveBeenLastCalledWith('about:blank', {
      waitUntil: 'commit',
      timeout: 15_000,
    });
    expect(() => assertLocalBrowserUrl('about:blank', 'agent')).toThrow(
      expect.objectContaining({ code: 'unsupported_address' })
    );
    await service.disconnect();
  });

  // DOR-4450, Security's ruling (Nov 16): which failures may try http:// once, and
  // that every page opened that way says so to the person and to the agent.
  describe('the http:// fallback for a bare host the person typed', () => {
    const failing = (message: string, name?: string) =>
      Object.assign(new Error(`page.goto: ${message}`), name ? { name } : {});
    const gotoUrls = (page: Page) => vi.mocked(page.goto).mock.calls.map(([url]) => url);
    const selectedTab = (state: { tabs: { id: string }[]; selectedTabId: string | null }) =>
      state.tabs.find((tab) => tab.id === state.selectedTabId) as
        { openedOverHttp?: boolean } | undefined;

    // Security's proof for #3859: Playwright's message carries the typed address, so
    // only Chromium's own first error code may decide, never text the person typed.
    describe('reads only the browser’s own error code, never the typed address', () => {
      const typed = 'https://bank.example/?q=net::ERR_CONNECTION_REFUSED';

      it('a certificate error never falls back, whatever the typed URL holds', () => {
        const cert = new Error(`page.goto: net::ERR_CERT_AUTHORITY_INVALID at ${typed}`);
        expect(httpFallbackAllowed(cert, typed)).toBe(false);
        expect(navigationRefusal(cert).code).toBe('navigation_uncertain');
      });

      it('a timeout never falls back, whatever the typed URL holds', () => {
        const timeout = Object.assign(
          new Error(
            `page.goto: Timeout 15000ms exceeded.\nCall log:\n  - navigating to "${typed}", waiting until "commit"\n`
          ),
          { name: 'TimeoutError' }
        );
        expect(httpFallbackAllowed(timeout, typed)).toBe(false);
        expect(navigationRefusal(timeout).code).toBe('navigation_timed_out');
      });

      it('an SSL protocol error on 443 never falls back, whatever the typed URL holds', () => {
        const url = 'https://bank.example/?q=net::ERR_ADDRESS_UNREACHABLE';
        const ssl = new Error(`page.goto: net::ERR_SSL_PROTOCOL_ERROR at ${url}`);
        expect(httpFallbackAllowed(ssl, url)).toBe(false);
      });

      it('a failure with no code of its own never borrows one from the typed URL', () => {
        const crashed = new Error(
          `page.goto: Navigation failed because page crashed!\nCall log:\n  - navigating to "${typed}"\n`
        );
        expect(httpFallbackAllowed(crashed, typed)).toBe(false);
        expect(navigationRefusal(crashed).code).toBe('navigation_uncertain');
      });

      it('a real refusal still falls back when the typed URL holds another code', () => {
        const url = 'https://shop.example/?q=net::ERR_CERT_AUTHORITY_INVALID';
        const refused = new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${url}`);
        expect(httpFallbackAllowed(refused, url)).toBe(true);
      });
    });

    // Every failure that must never try http://: a timeout (the site may just be
    // slow), an SSL error on the https port, a certificate error, an address
    // without the fallback flag (a reload, or one typed with https://), and an
    // address that is already http://.
    it.each([
      [
        'a Playwright timeout',
        'https://slow.example/',
        failing('Timeout 15000ms exceeded.', 'TimeoutError'),
        true,
        'navigation_timed_out',
      ],
      [
        'ERR_CONNECTION_TIMED_OUT',
        'https://slow.example/',
        failing('net::ERR_CONNECTION_TIMED_OUT at https://x/'),
        true,
        'navigation_timed_out',
      ],
      [
        'ERR_TIMED_OUT',
        'https://slow.example/',
        failing('net::ERR_TIMED_OUT at https://x/'),
        true,
        'navigation_timed_out',
      ],
      [
        'an SSL protocol error on https://nas.example/',
        'https://nas.example/',
        failing('net::ERR_SSL_PROTOCOL_ERROR at https://nas.example/'),
        true,
        expect.stringMatching(/^navigation_/),
      ],
      [
        'an SSL protocol error on https://nas.example:443/',
        'https://nas.example:443/',
        failing('net::ERR_SSL_PROTOCOL_ERROR at https://nas.example/'),
        true,
        expect.stringMatching(/^navigation_/),
      ],
      [
        'a certificate error',
        'https://shop.example/',
        failing('net::ERR_CERT_AUTHORITY_INVALID at https://shop.example/'),
        true,
        'navigation_uncertain',
      ],
      [
        'a refusal without the flag',
        'https://shop.example/',
        failing('net::ERR_CONNECTION_REFUSED at https://shop.example/'),
        false,
        'navigation_unreachable',
      ],
      [
        'a refusal of http:// itself',
        'http://shop.example/',
        failing('net::ERR_CONNECTION_REFUSED at http://shop.example/'),
        true,
        'navigation_unreachable',
      ],
    ])('never falls back after %s', async (_name, url, error, httpFallback, code) => {
      const { service, page } = await create();
      await selectOwned(service);
      vi.mocked(page.goto).mockClear();
      vi.mocked(page.goto).mockRejectedValueOnce(error);
      await expect(
        service.navigate(url, httpFallback ? { httpFallback: true } : undefined)
      ).rejects.toMatchObject({ code });
      expect(gotoUrls(page)).toEqual([url]);
      await service.disconnect();
    });

    it('falls back after an SSL protocol error on a port other than 443, and says so', async () => {
      const { service, page } = await create();
      await selectOwned(service);
      vi.mocked(page.goto).mockClear();
      vi.mocked(page.goto).mockRejectedValueOnce(
        failing('net::ERR_SSL_PROTOCOL_ERROR at https://nas.example:5000/')
      );
      const state = await service.navigate('https://nas.example:5000/', { httpFallback: true });
      expect(gotoUrls(page)).toEqual(['https://nas.example:5000/', 'http://nas.example:5000/']);
      expect(selectedTab(state)?.openedOverHttp).toBe(true);
      expect(selectedTab(await service.agentState())?.openedOverHttp).toBe(true);
      await service.disconnect();
    });

    it.each(['ERR_CONNECTION_REFUSED'])(
      'falls back once after %s, and the person and the agent both hear it opened over http',
      async (reason) => {
        const { service, page } = await create();
        await selectOwned(service);
        vi.mocked(page.goto).mockClear();
        vi.mocked(page.goto).mockRejectedValueOnce(
          failing(`net::${reason} at https://shop.example/`)
        );
        const state = await service.navigate('https://shop.example/', { httpFallback: true });
        expect(gotoUrls(page)).toEqual(['https://shop.example/', 'http://shop.example/']);
        expect(selectedTab(state)?.openedOverHttp).toBe(true);
        expect(selectedTab(await service.agentState())?.openedOverHttp).toBe(true);
        expect((await service.observe()).openedOverHttp).toBe(true);
        await service.disconnect();
      }
    );

    it('tries http:// only once, and a page opened over https never says it', async () => {
      const { service, page } = await create();
      await selectOwned(service);
      vi.mocked(page.goto).mockClear();
      vi.mocked(page.goto)
        .mockRejectedValueOnce(failing('net::ERR_CONNECTION_REFUSED at https://shop.example/'))
        .mockRejectedValueOnce(failing('net::ERR_CONNECTION_REFUSED at http://shop.example/'));
      await expect(
        service.navigate('https://shop.example/', { httpFallback: true })
      ).rejects.toMatchObject({ code: 'navigation_unreachable' });
      expect(gotoUrls(page)).toHaveLength(2);
      const state = await service.navigate('https://shop.example/', { httpFallback: true });
      expect(selectedTab(state)?.openedOverHttp).toBeFalsy();
      expect((await service.observe()).openedOverHttp).toBeFalsy();
      await service.disconnect();
    });

    it('never falls back onto this DorkOS app’s own address', async () => {
      const { service, page } = await create(() => ['http://dorkos.example:4242']);
      await selectOwned(service);
      vi.mocked(page.goto).mockClear();
      vi.mocked(page.goto).mockRejectedValueOnce(
        failing('net::ERR_SSL_PROTOCOL_ERROR at https://dorkos.example:4242/')
      );
      await expect(
        service.navigate('https://dorkos.example:4242/', { httpFallback: true })
      ).rejects.toMatchObject({ code: 'navigation_unreachable' });
      expect(gotoUrls(page)).toEqual(['https://dorkos.example:4242/']);
      await service.disconnect();
    });

    it('never falls back for an address an agent opens', async () => {
      const { service, page } = await create();
      vi.mocked(page.goto).mockRejectedValueOnce(
        failing('net::ERR_CONNECTION_REFUSED at https://shop.example/')
      );
      await expect(
        service.open({ mode: 'new-window', url: 'https://shop.example/' })
      ).rejects.toBeDefined();
      expect(gotoUrls(page)).toEqual(['https://shop.example/']);

      const opened = await create();
      await selectOwned(opened.service);
      const observed = await opened.service.observe();
      vi.mocked(opened.page.goto).mockClear();
      vi.mocked(opened.page.goto).mockRejectedValueOnce(
        failing('net::ERR_CONNECTION_REFUSED at https://shop.example/')
      );
      await opened.service
        .action({ kind: 'navigate', url: 'https://shop.example/', revision: observed.revision })
        .catch(() => undefined);
      expect(gotoUrls(opened.page).filter((url) => url.startsWith('http://'))).toEqual([]);
      expect(selectedTab(await opened.service.agentState())?.openedOverHttp).toBeFalsy();
      await opened.service.disconnect();
    });
  });
});
