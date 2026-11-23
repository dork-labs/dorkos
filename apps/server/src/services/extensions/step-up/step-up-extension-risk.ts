/**
 * The loaded extensions that keep "Confirm it's you" off (DOR-3234, Must 3).
 *
 * An installed extension runs in the app's own page, trusted like the app.
 * So a step-up means nothing while code an agent can rewrite is loaded there:
 * that code could draw a look-alike sheet and read the password. Step-up is
 * refused, with a plain reason, while any loaded extension is
 *
 * - **in an agent's folder:** the files it runs from (its snapshot when it has
 *   one, its folder with every link resolved otherwise) lie inside a
 *   registered agent's folder, or the folder an approval names as its author;
 * - **changed:** its files no longer match what a person approved.
 *
 * The extension keeps loading either way; only the step-up is refused. The
 * person fixes it in Settings → Extensions.
 *
 * A copy whose current bundle the server would not serve is never listed
 * (DOR-4906): the bundle route serves only bytes {@link mayLoadClientHalf}
 * allows, so a copy waiting for a person (an update that asks for more, files
 * changed since the yes) has no code in the page to draw a sheet with. That
 * is what let approving such an update deadlock on its own change. Code
 * served earlier, while it still counted, is caught by the risk ledger: the
 * bundle route takes a reading before it serves (`routes/extensions.ts`).
 *
 * @module services/extensions/step-up-extension-risk
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';
import type { StepUpExtensionRisk } from '@dorkos/shared/step-up';

import { type ExtensionApprovals, mayLoadClientHalf } from '../extension-load-policy.js';
import { isInsideFolder } from '../pin/extension-path-trust.js';
import { stepUpRiskLedger } from './step-up-risk-ledger.js';

/** The statuses whose code may be in the app's page. */
const LOADED: ReadonlySet<ExtensionRecord['status']> = new Set([
  'enabled',
  'compiled',
  'active',
  'activate_error',
]);

/** One agent's folder, named as the person knows it. */
export interface AgentFolder {
  /** The agent's folder, as registered. */
  path: string;
  /** What to call the agent: its display name, else its name. */
  name: string;
}

/** What {@link stepUpExtensionRisks} reads. */
export interface StepUpExtensionRiskInputs {
  /** Every discovered extension. */
  records: readonly ExtensionRecord[];
  /** `config.extensions`: the approvals, and what each covers. */
  extensions: ExtensionApprovals;
  /** Every registered agent's folder. */
  agents: readonly AgentFolder[];
  /**
   * The extension whose bundle is being served now, if any. It counts as
   * loaded whatever its record says: a reload during the serve may have
   * replaced that record with a held one (DOR-4906).
   */
  served?: string;
}

function realOrSelf(folder: string): string {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

/** The folder this copy's code runs from, with every link resolved. */
function runsFrom(record: ExtensionRecord): string {
  return realOrSelf(record.runPath ?? record.realPath ?? record.path);
}

/** Whether this copy's files differ from the ones a person approved. */
function isChanged(
  record: ExtensionRecord,
  approval: ExtensionApprovedSource | undefined
): boolean {
  if (record.originProblem === 'changed') return true;
  if (!approval?.digest || !record.currentDigest) return false;
  return record.currentDigest !== approval.digest;
}

/**
 * The loaded extensions that keep step-up off, each with why. Empty when it
 * may run. A copy that is both in an agent's folder and changed is listed
 * once, as in an agent's folder: moving it is the fix that holds.
 *
 * @param inputs - See {@link StepUpExtensionRiskInputs}.
 */
export function stepUpExtensionRisks(inputs: StepUpExtensionRiskInputs): StepUpExtensionRisk[] {
  const approvals = inputs.extensions.approvedSources ?? {};
  const folders: AgentFolder[] = [...inputs.agents];
  for (const approval of Object.values(approvals)) {
    if (approval.authorHome && !folders.some((f) => f.path === approval.authorHome)) {
      folders.push({ path: approval.authorHome, name: path.basename(approval.authorHome) });
    }
  }
  const realFolders = folders.map((folder) => ({ ...folder, real: realOrSelf(folder.path) }));
  const risks: StepUpExtensionRisk[] = [];
  for (const record of inputs.records) {
    if (record.id !== inputs.served) {
      if (!LOADED.has(record.status)) continue;
      // Held: the bundle route would refuse its bytes, so none reach the page.
      if (!mayLoadClientHalf(record, inputs.extensions)) continue;
    }
    const name = record.manifest.name || record.id;
    const where = runsFrom(record);
    const agent = realFolders.find((folder) => isInsideFolder(where, folder.real));
    if (agent) {
      risks.push({ id: record.id, name, reason: 'agent-folder', agentName: agent.name });
    } else if (isChanged(record, approvals[record.id])) {
      risks.push({ id: record.id, name, reason: 'changed' });
    }
  }
  return risks;
}

/** Where the live inputs come from, set once the extension manager is up. */
let liveInputs: (() => StepUpExtensionRiskInputs) | undefined;

/**
 * Point step-up at the running server's extensions, agents and approvals.
 * Called once at startup; before it, no extension is loaded, so none blocks.
 *
 * @param read - Reads the inputs fresh, on each step-up request.
 */
export function setStepUpExtensionRiskInputs(read: () => StepUpExtensionRiskInputs): void {
  liveInputs = read;
}

/**
 * The live {@link stepUpExtensionRisks}, read fresh, and noted in the risk
 * ledger so a cleared risk is remembered. A read that throws is not caught:
 * the step-up request fails, and nothing runs.
 */
export function currentStepUpExtensionRisks(): StepUpExtensionRisk[] {
  if (!liveInputs) return [];
  const risks = stepUpExtensionRisks(liveInputs());
  stepUpRiskLedger().note(risks.length);
  return risks;
}

/**
 * Take a risk reading before a bundle is served (DOR-4906): whether the
 * ledger kept it. On `false` the bundle must not be served, since a tab could
 * then hold code no kept reading saw, and a held copy is left out of the list
 * on the promise that none is ever in a tab unseen. The served copy counts as
 * loaded, and one no longer listed counts as a risk.
 *
 * @param id - The extension whose bundle is about to be served.
 */
export function noteStepUpRisksBeforeServing(id: string): boolean {
  if (!liveInputs) return true;
  const inputs = { ...liveInputs(), served: id };
  const unlisted = inputs.records.some((record) => record.id === id) ? 0 : 1;
  return stepUpRiskLedger().note(stepUpExtensionRisks(inputs).length + unlisted);
}
