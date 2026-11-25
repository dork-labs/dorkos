import { describe, it, expect, afterEach, vi } from 'vitest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import {
  ConfigManager,
  backfillRoomsDefaults,
  backfillWelcomeBackDefaults,
  CONFIG_MIGRATIONS,
  seedCommunityNavigationPrefs,
  raiseEngagedWindowDefaults,
  seedSpacesOfficial,
} from '../../config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMockStore, upgradeConfigFile } from './config-manager.fixtures.js';

describe('seedCommunityNavigationPrefs migration (community-switcher-navigation 1.2)', () => {
  it('adds the versioned block without replacing existing ui preferences', () => {
    let ui: unknown = { theme: 'dark', composer: { richText: false } };
    const store = {
      get: vi.fn(() => ui),
      set: vi.fn((_key: string, value: unknown) => {
        ui = value;
      }),
    };

    seedCommunityNavigationPrefs(store);

    expect(ui).toEqual({
      theme: 'dark',
      composer: { richText: false },
      communityNavigation: { version: 1, owners: [] },
    });
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it('is idempotent and preserves an existing owner history', () => {
    const ui = {
      theme: 'system',
      communityNavigation: {
        version: 1,
        owners: [{ ownerKey: 'owner-a', order: ['community_a'], destinations: [] }],
      },
    };
    const store = { get: vi.fn(() => ui), set: vi.fn() };

    seedCommunityNavigationPrefs(store);
    seedCommunityNavigationPrefs(store);

    expect(store.set).not.toHaveBeenCalled();
  });
});

describe('backfillRoomsDefaults migration (room cascade ceiling, DOR-526)', () => {
  it('seeds the section on a config persisted before it existed', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillRoomsDefaults(store);
    // Pinned to the literal the release ships. Reading the default out of the
    // schema here would only prove the migration and the schema agree, never
    // that they agree on a number that bounds anything.
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 3,
      maxAutomaticTurnsPerRoomPerHour: 60,
      maxAutomaticTurnsTotalPerHour: 240,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('is idempotent — keeps a ceiling the user already chose', () => {
    const store = createMockStore({
      rooms: {
        maxAgentDepth: 1,
        maxAutomaticTurnsPerRoomPerHour: 5,
        maxAutomaticTurnsTotalPerHour: 9,
      },
    });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 1,
      maxAutomaticTurnsPerRoomPerHour: 5,
      maxAutomaticTurnsTotalPerHour: 9,
      // Untouched above, seeded here: the two wait bounds are new keys on a
      // block that predates them, which is the additive half of the same rule.
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('keeps an explicit zero, which is a real choice and not an absent section', () => {
    const store = createMockStore({
      rooms: {
        maxAgentDepth: 0,
        maxAutomaticTurnsPerRoomPerHour: 0,
        maxAutomaticTurnsTotalPerHour: 0,
      },
    });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 0,
      maxAutomaticTurnsPerRoomPerHour: 0,
      maxAutomaticTurnsTotalPerHour: 0,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('adds both spend caps to a rooms block that predates them', () => {
    // The upgrade that matters: someone already had `rooms` from an earlier
    // build of this feature, so conf's shallow merge would never give them the
    // caps. Without this they would run with no posture-independent bound.
    const store = createMockStore({ rooms: { maxAgentDepth: 1 } });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 1,
      maxAutomaticTurnsPerRoomPerHour: 60,
      maxAutomaticTurnsTotalPerHour: 240,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('adds the engaged-window ceilings to a rooms block that predates them', () => {
    // The upgrade that matters for RP4: `engaged` becomes the channel default in
    // the same release, so an install whose `rooms` block was written before
    // these keys existed would run the new mode with no window bounding it at
    // all — conf's shallow merge never reaches a nested key on a block already
    // on disk. A shorter window somebody chose survives, because the backfill
    // only fills what is absent.
    const store = createMockStore({ rooms: { maxAgentDepth: 3, engagedWindowMinutes: 2 } });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 3,
      maxAutomaticTurnsPerRoomPerHour: 60,
      maxAutomaticTurnsTotalPerHour: 240,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 2,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('carries a chosen value across the per-hour cap rename, rather than resetting it', () => {
    // `maxAutomaticTurnsPerHour` only existed on unreleased builds, and was split
    // into a per-room and a total cap. Anyone running one of those builds has
    // picked a number; silently resetting it to the default would be the kind of
    // quiet data loss a migration is supposed to prevent, and leaving the key in
    // place would make the schema reject the whole config.
    const store = createMockStore({ rooms: { maxAgentDepth: 2, maxAutomaticTurnsPerHour: 7 } });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 2,
      maxAutomaticTurnsPerRoomPerHour: 7,
      maxAutomaticTurnsTotalPerHour: 240,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });
});

describe('backfillWelcomeBackDefaults migration (team-room-home D5.2)', () => {
  it('seeds the section on a config persisted before it existed', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillWelcomeBackDefaults(store);
    // Pinned to the literals the release ships. Reading them out of the schema
    // would only prove the migration and the schema agree, never that they
    // agree on numbers that bound anything.
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });

  it('is idempotent — a second run keeps what the first wrote', () => {
    const store = createMockStore({});
    backfillWelcomeBackDefaults(store);
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });

  it('never clobbers a value the person chose', () => {
    const store = createMockStore({
      welcomeBack: { enabled: false, absenceThresholdMinutes: 720, maxPosts: 1 },
    });
    backfillWelcomeBackDefaults(store);
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: false,
      absenceThresholdMinutes: 720,
      maxPosts: 1,
      offersEnabled: true,
    });
  });

  it('keeps an explicit off, which is a real choice and not an absent section', () => {
    // The failure that would matter most: someone turned the greetings off, and
    // a `!has` guard on the SECTION would leave that alone, while a truthiness
    // check on the VALUE would hand them back a greeting they refused.
    const store = createMockStore({ welcomeBack: { enabled: false } });
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: false,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });

  it('keeps an explicit zero cap for the same reason', () => {
    const store = createMockStore({ welcomeBack: { maxPosts: 0 } });
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 0,
      offersEnabled: true,
    });
  });

  it('never turns off an offers opt-in somebody paid for', () => {
    // The one leaf here that costs money. Somebody who turned offers ON said
    // yes to a model turn per greeting agent; an upgrade that quietly seeded
    // `false` over it would take that back without asking, and the person would
    // notice only by the offers no longer arriving.
    const store = createMockStore({ welcomeBack: { offersEnabled: true } });
    backfillWelcomeBackDefaults(store);
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });

  it('never turns offers back ON for somebody who switched them off (DOR-1121)', () => {
    // The mirror, and the one that matters now that the seed is `true`: an
    // explicit `false` is a value, not an absence, so the fill-if-missing rule
    // must not see a gap where a refusal is. Getting this wrong would bill
    // somebody who had said no, once per return, and the only signal would be
    // offers reappearing.
    const store = createMockStore({ welcomeBack: { offersEnabled: false } });
    backfillWelcomeBackDefaults(store);
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: false,
    });
  });

  it('fills only the missing keys of a block written by an earlier build', () => {
    // conf merges top-level defaults SHALLOWLY, so a `welcomeBack` block already
    // on disk never gains a new nested key on its own. Without this, an install
    // upgraded mid-feature would run returns with no post cap at all — and, since
    // DOR-1046, with no answer at all to whether offers may spend a turn.
    const store = createMockStore({ welcomeBack: { enabled: true } });
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });
});

describe('welcomeBack on a config written before it existed (real conf + Ajv)', () => {
  // The half of the surface the mock store cannot answer: correctness must NOT
  // depend on the migration having run. A dev tree resolves SERVER_VERSION to
  // 0.0.0 and runs no migrations at all, and a release below the migration key
  // would skip it for everybody — so the Zod defaults have to produce a valid,
  // fully-populated section on their own.
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A config file holding a realistic pre-welcomeBack blob. */
  function seedPreWelcomeBack(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-welcome-back-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        server: { port: 4242, cwd: null, boundary: null, open: true },
        rooms: {
          maxAgentDepth: 3,
          maxAutomaticTurnsPerRoomPerHour: 60,
          maxAutomaticTurnsTotalPerHour: 240,
          replyWaitMinutes: 10,
          lateReplyCeilingMinutes: 60,
          engagedWindowMinutes: 10,
          engagedWindowPosts: 5,
        },
        __internal__: { migrations: { version: '0.57.0' } },
      })
    );
    return dir;
  }

  it('reads back the shipped defaults with no migration having run', () => {
    const manager = new ConfigManager(seedPreWelcomeBack());
    expect(manager.get('welcomeBack')).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('is written through explicitly once the migration applies to the same file', () => {
    const dir = seedPreWelcomeBack();
    const configPath = path.join(dir, 'config.json');
    const store = {
      get: (key: string) =>
        (JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>)[key],
      set: (key: string, value: unknown) => {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        raw[key] = value;
        fs.writeFileSync(configPath, JSON.stringify(raw));
      },
    };
    CONFIG_MIGRATIONS['0.59.0'](store);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
    expect(new ConfigManager(dir).validate()).toEqual({ valid: true });
  });

  it('refuses an absence shorter than the floor and a cap past the ceiling', () => {
    // The bounds are the honest part of the schema: below a quarter of an hour
    // is a coffee, not an absence, and a return that could post eleven times is
    // the noise the whole feature exists to avoid.
    expect(
      UserConfigSchema.safeParse({ version: 1, welcomeBack: { absenceThresholdMinutes: 14 } })
        .success
    ).toBe(false);
    expect(
      UserConfigSchema.safeParse({ version: 1, welcomeBack: { absenceThresholdMinutes: 10_081 } })
        .success
    ).toBe(false);
    expect(UserConfigSchema.safeParse({ version: 1, welcomeBack: { maxPosts: 11 } }).success).toBe(
      false
    );
    expect(UserConfigSchema.safeParse({ version: 1, welcomeBack: { maxPosts: -1 } }).success).toBe(
      false
    );
    expect(
      UserConfigSchema.safeParse({ version: 1, welcomeBack: { absenceThresholdMinutes: 90.5 } })
        .success
    ).toBe(false);
    // The edges themselves are legal.
    expect(
      UserConfigSchema.safeParse({
        version: 1,
        welcomeBack: { absenceThresholdMinutes: 15, maxPosts: 0 },
      }).success
    ).toBe(true);
  });
});

describe('raiseEngagedWindowDefaults migration (DOR-2823)', () => {
  /** Run the real upgrade to `'0.103.0'` over a stored `rooms` block. */
  function upgrade(rooms: Record<string, unknown>): { rooms: Record<string, unknown> } {
    return upgradeConfigFile({ rooms }, '0.102.0', '0.103.0');
  }

  it('raises a window still at the old shipped defaults', () => {
    // READ THE FILE: `rooms` is a section a stored config already has, so the
    // shallow default merge never reaches these leaves. Suppress the body and
    // this goes red.
    const onDisk = upgrade({ engagedWindowMinutes: 10, engagedWindowPosts: 5 });
    expect(onDisk.rooms.engagedWindowMinutes).toBe(60);
    expect(onDisk.rooms.engagedWindowPosts).toBe(15);
  });

  it('keeps numbers a person chose, including turning the window off', () => {
    expect(upgrade({ engagedWindowMinutes: 60, engagedWindowPosts: 15 }).rooms).toMatchObject({
      engagedWindowMinutes: 60,
      engagedWindowPosts: 15,
    });
    expect(upgrade({ engagedWindowMinutes: 0, engagedWindowPosts: 3 }).rooms).toMatchObject({
      engagedWindowMinutes: 0,
      engagedWindowPosts: 3,
    });
  });

  it('fills a window a stored rooms block never had', () => {
    const onDisk = upgrade({ replyWaitMinutes: 10 });
    expect(onDisk.rooms.engagedWindowMinutes).toBe(60);
    expect(onDisk.rooms.engagedWindowPosts).toBe(15);
    expect(onDisk.rooms.replyWaitMinutes).toBe(10);
  });

  it('is idempotent', () => {
    // The mock store is flat, so the dotted keys the body reads are the keys.
    const store = createMockStore({
      rooms: {},
      'rooms.engagedWindowMinutes': 10,
      'rooms.engagedWindowPosts': 5,
    });
    raiseEngagedWindowDefaults(store);
    raiseEngagedWindowDefaults(store);
    expect(store.data).toMatchObject({
      'rooms.engagedWindowMinutes': 60,
      'rooms.engagedWindowPosts': 15,
    });
    expect(store.writes).toHaveLength(2);
  });
});

describe('seedSpacesOfficial migration (spec official-community-space D4)', () => {
  /** Run the real upgrade to `'0.107.0'` over a file last written at 0.106.0. */
  function upgrade(spaces: Record<string, unknown>): {
    spaces: { enabled: unknown; official?: { url: unknown } };
  } {
    return upgradeConfigFile({ spaces }, '0.106.0', '0.107.0');
  }

  it('writes an empty link into a stored spaces block that predates it', () => {
    // READ THE FILE: `spaces` is a section a stored config already has, so
    // conf's shallow default merge never adds this leaf. Suppress the body and
    // this goes red.
    const onDisk = upgrade({ enabled: true });
    expect(onDisk.spaces.official).toEqual({ url: '' });
    expect(onDisk.spaces.enabled).toBe(true);
  });

  it('keeps a link a person already set', () => {
    const onDisk = upgrade({ enabled: false, official: { url: 'https://space.example/c/x' } });
    expect(onDisk.spaces.official).toEqual({ url: 'https://space.example/c/x' });
  });

  it('is idempotent and skips a config with no spaces block', () => {
    const store = createMockStore({ spaces: { enabled: false } });
    seedSpacesOfficial(store);
    seedSpacesOfficial(store);
    expect(store.data.spaces).toEqual({ enabled: false, official: { url: '' } });
    const none = createMockStore({ server: { port: 4242 } });
    seedSpacesOfficial(none);
    expect(none.data.spaces).toBeUndefined();
  });
});
