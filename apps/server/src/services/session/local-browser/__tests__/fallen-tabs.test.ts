import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { getOrCreateProjector, disposeProjector } from '../../session-state-projector.js';
import type { RawSessionEvent } from '../../session-state-projector.js';
import { watchBrowserChatLifecycle } from '../handover/turn-lifecycle.js';
import { chatToolsFixture } from './chat-tools-fixture.js';

it('keeps a stopped handoff attached for 1.7 and refuses every agent verb until hand-back', async () => {
  const f = await chatToolsFixture();
  try {
    const { handoffId } = await f.service.handover.ask('atlas', 'password');
    const ended = vi.fn();
    f.service.handover.useEndListener(ended);
    const stopped = await f.service.handover.stop(handoffId);
    expect(stopped).toMatchObject({
      status: 'connected',
      paused: true,
      handoffAttached: true,
      handoff: { id: handoffId, outcome: 'stopped' },
    });
    for (const verb of ['state', 'observe', 'screenshot', 'act']) {
      await expect(
        f.call(
          verb,
          'atlas',
          verb === 'act'
            ? { action: { kind: 'navigate', revision: 0, url: 'https://atlas.example/' } }
            : {}
        )
      ).rejects.toMatchObject({
        payload: { code: 'task_stopped' },
      });
    }
    f.pages[0].navigate('https://northwind.example/private?token=made-up');
    expect(JSON.stringify(await f.service.handover.state('atlas'))).not.toContain('token');
    const returned = await f.service.handover.handBack(handoffId);
    expect(returned).toMatchObject({ paused: false, handoffAttached: false });
    await expect(f.call('observe', 'atlas')).resolves.toMatchObject({
      url: 'https://northwind.example/private?token=made-up',
    });
    expect(ended).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'handed-back' }), {
      defer: true,
    });
    await expect(f.service.handover.handBack(handoffId)).rejects.toMatchObject({
      code: 'handoff_ended',
    });
    const audit = (await readFile(path.join(f.dir, 'local-browser', 'tabs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit).toContainEqual(
      expect.objectContaining({ kind: 'hand_back', ownerId: 'atlas', held: false })
    );
    expect(f.pages[0].value.close).not.toHaveBeenCalled();
  } finally {
    await f.service.disconnect();
  }
});

it('a fall and hand-back keep the same slot occupied at the six-chat cap', async () => {
  const f = await chatToolsFixture();
  try {
    for (const sessionId of ['c3', 'c4', 'c5', 'c6'])
      await f.service.open({ mode: 'new-window', sessionId });
    const before = await f.service.handover.state('atlas');
    const { handoffId } = await f.service.handover.ask('atlas', 'password');
    await f.service.handover.stop(handoffId);
    await f.service.open({ mode: 'new-window', sessionId: 'c7' });
    expect((await f.service.handover.state('c7')).waitingForTab).toBe(true);
    await f.service.handover.handBack(handoffId);
    expect((await f.service.handover.state('c7')).waitingForTab).toBe(true);
    expect((await f.service.handover.state('atlas')).selectedTabId).toBe(before.selectedTabId);
    expect(f.context.newPage).toHaveBeenCalledTimes(6);
  } finally {
    await f.service.disconnect();
  }
});

it('a chat ending after hand-back falls again without changing another chat’s handoff', async () => {
  const f = await chatToolsFixture();
  try {
    const first = await f.service.handover.ask('atlas', 'password');
    await f.service.handover.handBack(first.handoffId);
    const other = await f.service.handover.ask('nova', 'password');
    await f.service.handover.chatEnded('atlas');
    expect(await f.service.handover.state('atlas')).toMatchObject({
      handoffAttached: true,
      handoff: { sessionId: 'atlas', outcome: 'stopped' },
    });
    expect(await f.service.handover.state('nova')).toMatchObject({
      handoffAttached: true,
      handoff: { id: other.handoffId, outcome: null },
    });
    const fallen = (await f.service.handover.state('atlas')).handoff!;
    await f.service.handover.handBack(fallen.id);
    expect((await f.service.handover.state('nova')).handoff?.outcome).toBeNull();
  } finally {
    await f.service.disconnect();
  }
});

