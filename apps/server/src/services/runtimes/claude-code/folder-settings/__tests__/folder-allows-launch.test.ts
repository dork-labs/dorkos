/**
 * An agent's own folder allow list reaches a launch only once a person has
 * approved exactly that list, and only for the agent's own turn in its own
 * home (DOR-3039).
 *
 * @vitest-environment node
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** A config store holding just the `permissions` section. */
const store = vi.hoisted(() => ({
  permissions: {
    approvedFolderAllows: [] as string[],
    refusedFolderAllows: [] as string[],
  } as Record<string, unknown>,
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? store.permissions : undefined),
    set: (key: string, value: typeof store.permissions) => {
      if (key === 'permissions') store.permissions = value;
    },
  },
}));
vi.mock('../../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));

import {
  firstTimeToldAbout,
  folderAllowsFromSettings,
  folderAllowsWaitingStatus,
  mergeFolderAllows,
  resolveFolderAllows,
} from '../apply-folder-allows.js';
import {
  isFolderAllowListApproved,
  recordFolderAllowApproval,
  recordFolderAllowRefusal,
} from '../folder-allow-consent.js';
import {
  _internal,
  askForFolderAllows,
  mayAskAboutFolderAllows,
  summariseFolderAllows,
  type FolderAllowApprovalGateway,
} from '../folder-allow-approval.js';

const AGENT = { id: '01AGENT', name: 'Marketing' };
let home: string;

/** Write the agent's `.claude/settings.json`. */
async function writeSettings(body: unknown): Promise<void> {
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(body));
}

