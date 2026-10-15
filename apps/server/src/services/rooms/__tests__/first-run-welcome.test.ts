/**
 * DorkBot's first-run welcome in #team (spec `one-minute-onboarding` §4.2),
 * over the real `RoomService` and a real notification pipeline.
 *
 * The load-bearing claim is that the welcome starts no agent turn and raises no
 * notification, in a room where every agent answers everything. Each "nothing
 * happened" below has a control beside it that shows the same room DOES wake
 * agents and DOES notify for an ordinary post, so the silence is the greeting
 * path and not a room where nothing ever runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserConfigSchema, type UserConfig } from '@dorkos/shared/config-schema';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';

vi.mock('../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));
vi.mock('../../core/config-manager.js', () => ({ configManager: { get: vi.fn(), set: vi.fn() } }));

import { eventFanOut } from '../../core/event-fan-out.js';
import { NotificationStore } from '../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../notifications/notification-service.js';
import { postFirstRunWelcome, type WelcomeDeps } from '../../core/onboarding/welcome.js';
import { RoomError } from '../data/room-errors.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from './room-test-harness.js';

const DORKBOT = '/dork/agents/dorkbot';
const ANA = '/dork/agents/ana';

const agents = agentLookupFor({
  [DORKBOT]: { name: 'dorkbot', displayName: 'DorkBot', responseMode: 'always' },
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

let harness: RoomHarness;
let notifications: NotificationService;
let team: RoomWithRoster;
let config: UserConfig;
let deps: WelcomeDeps;

/** Let the fire-and-forget `notify()` microtasks settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  harness = createRoomHarness({ agents, runner: scriptedRunner(() => 'on it') });
  notifications = new NotificationService(new NotificationStore(harness.db));
  setNotificationService(notifications);
  harness.authors.setHandle(harness.human, 'dorian');
  const { room } = harness.service.ensureSystemChannel(
    'team',
    { slug: 'team', topic: 'You and every agent you run.' },
    harness.human
  );
  for (const agentPath of [DORKBOT, ANA]) {
    const { authorId } = harness.service.addMember(room.id, harness.human, { agentPath });
    // `always`, so "nothing ran" is the greeting path and not a closed window.
    harness.service.updateMembership(room.id, harness.human, authorId, 'always');
  }
  team = harness.service.getRoom(room.id, harness.human)!;
  config = UserConfigSchema.parse({ version: 1 });
  config.onboarding.firstRunPath = 'dorkos';
  deps = {
    config: {
      get: (key) => config[key],
      set: (key, value) => {
        config = { ...config, [key]: value };
      },
    },
    rooms: harness.service,
    dorkbotPath: DORKBOT,
    personName: () => 'Dorian',
  };
});

afterEach(() => {
  setNotificationService(null);
  vi.restoreAllMocks();
});

describe('postFirstRunWelcome', () => {
  it('posts DorkBot’s welcome into #team as DorkBot, and keeps its id', () => {
    const result = postFirstRunWelcome(deps);
    const entries = harness.service.listEntries(team.id, harness.human, { limit: 50 });
    const welcome = entries.find((entry) => entry.id === result.entryId)!;
    const dorkbot = harness.authors.resolveAgent(DORKBOT, 'DorkBot').id;
    expect(result.roomId).toBe(team.id);
    expect(welcome.authorId).toBe(dorkbot);
    expect(welcome.body.text).toBe(
      'Hi Dorian. Your agents run on DorkOS. Usage is in Settings.\n\n' +
        'Want a first tool? Pick one below, or tell me what you need.'
    );
    expect(welcome.mentions).toEqual([]);
    expect(config.onboarding.welcomeEntryId).toBe(result.entryId);
  });

  it('is idempotent: a second call answers with the same entry and posts nothing', () => {
    const first = postFirstRunWelcome(deps);
    const count = harness.service.listEntries(team.id, harness.human, { limit: 50 }).length;
    expect(postFirstRunWelcome(deps)).toEqual(first);
    expect(harness.service.listEntries(team.id, harness.human, { limit: 50 })).toHaveLength(count);
  });

  it('starts no agent turn, in a room where every agent answers everything', async () => {
    // The control: an ordinary post here wakes the agents.
    harness.service.post(team.id, { authorId: harness.human, text: 'morning' });
    await harness.service.triggersIdle();
    const woken = harness.runner!.turns.length;
    expect(woken).toBeGreaterThan(0);

    postFirstRunWelcome(deps);
    await harness.service.triggersIdle();
    expect(harness.runner!.turns).toHaveLength(woken);
  });

  it('raises no notification, even when its words name the person', async () => {
    deps.personName = () => '@dorian';
    const dorkbot = harness.authors.resolveAgent(DORKBOT, 'DorkBot').id;
    // The control: DorkBot naming the person on the ordinary path notifies.
    harness.service.post(team.id, { authorId: dorkbot, text: 'Hi @dorian.' });
    await flush();
    const before = notifications.list({ limit: 25, unread: false }).notifications.length;
    expect(before).toBe(1);

    postFirstRunWelcome(deps);
    await flush();
    expect(notifications.list({ limit: 25, unread: false }).notifications).toHaveLength(before);
  });

  it('says how to connect AI on the no-AI path, and falls back to "there"', () => {
    config.onboarding.firstRunPath = 'none';
    deps.personName = () => null;
    const { entryId } = postFirstRunWelcome(deps);
    const entry = harness.service
      .listEntries(team.id, harness.human, { limit: 50 })
      .find((e) => e.id === entryId)!;
    expect(entry.body.text).toBe('Hi there. Agents need AI to reply. Connect DorkOS or your own.');
  });

  for (const closed of ['completedAt', 'dismissedAt'] as const) {
    it(`refuses once the first run has ${closed} without a welcome`, () => {
      config.onboarding[closed] = '2026-10-01T00:00:00.000Z';
      expect(() => postFirstRunWelcome(deps)).toThrow(/already finished/);
    });
  }

  it('posts anew over a stored id #team does not hold, never handing it to the chips', () => {
    config.onboarding.welcomeEntryId = 'entry-from-somewhere-else';
    const result = postFirstRunWelcome(deps);
    expect(result.entryId).not.toBe('entry-from-somewhere-else');
    expect(harness.service.hasEntry(team.id, result.entryId)).toBe(true);
    expect(config.onboarding.welcomeEntryId).toBe(result.entryId);
  });

  it('marks the welcome as a greeting, which keeps it off chat bridges', () => {
    const { entryId } = postFirstRunWelcome(deps);
    const entry = harness.service
      .listEntries(team.id, harness.human, { limit: 50 })
      .find((e) => e.id === entryId)!;
    expect(entry.body.greeting).toBe('first-run');
  });

  it('asks for the sign-in while an AI app is still waiting for one', () => {
    config.onboarding.firstRunPath = 'own';
    config.onboarding.runtimeDefaultSetAt = null;
    const { entryId } = postFirstRunWelcome(deps);
    const entry = harness.service
      .listEntries(team.id, harness.human, { limit: 50 })
      .find((e) => e.id === entryId)!;
    expect(entry.body.text).toBe('Hi Dorian. Sign in to an AI app to start.');
  });

  it('will not post as an author who is not an agent seated in the room', () => {
    expect(() =>
      harness.service.postAgentGreeting(team.id, {
        authorId: harness.human,
        text: 'hi',
        greeting: 'first-run',
      })
    ).toThrow(RoomError);
    const stranger = harness.authors.resolveAgent('/dork/agents/stranger', 'Stranger').id;
    expect(() =>
      harness.service.postAgentGreeting(team.id, {
        authorId: stranger,
        text: 'hi',
        greeting: 'first-run',
      })
    ).toThrow(RoomError);
  });
});
