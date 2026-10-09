/**
 * The link-time yes for global activation and project hooks (DOR-2696 task
 * 2.2): the card's yes covers exactly the hooks and programs it showed, a new
 * declaration asks again, editing never asks, and unlink takes back only the
 * link's own consent while putting the installed copy's back verbatim.
 *
 * Real filesystem in a temp folder; the decision lists are in memory, read by
 * the same functions the server uses (`partitionGlobalPlugins`,
 * `scanHookRequests`, `isHookProjectionApproved`).
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevLinkService, type DevLinkApprovals } from '../dev-link-service.js';
import { DevLinkError } from '../errors.js';
import { readDevLinks } from '../registry.js';
import { planLinkConsent } from '../consent.js';
import { memoryConsentStore, type MemoryConsentStore } from './memory-consent-store.js';
import {
  bindingOf,
  globalActivationEntry,
  partitionGlobalPlugins,
  readActivationState,
} from '../../consent/global-plugin-consent.js';
import { writeInstallMetadata } from '../../installed-metadata.js';
import { scanHookRequests } from '../../../harness/project-with-consent.js';
import { hookApprovalEntry, isHookProjectionApproved } from '../../../harness/hook-consent.js';

let base: string;
let home: string;
let work: string;
let project: string;
let approvals: DevLinkApprovals;
let consent: MemoryConsentStore;

/** A hook declaration file. */
function hooksJson(commands: Array<{ event: string; command: string }>): string {
  const byEvent: Record<string, unknown[]> = {};
  for (const { event, command } of commands) {
    (byEvent[event] ??= []).push({ hooks: [{ type: 'command', command }] });
  }
  return JSON.stringify({ hooks: byEvent });
}

/** A plugin folder declaring the given hooks. */
async function writePlugin(
  dir: string,
  hooks: Array<{ event: string; command: string }>,
  version = '1.0.0'
): Promise<void> {
  await mkdir(path.join(dir, '.dork'), { recursive: true });
  await mkdir(path.join(dir, 'hooks'), { recursive: true });
  await writeFile(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, name: 'flow', version, type: 'plugin', description: 't' })
  );
  await writeFile(path.join(dir, 'hooks', 'hooks.json'), hooksJson(hooks));
  await writeFile(path.join(dir, 'hooks', 'loop.sh'), 'echo one\n');
}