/** The agent's own turn, in its own home. */
function ownTurn(overrides: Partial<Parameters<typeof resolveFolderAllows>[0]> = {}) {
  return resolveFolderAllows({ agent: AGENT, home, cwd: home, ...overrides });
}

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'folder-allows-')));
  store.permissions = { approvedFolderAllows: [], refusedFolderAllows: [] };
  _internal.forgetOpenCards();
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('resolveFolderAllows', () => {
  it('waits for a person when nobody has approved the list', async () => {
    await writeSettings({ permissions: { allow: ['Bash(scripts/claim-check:*)'] } });
    const decision = await ownTurn();
    expect(decision.kind).toBe('waiting');
  });

  it('applies the list once a person approves it', async () => {
    await writeSettings({ permissions: { allow: ['Bash(scripts/claim-check:*)'] } });
    const waiting = await ownTurn();
    if (waiting.kind !== 'waiting') throw new Error('expected waiting');
    recordFolderAllowApproval(waiting.request);

    const decision = await ownTurn();
    expect(decision).toMatchObject({ kind: 'applied', rules: ['Bash(scripts/claim-check:*)'] });
  });

  it('stops applying a list that changed after approval, until it is approved again', async () => {
    await writeSettings({ permissions: { allow: ['Bash(scripts/claim-check:*)'] } });
    const first = await ownTurn();
    if (first.kind !== 'waiting') throw new Error('expected waiting');
    recordFolderAllowApproval(first.request);

    await writeSettings({
      permissions: { allow: ['Bash(scripts/claim-check:*)', 'Bash(curl:*)'] },
    });
    const changed = await ownTurn();
    expect(changed.kind).toBe('waiting');

    if (changed.kind !== 'waiting') throw new Error('expected waiting');
    recordFolderAllowApproval(changed.request);
    expect((await ownTurn()).kind).toBe('applied');
    // One yes per agent: going back to the old list asks again.
    expect(isFolderAllowListApproved(first.request)).toBe(false);
  });

  it('applies a list that only lost rules without asking, and records it as the yes', async () => {
    await writeSettings({ permissions: { allow: ['Bash(a:*)', 'Bash(b:*)'] } });
    const first = await ownTurn();
    if (first.kind !== 'waiting') throw new Error('expected waiting');
    recordFolderAllowApproval(first.request);

    await writeSettings({ permissions: { allow: ['Bash(b:*)'] } });
    expect(await ownTurn()).toMatchObject({ kind: 'applied', rules: ['Bash(b:*)'] });
    // Adding the removed rule back is a widening again, so it asks.
    await writeSettings({ permissions: { allow: ['Bash(a:*)', 'Bash(b:*)'] } });
    expect((await ownTurn()).kind).toBe('waiting');
  });

  it('tells the card what changed since the last yes', async () => {
    await writeSettings({ permissions: { allow: ['Bash(a:*)', 'Bash(b:*)'] } });
    const first = await ownTurn();
    if (first.kind !== 'waiting') throw new Error('expected waiting');
    recordFolderAllowApproval(first.request);

    await writeSettings({ permissions: { allow: ['Bash(b:*)', 'Bash(c:*)', 'mcp__*'] } });
    const changed = await ownTurn();
    if (changed.kind !== 'waiting') throw new Error('expected waiting');
    expect(summariseFolderAllows(changed.request)).toBe(
      '"Marketing" changed the commands it can run without asking. Added: "Bash(c:*)". ' +
        'Removed: "Bash(a:*)". Applies from its next turn. ' +
        '1 rule left out: DorkOS never applies wildcards or rules for its own tools.'
    );
  });

  it('ignores a stored rule list that no stored yes vouches for', async () => {
    store.permissions = {
      approvedFolderAllows: [],
      refusedFolderAllows: [],
      approvedFolderAllowRules: { [AGENT.id]: ['Bash(a:*)', 'Bash(b:*)'] },
    };
    await writeSettings({ permissions: { allow: ['Bash(a:*)'] } });
    expect((await ownTurn()).kind).toBe('waiting');
  });

  it('remembers a no until the list changes', async () => {
    await writeSettings({ permissions: { allow: ['Bash(scripts/claim-check:*)'] } });
    const waiting = await ownTurn();
    if (waiting.kind !== 'waiting') throw new Error('expected waiting');
    recordFolderAllowRefusal(waiting.request);
    expect((await ownTurn()).kind).toBe('refused');

    await writeSettings({
      permissions: { allow: ['Bash(scripts/claim-check:*)', 'Read(docs/**)'] },
    });
    expect((await ownTurn()).kind).toBe('waiting');
  });

  it('passes nothing for a folder no registered agent owns', async () => {
    await writeSettings({ permissions: { allow: ['Bash(scripts/claim-check:*)'] } });
    expect(await ownTurn({ agent: undefined })).toEqual({ kind: 'none' });
    expect(await ownTurn({ home: undefined })).toEqual({ kind: 'none' });
  });

  it('passes nothing when the turn stands anywhere but the home itself', async () => {
    await writeSettings({ permissions: { allow: ['Bash(scripts/claim-check:*)'] } });
    const sub = path.join(home, 'sub');
    await fs.mkdir(sub);
    expect(await ownTurn({ cwd: sub })).toEqual({ kind: 'none' });

    const link = `${home}-link`;
    await fs.symlink(home, link);
    try {
      expect(await ownTurn({ cwd: link })).toEqual({ kind: 'none' });
    } finally {
      await fs.rm(link);
    }
  });

  it('never carries defaultMode or anything else from the file', async () => {
    await writeSettings({
      permissions: { allow: ['Bash(scripts/claim-check:*)'], defaultMode: 'bypassPermissions' },
      apiKeyHelper: 'echo stolen',
    });
    const waiting = await ownTurn();
    if (waiting.kind !== 'waiting') throw new Error('expected waiting');
    recordFolderAllowApproval(waiting.request);
    const decision = await ownTurn();
    if (decision.kind !== 'applied') throw new Error('expected applied');

    const options: Options = {};
    mergeFolderAllows(options, decision.rules, []);
    expect(options.settings).toEqual({
      permissions: { allow: ['Bash(scripts/claim-check:*)'], deny: [] },
    });
  });

  it('asks about nothing when the list is empty or only holds dropped rules', async () => {
    await writeSettings({ permissions: { allow: ['mcp__dorkos__chat_send', 'mcp__*'] } });
    expect(await ownTurn()).toEqual({ kind: 'none' });
  });
});

