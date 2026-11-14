import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Frame } from 'playwright-core';
import { invokeCapabilityAsMcpResult } from '../../../core/capabilities/mcp-projection.js';
import { chatToolsFixture as fixture } from './chat-tools-fixture.js';

it('Security Must 1: the server chat owns every state, read, screenshot and effect', async () => {
  const f = await fixture();
  const state = await f.call('state', 'atlas', { sessionId: 'nova', tabId: 'nova' });
  expect(state).toMatchObject({
    sessionId: 'atlas',
    tabs: [{ url: 'https://atlas.example/private?token=made-up-atlas' }],
  });
  expect(JSON.stringify(state)).not.toContain('made-up-nova');
  const nova = (await f.call('state', 'nova')) as { selectedTabId: string };
  const forged = { sessionId: 'nova', tabId: nova.selectedTabId, fullPage: true, record: true };
  const read = await f.call('observe', 'atlas', { sessionId: 'nova' });
  expect(read).toMatchObject({ url: 'https://atlas.example/private?token=made-up-atlas' });
  await invokeCapabilityAsMcpResult(f.registry, 'local_browser.screenshot', forged, {
    sessionId: 'atlas',
  });
  expect(f.pages[0].value.screenshot).toHaveBeenCalledTimes(1);
  expect(f.pages[1].value.screenshot).not.toHaveBeenCalled();
  expect(f.pages[0].value.screenshot).toHaveBeenCalledWith({
    type: 'png',
    fullPage: false,
    timeout: 750,
  });
  // No window capture, recording, attachment or tab selection capability exists to bypass ownership.
  expect(f.registry.capabilities.map((capability) => capability.id)).toEqual([
    'local_browser.state',
    'local_browser.observe',
    'local_browser.screenshot',
    'local_browser.act',
    'local_browser.ask_person',
  ]);
  await expect(
    f.call('act', 'atlas', {
      ...forged,
      action: { kind: 'navigate', revision: 0, url: 'https://nova.example/forged' },
    })
  ).rejects.toThrow();
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
  f.pages[0].navigate('https://second.example/private?token=made-up-second#secret');
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
    const pageId = owned.find((event) => event.kind === 'bind')!.pageId;
    expect(events.some((event) => event.pageId === pageId && event.kind === 'open')).toBe(true);
  }
  expect(
    events.some((event) => event.ownerId === 'atlas' && event.origin === 'https://second.example')
  ).toBe(true);
  expect(raw).not.toContain('secret');
  expect(events.some((event) => event.kind === 'hold' && event.ownerId === 'atlas')).toBe(true);
  expect(events.some((event) => event.kind === 'hand_back' && event.ownerId === 'atlas')).toBe(
    true
  );
});

it.each([
  ['https://cloud.dorkos.ai/secret?token=made-up', 'cloud_origin'],
  ['https://app.fixture.example/private', 'dorkos_origin'],
  ['http://localhost:9330/private', 'dorkos_origin'],
  ['https://made-up:made-up@atlas.example/private', 'url_blocked'],
] as const)(
  'Security Must 4: refusing navigation to %s pauses only its chat',
  async (url, code) => {
    const f = await fixture();
    try {
      await expect(
        f.call('act', 'atlas', {
          action: { kind: 'navigate', revision: 0, url },
        })
      ).rejects.toMatchObject({ payload: { code } });
      expect(f.pages[0].value.goto).toHaveBeenCalledTimes(1);
      expect((await f.service.state('atlas')).paused).toBe(true);
      expect((await f.service.state('nova')).paused).toBe(false);
      await expect(f.call('observe', 'nova')).resolves.toMatchObject({
        url: expect.stringContaining('nova.example'),
      });
    } finally {
      await f.service.disconnect();
    }
  }
);

it.each([
  'http://localhost:9331/local',
  'http://127.0.0.1:9331/local',
  'https://app.fixture.example.evil.example/public',
])('Security Must 4: existing site allows keep %s usable in just its chat', async (url) => {
  const f = await fixture();
  try {
    await expect(
      f.call('act', 'atlas', {
        action: { kind: 'navigate', revision: 0, url },
      })
    ).resolves.toMatchObject({ sessionId: 'atlas', tabs: [{ url }] });
    await expect(f.call('observe', 'atlas')).resolves.toMatchObject({ url });
    expect(f.pages[1].value.goto).toHaveBeenCalledTimes(1);
    await expect(f.call('observe', 'nova')).resolves.toMatchObject({
      url: expect.stringContaining('nova.example'),
    });
  } finally {
    await f.service.disconnect();
  }
});

