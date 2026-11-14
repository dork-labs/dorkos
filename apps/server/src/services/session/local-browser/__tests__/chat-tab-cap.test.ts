import { expect, it, vi } from 'vitest';
import { chatToolsFixture } from './chat-tools-fixture.js';

it('keeps exactly six chat tabs, counting a handoff and ignoring personal pages', async () => {
  const f = await chatToolsFixture();
  try {
    const personal = f.makePage();
    const read = vi.spyOn(personal.value, 'url');
    f.contextEvents.emit('page', personal.value);
    await f.call('ask_person', 'atlas', { reason: 'password' });
    for (const sessionId of ['c3', 'c4', 'c5', 'c6'])
      await f.service.open({ mode: 'new-window', sessionId });
    const count = vi.mocked(f.context.newPage).mock.calls.length;
    await f.service.open({ mode: 'new-window', sessionId: 'c7' });
    expect(await f.service.handover.state('c7')).toMatchObject({ waitingForTab: true });
    for (const verb of ['state', 'observe', 'screenshot', 'act', 'ask_person'])
      await expect(
        f.call(
          verb,
          'c7',
          verb === 'ask_person'
            ? { reason: 'password' }
            : verb === 'act'
              ? { action: { kind: 'navigate', url: 'https://made-up.example/', revision: 0 } }
              : {}
        )
      ).rejects.toMatchObject({
        payload: {
          code: 'tab_limit',
          error:
            'All 6 chat tabs are in use. Wait for one to free up, or ask the person to close one.',
        },
      });
    expect(f.context.newPage).toHaveBeenCalledTimes(count!);
    expect(read).not.toHaveBeenCalled();
    expect(personal.value.title).not.toHaveBeenCalled();
    expect(personal.protocol.send.mock.calls.map(([method]) => method)).not.toContain(
      'Target.getTargetInfo'
    );
    expect(f.pages.slice(0, 6).every((p) => !p.value.isClosed())).toBe(true);
  } finally {
    await f.service.disconnect();
  }
});

it('silently allocates a freed slot to the oldest waiting chat without raising a page', async () => {
  const f = await chatToolsFixture();
  try {
    for (const sessionId of ['c3', 'c4', 'c5', 'c6', 'c7', 'c8'])
      await f.service.open({ mode: 'new-window', sessionId });
    await f.pages[1].value.close();
    await vi.waitFor(async () => expect((await f.service.state('c7')).selectedTabId).toBeTruthy());
    expect((await f.service.handover.state('c7')).waitingForTab).toBe(false);
    expect((await f.service.handover.state('c8')).waitingForTab).toBe(true);
    expect(f.pages.at(-1)!.value.bringToFront).not.toHaveBeenCalled();
    await expect(f.call('state', 'c7')).resolves.toMatchObject({ sessionId: 'c7' });
  } finally {
    await f.service.disconnect();
  }
});

it('offers only the longest-idle chat and rechecks it before a person closes it', async () => {
  const f = await chatToolsFixture();
  const active = new Set(['atlas']);
  f.service.useChatLookup(async (id) => ({ title: `Made-up ${id}`, active: active.has(id) }));
  try {
    for (const sessionId of ['c3', 'c4', 'c5', 'c6', 'c7'])
      await f.service.open({ mode: 'new-window', sessionId });
    const state = await f.service.handover.state('c7');
    expect(state.openChatTabs?.[0]).toMatchObject({
      sessionId: 'atlas',
      title: 'Made-up atlas',
      idle: false,
    });
    expect(state.idleTabToClose).toMatchObject({ sessionId: 'nova', title: 'Made-up nova' });
    expect(JSON.stringify(state.openChatTabs)).not.toContain('/private');
    active.add('nova');
    await expect(f.service.closeIdleTab('nova', 'c7')).rejects.toMatchObject({ code: 'tab_busy' });
    expect(f.pages[1].value.close).not.toHaveBeenCalled();
    active.delete('nova');
    await f.service.closeIdleTab('nova', 'c7');
    expect(f.pages[1].value.close).toHaveBeenCalledOnce();
    expect(f.context.close).not.toHaveBeenCalled();
  } finally {
    await f.service.disconnect();
  }
});

it('keeps a stopped handoff tab in its chat slot until the person closes or returns it', async () => {
  const f = await chatToolsFixture();
  try {
    for (const sessionId of ['c3', 'c4', 'c5', 'c6'])
      await f.service.open({ mode: 'new-window', sessionId });
    const handoff = await f.service.handover.ask('atlas', 'password');
    await f.service.handover.stop(handoff.handoffId);
    await f.service.open({ mode: 'new-window', sessionId: 'c7' });
    expect((await f.service.handover.state('c7')).waitingForTab).toBe(true);
    await f.service.handover.resume('atlas');
    await expect(f.call('state', 'atlas')).resolves.toMatchObject({ sessionId: 'atlas' });
    expect(f.pages[0].value.close).not.toHaveBeenCalled();
  } finally {
    await f.service.disconnect();
  }
});

it('refuses a stale idle-close choice if the person takes that tab during the activity lookup', async () => {
  const f = await chatToolsFixture();
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    for (const sessionId of ['c3', 'c4', 'c5', 'c6', 'c7'])
      await f.service.open({ mode: 'new-window', sessionId });
    f.service.useChatLookup(async (id) => {
      if (id === 'nova') {
        started();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      return { title: `Made-up ${id}`, active: false };
    });
    const closing = f.service.closeIdleTab('nova', 'c7');
    const refused = expect(closing).rejects.toMatchObject({ code: 'tab_busy' });
    await ready;
    await f.service.handover.ask('nova', 'password');
    finish();
    await refused;
    expect(f.pages[1].value.close).not.toHaveBeenCalled();
  } finally {
    finish?.();
    await f.service.disconnect();
  }
});

it('shows the chat tab’s top-level origin rather than an embedded frame’s site', async () => {
  const f = await chatToolsFixture();
  try {
    f.pages[0].events.emit('framenavigated', {
      url: () => 'https://metrics.made-up.example/secret',
    });
    const state = await f.service.handover.state('nova');
    expect(state.openChatTabs?.find((tab) => tab.sessionId === 'atlas')?.origin).toBe(
      'https://atlas.example'
    );
  } finally {
    await f.service.disconnect();
  }
});
