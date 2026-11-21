import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmPersonPaint, leaseFixture } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup() {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  const page = f.contexts[0].pages[0];
  page.navigate('https://example.com');
  const viewer = await f.service.pageBroker.captureViewerLease('chat-a', {
    ownerId: 'owner',
    appSessionId: 'app',
    clientInstanceId: 'client',
    viewerId: 'viewer',
  });
  return { ...f, page, viewer };
}
function unknownRead(f: Awaited<ReturnType<typeof setup>>, value: unknown, throws: boolean) {
  const attach = vi.mocked(f.contexts[0].context.newCDPSession);
  const original = attach.getMockImplementation()!;
  attach.mockImplementationOnce(async (...args) => {
    const protocol = await original(...args);
    const send = protocol.send.bind(protocol);
    protocol.send = vi.fn(async (method, params) => {
      if (method !== 'Runtime.evaluate') return send(method, params);
      if (throws) throw Error('Made-up protocol read exception');
      return { result: { value } };
    }) as typeof protocol.send;
    return protocol;
  });
}
const unknownCases: [string, unknown, boolean][] = [
  ['extra key', { title: '', text: '', extra: 'PRIVATE' }, false],
  ['wrong shape', { title: 12, text: '' }, false],
  ['oversize title', { title: 'x'.repeat(2049), text: '' }, false],
  ['oversize text', { title: '', text: 'x'.repeat(16385) }, false],
  ['DOM cap returns null', null, false],
  ['read exception', null, true],
];
describe('unknown safety never grants control', () => {
  it.each(unknownCases)(
    'first takeover refuses %s and existing Resume releases custody without a lease',
    async (_name, value, throws) => {
      const f = await setup();
      unknownRead(f, value, throws);
      await expect(f.service.pageBroker.takePersonControl(f.viewer)).rejects.toMatchObject({
        code: 'viewer_unavailable',
      });
      const protocol = f.protocolSessions.at(-1)!;
      await expect(f.observe('chat-a')).rejects.toBeDefined();
      await vi.waitFor(() => expect(protocol.detach).toHaveBeenCalled());
      // This is the same person-owned Resume used by POST /api/local-browser/resume.
      // It takes the selected chat, never a BrowserPersonInputLease.
      const state = await f.service.personSession('chat-a').handover.resume();
      expect(state.paused).toBe(false);
      await expect(f.observe('chat-a')).resolves.toBeDefined();
      expect(f.page.page.keyboard.insertText).not.toHaveBeenCalled();
    }
  );
  it.each(unknownCases)(
    'renewal drops %s without leaving usable person input',
    async (_name, value, throws) => {
      const f = await setup();
      const lease = await f.service.pageBroker.takePersonControl(f.viewer);
      confirmPersonPaint(lease, f.viewer);
      unknownRead(f, value, throws);
      f.page.navigate('https://example.com/next');
      expect(lease.inputReady()).toBe(false);
      await vi.waitFor(() => expect(lease.isCurrent()).toBe(false));
      expect(lease.inputReady()).toBe(false);
      await expect(lease.runPerson({ kind: 'text', text: 'PRIVATE' })).rejects.toBeDefined();
      expect(f.page.page.keyboard.insertText).not.toHaveBeenCalled();
      await expect(f.observe('chat-a')).rejects.toBeDefined();
    }
  );
  it('checks the live site before dispatch even without a main-frame event', async () => {
    const f = await setup();
    const lease = await f.service.pageBroker.takePersonControl(f.viewer);
    confirmPersonPaint(lease, f.viewer);
    const url = vi.spyOn(f.page.page, 'url').mockReturnValue('https://other.com');
    try {
      await expect(lease.runPerson({ kind: 'text', text: 'PRIVATE' })).rejects.toBeDefined();
      expect(f.page.page.keyboard.insertText).not.toHaveBeenCalled();
    } finally {
      url.mockRestore();
    }
  });
});