it.each([
  ['https://cloud.dorkos.ai/private?token=made-up-redirect', 'cloud_origin'],
  ['https://app.fixture.example/private?token=made-up-redirect', 'dorkos_origin'],
] as const)(
  'Security Must 4: a tool navigation redirected to %s returns only its refusal',
  async (url, code) => {
    const f = await fixture();
    try {
      vi.mocked(f.pages[0].value.goto).mockImplementationOnce(async (requested) => {
        f.pages[0].navigate(requested);
        f.pages[0].navigate(url);
        return null;
      });
      const result = await invokeCapabilityAsMcpResult(
        f.registry,
        'local_browser.act',
        {
          action: { kind: 'navigate', revision: 0, url: 'https://atlas.example/redirect' },
        },
        { sessionId: 'atlas' }
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).not.toContain('made-up-redirect');
      expect((await f.service.state('atlas')).paused).toBe(true);
      expect((await f.service.state('nova')).paused).toBe(false);
      await expect(f.call('observe', 'nova')).resolves.toMatchObject({
        url: expect.stringContaining('nova.example'),
      });
    } finally {
      await f.service.disconnect();
    }
  }
);

it.each([
  ['https://cloud.dorkos.ai/private', 'cloud_origin'],
  ['view-source:https://app.fixture.example/private', 'dorkos_origin'],
] as const)(
  'Security Must 4: a redirect onto %s refuses every read and effect on only that page',
  async (url, code) => {
    const f = await fixture();
    try {
      f.pages[0].navigate(url);
      for (const name of ['state', 'observe', 'screenshot', 'act']) {
        await expect(
          f.call(
            name,
            'atlas',
            name === 'act'
              ? {
                  action: { kind: 'navigate', revision: 0, url: 'https://atlas.example/next' },
                }
              : {}
          )
        ).rejects.toMatchObject({ payload: { code } });
      }
      expect(f.pages[0].body.ariaSnapshot).not.toHaveBeenCalled();
      expect(f.pages[0].value.screenshot).not.toHaveBeenCalled();
      expect((await f.service.state('atlas')).paused).toBe(true);
      expect((await f.service.state('nova')).paused).toBe(false);
      await expect(f.call('observe', 'nova')).resolves.toMatchObject({
        url: expect.stringContaining('nova.example'),
      });
    } finally {
      await f.service.disconnect();
    }
  }
);

it('Security Must 4: a blocked frame refuses its page without blocking another chat', async () => {
  const f = await fixture();
  try {
    const frame = { url: () => 'https://cloud.dorkos.ai/private?token=made-up-frame' };
    vi.spyOn(f.pages[0].value, 'frames').mockReturnValue([
      f.pages[0].value.mainFrame(),
      frame as Frame,
    ]);
    f.pages[0].events.emit('frameattached', frame);
    await expect(f.call('observe', 'atlas')).rejects.toMatchObject({
      payload: { code: 'cloud_origin' },
    });
    expect(f.pages[0].body.ariaSnapshot).not.toHaveBeenCalled();
    await expect(f.call('observe', 'nova')).resolves.toMatchObject({
      url: expect.stringContaining('nova.example'),
    });
  } finally {
    await f.service.disconnect();
  }
});

it('Security Must 2: a screenshot already in flight returns no image after person takeover', async () => {
  const f = await fixture();
  let finish!: (bytes: Buffer) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const original = await f.pages[0].value.screenshot();
  vi.mocked(f.pages[0].value.screenshot).mockImplementationOnce(async () => {
    started();
    return new Promise<Buffer>((resolve) => {
      finish = resolve;
    });
  });
  const reading = invokeCapabilityAsMcpResult(
    f.registry,
    'local_browser.screenshot',
    {},
    { sessionId: 'atlas' }
  );
  try {
    await ready;
    await f.call('ask_person', 'atlas', { reason: 'password' });
    finish(original);
    const result = await reading;
    expect(result.isError).toBe(true);
    expect(result.content.every((item) => item.type !== 'image')).toBe(true);
    await expect(f.call('observe', 'nova')).resolves.toMatchObject({
      url: expect.stringContaining('nova.example'),
    });
  } finally {
    finish(original);
    await reading;
    await f.service.disconnect();
  }
});

it('Security Must 2: idle and disconnect never regrant the person’s page through tools', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const f = await fixture();
  try {
    await f.call('ask_person', 'atlas', { reason: 'password' });
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    await f.call('state', 'nova');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    for (const name of ['state', 'observe', 'screenshot']) {
      await expect(f.call(name, 'atlas')).rejects.toMatchObject({
        payload: { code: 'handed_to_person' },
      });
    }
    await f.service.handover.disconnect('atlas');
    await expect(f.call('observe', 'atlas')).rejects.toMatchObject({
      payload: { code: 'task_stopped' },
    });
    expect(f.pages[0].value.close).toHaveBeenCalledOnce();
    await invokeCapabilityAsMcpResult(
      f.registry,
      'local_browser.screenshot',
      { sessionId: 'atlas', fullPage: true },
      { sessionId: 'nova' }
    );
    expect(f.pages[0].value.screenshot).not.toHaveBeenCalled();
    expect(f.pages[1].value.screenshot).toHaveBeenCalledOnce();
  } finally {
    await f.service.disconnect();
  }
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
