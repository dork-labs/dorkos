/**
 * Core's own rule for an agent naming an account when no advisor is
 * registered (DOR-5033): opt-in per account, never Main, never credits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_HIDDEN_REASON,
  SIGNED_OUT_REASON,
  checkAccountLaunch,
  formatShortLocalTime,
} from '../account-ranking.js';
import {
  recordAccountSignin,
  resetAccountSignins,
} from '../../../observability/account-signin-state.js';
import { __resetAccountAdvisorForTests } from '../account-advisor.js';
import { setAccountUsageStore } from '../current-usage-store.js';
import { creditsClaudeRoot } from '../../../runtimes/claude-code/credits-root.js';
import { installStore } from './account-ranking.fixtures.js';

beforeEach(() => {
  __resetAccountAdvisorForTests();
  resetAccountSignins();
});

afterEach(() => {
  setAccountUsageStore(undefined);
});

/** Core's own refusals (DOR-5033), pinned word for word: an agent reads them. */
const MAIN_ACCOUNT_REASON = 'Agents can’t pick the main sign-in. Name another account.';
const KEPT_OFF_REASON = 'A person kept agents off this account.';
const CREDITS_REASON = 'Only a person can pick DorkOS credits.';
const NOT_LET_REASON = 'A person hasn’t let agents pick this account. Ask them in Settings.';

describe("checkAccountLaunch with no advisor: core's own rule for an agent (DOR-5033)", () => {
  const ask = (accountId: string) =>
    checkAccountLaunch({ accountId, cwd: '/w', runtime: 'claude-code', caller: 'agent' });

  it('allows only an account a person let agents pick', async () => {
    installStore([
      { id: 'work', weekly: 10, agentsMayPick: true },
      { id: 'client', weekly: 30 },
      { id: 'default', implicit: true, weekly: 0 },
    ]);
    expect(await ask('work')).toEqual({ allowed: true });
    // Opt-in: an account nobody let agents pick is refused, Flow or no Flow.
    expect(await ask('client')).toEqual({ allowed: false, reason: NOT_LET_REASON });
  });

  it('refuses an account a person kept agents off, even one they may pick', async () => {
    installStore([{ id: 'client', weekly: 30, agentsMayPick: true, noAutoMove: true }]);
    expect(await ask('client')).toEqual({ allowed: false, reason: KEPT_OFF_REASON });
  });

  it('never picks the main sign-in: standalone, its alias row, or another row on its folder', async () => {
    installStore([
      { id: 'work', weekly: 10, agentsMayPick: true },
      { id: 'default', implicit: true, weekly: 0, agentsMayPick: true },
    ]);
    expect(await ask('default')).toEqual({ allowed: false, reason: MAIN_ACCOUNT_REASON });
    installStore([
      { id: 'main-row', isDefault: true, weekly: 0, agentsMayPick: true },
      { id: 'work', weekly: 10, agentsMayPick: true },
    ]);
    expect(await ask('main-row')).toEqual({ allowed: false, reason: MAIN_ACCOUNT_REASON });
    // A second row on Main's folder is not marked as Main, and is still Main.
    installStore([
      { id: 'main-row', isDefault: true, folder: '/home/me/.claude', weekly: 0 },
      { id: 'twin', folder: '/home/me/.claude', weekly: 0, agentsMayPick: true },
    ]);
    expect(await ask('twin')).toEqual({ allowed: false, reason: MAIN_ACCOUNT_REASON });
    installStore([
      { id: 'default', implicit: true, folder: '/home/me/.claude', weekly: 0 },
      { id: 'twin', folder: '/home/me/.claude', weekly: 0, agentsMayPick: true },
    ]);
    expect(await ask('twin')).toEqual({ allowed: false, reason: MAIN_ACCOUNT_REASON });
  });

  it('refuses an unknown, an unroutable and a credits account', async () => {
    installStore([
      { id: 'work', weekly: 10, agentsMayPick: true },
      { id: 'Bad Id', routable: false, agentsMayPick: true },
    ]);
    expect(await ask('ghost')).toEqual({ allowed: false, reason: ACCOUNT_HIDDEN_REASON });
    expect(await ask('Bad Id')).toEqual({ allowed: false, reason: ACCOUNT_HIDDEN_REASON });
    expect(await ask('dorkos-credits')).toEqual({ allowed: false, reason: CREDITS_REASON });
  });

  describe('a registered row on the DorkOS credits folder', () => {
    let home: string;
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-row-'));
      vi.stubEnv('DORK_HOME', home);
      fs.mkdirSync(creditsClaudeRoot(), { recursive: true });
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('is refused as credits, by its folder or through a link to it', async () => {
      const link = path.join(home, 'looks-like-mine');
      fs.symlinkSync(creditsClaudeRoot(), link);
      installStore([
        { id: 'paid', folder: creditsClaudeRoot(), weekly: 10, agentsMayPick: true },
        { id: 'linked', folder: link, canonicalPath: null, weekly: 10, agentsMayPick: true },
      ]);
      expect(await ask('paid')).toEqual({ allowed: false, reason: CREDITS_REASON });
      expect(await ask('linked')).toEqual({ allowed: false, reason: CREDITS_REASON });
    });
  });

  it('refuses an account that is out, or last seen signed out, with its reason', async () => {
    installStore([
      {
        id: 'out',
        state: 'limited',
        weekly: 100,
        resetsAt: '2026-09-29T15:00:00',
        agentsMayPick: true,
      },
      { id: 'seen', weekly: 10, agentsMayPick: true },
    ]);
    recordAccountSignin('claude-code', '/accounts/seen', 'signed-out');
    expect(await ask('out')).toEqual({
      allowed: false,
      reason: `Out until ${formatShortLocalTime('2026-09-29T15:00:00')}`,
    });
    expect(await ask('seen')).toEqual({ allowed: false, reason: SIGNED_OUT_REASON });
  });
});
