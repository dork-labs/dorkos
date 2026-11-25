import { describe, it, expect } from 'vitest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import {
  backfillProfileDefaults,
  seedDisplayNameSourceDefault,
  seedIdentityPromptDismissedDefault,
  seedWorkingHoursDefaults,
  seedFirstRunOnboardingLeaves,
} from '../../config-manager.js';
import { createMockStore, upgradeConfigFile } from './config-manager.fixtures.js';

describe('backfillProfileDefaults migration', () => {
  it('backfills the profile section with empty defaults when absent', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillProfileDefaults(store);
    expect(store.data.profile).toEqual({
      roles: [],
      tools: [],
      displayName: null,
      rolePromptDismissedAt: null,
    });
  });

  it('is idempotent (leaves an existing profile untouched)', () => {
    const existing = {
      roles: ['hiring'],
      tools: [],
      displayName: 'Dorian',
      rolePromptDismissedAt: null,
    };
    const store = createMockStore({ profile: existing });
    backfillProfileDefaults(store);
    expect(store.data.profile).toBe(existing);
  });
});

describe('seedIdentityPromptDismissedDefault migration (DOR-677)', () => {
  it('reserves the leaf on a `profile` block that predates it', () => {
    // conf's pre-migration merge is shallow, so a stored `profile` never gains
    // a new member on its own. Drop the body and this reads `undefined`.
    const store = createMockStore({ profile: { roles: ['Engineer'], displayName: 'Dorian' } });
    seedIdentityPromptDismissedDefault(store);
    expect(store.data.profile).toEqual({
      roles: ['Engineer'],
      displayName: 'Dorian',
      identityPromptDismissedAt: null,
    });
  });

  it('seeds "never asked" even beside a stored name, never a dismissal nobody made', () => {
    // Every surface that asks also checks what is missing, so a person who
    // already has a name and a handle is never shown the question; recording a
    // dismissal here would claim an answer the person never gave.
    const store = createMockStore({ profile: { displayName: 'Dorian' } });
    seedIdentityPromptDismissedDefault(store);
    expect(store.data.profile).toEqual({ displayName: 'Dorian', identityPromptDismissedAt: null });
  });

  it('never overwrites a dismissal already on file (idempotent)', () => {
    const store = createMockStore({
      profile: { identityPromptDismissedAt: '2026-09-25T00:00:00.000Z' },
    });
    seedIdentityPromptDismissedDefault(store);
    expect(store.data.profile).toEqual({ identityPromptDismissedAt: '2026-09-25T00:00:00.000Z' });
  });

  it('leaves a stored `null` alone rather than rewriting it', () => {
    // By identity: the body spreads into a fresh object, so only `toBe` can
    // tell a skipped write from a rewrite. Swap `in` for `== null` and this
    // goes red.
    const profile = { identityPromptDismissedAt: null };
    const store = createMockStore({ profile });
    seedIdentityPromptDismissedDefault(store);
    expect(store.data.profile).toBe(profile);
  });

  it('does nothing when there is no `profile` block to extend', () => {
    const store = createMockStore({ server: { port: 4242 } });
    seedIdentityPromptDismissedDefault(store);
    expect(store.data.profile).toBeUndefined();
  });

  it('a real pre-0.85.0 config file gains the leaf on disk (full conf path)', () => {
    // Read from the FILE: Ajv's `useDefaults` answers `null` from a discarded
    // copy, so a `getDot` assertion would pass with the body deleted (DOR-1496).
    const onDisk = upgradeConfigFile<{
      profile: Record<string, unknown>;
    }>(
      {
        profile: {
          roles: ['Engineer'],
          tools: [],
          displayName: 'Dorian',
          displayNameSource: null,
          rolePromptDismissedAt: '2026-08-01T00:00:00.000Z',
        },
      },
      '0.84.0',
      '0.85.0'
    );
    expect(onDisk.profile).toHaveProperty('identityPromptDismissedAt', null);
    // The upgrade adds one leaf; everything the person had set is untouched.
    expect(onDisk.profile.displayName).toBe('Dorian');
    expect(onDisk.profile.rolePromptDismissedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
  });
});

describe('seedWorkingHoursDefaults migration (DOR-2788)', () => {
  it('reserves the three hours leaves on a `profile` block that predates them', () => {
    // conf's pre-migration merge is shallow, so a stored `profile` never gains a
    // member on its own. Drop the body and these read `undefined`.
    const store = createMockStore({ profile: { roles: ['Engineer'], displayName: 'Dorian' } });
    seedWorkingHoursDefaults(store);
    expect(store.data.profile).toEqual({
      roles: ['Engineer'],
      displayName: 'Dorian',
      timezone: null,
      workingHours: null,
      away: null,
    });
  });

  it('keeps a leaf a person already set and fills only the missing ones', () => {
    const store = createMockStore({ profile: { timezone: 'Europe/Berlin' } });
    seedWorkingHoursDefaults(store);
    expect(store.data.profile).toEqual({
      timezone: 'Europe/Berlin',
      workingHours: null,
      away: null,
    });
  });

  it('leaves a profile that already has all three alone (idempotent, by identity)', () => {
    const profile = { timezone: null, workingHours: null, away: null };
    const store = createMockStore({ profile });
    seedWorkingHoursDefaults(store);
    expect(store.data.profile).toBe(profile);
  });

  it('does nothing when there is no `profile` block to extend', () => {
    const store = createMockStore({ server: { port: 4242 } });
    seedWorkingHoursDefaults(store);
    expect(store.data.profile).toBeUndefined();
  });

  it('a real pre-0.105.0 config file gains the leaves on disk (full conf path)', () => {
    // Read from the FILE: Ajv's `useDefaults` answers `null` from a discarded
    // copy, so a `getDot` assertion would pass with the body deleted (DOR-1496).
    const onDisk = upgradeConfigFile<{
      profile: Record<string, unknown>;
    }>(
      {
        profile: {
          roles: ['Engineer'],
          tools: [],
          displayName: 'Dorian',
          displayNameSource: null,
          rolePromptDismissedAt: null,
          identityPromptDismissedAt: '2026-09-01T00:00:00.000Z',
        },
      },
      '0.103.0',
      '0.105.0'
    );
    expect(onDisk.profile).toHaveProperty('timezone', null);
    expect(onDisk.profile).toHaveProperty('workingHours', null);
    expect(onDisk.profile).toHaveProperty('away', null);
    // Everything the person had set is untouched.
    expect(onDisk.profile.displayName).toBe('Dorian');
    expect(onDisk.profile.identityPromptDismissedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
  });
});

describe('seedFirstRunOnboardingLeaves migration (DOR-2783)', () => {
  it('reserves the three first-run leaves on an `onboarding` block that predates them', () => {
    // conf's pre-migration merge is shallow, so a stored `onboarding` never gains
    // a member on its own. Drop the body and these read `undefined`.
    const store = createMockStore({
      onboarding: { completedSteps: ['meet-dorkbot'], completedAt: '2026-07-01T00:00:00.000Z' },
    });
    seedFirstRunOnboardingLeaves(store);
    expect(store.data.onboarding).toEqual({
      completedSteps: ['meet-dorkbot'],
      completedAt: '2026-07-01T00:00:00.000Z',
      firstRunPath: null,
      welcomeEntryId: null,
      priorRuntime: null,
    });
  });

  it('keeps a leaf already set and fills only the missing ones', () => {
    const store = createMockStore({ onboarding: { firstRunPath: 'own' } });
    seedFirstRunOnboardingLeaves(store);
    expect(store.data.onboarding).toEqual({
      firstRunPath: 'own',
      welcomeEntryId: null,
      priorRuntime: null,
    });
  });

  it('leaves a block that already has all three alone (idempotent, by identity)', () => {
    const onboarding = { firstRunPath: null, welcomeEntryId: null, priorRuntime: null };
    const store = createMockStore({ onboarding });
    seedFirstRunOnboardingLeaves(store);
    expect(store.data.onboarding).toBe(onboarding);
  });

  it('does nothing when there is no `onboarding` block to extend', () => {
    const store = createMockStore({ server: { port: 4242 } });
    seedFirstRunOnboardingLeaves(store);
    expect(store.data.onboarding).toBeUndefined();
  });

  it('a real pre-0.108.0 config file gains the leaves on disk (full conf path)', () => {
    // Read from the FILE: Ajv's `useDefaults` answers `null` from a discarded
    // copy, so a `getDot` assertion would pass with the body deleted (DOR-1496).
    const onDisk = upgradeConfigFile<{
      onboarding: Record<string, unknown>;
    }>(
      {
        onboarding: {
          completedSteps: [],
          skippedSteps: [],
          startedAt: null,
          dismissedAt: null,
          completedAt: '2026-09-01T00:00:00.000Z',
          runtimeDefaultSetAt: '2026-09-01T00:00:00.000Z',
        },
      },
      '0.107.0',
      '0.108.0'
    );
    expect(onDisk.onboarding).toHaveProperty('firstRunPath', null);
    expect(onDisk.onboarding).toHaveProperty('welcomeEntryId', null);
    expect(onDisk.onboarding).toHaveProperty('priorRuntime', null);
    // Everything the install already had is untouched.
    expect(onDisk.onboarding.completedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
  });
});

describe('seedDisplayNameSourceDefault migration (DOR-1022)', () => {
  it('reserves the leaf on a `profile` block that predates it', () => {
    // What this catches: conf merges top-level defaults SHALLOWLY, so an
    // upgrading install with a stored `profile` block never inherits the new
    // leaf on its own. Drop the body and it reads `undefined`.
    const store = createMockStore({ profile: { roles: ['Engineer'], displayName: 'Dorian' } });
    seedDisplayNameSourceDefault(store);
    expect(store.data.profile).toEqual({
      roles: ['Engineer'],
      displayName: 'Dorian',
      displayNameSource: null,
    });
  });

  it('seeds `null` beside a name it cannot attribute, never a guess', () => {
    // The decision, pinned as behaviour: a name stored before this field existed
    // could have come from the person or from DorkBot, and this install has no
    // record either way. `null` is read as "no record" and draws no hint, so an
    // upgrade is silent rather than labelling a long-standing name a suggestion.
    const store = createMockStore({ profile: { displayName: 'Dorian' } });
    seedDisplayNameSourceDefault(store);
    expect(store.data.profile).toEqual({ displayName: 'Dorian', displayNameSource: null });
  });

  it('never overwrites a source already on file (idempotent)', () => {
    // What this catches: a re-run — corrupt-recovery instantiates conf twice —
    // erasing a real attribution back to "no record", which silently clears the
    // hint this whole field exists to draw.
    const store = createMockStore({
      profile: {
        displayName: 'Dorian',
        displayNameSource: { kind: 'agent', agentName: 'DorkBot' },
      },
    });
    seedDisplayNameSourceDefault(store);
    expect(store.data.profile).toEqual({
      displayName: 'Dorian',
      displayNameSource: { kind: 'agent', agentName: 'DorkBot' },
    });
  });

  it('leaves a stored `null` alone rather than rewriting it', () => {
    // The reason the guard is `in` and not `== null`: this leaf's default IS
    // `null`, so an absence test written the usual way is true for a value that
    // is already there, and the body writes on every re-run for ever.
    //
    // Asserted by IDENTITY rather than by value: the body spreads into a fresh
    // object, so a `toEqual` here passes whether it wrote or not and would prove
    // nothing about the `in` guard. Swap `in` for `== null` and this goes red.
    const profile = { displayName: 'Dorian', displayNameSource: null };
    const store = createMockStore({ profile });
    seedDisplayNameSourceDefault(store);
    expect(store.data.profile).toBe(profile);
  });

  it('does nothing when there is no `profile` block to extend', () => {
    // The schema default supplies the whole section on read in that case, and
    // writing a partial `profile` here would drop every other default in it.
    const store = createMockStore({ server: { port: 4242 } });
    seedDisplayNameSourceDefault(store);
    expect(store.data.profile).toBeUndefined();
  });

  it('a real pre-0.73.0 config file gains the leaf on disk (full conf path)', () => {
    // The half neither the mock store nor a `getDot` assertion can reach (see
    // `seedToolOnlyReplyDefaults` above for the DOR-1496 measurement this shape
    // comes from). A nested-leaf case, so this body is the ONLY thing that puts
    // it on the file: suppress it and this goes red while
    // `store.get('profile').displayNameSource` still answers `null` from Ajv's
    // discarded copy.
    const onDisk = upgradeConfigFile<{
      profile: Record<string, unknown>;
    }>(
      {
        profile: {
          roles: ['Engineer'],
          tools: [],
          displayName: 'Dorian',
          rolePromptDismissedAt: null,
        },
      },
      '0.72.0',
      '0.73.0'
    );
    expect(onDisk.profile).toHaveProperty('displayNameSource', null);
    // The upgrade adds one leaf; it changes nothing the person had set.
    expect(onDisk.profile.displayName).toBe('Dorian');
    expect(onDisk.profile.roles).toEqual(['Engineer']);
    expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
  });
});