const STOP = { event: 'Stop', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/loop.sh"' };
const PRE = { event: 'PreToolUse', command: 'echo before' };

function service(): DevLinkService {
  return new DevLinkService({
    dorkHome: home,
    consent,
    approvals: {
      read: () => structuredClone(approvals),
      write: (next) => {
        approvals = structuredClone(next);
      },
    },
    onPluginsChanged: () => undefined,
    refreshExtensions: () => undefined,
    boundary: () => base,
  });
}

/** What global consent decides about `flow` with the stored lists as they are. */
async function globalDecision(): Promise<'activate' | string> {
  const partition = await partitionGlobalPlugins(home, {
    approved: consent.approved(),
    refused: [],
  });
  if (partition.activate.includes('flow')) return 'activate';
  const held = partition.withheld.find((w) => w.name === 'flow');
  return held ? `${held.reason}${held.changedSinceApproval ? ' (changed)' : ''}` : 'absent';
}

/** Whether the project's hook request for `flow` is approved now. */
function projectHooksApproved(): boolean {
  const request = scanHookRequests(project, home).find((r) => r.packageName === 'flow');
  if (!request) throw new Error('flow projects no hooks');
  return isHookProjectionApproved(request, { approved: consent.approved(), refused: [] });
}

/** The refusal a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<DevLinkError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DevLinkError) return err;
    throw err;
  }
  throw new Error('expected a DevLinkError');
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'devlink-consent-')));
  home = path.join(base, 'dork-home');
  work = path.join(base, 'work', 'flow');
  project = path.join(base, 'project');
  await mkdir(path.join(home, 'plugins'), { recursive: true });
  await mkdir(project, { recursive: true });
  await writePlugin(work, [STOP]);
  approvals = { approvedToRun: [], approvedSources: {} };
  consent = memoryConsentStore(['other@global-aaaa', 'other@bbbb']);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the link card shows what its yes covers', () => {
  it('lists every hook command in full, and says where it runs', async () => {
    // Purpose: the yes records approval for these hooks, so the card must show
    // them, not a count.
    const shown = await service().describeApproval({ path: work, scope: 'global' });
    expect(shown).toContain(JSON.stringify(STOP.command));
    expect(shown).toContain('Approving lets these start in every chat.');
    const projectCard = await service().describeApproval({
      path: work,
      scope: 'project',
      projectPath: project,
    });
    expect(projectCard).toContain('Approving lets its hooks run in this project.');
  });

  it('refuses the link, and records nothing, when a hook changed after the card', async () => {
    // Purpose: the card text binds the yes; a changed declaration voids it.
    const shown = await service().describeApproval({ path: work, scope: 'global' });
    await writeFile(path.join(work, 'hooks', 'hooks.json'), hooksJson([STOP, PRE]));

    const err = await refusal(
      service().link({ path: work, scope: 'global', via: 'agent-card', expectedChange: shown })
    );

    expect(err.code).toBe('dev_link_changed');
    expect(consent.entries).toEqual(['other@global-aaaa', 'other@bbbb']);
  });
});

describe('the link card binds when each hook runs, not just its command', () => {
  it('refuses a link whose hook moved to another event after the card', async () => {
    // Purpose: the summary line names commands but not events. A hook moved
    // from Stop (once, at the end) to PreToolUse (before every tool call) is a
    // different approval, so the card lists each hook in full and binds it.
    const shown = await service().describeApproval({ path: work, scope: 'global' });
    await writeFile(
      path.join(work, 'hooks', 'hooks.json'),
      hooksJson([{ event: 'PreToolUse', command: STOP.command }])
    );

    const err = await refusal(
      service().link({ path: work, scope: 'global', via: 'agent-card', expectedChange: shown })
    );

    expect(err.code).toBe('dev_link_changed');
  });
});

describe('global scope: the link-time global-activation yes', () => {
  it('loads into sessions without a held-back card, and touches no other entry', async () => {
    // Purpose: D1=A. The card's yes is the global consent for what it showed.
    expect((await service().link({ path: work, scope: 'global', via: 'app' })).state).toBe(
      'active'
    );

    expect(await globalDecision()).toBe('activate');
    expect(consent.entries.slice(0, 2)).toEqual(['other@global-aaaa', 'other@bbbb']);
    expect(consent.entries).toHaveLength(3);
  });

  it('holds the folder back once it declares a new hook', async () => {
    // Purpose: anything new asks through its usual card.
    await service().link({ path: work, scope: 'global', via: 'app' });
    await writeFile(path.join(work, 'hooks', 'hooks.json'), hooksJson([STOP, PRE]));

    expect(await globalDecision()).toBe('unasked (changed)');
  });

  it('keeps loading after an edit to a script a hook runs', async () => {
    // Purpose: editing never asks.
    await service().link({ path: work, scope: 'global', via: 'app' });
    await writeFile(path.join(work, 'hooks', 'loop.sh'), 'echo two\n');

    expect(await globalDecision()).toBe('activate');
  });

  it('records nothing for a folder whose hooks cannot all be read', async () => {
    // Purpose: never more than the card showed. An unreadable declaration was
    // not on the card, so no yes covers the folder.
    // One hook the card can show, and one of a kind it cannot: it runs, but
    // only the first is on the card.
    await writeFile(
      path.join(work, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'echo ok' },
                { type: 'prompt', prompt: 'Keep going' },
              ],
            },
          ],
        },
      })
    );
    await service().link({ path: work, scope: 'global', via: 'app' });

    expect(consent.entries).toEqual(['other@global-aaaa', 'other@bbbb']);
    expect(await globalDecision()).toBe('unreadable');
  });

  it("parks the installed copy's approval and puts it back verbatim on unlink", async () => {
    // Purpose: unlink restores the installed copy's consent, so it is not held
    // back, and takes back only the link's own.
    const slot = path.join(home, 'plugins', 'flow');
    await writePlugin(slot, [PRE], '0.9.0');
    await writeInstallMetadata(slot, {
      name: 'flow',
      version: '0.9.0',
      type: 'plugin',
      installedAt: '2026-10-01T00:00:00.000Z',
      contentHash: `sha256:${'a'.repeat(64)}`,
    });
    const reading = await readActivationState(slot);
    if ('unreadable' in reading || reading.subject === null) throw new Error('fixture');
    const installedEntry = globalActivationEntry(
      'flow',
      reading.effects,
      bindingOf(reading.subject)
    );
    consent.entries.push(installedEntry);
    expect(await globalDecision()).toBe('activate');

    await service().link({ path: work, scope: 'global', replaceInstalled: true, via: 'app' });
    const reg = await readDevLinks(home);
    expect('links' in reg && reg.links[0]?.restoreApprovals?.globalActivation).toEqual([
      installedEntry,
    ]);
    expect(consent.entries).not.toContain(installedEntry);
    expect(await globalDecision()).toBe('activate');

    expect((await service().unlink({ name: 'flow', scope: 'global' })).restored).toBe('installed');

    expect(consent.entries).toEqual(['other@global-aaaa', 'other@bbbb', installedEntry]);
    expect(await globalDecision()).toBe('activate');
  });

  it("does not put the installed copy's approval back when that copy did not come back", async () => {
    // Purpose: a restored approval must be about what is in the slot. With the
    // set-aside copy gone, nothing comes back, and neither does its approval.
    const slot = path.join(home, 'plugins', 'flow');
    await writePlugin(slot, [PRE], '0.9.0');
    consent.entries.push('flow@global-installed');

    await service().link({ path: work, scope: 'global', replaceInstalled: true, via: 'app' });
    await rm(`${slot}.dorkos-devlink-parked`, { recursive: true, force: true });

    expect((await service().unlink({ name: 'flow', scope: 'global' })).restored).toBe('removed');
    expect(consent.entries).toEqual(['other@global-aaaa', 'other@bbbb']);
  });

  it("drops the link's yes on unlink when nothing comes back", async () => {
    // Purpose: no consent outlives the dev link it was given to.
    await service().link({ path: work, scope: 'global', via: 'app' });
    await service().unlink({ name: 'flow', scope: 'global' });

    expect(consent.entries).toEqual(['other@global-aaaa', 'other@bbbb']);
  });

  it('takes the yes back when the link fails after recording it', async () => {
    // Purpose: rollback leaves the decision lists as they were.
    await mkdir(path.join(work, '.dork', 'extensions', 'flow-dash'), { recursive: true });
    await writeFile(
      path.join(work, '.dork', 'extensions', 'flow-dash', 'extension.json'),
      JSON.stringify({ id: 'flow-dash', name: 'flow-dash', version: '1.0.0' })
    );
    const failing = new DevLinkService({
      dorkHome: home,
      consent,
      approvals: {
        read: () => structuredClone(approvals),
        write: () => {
          throw new Error('config write failed');
        },
      },
      onPluginsChanged: () => undefined,
      refreshExtensions: () => undefined,
      boundary: () => base,
    });

    await expect(failing.link({ path: work, scope: 'global', via: 'app' })).rejects.toThrow(
      'config write failed'
    );
    expect(consent.entries).toEqual(['other@global-aaaa', 'other@bbbb']);
  });
});

describe('project scope: the link-time hook yes', () => {
  it('approves the hooks the card showed, for this project only', async () => {
    // Purpose: D1=A for a project. The projection that follows the link does
    // not ask about the hooks the person just approved.
    await service().link({ path: work, scope: 'project', projectPath: project, via: 'app' });

    expect(projectHooksApproved()).toBe(true);
    expect(consent.entries.filter((e) => e.includes('@global-'))).toEqual(['other@global-aaaa']);
  });

  it('asks again once the folder adds a hook', async () => {
    // Purpose: a new declaration is a different decision.
    await service().link({ path: work, scope: 'project', projectPath: project, via: 'app' });
    await writeFile(path.join(work, 'hooks', 'hooks.json'), hooksJson([STOP, PRE]));

    expect(projectHooksApproved()).toBe(false);
  });

  it('keeps hooks approved after an edit to a script they run', async () => {
    // Purpose: editing never asks.
    await service().link({ path: work, scope: 'project', projectPath: project, via: 'app' });
    await writeFile(path.join(work, 'hooks', 'loop.sh'), 'echo two\n');

    expect(projectHooksApproved()).toBe(true);
  });

  it('removes on unlink only the approval the link added', async () => {
    // Purpose: unlink takes back the link's own consent and nothing else.
    await service().link({ path: work, scope: 'project', projectPath: project, via: 'app' });
    const reg = await readDevLinks(home);
    const granted = 'links' in reg ? reg.links[0]?.grantedHooks : undefined;
    expect(granted).toHaveLength(1);

    await service().unlink({ name: 'flow', scope: 'project', projectPath: project });

    expect(consent.entries).toEqual(['other@global-aaaa', 'other@bbbb']);
  });

  it("leaves the installed copy's approval for the same hooks in place", async () => {
    // Purpose: an approval that was there before the link was never the
    // link's, so unlink must not take it.
    const slot = path.join(project, '.dork', 'plugins', 'flow');
    await writePlugin(slot, [STOP], '0.9.0');
    const [request] = scanHookRequests(project, home);
    if (!request) throw new Error('fixture');
    const installedEntry = hookApprovalEntry(request);
    consent.entries.push(installedEntry);

    await service().link({
      path: work,
      scope: 'project',
      projectPath: project,
      replaceInstalled: true,
      via: 'app',
    });
    expect(projectHooksApproved()).toBe(true);
    const reg = await readDevLinks(home);
    expect('links' in reg && reg.links[0]?.grantedHooks).toBeUndefined();

    expect(
      (await service().unlink({ name: 'flow', scope: 'project', projectPath: project })).restored
    ).toBe('installed');
    expect(consent.entries).toContain(installedEntry);
    expect(projectHooksApproved()).toBe(true);
  });

  it('records no hook approval when the folder projects a hook the card did not show', async () => {
    // Purpose: never more than the card. The folder can change between the
    // card check and the scan the approval is computed from; a hook that only
    // the scan saw must leave the hooks to ask.
    const preview = await service().preview({ path: work, scope: 'project', projectPath: project });
    await service().link({ path: work, scope: 'project', projectPath: project, via: 'app' });
    const reg = await readDevLinks(home);
    const record = 'links' in reg ? reg.links[0] : undefined;
    if (!record) throw new Error('fixture');
    consent.entries = [];
    await writeFile(path.join(work, 'hooks', 'hooks.json'), hooksJson([STOP, PRE]));

    const plan = planLinkConsent(consent, {
      preview,
      record,
      declarationsReadable: true,
      dorkHome: home,
    });

    expect(plan.grantedHooks).toEqual([]);
  });
});