describe('what the person reads', () => {
  it('names every rule on a new list', () => {
    expect(
      summariseFolderAllows({
        agentId: AGENT.id,
        agentName: 'marketing',
        home: '/h',
        rules: ['Bash(scripts/claim-check:*)', 'Bash(npm test:*)'],
      })
    ).toBe(
      'Let "marketing" run 2 commands without asking, as listed in its folder: ' +
        '"Bash(scripts/claim-check:*)", "Bash(npm test:*)". Applies from its next turn.'
    );
  });

  it('names the agent in the status line, exactly as written', () => {
    expect(folderAllowsWaitingStatus('marketing')).toBe(
      'Folder rules for marketing are waiting for your approval in Needs you. ' +
        "Until then, this chat won't run the commands they allow."
    );
  });

  it('tells a chat once per waiting card, and again for a newer one', () => {
    const chat = {};
    const card = { agentId: AGENT.id, agentName: 'm', home: '/h', rules: ['Bash(a:*)'] };
    expect(firstTimeToldAbout(chat, card)).toBe(true);
    expect(firstTimeToldAbout(chat, card)).toBe(false);
    expect(firstTimeToldAbout({}, card)).toBe(true);
    expect(firstTimeToldAbout(chat, { ...card, rules: ['Bash(b:*)'] })).toBe(true);
  });
});

describe('mergeFolderAllows', () => {
  it('keeps the settings already on the launch and never sets allowedTools', () => {
    const options: Options = {
      settings: {
        fastMode: true,
        env: { ANTHROPIC_BASE_URL: 'http://credits' },
        permissions: { additionalDirectories: ['/rooms/r1'], deny: ['Edit(/rooms/r1/**)'] },
      } as Options['settings'],
    };
    mergeFolderAllows(options, ['Bash(scripts/claim-check:*)'], ['Edit(//home/.claude/**)']);
    expect(options.settings).toEqual({
      fastMode: true,
      env: { ANTHROPIC_BASE_URL: 'http://credits' },
      permissions: {
        additionalDirectories: ['/rooms/r1'],
        deny: ['Edit(/rooms/r1/**)', 'Edit(//home/.claude/**)'],
        allow: ['Bash(scripts/claim-check:*)'],
      },
    });
    expect(options.allowedTools).toBeUndefined();
    expect(folderAllowsFromSettings(options.settings)).toEqual(['Bash(scripts/claim-check:*)']);
  });
});

describe('askForFolderAllows', () => {
  /** A gateway whose card is answered with `outcome` on the first look. */
  function gateway(outcome: 'granted' | 'denied' | 'expired'): FolderAllowApprovalGateway & {
    requests: unknown[];
  } {
    const requests: unknown[] = [];
    return {
      requests,
      request: (input) => {
        requests.push(input);
        return {
          approvalId: 'a1',
          token: 't1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      consume: () => ({ outcome }) as never,
    };
  }

  const request = () => ({ agentId: AGENT.id, agentName: AGENT.name, home, rules: ['Bash(x:*)'] });

  it('records a yes, and asks no more', async () => {
    const g = gateway('granted');
    expect(await askForFolderAllows(g, request())).toBe(true);
    expect(isFolderAllowListApproved(request())).toBe(true);
    expect(mayAskAboutFolderAllows(request())).toBe(false);
    expect(g.requests[0]).toMatchObject({ capabilityId: 'runtime.apply_folder_allows' });
  });

  it('records a no', async () => {
    expect(await askForFolderAllows(gateway('denied'), request())).toBe(false);
    expect(store.permissions.refusedFolderAllows as string[]).toHaveLength(1);
    expect(mayAskAboutFolderAllows(request())).toBe(false);
  });

  it('records nothing when nobody answered, so a later turn asks again', async () => {
    expect(await askForFolderAllows(gateway('expired'), request())).toBe(false);
    expect(store.permissions.approvedFolderAllows).toEqual([]);
    expect(store.permissions.refusedFolderAllows).toEqual([]);
    expect(mayAskAboutFolderAllows(request())).toBe(true);
  });
});
