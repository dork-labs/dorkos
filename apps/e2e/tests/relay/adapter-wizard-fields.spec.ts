import { test, expect, type Page } from '@playwright/test';

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

/** Adapter categories a person manages from the Integrations tab. */
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
 * Opens Settings on the Integrations section.
 *
 * Wide viewports render the sections as tabs the deep link selects directly.
 * Narrow ones render a drill-down list instead, so the section has to be tapped.
 */
async function openIntegrations(page: Page) {
  await page.goto('/?settings=integrations');
  await page.waitForSelector('[data-testid="settings-dialog"]');

  const tab = page.getByRole('tab', { name: 'Integrations' });
  if ((await tab.count()) > 0) {
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  } else {
    await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: 'Add Slack' })).toBeVisible();
}

/** The setup wizard dialog, whichever adapter it was opened for. */
function wizard(page: Page) {
  return page.getByRole('dialog', { name: /^(Add|Edit) / });
}

/**
 * Get past the wizard's first question.
 *
 * Adding a connection asks who answers before it asks for any setting
 * (DOR-857), so every assertion about the configure step has to walk through
 * it. Editing skips the step, and this is a no-op there.
 */
async function pastAgentStep(page: Page) {
  const dialog = wizard(page);
  const agentQuestion = dialog.getByLabel('Who should answer?');
  const namedAgent = dialog.getByText(/will answer\.$/);
  if ((await agentQuestion.count()) === 0 && (await namedAgent.count()) === 0) return;

  if ((await agentQuestion.count()) > 0) {
    await agentQuestion.click();
    await page.getByRole('option').first().click();
  }
  const next = dialog.getByRole('button', { name: 'Continue' });
  await expect(next).toBeEnabled();
  await next.click();
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
    for (const label of await dialog.locator('label').all()) {
      const text = (await label.innerText()).trim();
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
    await openIntegrations(page);

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
    await openIntegrations(page);
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
      await openIntegrations(page);

      await page.getByRole('button', { name: 'Configure Legacy workspace' }).click();
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
      await openIntegrations(page);
      await page.getByRole('button', { name: 'Configure Stored values' }).click();
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
      await dialog.getByRole('button', { name: 'Save Changes' }).click();
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
      await openIntegrations(page);
      await page.getByRole('button', { name: 'Configure Refused save' }).click();
      const dialog = wizard(page);

      // Break the JSON the way a stray keystroke would.
      await dialog.getByLabel('Slack channel settings').fill('{"C01ABC": ');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await dialog.getByRole('button', { name: /^(Continue|Skip)$/ }).click();
      await dialog.getByRole('button', { name: 'Save Changes' }).click();

      // The specific sentence, and ONLY it — the app-wide "Action failed.
      // Please try again." would talk over the reason and invite a retry of the
      // same broken input.
      await expect(page.getByText(/expected JSON/)).toBeVisible();
      await expect(page.getByText('Action failed. Please try again.')).toHaveCount(0);

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
    await openIntegrations(page);
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
    await openIntegrations(page);
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
      await openIntegrations(page);
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
