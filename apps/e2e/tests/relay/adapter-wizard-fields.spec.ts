import { test, expect, type Page } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';

/**
 * Every setting a real adapter declares must be reachable in the setup wizard.
 *
 * This drives the manifests the server actually serves, not a transcription of
 * them, because the defect it locks down (DOR-640) was invisible to every unit
 * test: the wizard rendered only the fields the current setup step named and
 * dropped the rest, so Slack's DM policy and both adapters' approver lists —
 * which decide who may message an agent and who may approve what it runs — never
 * reached a screen in either the add flow or Configure.
 */

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/** Adapter categories a person manages from the Connections page. */
const EXTERNAL_CATEGORIES = new Set(['messaging', 'automation']);

/**
 * The slice of the served catalog this spec reads.
 *
 * Declared locally rather than imported: `apps/e2e` deliberately does not depend
 * on the workspace packages, so the shape is asserted against the live API
 * response instead of a compile-time type.
 */
interface CatalogEntry {
  manifest: {
    type: string;
    displayName: string;
    category: string;
    setupSteps?: Array<{ fields: string[] }>;
    configFields: Array<{ key: string; label: string; showWhen?: unknown }>;
  };
  instances: Array<{ id: string; config?: Record<string, unknown> }>;
}

/** The catalog the server serves — the same JSON the cockpit renders from. */
async function fetchCatalog(page: Page): Promise<CatalogEntry[]> {
  const response = await page.request.get('/api/relay/adapters/catalog');
  expect(response.ok(), 'catalog request failed').toBe(true);
  return (await response.json()) as CatalogEntry[];
}

/**
 * Opens the Messaging region of the Connections page — where the adapters this
 * spec drives now live.
 *
 * Integrations left the Settings dialog and became half of the Connections page
 * (DOR-857). `?settings=integrations` still resolves, but only as a *redirect*
 * to this page, so waiting on the Settings dialog after it waits forever. This
 * goes to the destination directly; `?region=messaging` is the search param the
 * page reads to scroll the half we want into view.
 */
async function openMessagingRegion(page: Page) {
  await page.goto('/connections?region=messaging');
  await new BasePage(page).waitForAppReady();
  await expect(page.getByRole('button', { name: 'Add Slack' })).toBeVisible();
}

/** The setup wizard dialog, whichever adapter it was opened for. */
function wizard(page: Page) {
  return page.getByRole('dialog', { name: /^(Add|Edit) / });
}

/**
 * Opens Configure on one already-added adapter.
 *
 * Every per-adapter action moved behind a kebab menu whose label reads
 * "Connection actions" on every card (DOR-857), so there is no longer a
 * "Configure <name>" button to click and nothing in the menu distinguishes one
 * card from another. The card's own test id is what picks the right one.
 *
 * @param adapterId - The instance id the adapter was created with.
 */
