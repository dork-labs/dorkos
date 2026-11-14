import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { chatToolsFixture } from './chat-tools-fixture.js';

const refusal = {
  payload: {
    code: 'signing_in_elsewhere',
    error:
      'The person is signing in for another chat. Acting is paused until they finish. Reading still works.',
  },
};

it.each(['password', 'wall'] as const)(
  'M1: a %s handoff refuses other chats’ acts but preserves reads and automatic handback',
  async (reason) => {
    const f = await chatToolsFixture();
    try {
      const { handoffId } = (await f.call('ask_person', 'atlas', { reason })) as {
        handoffId: string;
      };
      await expect(
        f.call('act', 'nova', {
          action: { kind: 'navigate', revision: 0, url: 'https://nova.example/popup' },
        })
      ).rejects.toMatchObject(refusal);
      expect(f.pages[1].value.goto).toHaveBeenCalledTimes(1);
      await expect(f.call('state', 'nova')).resolves.toMatchObject({ sessionId: 'nova' });
      await expect(f.call('observe', 'nova')).resolves.toMatchObject({
        url: expect.stringContaining('nova.example'),
      });
      await expect(f.call('screenshot', 'nova')).resolves.toMatchObject({
        image: { mimeType: 'image/png' },
      });
      expect((await f.service.state('nova')).paused).toBe(false);
      await f.service.handover.handBack(handoffId);
      await expect(
        f.call('act', 'nova', {
          action: { kind: 'navigate', revision: 0, url: 'https://nova.example/after' },
        })
      ).resolves.toMatchObject({ tabs: [{ url: 'https://nova.example/after' }] });
    } finally {
      await f.service.disconnect();
    }
  }
);

it('M1: an act waiting on a DOM read is refused before dispatch when another chat takes over', async () => {
  const f = await chatToolsFixture();
  let release!: (snapshot: string) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const observation = (await f.call('observe', 'nova')) as { revision: number; snapshot: string };
    f.pages[1].body.ariaSnapshot.mockImplementationOnce(() => {
      entered();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const effect = vi.fn();
    Object.assign(f.pages[1].value, { mouse: { wheel: effect } });
    const acting = expect(
      f.call('act', 'nova', {
        action: { kind: 'scroll', revision: observation.revision, deltaX: 0, deltaY: 100 },
      })
    ).rejects.toMatchObject(refusal);
    await waiting;
    await f.call('ask_person', 'atlas', { reason: 'password' });
    release(observation.snapshot);
    await acting;
    expect(effect).not.toHaveBeenCalled();
  } finally {
    release?.('');
    await f.service.disconnect();
  }
});

it('S2: every tab audit line marks held state and attributes held visits to no agent', async () => {
  const f = await chatToolsFixture();
  try {
    const { handoffId } = (await f.call('ask_person', 'atlas', { reason: 'password' })) as {
      handoffId: string;
    };
    f.pages[0].navigate('https://person.example/private?token=person-only#secret');
    await f.service.handover.handBack(handoffId);
    f.pages[0].navigate('https://agent.example/after');
    const raw = await readFile(path.join(f.dir, 'local-browser', 'tabs.jsonl'), 'utf8');
    const events = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.every((event) => typeof event.held === 'boolean')).toBe(true);
    expect(events.filter((event) => event.held).every((event) => event.agentId === null)).toBe(
      true
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'origin',
        ownerId: 'atlas',
        agentId: null,
        held: true,
        origin: 'https://person.example',
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'origin',
        ownerId: 'atlas',
        agentId: 'agent-atlas',
        held: false,
        origin: 'https://agent.example',
      })
    );
    expect(raw).not.toMatch(/person-only|private|secret/);
  } finally {
    await f.service.disconnect();
  }
});

it('M1: handoff preparation blocks acts before the held page is ready', async () => {
  const f = await chatToolsFixture();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalState = f.service.state.bind(f.service);
  vi.spyOn(f.service, 'state').mockImplementationOnce(async (sessionId) => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return originalState(sessionId);
  });
  try {
    const asking = f.call('ask_person', 'atlas', { reason: 'password' });
    await waiting;
    await expect(
      f.call('act', 'nova', {
        action: { kind: 'navigate', revision: 0, url: 'https://nova.example/popup' },
      })
    ).rejects.toMatchObject(refusal);
    await expect(f.call('observe', 'nova')).resolves.toMatchObject({
      url: expect.stringContaining('nova.example'),
    });
    expect(f.pages[1].value.goto).toHaveBeenCalledTimes(1);
    release();
    await asking;
  } finally {
    release?.();
    await f.service.disconnect();
  }
});

it('1.11 exposes only a person-facing hold target and shows the held tab without handing it back', async () => {
  const f = await chatToolsFixture();
  try {
    const { handoffId } = (await f.call('ask_person', 'atlas', { reason: 'password' })) as {
      handoffId: string;
    };
    expect(await f.service.handover.state('nova')).toMatchObject({
      sessionId: 'nova',
      handoff: null,
      signInElsewhere: { handoffId },
    });
    expect(await f.service.handover.state()).toMatchObject({
      sessionId: 'atlas',
      handoff: { id: handoffId },
      signInElsewhere: null,
    });
    expect(await f.service.handover.state('atlas')).toMatchObject({ signInElsewhere: null });
    expect(await f.service.handover.state('not-opened')).toMatchObject({ signInElsewhere: null });
    const agent = await f.call('state', 'nova');
    expect(agent).not.toHaveProperty('signInElsewhere');
    expect(agent).not.toHaveProperty('handoffAttached');
    expect(JSON.stringify(agent)).not.toContain(handoffId);
    vi.mocked(f.pages[0].value.bringToFront).mockClear();
    vi.mocked(f.pages[1].value.bringToFront).mockClear();
    await f.service.handover.signIn({ handoffId });
    expect(f.pages[0].value.bringToFront).toHaveBeenCalledOnce();
    expect(f.pages[1].value.bringToFront).not.toHaveBeenCalled();
    await expect(f.call('state', 'atlas')).rejects.toMatchObject({
      payload: { code: 'handed_to_person' },
    });
    await f.service.handover.handBack(handoffId);
    expect(await f.service.handover.state('nova')).toMatchObject({ signInElsewhere: null });
  } finally {
    await f.service.disconnect();
  }
});

it('keeps the global handoff card on its held tab when a handoff starts during the read', async () => {
  const f = await chatToolsFixture();
  const original = f.service.state.bind(f.service);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(f.service, 'state').mockImplementationOnce(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original('nova');
  });
  try {
    const reading = f.service.handover.state();
    await waiting;
    const { handoffId } = (await f.call('ask_person', 'atlas', { reason: 'password' })) as {
      handoffId: string;
    };
    release();
    expect(await reading).toMatchObject({
      sessionId: 'atlas',
      handoff: { id: handoffId },
      handoffAttached: true,
    });
  } finally {
    release?.();
    await f.service.disconnect();
  }
});
