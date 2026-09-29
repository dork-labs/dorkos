import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Where each Claude account may work, in a real browser (spec
 * `flow-multiproject` §8.5, §12 Phase 3 "Browser").
 *
 * Two Claude accounts are registered and one is kept to project A. Then:
 *
 * 1. in a new chat in project B, the pre-launch account picker shows that
 *    account DISABLED with the line "Only for <A>" — shown with why, not hidden;
 * 2. Settings → Runtimes shows "Only for <A>" on that account's row.
 *
 * **Never sends a message.** The picker is the PRE-launch chip, and this leg
 * runs the real claude-code runtime (test-mode declares `supportsAccounts:
 * false`, so the chip never appears there). A send would start a real,
 * billable turn, so nothing here ever presses send.
 *
 * **Everything it registers is put back.** The account registry and the
 * account rule are global to the server the whole suite shares, so the
 * `finally` restores both whatever the test's verdict, and the account folders
 * and repositories live under the run's own `agentRoot`, which `roomsApi`
 * removes. SERIAL for the same reason: the registry is one global setting.
 */
test.describe.configure({ mode: 'serial' });

const run = promisify(execFile);

/** One registry row as `GET /api/config` reads it back. */
interface ReadAccountRow {
  id: string;
  path: string;
  label: string | null;
  color: string;
  colorIsDefault?: boolean;
  /** Read back named (`{ root, name }`), stored as roots. */
  onlyProjects?: { root: string; name: string }[] | null;
}

/** The curated config block this file reads. */
interface ConfigView {
  claudeCode?: { accounts?: ReadAccountRow[] };
}

/** One account as a project's rules see it (`GET …/account-eligibility`). */
interface EligibilityRow {
  id: string;
  eligible: boolean;
  onlyProjects: { root: string; name: string }[] | null;
}

/** The eligibility answer for one folder. */
interface EligibilityView {
  project: { root: string; name: string } | null;
  allow: string[] | null;
  accounts: EligibilityRow[];
}

/**
 * The registry rows as they are stored, from the curated read, so the restore
 * writes back what this server HAD — a row whose color follows its position
 * keeps following it (`color: null`), rather than freezing today's default.
 *
 * @param request - Playwright's request fixture, based at the cockpit leg.
 */
async function readStoredAccounts(request: APIRequestContext) {
  const response = await request.get('/api/config');
  expect(response.ok()).toBe(true);
  const { claudeCode } = (await response.json()) as ConfigView;
  return (claudeCode?.accounts ?? []).map((row) => ({
    id: row.id,
    path: row.path,
    label: row.label,
    color: row.colorIsDefault ? null : row.color,
    // The read names each project; the stored shape is its root, so the
    // restore writes roots (or null), never the named form.
    ...(row.onlyProjects !== undefined
      ? { onlyProjects: row.onlyProjects === null ? null : row.onlyProjects.map((p) => p.root) }
      : {}),
  }));
}

/**
 * Write the whole Claude account registry.
 *
 * @param request - Playwright's request fixture.
 * @param accounts - The rows to store.
 */
