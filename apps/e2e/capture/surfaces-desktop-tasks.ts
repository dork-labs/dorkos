import type { Page } from '@playwright/test';
import { type Theme } from './config.js';
import type { RunRecorder } from './library.js';
import { shoot, url, WAIT_MS } from './lib.js';

/**
 * The `task-runtime-picker` drive: a scheduled task's edit form, Advanced
 * settings expanded to the Runs-on fieldset (spec `task-runtime-model`).
 *
 * Split out of `surfaces-desktop.ts` (already over the file-size limit) for
 * the same reason the power and rooms surfaces are — one small, self-contained
 * drive.
 *
 * **Why the runtime is picked explicitly.** The capture stack registers only
 * test-mode runtimes (`boot.ts`), and a task with no override shows whatever
 * the server's default runtime resolves to — which reads as the literal label
 * "Test Mode" in the closed select, an internal name that must never reach a
 * changelog screenshot. `DORKOS_TEST_RUNTIME_CLAUDE_ALIAS` (`boot.ts`)
 * registers a second test-mode instance under the real `'claude-code'` type
 * string, so choosing "Claude Code" here is a real, connected option rather
 * than a synthesized one — same fake runtime underneath, honestly labeled.
 *
 * **Why Effort does not appear.** `TaskExecutionFields` only draws the effort
 * select when the resolved runtime's capabilities say `supportsEffort: true`
 * (`use-task-execution.ts`), and `TestModeRuntime` reports `supportsEffort:
 * false` unconditionally (`runtime-constants.ts`) — the alias above changes
 * the type string, not the capabilities behind it. Showing a fake effort
 * control would mean editing production runtime capabilities for a
 * screenshot, which is out of scope here; the shot honestly shows the
 * Runtime and Model rows the pipeline can actually produce.
 */
async function driveTaskRuntimePicker(page: Page): Promise<void> {
  await page.goto(url('/tasks'));
  await page
    .getByText('Nightly dependency audit', { exact: false })
    .first()
    .waitFor({ timeout: WAIT_MS });

  // The row's own kebab menu, not the row click (which expands run history).
  // `exact: true`: the row itself is ALSO a `role="button"` whose accessible
  // name is computed from its content — which folds in this nested button's
  // own `aria-label` — so a substring match resolves to both.
  await page
    .getByRole('button', { name: 'Actions for nightly-dependency-audit', exact: true })
    .click({ timeout: WAIT_MS });
  await page.getByRole('menuitem', { name: 'Edit' }).click({ timeout: WAIT_MS });

  const dialog = page.getByRole('dialog');
  await dialog.getByText('Edit Schedule', { exact: true }).waitFor({ timeout: WAIT_MS });

  await dialog.getByText('Advanced settings', { exact: true }).click({ timeout: WAIT_MS });
  const runtimeSelect = dialog.getByTestId('task-runtime-select');
  await runtimeSelect.waitFor({ timeout: WAIT_MS });

  // Pick "Claude Code" explicitly — see the module doc for why the default
  // inherited label is not fit for a screenshot.
  await runtimeSelect.click({ timeout: WAIT_MS });
  await page.getByRole('option', { name: 'Claude Code' }).click({ timeout: WAIT_MS });
  await dialog.getByTestId('task-model-select').waitFor({ timeout: WAIT_MS });
}

/** Capture the task-runtime-picker surface: Advanced settings, Runs-on expanded. */
export async function shootTaskRuntimePicker(
  page: Page,
  theme: Theme,
  rec: RunRecorder
): Promise<void> {
  await driveTaskRuntimePicker(page);
  await shoot(page, 'task-runtime-picker', theme, rec);
}
