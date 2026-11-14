import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { chatToolsFixture } from './chat-tools-fixture.js';

it('refuses every agent verb on a held sign-in popup and never lists or adopts it', async () => {
  const f = await chatToolsFixture();
  try {
    const handoff = await f.call('ask_person', 'atlas', { reason: 'password' });
    const popup = f.makePage();
    popup.navigate('https://signin.made-up.example/oauth?code=made-up');
    f.pages[0].events.emit('popup', popup.value);
    for (const [verb, input] of [
      ['state', {}],
      ['observe', {}],
      ['screenshot', {}],
      ['act', { action: { kind: 'click', revision: 0, role: 'button', name: 'Sign in' } }],
      [
        'act',
        { action: { kind: 'fill', revision: 0, role: 'textbox', name: 'Email', text: 'made-up' } },
      ],
      ['act', { action: { kind: 'navigate', revision: 0, url: 'https://made-up.example/' } }],
    ] as const)
      await expect(f.call(verb, 'atlas', input)).rejects.toMatchObject({
        payload: { code: 'handed_to_person' },
      });
    expect((await f.service.state('atlas')).tabs).toHaveLength(1);
    expect(popup.value.title).not.toHaveBeenCalled();
    expect(popup.body.ariaSnapshot).not.toHaveBeenCalled();
    expect(popup.value.screenshot).not.toHaveBeenCalled();
    await f.service.handover.handBack((handoff as { handoffId: string }).handoffId);
    expect(popup.value.close).toHaveBeenCalledOnce();
    expect(((await f.call('state', 'atlas')) as { tabs: unknown[] }).tabs).toHaveLength(1);
  } finally {
    await f.service.disconnect();
  }
});

it('blocks all popups outside a handoff, and a second or nested popup during one', async () => {
  const f = await chatToolsFixture();
  try {
    const blocked = f.makePage();
    f.pages[0].events.emit('popup', blocked.value);
    expect(blocked.value.close).toHaveBeenCalledOnce();
    await f.call('ask_person', 'atlas', { reason: 'password' });
    const first = f.makePage();
    const second = f.makePage();
    const nested = f.makePage();
    f.pages[0].events.emit('popup', first.value);
    f.pages[0].events.emit('popup', second.value);
    first.events.emit('popup', nested.value);
    expect(first.value.close).not.toHaveBeenCalled();
    expect(second.value.close).toHaveBeenCalledOnce();
    expect(nested.value.close).toHaveBeenCalledOnce();
  } finally {
    await f.service.disconnect();
  }
});

it.each(['hand-back', 'stop', 'disconnect', 'root-close'] as const)(
  'closes the popup on %s and never focuses it automatically',
  async (end) => {
    const f = await chatToolsFixture();
    try {
      const handoff = await f.service.handover.ask('atlas', 'password');
      const popup = f.makePage();
      f.pages[0].events.emit('popup', popup.value);
      const bPopup = f.makePage();
      f.pages[1].events.emit('popup', bPopup.value);
      expect(bPopup.value.close).toHaveBeenCalledOnce();
      expect(popup.value.bringToFront).not.toHaveBeenCalled();
      expect(bPopup.value.bringToFront).not.toHaveBeenCalled();
      await f.service.handover.signIn({ handoffId: handoff.handoffId });
      expect(popup.value.bringToFront).toHaveBeenCalledOnce();
      if (end === 'hand-back') await f.service.handover.handBack(handoff.handoffId);
      if (end === 'stop') await f.service.handover.stop(handoff.handoffId);
      if (end === 'disconnect') await f.service.handover.disconnect('atlas');
      if (end === 'root-close') await f.pages[0].value.close();
      await vi.waitFor(() => expect(popup.value.close).toHaveBeenCalledOnce());
    } finally {
      await f.service.disconnect();
    }
  }
);

it('records popup lifecycle and origins as person actions without URL secrets', async () => {
  const f = await chatToolsFixture();
  try {
    const h = await f.service.handover.ask('atlas', 'password');
    const popup = f.makePage();
    popup.navigate('https://login.made-up.example/private?code=made-up-secret');
    f.pages[0].events.emit('popup', popup.value);
    await f.service.handover.stop(h.handoffId);
    const rows = (await readFile(path.join(f.dir, 'local-browser/tabs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    const lifecycle = rows.filter((row) => row.kind.startsWith('popup_'));
    expect(lifecycle).toMatchObject([
      {
        kind: 'popup_open',
        agentId: null,
        ownerId: 'atlas',
        origin: 'https://login.made-up.example',
      },
      {
        kind: 'popup_close',
        agentId: null,
        ownerId: 'atlas',
        origin: 'https://login.made-up.example',
      },
    ]);
    expect(JSON.stringify(lifecycle)).not.toContain('made-up-secret');
    expect(JSON.stringify(lifecycle)).not.toContain('/private');
  } finally {
    await f.service.disconnect();
  }
});

it('expires a sign-in child after ten minutes without returning the held tab to the agent', async () => {
  const f = await chatToolsFixture();
  try {
    await f.service.handover.ask('atlas', 'password');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const popup = f.makePage();
    f.pages[0].events.emit('popup', popup.value);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(popup.value.close).toHaveBeenCalledOnce();
    await expect(f.call('state', 'atlas')).rejects.toMatchObject({
      payload: { code: 'handed_to_person' },
    });
  } finally {
    vi.useRealTimers();
    await f.service.disconnect();
  }
});

it('fails a handoff closed if its window policy cannot be installed, without leaving an orphaned hold', async () => {
  const f = await chatToolsFixture();
  try {
    vi.mocked(f.pages[0].value.evaluate).mockRejectedValueOnce(
      new Error('made-up navigation race')
    );
    await expect(f.service.handover.ask('atlas', 'password')).rejects.toThrow(
      'made-up navigation race'
    );
    await expect(f.call('state', 'atlas')).resolves.toMatchObject({ paused: true });
    expect((await f.service.handover.state('nova')).signInElsewhere).toBeNull();
  } finally {
    await f.service.disconnect();
  }
});