async function openConfigure(page: Page, adapterId: string) {
  const card = page.getByTestId(`adapter-card-${adapterId}`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Connection actions' }).click();
  await page.getByRole('menuitem', { name: 'Configure' }).click();
}

/**
 * Get past the wizard's first question.
 *
 * Adding a connection asks who answers before it asks for any setting
 * (DOR-857), so every assertion about the configure step has to walk through
 * it. The step wears one of two faces depending on how many agents exist: a
 * picker to choose from, or a line naming the only one there is.
 *
 * Both faces arrive with the agent list, so this waits for one of them instead
 * of branching on a bare `count()`. `count()` does not auto-wait, so a list
 * that had not resolved yet read as "there is no agent step at all" — this
 * returned having advanced nothing, and the caller then reported the configure
 * step as hiding every field the adapter declares. A defect in the wait,
 * reported as a defect in the wizard.
 */
async function pastAgentStep(page: Page) {
  const dialog = wizard(page);
  const agentQuestion = dialog.getByLabel('Who should answer?');
  const namedAgent = dialog.getByText(/will answer\.$/);
  const agentStep = agentQuestion.or(namedAgent).first();

  await expect(agentStep).toBeVisible();

  if ((await agentQuestion.count()) > 0) {
    await agentQuestion.click();
    await page.getByRole('option').first().click();
  }
  const next = dialog.getByRole('button', { name: 'Continue' });
  await expect(next).toBeEnabled();
  await next.click();

  // Leaving is what the caller is actually waiting for. Without this, labels
  // can be read off the step this function was supposed to have left behind.
  await expect(agentStep).toBeHidden();
}

/**
 * The name a field presents, with the required marker taken back off.
 *
 * A required field's label carries a real asterisk node (DOR-651) rather than
 * CSS generated content, so the label now reads "Bot Token\n*" and an exact
 * match against the manifest's `label` misses every required field — reporting
 * each one as a field the wizard never renders. The marker's own shape is
 * ConfigFieldInput's business; this sweep only asks whether the field arrived.
 *
 * @param raw - The label's rendered text.
 */
function fieldName(raw: string): string {
  return raw
    .replace(/\s*\*\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Walks every configure step of the open wizard and returns the field labels it
 * rendered along the way. Stops before the last Continue so the wizard never
 * leaves the configure step to test a connection with a made-up token.
 */
async function labelsAcrossSteps(page: Page, stepCount: number): Promise<Set<string>> {
  const dialog = wizard(page);
  const seen = new Set<string>();

  for (let step = 0; step < Math.max(stepCount, 1); step++) {
    // A step's fields paint a tick after the previous one leaves. Reading the
    // instant the transition starts collects an empty step and reports every
    // field on it as one the wizard never renders — the exact claim this spec
    // exists to make, arrived at without ever having looked.
    await expect(dialog.locator('label').first()).toBeVisible();

    for (const label of await dialog.locator('label').all()) {
      const text = fieldName(await label.innerText());
      if (text) seen.add(text);
    }
    if (step === Math.max(stepCount, 1) - 1) break;

    // Required fields block Continue; any non-empty value clears them.
    for (const box of await dialog.getByRole('textbox').all()) {
      if ((await box.inputValue()) === '') await box.fill('placeholder');
    }
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog.getByText(/is required/)).toHaveCount(0);
  }

  return seen;
}

test.describe('Adapter setup wizard — every declared field reaches a screen', () => {
  test('the Slack access controls render in the add wizard', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openMessagingRegion(page);

    await page.getByRole('button', { name: 'Add Slack' }).click();
    const dialog = wizard(page);
    await expect(dialog).toBeVisible();
    await pastAgentStep(page);

    // The section that collects the fields no setup step names.
    await expect(dialog.getByRole('heading', { name: 'Access Control' })).toBeVisible();
    // The two security controls the defect hid (DOR-604, DOR-609).
    await expect(dialog.getByText('DM Access')).toBeVisible();
    await expect(dialog.getByLabel('Approvers')).toBeVisible();
    // And the rest of the stranded set.
    await expect(dialog.getByText('Respond Mode')).toBeVisible();
    await expect(dialog.getByLabel('Slack channel settings')).toBeVisible();

    // The fields the step does name are still there, above the new section.
    await expect(dialog.getByLabel('Bot Token')).toBeVisible();
    await expect(dialog.getByLabel('App-Level Token')).toBeVisible();
  });

  test('surfacing the DM policy leaves it on its safe default', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openMessagingRegion(page);
    await page.getByRole('button', { name: 'Add Slack' }).click();
    await pastAgentStep(page);

    const dialog = wizard(page);
    await expect(dialog.getByRole('radio', { name: /Allowlist only/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(dialog.getByRole('radio', { name: /Open \(anyone\)/ })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    // Nobody may approve until someone is named — the empty default holds.
    await expect(dialog.getByLabel('Approvers')).toHaveValue('');
  });

  test('Configure surfaces the fields on a config saved before they existed', async ({ page }) => {
    // A Slack instance whose stored config predates dmPolicy and
    // approverAllowlist — the population the defect actually stranded. Added
    // disabled so no Slack connection is attempted.
    const created = await page.request.post('/api/relay/adapters', {
      data: {
        type: 'slack',
        id: 'slack-legacy-config',
        enabled: false,
        label: 'Legacy workspace',
        config: {
          botToken: 'xoxb-not-a-real-token',
          appToken: 'xapp-not-a-real-token',
          signingSecret: 'not-a-real-secret',
          streaming: true,
        },
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    try {
      await page.setViewportSize(DESKTOP);
      await openMessagingRegion(page);

      await openConfigure(page, 'slack-legacy-config');
      const dialog = wizard(page);
      await expect(dialog.getByText('Edit Slack')).toBeVisible();

      // The stored config never carried these keys. They open on the manifest's
      // declared defaults, which are the safe ones.
      await expect(dialog.getByRole('heading', { name: 'Access Control' })).toBeVisible();
      await expect(dialog.getByRole('radio', { name: /Allowlist only/ })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      await expect(dialog.getByLabel('Approvers')).toHaveValue('');

      // An approver typed here is editable — the point of the whole fix.
      await dialog.getByLabel('Approvers').fill('U01ABC123');
      await expect(dialog.getByLabel('Approvers')).toHaveValue('U01ABC123');
    } finally {
      await page.request.delete('/api/relay/adapters/slack-legacy-config');
    }
  });

  test('a stored approver list survives being edited', async ({ page }) => {
    // The population the wizard used to mangle: values ALREADY on disk. An array
    // handed straight to a textarea renders as `a,b` on one line, and saving that
    // collapsed both ids into one bogus entry — silently revoking both approvers.
    const created = await page.request.post('/api/relay/adapters', {
      data: {
        type: 'slack',
        id: 'slack-stored-values',
        enabled: false,
        label: 'Stored values',
        config: {
          botToken: 'xoxb-not-a-real-token',
          appToken: 'xapp-not-a-real-token',
          signingSecret: 'not-a-real-secret',
          approverAllowlist: ['U01ABC123', 'U02DEF456'],
          dmAllowlist: ['U01ABC123', 'U02DEF456'],
          channelOverrides: { C01ABC: { respondMode: 'always' } },
        },
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    try {
      await page.setViewportSize(DESKTOP);
      await openMessagingRegion(page);
      await openConfigure(page, 'slack-stored-values');
      const dialog = wizard(page);

      // One id per line, not comma-joined; real JSON, not [object Object].
      await expect(dialog.getByLabel('Approvers')).toHaveValue('U01ABC123\nU02DEF456');
      await expect(dialog.getByLabel('DM Allowlist')).toHaveValue('U01ABC123\nU02DEF456');
      await expect(dialog.getByLabel('Slack channel settings')).toHaveValue(
        JSON.stringify({ C01ABC: { respondMode: 'always' } }, null, 2)
      );

      // Append an approver the way the field's own description says to, save,
      // and read back what actually landed on disk.
      await dialog.getByLabel('Approvers').fill('U01ABC123\nU02DEF456\nU03GHI789');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await dialog.getByRole('button', { name: /^(Continue|Skip)$/ }).click();
      await dialog.getByRole('button', { name: 'Save changes' }).click();
      await expect(dialog).toBeHidden();

      // Read the saved config back from the catalog — the same JSON the cockpit
      // renders, so this asserts what a person would next see, not an internal.
      const saved = (await fetchCatalog(page))
        .flatMap((entry) => entry.instances)
        .find((instance) => instance.id === 'slack-stored-values');
      const config = saved?.config ?? {};

      expect(config.approverAllowlist).toEqual(['U01ABC123', 'U02DEF456', 'U03GHI789']);
      expect(config.dmAllowlist).toEqual(['U01ABC123', 'U02DEF456']);
      expect(config.channelOverrides).toEqual({ C01ABC: { respondMode: 'always' } });
    } finally {
      await page.request.delete('/api/relay/adapters/slack-stored-values');
    }
  });

  test('a refused save says why once, and keeps the stored rules', async ({ page }) => {
    const created = await page.request.post('/api/relay/adapters', {
      data: {
        type: 'slack',
        id: 'slack-refused-save',
        enabled: false,
        label: 'Refused save',
        config: {
          botToken: 'xoxb-not-a-real-token',
          appToken: 'xapp-not-a-real-token',
          signingSecret: 'not-a-real-secret',
          channelOverrides: { C01ABC: { respondMode: 'always' } },
        },
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    try {
      await page.setViewportSize(DESKTOP);
      await openMessagingRegion(page);
      await openConfigure(page, 'slack-refused-save');
      const dialog = wizard(page);

      // Break the JSON the way a stray keystroke would.
      await dialog.getByLabel('Slack channel settings').fill('{"C01ABC": ');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await dialog.getByRole('button', { name: /^(Continue|Skip)$/ }).click();
      await dialog.getByRole('button', { name: 'Save changes' }).click();

      // The specific sentence, and ONLY it — the app-wide "That didn't work.
      // Try again." would talk over the reason and invite a retry of the same
      // broken input.
      await expect(page.getByText(/expected JSON/)).toBeVisible();
      await expect(page.getByText("That didn't work. Try again.")).toHaveCount(0);

      // The stored rules are still there.
      const saved = (await fetchCatalog(page))
        .flatMap((entry) => entry.instances)
        .find((instance) => instance.id === 'slack-refused-save');
      expect(saved?.config?.channelOverrides).toEqual({ C01ABC: { respondMode: 'always' } });
    } finally {
      await page.request.delete('/api/relay/adapters/slack-refused-save');
    }
  });

  test('the approvers field is reachable by keyboard', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openMessagingRegion(page);
    await page.getByRole('button', { name: 'Add Slack' }).click();
    await pastAgentStep(page);

    const dialog = wizard(page);
    const approvers = dialog.getByLabel('Approvers');
    await dialog.getByLabel('Bot Token').focus();

    let reached = false;
    for (let press = 0; press < 40 && !reached; press++) {
      await page.keyboard.press('Tab');
      reached = await approvers.evaluate((el) => el === document.activeElement);
    }

    expect(reached, 'Approvers was not reachable by Tab from the first field').toBe(true);
    await expect(approvers).toBeFocused();
  });

  test('the access controls stay on screen at 390px', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await openMessagingRegion(page);
    await page.getByRole('button', { name: 'Add Slack' }).click();
    await pastAgentStep(page);

    const dialog = wizard(page);
    await expect(dialog.getByRole('heading', { name: 'Access Control' })).toBeVisible();
    await dialog.getByLabel('Approvers').scrollIntoViewIfNeeded();
    await expect(dialog.getByLabel('Approvers')).toBeInViewport();

    // The page itself must not scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('no external adapter declares a field the wizard never renders', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const external = (await fetchCatalog(page)).filter((entry) =>
      EXTERNAL_CATEGORIES.has(entry.manifest.category)
    );
    expect(external.length, 'no external adapters in the catalog').toBeGreaterThan(0);

    for (const entry of external) {
      await openMessagingRegion(page);
      const add = page.getByRole('button', { name: `Add ${entry.manifest.displayName}` });
      if (!(await add.isVisible().catch(() => false))) continue;
      await add.click();
      await expect(wizard(page)).toBeVisible();
      await pastAgentStep(page);

      const labels = await labelsAcrossSteps(page, entry.manifest.setupSteps?.length ?? 1);
      const missing = entry.manifest.configFields
        // A `showWhen` field is meant to be absent until its dependency matches,
        // and this sweep only ever sees the default values. Conditional
        // visibility has its own coverage in the client's wizard tests.
        .filter((field) => !field.showWhen && !labels.has(field.label))
        .map((field) => `${field.key} (${field.label})`);

      expect(missing, `${entry.manifest.type} hides these declared fields`).toEqual([]);
      await page.keyboard.press('Escape');
    }
  });
});