async function writeAccounts(request: APIRequestContext, accounts: unknown[]): Promise<void> {
  const response = await request.patch('/api/config', {
    data: { runtimes: { claudeCode: { accounts } } },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/**
 * Read which accounts may work in `folder`'s project.
 *
 * @param request - Playwright's request fixture.
 * @param folder - The folder to ask about.
 */
async function readEligibility(
  request: APIRequestContext,
  folder: string
): Promise<EligibilityView> {
  const response = await request.get(
    `/api/runtimes/claude-code/account-eligibility?project=${encodeURIComponent(folder)}`
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as EligibilityView;
}

test.describe('Claude account project limits @smoke', () => {
  test('an account kept to project A is disabled in B, and Settings says "Only for A"', async ({
    page,
    basePage,
    settingsPage,
    request,
    roomsApi,
  }) => {
    // Boots a chat and Settings on a cold cockpit; the default 30s is too tight.
    test.setTimeout(120_000);
    const runId = roomsApi.runId;
    const root = roomsApi.agentRoot;

    // Two real git main checkouts — a project is a repository.
    const repoA = join(root, `proj-a-${runId}`);
    const repoB = join(root, `proj-b-${runId}`);
    for (const repo of [repoA, repoB]) {
      await mkdir(repo, { recursive: true });
      await run('git', ['init', '-q'], { cwd: repo });
    }

    // Two account folders; `projects/` is what makes a folder count as one.
    const alpha = {
      id: `e2e-alpha-${runId}`,
      path: join(root, `acct-alpha-${runId}`),
      label: `Alpha ${runId}`,
      color: null,
    };
    const beta = {
      id: `e2e-beta-${runId}`,
      path: join(root, `acct-beta-${runId}`),
      label: `Beta ${runId}`,
      color: null,
    };
    for (const account of [alpha, beta]) {
      await mkdir(join(account.path, 'projects'), { recursive: true });
    }

    const priorAccounts = await readStoredAccounts(request);
    let restricted = false;
    try {
      await writeAccounts(request, [...priorAccounts, alpha, beta]);

      // Keep Alpha to project A — a person's write (no X-DorkOS-Agent header).
      const restrict = await request.put(
        `/api/runtimes/claude-code/accounts/${alpha.id}/only-projects`,
        { data: { projects: [repoA] } }
      );
      expect(restrict.ok(), await restrict.text()).toBe(true);
      restricted = true;

      // The server's own answer, which the UI has to agree with.
      const inB = await readEligibility(request, repoB);
      expect(inB.project?.name).toBe(`proj-b-${runId}`);
      const alphaInB = inB.accounts.find((row) => row.id === alpha.id);
      const betaInB = inB.accounts.find((row) => row.id === beta.id);
      expect(alphaInB?.eligible).toBe(false);
      expect(betaInB?.eligible).toBe(true);
      expect(alphaInB?.onlyProjects).toHaveLength(1);
      const nameA = alphaInB!.onlyProjects![0]!.name;
      expect(nameA).toBe(`proj-a-${runId}`);
      const onlyForA = `Only for ${nameA}`;

      const inA = await readEligibility(request, repoA);
      expect(inA.accounts.find((row) => row.id === alpha.id)?.eligible).toBe(true);

      // --- 1. The pre-launch picker in a new chat in project B ---
      await page.goto(`/session?dir=${encodeURIComponent(repoB)}`);
      await basePage.waitForAppReady();

      // The account chip (the only status-bar button carrying `data-state-tone`).
      // Before launch it is the picker, a menu trigger — not the popover chip.
      // Not `data-slot="account-chip"`: the menu trigger's own `data-slot`
      // rides the Slot props onto the button and wins.
      const chip = page
        .getByRole('toolbar', { name: 'Session status' })
        .locator('button[data-state-tone]');
      await expect(chip).toBeVisible({ timeout: 30_000 });
      await expect(chip).toHaveAttribute('aria-haspopup', 'menu');
      await chip.click();

      const menu = page.getByRole('menu');
      await expect(menu.getByTestId('account-scope-note')).toBeVisible();
      const alphaItem = menu.getByRole('menuitemradio', { name: new RegExp(alpha.label) });
      const betaItem = menu.getByRole('menuitemradio', { name: new RegExp(beta.label) });
      await expect(alphaItem).toBeVisible();
      await expect(alphaItem).toHaveAttribute('aria-disabled', 'true');
      await expect(alphaItem).toContainText(onlyForA);
      // Beta may work here: enabled, and says nothing about projects.
      await expect(betaItem).toBeVisible();
      await expect(betaItem).not.toHaveAttribute('aria-disabled', 'true');
      await expect(betaItem).not.toContainText('Only for');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      // --- 2. Settings → Runtimes: the restricted account's row ---
      await page.goto('/?settings=runtimes');
      await basePage.waitForAppReady();
      const card = settingsPage.runtimeCard('claude-code');
      await expect(card).toBeVisible({ timeout: 30_000 });
      const body = settingsPage.runtimeCardBody('claude-code');
      if (!(await body.isVisible())) {
        await settingsPage.runtimeCardToggle('claude-code').click();
      }
      await expect(body).toBeVisible();

      const alphaRow = body.getByTestId('claude-account-row').filter({ hasText: alpha.label });
      const betaRow = body.getByTestId('claude-account-row').filter({ hasText: beta.label });
      await expect(alphaRow).toHaveCount(1);
      await expect(alphaRow.getByTestId('claude-account-only-for')).toHaveText(onlyForA);
      await expect(betaRow).toHaveCount(1);
      await expect(betaRow.getByTestId('claude-account-only-for')).toHaveCount(0);
    } finally {
      if (restricted) {
        await request
          .put(`/api/runtimes/claude-code/accounts/${alpha.id}/only-projects`, {
            data: { projects: null },
          })
          .catch(() => {});
      }
      await request
        .patch('/api/config', {
          data: { runtimes: { claudeCode: { accounts: priorAccounts } } },
        })
        .catch(() => {});
      for (const dir of [repoA, repoB, alpha.path, beta.path]) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
});
