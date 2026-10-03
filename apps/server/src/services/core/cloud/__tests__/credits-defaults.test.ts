/**
 * Who chose credits, which agents a person allowed onto them, and what DorkOS
 * owes the person about choices it made.
 *
 * The rules under test: a new link fills only true gaps (no record at all, and
 * no sign-in at all), records `default` and announces it; a person's yes AND
 * no are both recorded and never overridden; Undo all records a no; an
 * expired or out-of-usage sign-in is not a gap; a link to a different account
 * starts over, the same account keeps everything; a real sign-in appearing
 * under a `default` choice is re-offered once; a computer linked before
 * credits were a choice is offered, never switched.
 */
import { describe, expect, it } from 'vitest';
import {
  creditsAllowedForAgent,
  creditsChoices,
  creditsIsDefaultFor,
  creditsNotices,
  dismissCreditsNotice,
  fillCreditsGaps,
  noteCreditsAccount,
  readCreditsSettings,
  setCreditsAllowedForAgent,
  setCreditsDefault,
  undoFilledDefaults,
  type CreditsConfigPort,
  type CreditsRuntimeView,
  type RuntimeSignInState,
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

function runtime(type: string, signIn: RuntimeSignInState, declares = true): CreditsRuntimeView {
  return {
    type,
    capabilities: declares
      ? { credits: { protocol: 'anthropic-messages', scope: 'conversation' } }
      : {},
    wired: declares,
    signIn: async () => signIn,
  };
}

const ACCOUNT = { key: 'acct-1' };

describe('filling the gaps on a new link', () => {
  it('sets credits only where there is no sign-in at all, and says so once', async () => {
    const config = memoryConfig();
    const switched = await fillCreditsGaps(
      [runtime('claude-code', 'none'), runtime('codex', 'none', false), runtime('x', 'working')],
      ACCOUNT,
      config
    );
    expect(switched).toEqual(['claude-code']);
    expect(creditsIsDefaultFor('claude-code', config)).toBe(true);
    expect(creditsChoices(readCreditsSettings(config))).toEqual({
      'claude-code': { runsOn: 'credits', chosenBy: 'default' },
    });
    expect(
      await creditsNotices(readCreditsSettings(config), { linked: true, runtimes: [] })
    ).toEqual([{ kind: 'filled', runtimes: ['claude-code'] }]);
  });

  it('never fills a runtime that declares credits in a format the endpoint does not serve', async () => {
    const config = memoryConfig();
    const unserved: CreditsRuntimeView = {
      type: 'codex',
      capabilities: { credits: { protocol: 'openai-responses', scope: 'conversation' } },
      wired: false,
      signIn: async () => 'none',
    };
    expect(await fillCreditsGaps([unserved], ACCOUNT, config)).toEqual([]);
    expect(creditsIsDefaultFor('codex', config)).toBe(false);
  });

  it('never fills an expired or out-of-usage sign-in: it needs attention, not replacing', async () => {
    const config = memoryConfig();
    expect(
      await fillCreditsGaps([runtime('claude-code', 'needs-attention')], ACCOUNT, config)
    ).toEqual([]);
    expect(creditsIsDefaultFor('claude-code', config)).toBe(false);
  });

  it('never overrides a person’s no, on the same account', async () => {
    const config = memoryConfig({ credits: { linkedTo: 'acct-1' } });
    setCreditsDefault('claude-code', false, config);
    expect(await fillCreditsGaps([runtime('claude-code', 'none')], ACCOUNT, config)).toEqual([]);
    expect(creditsChoices(readCreditsSettings(config))).toEqual({
      'claude-code': { runsOn: 'own-sign-in', chosenBy: 'user' },
    });
  });

  it('keeps every choice and allowed agent when the same account relinks', async () => {
    const config = memoryConfig({ credits: { linkedTo: 'acct-1' } });
    setCreditsDefault('claude-code', true, config);
    setCreditsAllowedForAgent('agent-1', true, config);
    await fillCreditsGaps([runtime('claude-code', 'none')], ACCOUNT, config);
    expect(creditsChoices(readCreditsSettings(config))).toEqual({
      'claude-code': { runsOn: 'credits', chosenBy: 'user' },
    });
    expect(creditsAllowedForAgent('agent-1', config)).toBe(true);
  });

  it('starts over on a different account, then fills its gaps', async () => {
    const config = memoryConfig({ credits: { linkedTo: 'acct-old' } });
    setCreditsDefault('claude-code', false, config);
    setCreditsAllowedForAgent('agent-1', true, config);
    expect(await fillCreditsGaps([runtime('claude-code', 'none')], ACCOUNT, config)).toEqual([
      'claude-code',
    ]);
    expect(creditsAllowedForAgent('agent-1', config)).toBe(false);
    expect(readCreditsSettings(config).linkedTo).toBe('acct-1');
  });

  it('starts over when the account cannot be told apart', async () => {
    const config = memoryConfig({ credits: { linkedTo: 'acct-1' } });
    setCreditsAllowedForAgent('agent-1', true, config);
    await fillCreditsGaps([], { key: null }, config);
    expect(creditsAllowedForAgent('agent-1', config)).toBe(false);
  });

  it('treats a sign-in nobody can read as working, so doubt never spends', async () => {
    const config = memoryConfig();
    const broken: CreditsRuntimeView = {
      ...runtime('claude-code', 'none'),
      signIn: async () => {
        throw new Error('probe failed');
      },
    };
    expect(await fillCreditsGaps([broken], ACCOUNT, config)).toEqual([]);
  });

  it('settles the old-link offer: a new link was never owed it', async () => {
    const config = memoryConfig({ credits: { offer: 'pending', linkedTo: 'acct-1' } });
    await fillCreditsGaps([runtime('claude-code', 'working')], ACCOUNT, config);
    expect(readCreditsSettings(config).offer).toBe('none');
  });
});

describe('a person choosing in Runs on', () => {
  it('records a yes and a no as theirs', () => {
    const config = memoryConfig();
    setCreditsDefault('claude-code', true, config);
    expect(creditsChoices(readCreditsSettings(config))['claude-code']).toEqual({
      runsOn: 'credits',
      chosenBy: 'user',
    });
    setCreditsDefault('claude-code', false, config);
    expect(creditsIsDefaultFor('claude-code', config)).toBe(false);
    expect(creditsChoices(readCreditsSettings(config))['claude-code']).toEqual({
      runsOn: 'own-sign-in',
      chosenBy: 'user',
    });
  });

  it('answers the old-link offer either way', () => {
    const config = memoryConfig({ credits: { offer: 'pending' } });
    setCreditsDefault('claude-code', false, config);
    expect(readCreditsSettings(config).offer).toBe('dismissed');
  });

  it('keeps every other cloud field as stored', () => {
    const config = memoryConfig({ instanceName: 'mac', previousLinkProof: null });
    setCreditsDefault('claude-code', true, config);
    expect(config.cloud()).toMatchObject({ instanceToken: 'ik', instanceName: 'mac' });
  });
});

describe('agents a person allowed onto credits', () => {
  it('allows and stops one agent, and nobody else', () => {
    const config = memoryConfig();
    expect(creditsAllowedForAgent('agent-1', config)).toBe(false);
    setCreditsAllowedForAgent('agent-1', true, config);
    expect(creditsAllowedForAgent('agent-1', config)).toBe(true);
    expect(creditsAllowedForAgent('agent-2', config)).toBe(false);
    expect(creditsAllowedForAgent(undefined, config)).toBe(false);
    setCreditsAllowedForAgent('agent-1', false, config);
    expect(creditsAllowedForAgent('agent-1', config)).toBe(false);
  });
});

describe('Undo all', () => {
  it('turns what DorkOS chose into the person’s no, leaving their own picks alone', async () => {
    const config = memoryConfig();
    setCreditsDefault('codex', true, config);
    await fillCreditsGaps([runtime('claude-code', 'none')], { key: null }, config);
    setCreditsDefault('codex', true, config);
    expect(undoFilledDefaults(config)).toEqual(['claude-code']);
    expect(creditsChoices(readCreditsSettings(config))).toEqual({
      'claude-code': { runsOn: 'own-sign-in', chosenBy: 'user' },
      codex: { runsOn: 'credits', chosenBy: 'user' },
    });
    // A later new link on the same account does not fill it back in.
    noteCreditsAccount('acct-1', config);
    expect(await fillCreditsGaps([runtime('claude-code', 'none')], ACCOUNT, config)).toEqual([]);
  });
});

describe('the notices', () => {
  it('owe nothing while unlinked', async () => {
    const config = memoryConfig({ credits: { offer: 'pending' } });
    expect(
      await creditsNotices(readCreditsSettings(config), {
        linked: false,
        runtimes: [runtime('claude-code', 'working')],
      })
    ).toEqual([]);
  });

  it('offer credits once to a computer linked before they were a choice', async () => {
    const config = memoryConfig({ credits: { offer: 'pending' } });
    const opts = { linked: true, runtimes: [runtime('claude-code', 'working')] };
    expect(await creditsNotices(readCreditsSettings(config), opts)).toEqual([{ kind: 'offer' }]);
    dismissCreditsNotice({ kind: 'offer' }, config);
    expect(await creditsNotices(readCreditsSettings(config), opts)).toEqual([]);
  });

  it('re-offer the own sign-in once when it starts working under a default choice', async () => {
    const config = memoryConfig();
    await fillCreditsGaps([runtime('claude-code', 'none')], ACCOUNT, config);
    dismissCreditsNotice({ kind: 'filled' }, config);
    expect(
      await creditsNotices(readCreditsSettings(config), {
        linked: true,
        runtimes: [runtime('claude-code', 'none')],
      })
    ).toEqual([]);
    const signedIn = { linked: true, runtimes: [runtime('claude-code', 'working')] };
    expect(await creditsNotices(readCreditsSettings(config), signedIn)).toEqual([
      { kind: 'signed-in', runtime: 'claude-code' },
    ]);
    dismissCreditsNotice({ kind: 'signed-in', runtime: 'claude-code' }, config);
    expect(await creditsNotices(readCreditsSettings(config), signedIn)).toEqual([]);
    expect(creditsIsDefaultFor('claude-code', config)).toBe(true);
  });

  it('never re-offer a choice the person made themselves', async () => {
    const config = memoryConfig();
    setCreditsDefault('claude-code', true, config);
    expect(
      await creditsNotices(readCreditsSettings(config), {
        linked: true,
        runtimes: [runtime('claude-code', 'working')],
      })
    ).toEqual([]);
  });
});

describe('reading stored settings', () => {
  it('reads anything unreadable as no credits anywhere', () => {
    const config = memoryConfig({ credits: { defaults: 'nope' } });
    expect(readCreditsSettings(config).defaults).toEqual({});
    const noRunsOn = memoryConfig({
      credits: { defaults: { 'claude-code': { chosenBy: 'user' } } },
    });
    expect(creditsIsDefaultFor('claude-code', noRunsOn)).toBe(false);
    const throwing = {
      get: () => {
        throw new Error('not ready');
      },
    } as unknown as Pick<CreditsConfigPort, 'get'>;
    expect(creditsIsDefaultFor('claude-code', throwing)).toBe(false);
  });

  it('records the account once, and never moves a known one', () => {
    const config = memoryConfig();
    noteCreditsAccount('acct-1', config);
    noteCreditsAccount('acct-2', config);
    expect(readCreditsSettings(config).linkedTo).toBe('acct-1');
  });
});
