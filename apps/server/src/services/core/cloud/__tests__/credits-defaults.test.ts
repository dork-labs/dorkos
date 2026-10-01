/**
 * Who chose credits, and what DorkOS owes the person about choices it made.
 *
 * The rules under test: a new link fills only the gaps (a runtime with no
 * working sign-in), records `default` and announces it; a person's pick records
 * `user`; Undo all undoes only DorkOS's picks; a real sign-in appearing under a
 * `default` choice is re-offered once; a computer linked before credits were a
 * choice is offered, never switched.
 */
import { describe, expect, it } from 'vitest';
import {
  creditsChoices,
  creditsIsDefaultFor,
  creditsNotices,
  dismissCreditsNotice,
  fillCreditsGaps,
  readCreditsSettings,
  setCreditsDefault,
  undoFilledDefaults,
  type CreditsConfigPort,
  type CreditsRuntimeView,
} from '../credits-defaults.js';

function memoryConfig(cloud: Record<string, unknown> = {}): CreditsConfigPort & {
  cloud: () => Record<string, unknown>;
} {
  let stored: Record<string, unknown> = { instanceToken: 'ik', ...cloud };
  return {
    get: ((key: string) => (key === 'cloud' ? stored : undefined)) as CreditsConfigPort['get'],
    set: ((key: string, value: unknown) => {
      if (key === 'cloud') stored = value as Record<string, unknown>;
    }) as CreditsConfigPort['set'],
    cloud: () => stored,
  };
}

function runtime(type: string, signedIn: boolean, declares = true): CreditsRuntimeView {
  return {
    type,
    capabilities: declares ? { credits: { protocol: 'anthropic-messages' } } : {},
    hasWorkingSignIn: async () => signedIn,
  };
}

describe('filling the gaps on a new link', () => {
  it('sets credits only where there is no working sign-in, and says so once', async () => {
    const config = memoryConfig();
    const switched = await fillCreditsGaps(
      [runtime('claude-code', false), runtime('codex', false, false), runtime('opencode', true)],
      config
    );
    expect(switched).toEqual(['claude-code']);
    expect(creditsIsDefaultFor('claude-code', config)).toBe(true);
    expect(creditsChoices(readCreditsSettings(config))).toEqual({
      'claude-code': { chosenBy: 'default' },
    });
    expect(
      await creditsNotices(readCreditsSettings(config), { linked: true, runtimes: [] })
    ).toEqual([{ kind: 'filled', runtimes: ['claude-code'] }]);
  });

  it('never touches a runtime with a working sign-in, nor one the person already set', async () => {
    const config = memoryConfig({
      credits: { defaults: { codex: { chosenBy: 'user' } }, offer: 'none' },
    });
    const switched = await fillCreditsGaps(
      [runtime('claude-code', true), runtime('codex', false)],
      config
    );
    expect(switched).toEqual([]);
    expect(creditsChoices(readCreditsSettings(config))).toEqual({ codex: { chosenBy: 'user' } });
  });

  it('treats a sign-in nobody can read as working, so doubt never spends', async () => {
    const config = memoryConfig();
    const broken: CreditsRuntimeView = {
      ...runtime('claude-code', false),
      hasWorkingSignIn: async () => {
        throw new Error('probe failed');
      },
    };
    expect(await fillCreditsGaps([broken], config)).toEqual([]);
    expect(creditsIsDefaultFor('claude-code', config)).toBe(false);
  });

  it('settles the old-link offer: a new link was never owed it', async () => {
    const config = memoryConfig({ credits: { defaults: {}, offer: 'pending' } });
    await fillCreditsGaps([runtime('claude-code', true)], config);
    expect(readCreditsSettings(config).offer).toBe('none');
  });
});

