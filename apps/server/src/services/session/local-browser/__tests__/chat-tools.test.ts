import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { invokeCapabilityAsMcpResult } from '../../../core/capabilities/mcp-projection.js';
import { createLocalBrowserDomain } from '../capabilities.js';
import { LocalBrowserService } from '../service.js';
import { chatPagesFixture } from './chat-pages-fixture.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-tools-'));
  directories.push(dir);
  const fake = chatPagesFixture();
  const service = new LocalBrowserService(dir, undefined, fake.backend, undefined, () => ({
    platform: 'darwin',
  }));
  service.useAgentIdentityLookup(async (sessionId) => `agent-${sessionId}`);
  service.handover.useOutsideTurnCheck(async () => false);
  await service.open({
    mode: 'new-window',
    sessionId: 'atlas',
    url: 'https://atlas.example/private?token=made-up-atlas',
  });
  await service.open({
    mode: 'new-window',
    sessionId: 'nova',
    url: 'https://nova.example/private?token=made-up-nova',
  });
  const registry = composeRegistry([createLocalBrowserDomain(service)], { logger: noopLogger });
  const call = (name: string, sessionId: string, input: unknown = {}) =>
    registry.invoke(`local_browser.${name}`, input, { sessionId });
  return { ...fake, service, dir, registry, call };
}

it('Security Must 1: the server chat owns every state, read, screenshot and effect', async () => {
  const f = await fixture();
  const state = await f.call('state', 'atlas', { sessionId: 'nova', tabId: 'nova' });
  expect(state).toMatchObject({
    sessionId: 'atlas',
    tabs: [{ url: 'https://atlas.example/private?token=made-up-atlas' }],
  });
  expect(JSON.stringify(state)).not.toContain('made-up-nova');
  const read = await f.call('observe', 'atlas', { sessionId: 'nova' });
  expect(read).toMatchObject({ url: 'https://atlas.example/private?token=made-up-atlas' });
  await invokeCapabilityAsMcpResult(
    f.registry,
    'local_browser.screenshot',
    {},
    { sessionId: 'atlas' }
  );
  expect(f.pages[0].value.screenshot).toHaveBeenCalledTimes(1);
  expect(f.pages[1].value.screenshot).not.toHaveBeenCalled();
  await f.call('act', 'atlas', {
    action: { kind: 'navigate', revision: 0, url: 'https://atlas.example/next' },
  });
  expect(f.pages[1].value.goto).toHaveBeenCalledTimes(1); // The person's initial open only.
  await expect(f.call('observe', 'unknown')).rejects.toMatchObject({
    payload: { code: 'not_opened' },
  });
  await f.service.disconnect();
});

it('Security Must 2: takeover refuses all tools on that page while another chat keeps browsing', async () => {
  const f = await fixture();
  const { handoffId } = (await f.call('ask_person', 'atlas', { reason: 'password' })) as {
    handoffId: string;
  };
  for (const name of ['state', 'observe', 'screenshot', 'act']) {
    const input =
      name === 'act'
        ? { action: { kind: 'navigate', revision: 0, url: 'https://atlas.example/' } }
        : {};
    await expect(f.call(name, 'atlas', input)).rejects.toMatchObject({
      payload: { code: 'handed_to_person' },
    });
  }
  expect(f.context.close).not.toHaveBeenCalled();
  expect(f.pages[0].value.screenshot).not.toHaveBeenCalled();
  const privateReads = vi.mocked(f.pages[0].value.title).mock.calls.length;
  f.pages[0].navigate('https://private.example/?token=person-only');
  await f.call('state', 'nova');
  await f.call('observe', 'nova');
  await invokeCapabilityAsMcpResult(
    f.registry,
    'local_browser.screenshot',
    {},
    { sessionId: 'nova' }
  );
  expect(f.pages[0].value.title).toHaveBeenCalledTimes(privateReads);
  expect(f.pages[0].value.screenshot).not.toHaveBeenCalled();
  await f.service.handover.handBack(handoffId);
  await expect(f.call('observe', 'atlas')).resolves.toMatchObject({
    url: 'https://private.example/?token=person-only',
  });
  await f.service.disconnect();
});

it('Security Must 3: every page has actor, chat, origins and lifecycle events without URL secrets', async () => {
  const f = await fixture();
  const { handoffId } = (await f.call('ask_person', 'atlas', { reason: 'wall' })) as {
    handoffId: string;
  };
  await f.service.handover.handBack(handoffId);
  await f.service.disconnect();
  const raw = await readFile(path.join(f.dir, 'local-browser', 'tabs.jsonl'), 'utf8');
  expect(raw).not.toContain('token');
  expect(raw).not.toContain('/private');
  const events = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const name of ['atlas', 'nova']) {
    const owned = events.filter((event) => event.ownerId === name);
    expect(owned.some((event) => event.agentId === `agent-${name}` && event.kind === 'bind')).toBe(
      true
    );
    expect(
      owned.some((event) => event.kind === 'origin' && event.origin === `https://${name}.example`)
    ).toBe(true);
    expect(owned.some((event) => event.kind === 'close')).toBe(true);
    expect(owned.every((event) => typeof event.pageId === 'string')).toBe(true);
  }
  expect(events.some((event) => event.kind === 'hold' && event.ownerId === 'atlas')).toBe(true);
  expect(events.some((event) => event.kind === 'hand_back' && event.ownerId === 'atlas')).toBe(
    true
  );
});

it('Security Must 4: outsider handoff holds and the single active handoff stay scoped to pages', async () => {
  const f = await fixture();
  f.service.handover.useOutsideTurnCheck(async (sessionId) => sessionId === 'atlas');
  await expect(f.call('ask_person', 'atlas', { reason: 'wall' })).rejects.toMatchObject({
    payload: { code: 'outside_turn' },
  });
  await expect(f.call('observe', 'nova')).resolves.toMatchObject({
    url: expect.stringContaining('nova.example'),
  });
  const { handoffId } = (await f.call('ask_person', 'nova', { reason: 'wall' })) as {
    handoffId: string;
  };
  await expect(f.call('state', 'nova')).rejects.toMatchObject({
    payload: { code: 'handed_to_person' },
  });
  await expect(f.call('observe', 'atlas')).resolves.toMatchObject({
    url: expect.stringContaining('atlas.example'),
  });
  f.service.handover.useOutsideTurnCheck(async () => false);
  await expect(f.call('ask_person', 'atlas', { reason: 'wall' })).rejects.toMatchObject({
    payload: { code: 'busy' },
  });
  await f.service.handover.stop(handoffId);
  await expect(f.call('observe', 'nova')).rejects.toMatchObject({
    payload: { code: 'task_stopped' },
  });
  await expect(f.call('observe', 'atlas')).resolves.toMatchObject({
    url: expect.stringContaining('atlas.example'),
  });
  await f.service.disconnect();
});

it('a person can explicitly resume a stopped page without granting it automatically', async () => {
  const f = await fixture();
  const { handoffId } = (await f.call('ask_person', 'atlas', { reason: 'wall' })) as {
    handoffId: string;
  };
  await f.service.handover.stop(handoffId);
  await expect(f.call('observe', 'atlas')).rejects.toMatchObject({
    payload: { code: 'task_stopped' },
  });
  await expect(f.call('observe', 'nova')).resolves.toMatchObject({
    url: expect.stringContaining('nova.example'),
  });
  await f.service.handover.resume('atlas');
  await expect(f.call('observe', 'atlas')).resolves.toMatchObject({
    url: expect.stringContaining('atlas.example'),
  });
  await f.service.disconnect();
});
