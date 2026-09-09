/**
 * The agent profile's Skills page, in a real browser (spec `harness-sync-status`
 * §Testing, "Browser — T7"; contract VC-01, VC-02, TR-08).
 *
 * The unit and route suites own the mechanics — the derivation table, the eight
 * states, the person bar, the sweep as an exact tree diff. What only a browser
 * can answer is whether the page a person opens is really reading their folder:
 * that a skill they can see on disk appears with a chip per tool, that the tool
 * which cannot see one says so in the engine's own sentence rather than a
 * paraphrase, and that the button which deletes files names them first and then
 * actually deletes them.
 *
 * **On the default `chromium` leg, and that is safe.** Every entry on that
 * project's `testIgnore` list is there because the spec needs a different leg,
 * and nine of the fourteen are there for one reason in particular: they would
 * otherwise start a real, billable agent turn. Nothing here starts one — it
 * stages files, registers an agent, reads chips and clicks Sync — exactly like
 * `tests/profile/profile-pushin.spec.ts`, which says the same thing in its own
 * header. Putting it on a test-mode leg would mean a new
 * `playwright.config.ts` project, a new `testIgnore` entry and a second
 * Vite/Express pair booted for nothing; the default project's `*.spec.ts` glob
 * reaches `tests/harness/` already, so this file needed no config change at
 * all.
 *
 * **Floors, never totals.** Today `POST /api/mesh/agents` registers a directory
 * and projects nothing into it — `projectAgentWorkspace` (TR-03) runs for
 * workspaces DorkOS OWNS, under `{dorkHome}/agents`, and a staged fixture is
 * not one — so the tree here holds exactly what the fixture put in it. That is
 * the sort of fact that changes: DOR-1901 widens the agent-creation trigger,
 * and seeding the Operating DorkOS pack into this tree would add skills nobody
 * here asked for. So every count is a lower bound and every skill is named by
 * the fixture, and a widened trigger costs this spec nothing.
 *
 * @module tests/harness/skills-page
 */
import { lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';

/** The slice of `GET /api/harness/status` this spec compares the page against. */
interface StatusResponse {
  /** One entry per agent file, each with what every enabled tool does with it. */
  rows: {
    /** What kind of agent file it is. */
    artifact: string;
    /** Its name. */
    name: string;
    /** One entry per enabled tool, keyed by tool id. */
    cells: Record<string, { state: string; reason?: string } | undefined>;
  }[];
}

/**
 * Whether something is at this path — a broken symlink included.
 *
 * `existsSync` follows the link and answers `false` for one whose target is
 * gone, which is precisely the state this spec has to tell apart from "the link
 * was removed".
 */
function isPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

test.describe('Skills — what each of your tools can see', () => {
  test('VC-01, VC-02: every skill is listed, and the tool that cannot see one says why', async ({
    page,
    request,
    rightPanel,
    roomsApi,
    harnessRepo,
  }) => {
    const repo = await harnessRepo.stage({ harnessNativeSkill: true });
    const agent = await roomsApi.registerAgent(`E2E Skills ${roomsApi.runId}`, '🧰', '#8b5cf6', {
      path: repo.root,
    });

    // The namespace every agent in this run shares is `run-<runId>`, derived by
    // the server from the scan root — so a tree staged outside this run's own
    // agent root registers into somebody else's namespace, with no error
    // anywhere to say so. The stored path is what carries the answer. Compared
    // by the root's own name rather than its full path, because registration
    // canonicalizes what it is given and the two sides would otherwise differ
    // on any machine where a segment above the checkout is a symlink.
    expect(
      agent.projectPath,
      'the staged repository must sit under this run’s agent root, or every agent in the run lands in a namespace of its own'
    ).toContain(basename(roomsApi.agentRoot));

    // Setup, not the subject: bring the tree to the state a synced project is
    // in before the page is opened, so the chips below are the same on a busy
    // machine as on an idle one. The click that does this from the UI is the
    // second test's subject, and this is the same route it calls.
    const synced = await request.post('/api/harness/sync', {
      data: { projectPath: agent.projectPath },
    });
    expect(synced.ok(), await synced.text()).toBe(true);

    await rightPanel.openProfilePage('skills', agent.projectPath);
    const skills = page.locator('[data-slot="profile-skills"]');
    await expect(skills).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // Two rows at least — the skill in the canonical layer and the one kept
    // where only Claude Code looks — and each row is a named group.
    const rows = skills.getByRole('group');
    await expect(rows.nth(1)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    expect(await rows.count()).toBeGreaterThanOrEqual(2);

    // A row every tool is current on collapses to one chip, which is what
    // thirty-one healthy skills need. This is the control that opens them all.
    await skills.getByRole('switch', { name: 'Show every agent tool' }).click();

    const canonical = skills.getByRole('group', { name: repo.canonicalSkill, exact: true });
    await expect(canonical.getByRole('listitem', { name: 'Codex reads it' })).toBeVisible();
    await expect(canonical.getByRole('listitem', { name: 'Claude Code shared' })).toBeVisible();

    const harnessNativeSkill = repo.harnessNativeSkill();
    const harnessNative = skills.getByRole('group', { name: harnessNativeSkill, exact: true });
    await expect(
      harnessNative.getByRole('listitem', { name: 'Claude Code reads it' })
    ).toBeVisible();
    await expect(harnessNative.getByRole('listitem', { name: 'Codex can’t see it' })).toBeVisible();
    // The advice names the folder the row is actually in (DOR-1902: it is
    // `.opencode/skills` for an OpenCode-first repo), so the expected sentence
    // is built the way the row builds it, from the source path's parent, rather
    // than quoted — the folder here is `.claude/skills` because that is where
    // the fixture staged this skill.
    const adoptableFolder = '.claude/skills';
    await expect(harnessNative).toContainText(
      `Lives in ${adoptableFolder}. Move it to .agents/skills so every agent can read it.`
    );

    // The honesty gate. The reason is read off the API and compared with what
    // the panel draws, so this fails on a paraphrase rather than on a wording
    // this spec happens to know — which is the whole promise: the terminal
    // prints the same string.
    const status = await request.get('/api/harness/status', {
      params: { projectPath: agent.projectPath },
    });
    expect(status.ok(), await status.text()).toBe(true);
    const body = (await status.json()) as StatusResponse;
    const droppedRow = body.rows.find(
      (row) => row.artifact === 'skill' && row.name === harnessNativeSkill
    );
    const reason = droppedRow?.cells.codex?.reason;
    expect(reason, 'the status has no Codex reason for the .claude/skills skill').toBeDefined();

    const codexPanel = skills
      .locator('[data-slot="collapsible-field-card"]')
      .filter({ hasText: 'Not shared with Codex' });
    await codexPanel.getByRole('button', { name: /Not shared with Codex/ }).click();
    await expect(codexPanel).toContainText(`skill ${harnessNativeSkill}`);
    await expect(codexPanel).toContainText(reason as string);
  });

  test('TR-08: the banner names every file a sync removes, and the click removes them', async ({
    page,
    rightPanel,
    roomsApi,
    harnessRepo,
  }) => {
    const repo = await harnessRepo.stage({ orphanedLink: true });
    const agent = await roomsApi.registerAgent(`E2E Sync ${roomsApi.runId}`, '🧹', '#0ea5e9', {
      path: repo.root,
    });
    const orphan = repo.orphanedLink();

    await rightPanel.openProfilePage('skills', agent.projectPath);

    // The banner is here because of the ORPHAN, which is what makes this
    // deterministic: the skills watcher (DOR-1850) may re-project this tree at
    // any moment and repair the missing link, but it never sweeps, so the dead
    // link — and the banner over it — survive until somebody clicks.
    const banner = page.locator('[data-slot="harness-drift-banner"]');
    await expect(banner).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(banner).toContainText('Some agent files are out of date.');

    // Named BEFORE the click, with the reason each one goes.
    const disclosure = banner.getByRole('button', { name: /Syncing also removes/ });
    await expect(disclosure).toContainText('Syncing also removes 1 file DorkOS put here');
    await disclosure.click();
    await expect(banner).toContainText(orphan);
    await expect(banner).toContainText('The skill this link pointed to is gone.');

    await banner.getByRole('button', { name: 'Sync now' }).click();

    // And named again after it, in the banner's place. The count of files
    // WRITTEN is deliberately not asserted: the watcher may have written the
    // missing link a moment before the click, which is a race about who did the
    // repair and not about whether it happened. The end state below is what
    // this spec is entitled to claim.
    const summary = page.locator('[data-slot="harness-sync-summary"]');
    await expect(summary).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(summary).toContainText('Agent files updated.');
    await expect(summary).toContainText('Removed 1 file DorkOS put here:');
    await expect(summary).toContainText(orphan);
    await expect(summary).toContainText('The skill this link pointed to is gone.');

    // On disk, which is the only place this is true or false.
    expect(isPresent(join(repo.root, orphan)), `${orphan} should be gone`).toBe(false);
    expect(
      lstatSync(join(repo.root, repo.projectedLink)).isSymbolicLink(),
      `${repo.projectedLink} should be a link to the canonical skill`
    ).toBe(true);

    // Put the receipt away and there is nothing left to warn about — which is
    // the assertion a banner rendered unconditionally cannot pass.
    await summary.getByRole('button', { name: 'Dismiss what changed' }).click();
    await expect(summary).toHaveCount(0);
    await expect(banner).toHaveCount(0);
  });
});
