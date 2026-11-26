/**
 * @vitest-environment node
 *
 * Global packages held back from chats until a person reviews them (DOR-2306,
 * I2), and keeping the files an update could not sort (DOR-2341). Login is
 * off here; the signed-in bars are in `marketplace.signed-in.test.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KEPT_SKILL,
  installHeldBack,
  installWithKeptSkill,
  keepKeyOf,
  unprovenOnDisk,
  useMarketplaceRoutes,
} from './marketplace.fixtures.js';
import { wireTestConsent } from '../../../services/core/approvals/computer-asks/__tests__/wire-test-asks.js';

// The space side's consent writes reach a config store, as at startup.
beforeAll(() => wireTestConsent());

const h = useMarketplaceRoutes();

const heldBackNames = async () =>
  (await h.get('/held-back')).body.packages.map((p: { name: string }) => p.name);

/** What the held-back listing shows about `name`. */
async function shownHeldBack(name = 'flow'): Promise<{ effects: object; bindsTo: string }> {
  const listed = await h.get('/held-back');
  return listed.body.packages.find((p: { name: string }) => p.name === name);
}

describe('held-back global packages', () => {
  it('lists it, and marks its Installed row so it never vanishes without a word', async () => {
    await installHeldBack(h.dorkHome, 'held');

    const listed = await h.get('/held-back');
    const installed = await h.get('/installed');

    expect(listed.body.packages).toEqual([
      expect.objectContaining({
        name: 'held',
        reason: 'unasked',
        reviewable: true,
        bindsTo: expect.stringMatching(/^sha256:/),
      }),
    ]);
    const row = installed.body.packages.find((p: { name: string }) => p.name === 'held');
    expect(row.heldBack).toMatchObject({ reason: 'unasked', reviewable: true });
  });

  it('raises its card on request, and says why when there is nothing to review', async () => {
    await installHeldBack(h.dorkHome, 'held');

    const asked = await h.post('/held-back/held/review');
    const missing = await h.post('/held-back/nope/review');

    expect(asked.status).toBe(202);
    expect(h.approvals.listPending()).toEqual([
      expect.objectContaining({ capabilityId: 'marketplace.activate_global_plugin' }),
    ]);
    expect(missing.status).toBe(409);
    expect(missing.body.detail).toBe('This package has nothing to review right now.');
  });

  it('takes a decision only from the person, bound to what they were shown', async () => {
    await installHeldBack(h.dorkHome, 'held');
    const shown = await shownHeldBack('held');
    const decide = (bindsTo: string) =>
      h.post('/held-back/held/decision', { decision: 'allow', effects: shown.effects, bindsTo });

    h.agentHeader = 'agent-token';
    const byAgent = await decide(shown.bindsTo);
    expect(byAgent.status).toBe(403);
    expect(byAgent.body.code).toBe('operator_only');

    h.agentHeader = undefined;
    expect((await decide('sha256:other')).status).toBe(412);
    expect(await heldBackNames()).toEqual(['held']);

    expect((await decide(shown.bindsTo)).status).toBe(204);
    expect(await heldBackNames()).toEqual([]);
  });
});

describe('POST /packages/:name/keep-files (DOR-2341)', () => {
  const keep = (body: object, name = 'flow') => h.post(`/packages/${name}/keep-files`, body);

  it('refuses an agent, writing nothing', async () => {
    // Claiming files decides what every later update keeps.
    const root = await installWithKeptSkill(h.dorkHome);
    const keepKey = await keepKeyOf(h);

    h.agentHeader = 'agent-token';
    const res = await keep({ keepKey });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only');
    expect(await unprovenOnDisk(root)).toBeDefined();
  });

  it('refuses a key that no longer matches what is on disk', async () => {
    // The yes covers exactly the bytes shown.
    const root = await installWithKeptSkill(h.dorkHome);
    const keepKey = await keepKeyOf(h);
    writeFileSync(join(root, 'skills', 'old', 'SKILL.md'), `${KEPT_SKILL}edited`);

    const res = await keep({ keepKey });

    expect(res.status).toBe(412);
    expect(res.body.code).toBe('precondition_failed');
    expect(await unprovenOnDisk(root)).toBeDefined();
  });

  it('keeps the files, deletes nothing, and approves what the person was shown', async () => {
    // For a package held back because a kept file runs, the yes made after
    // seeing what it runs also approves it, exactly as a Review would.
    const root = await installWithKeptSkill(h.dorkHome);
    const keepKey = await keepKeyOf(h);
    const shown = await shownHeldBack();

    const res = await keep({ keepKey, review: { effects: shown.effects, bindsTo: shown.bindsTo } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'kept', approved: true });
    expect(res.body.message).toBe(
      'The file flow kept is yours now. Nothing was moved or deleted. flow loads into chats from the next message on.'
    );
    expect(await unprovenOnDisk(root)).toBeUndefined();
    expect(readFileSync(join(root, 'skills', 'old', 'SKILL.md'), 'utf8')).toBe(KEPT_SKILL);
    expect(await heldBackNames()).toEqual([]);
  });

  it('keeps the files but approves nothing it was not shown, and says it still waits', async () => {
    const root = await installWithKeptSkill(h.dorkHome);
    const keepKey = await keepKeyOf(h);
    const shown = await shownHeldBack();

    const unshown = await keep({ keepKey });
    expect(unshown.status).toBe(200);
    expect(unshown.body).toMatchObject({ outcome: 'kept', approved: false });
    expect(unshown.body.message).toBe(
      'The file flow kept is yours now. Nothing was moved or deleted. flow still waits for your Review before it runs in chats.'
    );
    expect(await unprovenOnDisk(root)).toBeUndefined();

    const other = await installWithKeptSkill(h.dorkHome, 'other');
    const stale = await keep(
      {
        keepKey: await keepKeyOf(h, 'other'),
        review: { effects: shown.effects, bindsTo: 'sha256:other' },
      },
      'other'
    );
    expect(stale.body).toMatchObject({ outcome: 'kept', approved: false });
    expect(await unprovenOnDisk(other)).toBeUndefined();
    expect(await heldBackNames()).toEqual(expect.arrayContaining(['flow', 'other']));
  });

  it('answers not-needed when nothing is kept, and 404 for a package not installed', async () => {
    await installWithKeptSkill(h.dorkHome);
    const keepKey = await keepKeyOf(h);
    await keep({ keepKey });

    const again = await keep({ keepKey });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('not-needed');
    expect((await keep({ keepKey }, 'nowhere')).status).toBe(404);
  });
});