it.each(['error', 'interrupted'] as const)(
  'a runtime %s falls during and after a handoff, with no focus change',
  async (lifecycle) => {
    const f = await chatToolsFixture();
    const unwatch = watchBrowserChatLifecycle(f.service.handover);
    try {
      const focused = vi.mocked(f.pages[0].value.bringToFront).mock.calls.length;
      const first = await f.service.handover.ask('atlas', 'password');
      const projector = getOrCreateProjector('atlas');
      projector.ingest({ type: 'turn_start' });
      projector.ingest({ type: 'status_change', status: { lifecycle } } as RawSessionEvent);
      await vi.waitFor(async () =>
        expect(await f.service.handover.state('atlas')).toMatchObject({
          handoffAttached: true,
          handoff: { outcome: 'stopped' },
        })
      );
      await f.service.handover.handBack(first.handoffId);
      projector.ingest({ type: 'turn_start' });
      projector.ingest({ type: 'status_change', status: { lifecycle } } as RawSessionEvent);
      await vi.waitFor(async () =>
        expect(await f.service.handover.state('atlas')).toMatchObject({
          handoffAttached: true,
          handoff: { outcome: 'stopped' },
        })
      );
      expect(f.pages[0].value.bringToFront).toHaveBeenCalledTimes(focused);
      const fallen = (await f.service.handover.state('atlas')).handoff!;
      await f.service.handover.handBack(fallen.id);
      unwatch();
      projector.ingest({ type: 'turn_start' });
      projector.ingest({ type: 'status_change', status: { lifecycle } } as RawSessionEvent);
      await Promise.resolve();
      expect((await f.service.handover.state('atlas')).handoffAttached).toBe(false);
    } finally {
      unwatch();
      disposeProjector('atlas');
      await f.service.disconnect();
    }
  }
);

it('does not lose a chat failure while the person is handing its tab back', async () => {
  const f = await chatToolsFixture();
  let release!: () => void;
  try {
    const { handoffId } = await f.service.handover.ask('atlas', 'password');
    const resume = f.service.resume.bind(f.service);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(f.service, 'resume').mockImplementationOnce(async (sessionId) => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return resume(sessionId);
    });
    const back = f.service.handover.handBack(handoffId);
    await ready;
    await f.service.handover.chatEnded('atlas');
    release();
    await back;
    await vi.waitFor(async () =>
      expect(await f.service.handover.state('atlas')).toMatchObject({
        handoffAttached: true,
        handoff: { outcome: 'stopped' },
      })
    );
    await expect(f.call('observe', 'atlas')).rejects.toMatchObject({
      payload: { code: 'task_stopped' },
    });
  } finally {
    release?.();
    vi.restoreAllMocks();
    await f.service.disconnect();
  }
});

it('normal completion stays waiting, and closing a fallen tab really releases its slot', async () => {
  const f = await chatToolsFixture();
  const unwatch = watchBrowserChatLifecycle(f.service.handover);
  try {
    const { handoffId } = await f.service.handover.ask('atlas', 'password');
    const projector = getOrCreateProjector('atlas');
    projector.ingest({ type: 'turn_start' });
    projector.ingest({ type: 'turn_end' });
    expect((await f.service.handover.state('atlas')).handoff?.outcome).toBeNull();
    await f.service.handover.stop(handoffId);
    await f.service.handover.disconnect('atlas');
    expect((await f.service.handover.state('atlas')).handoffAttached).toBe(false);
    expect(f.pages[0].value.close).toHaveBeenCalledOnce();
    await expect(f.service.handover.handBack(handoffId)).rejects.toMatchObject({
      code: 'handoff_ended',
    });
  } finally {
    unwatch();
    disposeProjector('atlas');
    await f.service.disconnect();
  }
});

it('retains a failure that arrives while preparing the first handoff', async () => {
  const f = await chatToolsFixture();
  let release!: () => void;
  try {
    const hold = f.service.handToPerson.bind(f.service);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(f.service, 'handToPerson').mockImplementationOnce(async (sessionId) => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return hold(sessionId);
    });
    const asking = f.service.handover.ask('atlas', 'password');
    await ready;
    await f.service.handover.chatEnded('atlas');
    release();
    await asking;
    await vi.waitFor(async () =>
      expect(await f.service.handover.state('atlas')).toMatchObject({
        handoffAttached: true,
        handoff: { outcome: 'stopped' },
      })
    );
    await expect(f.call('observe', 'atlas')).rejects.toMatchObject({
      payload: { code: 'task_stopped' },
    });
  } finally {
    release?.();
    vi.restoreAllMocks();
    await f.service.disconnect();
  }
});