describe('a person choosing in Runs on', () => {
  it('records the choice as theirs, and turning it off returns to the own sign-in', () => {
    const config = memoryConfig();
    setCreditsDefault('claude-code', true, config);
    expect(creditsChoices(readCreditsSettings(config))).toEqual({
      'claude-code': { chosenBy: 'user' },
    });
    setCreditsDefault('claude-code', false, config);
    expect(creditsIsDefaultFor('claude-code', config)).toBe(false);
  });

  it('answers the old-link offer either way', () => {
    const config = memoryConfig({ credits: { defaults: {}, offer: 'pending' } });
    setCreditsDefault('claude-code', false, config);
    expect(readCreditsSettings(config).offer).toBe('dismissed');
  });

  it('keeps every other cloud field as stored', () => {
    const config = memoryConfig({ instanceName: 'mac', previousLinkProof: null });
    setCreditsDefault('claude-code', true, config);
    expect(config.cloud()).toMatchObject({ instanceToken: 'ik', instanceName: 'mac' });
  });
});

describe('Undo all', () => {
  it('undoes only what DorkOS chose, never a person’s pick', async () => {
    const config = memoryConfig({
      credits: { defaults: { codex: { chosenBy: 'user' } }, offer: 'none' },
    });
    await fillCreditsGaps([runtime('claude-code', false)], config);
    expect(undoFilledDefaults(config)).toEqual(['claude-code']);
    expect(creditsChoices(readCreditsSettings(config))).toEqual({ codex: { chosenBy: 'user' } });
  });
});

describe('the notices', () => {
  it('owe nothing while unlinked', async () => {
    const config = memoryConfig({ credits: { defaults: {}, offer: 'pending' } });
    expect(
      await creditsNotices(readCreditsSettings(config), {
        linked: false,
        runtimes: [runtime('claude-code', true)],
      })
    ).toEqual([]);
  });

  it('offer credits once to a computer linked before they were a choice', async () => {
    const config = memoryConfig({ credits: { defaults: {}, offer: 'pending' } });
    const opts = { linked: true, runtimes: [runtime('claude-code', true)] };
    expect(await creditsNotices(readCreditsSettings(config), opts)).toEqual([{ kind: 'offer' }]);
    dismissCreditsNotice({ kind: 'offer' }, config);
    expect(await creditsNotices(readCreditsSettings(config), opts)).toEqual([]);
  });

  it('re-offer the own sign-in once when it starts working under a default choice', async () => {
    const config = memoryConfig();
    await fillCreditsGaps([runtime('claude-code', false)], config);
    dismissCreditsNotice({ kind: 'filled' }, config);
    // Still no sign-in: nothing to offer.
    expect(
      await creditsNotices(readCreditsSettings(config), {
        linked: true,
        runtimes: [runtime('claude-code', false)],
      })
    ).toEqual([]);
    // The person signs in to Claude Code.
    const signedIn = { linked: true, runtimes: [runtime('claude-code', true)] };
    expect(await creditsNotices(readCreditsSettings(config), signedIn)).toEqual([
      { kind: 'signed-in', runtime: 'claude-code' },
    ]);
    dismissCreditsNotice({ kind: 'signed-in', runtime: 'claude-code' }, config);
    expect(await creditsNotices(readCreditsSettings(config), signedIn)).toEqual([]);
    // Dismissing kept credits: nothing was switched by the notice itself.
    expect(creditsIsDefaultFor('claude-code', config)).toBe(true);
  });

  it('never re-offer a choice the person made themselves', async () => {
    const config = memoryConfig();
    setCreditsDefault('claude-code', true, config);
    expect(
      await creditsNotices(readCreditsSettings(config), {
        linked: true,
        runtimes: [runtime('claude-code', true)],
      })
    ).toEqual([]);
  });
});

describe('reading stored settings', () => {
  it('reads anything unreadable as no credits default anywhere', () => {
    const config = memoryConfig({ credits: { defaults: 'nope' } });
    expect(readCreditsSettings(config)).toEqual({ defaults: {}, offer: 'none' });
    const throwing = {
      get: () => {
        throw new Error('not ready');
      },
    } as unknown as Pick<CreditsConfigPort, 'get'>;
    expect(creditsIsDefaultFor('claude-code', throwing)).toBe(false);
  });
});
