/**
 * The summary card for a Marketplace install or update whose full list is too
 * long for one approval card (DOR-3070, DOR-3356; designer spec v1.1).
 *
 * The card used to be refused past `APPROVAL_DETAIL_MAX_LENGTH`, which was the
 * right rule (never cut) with the wrong result: no large package could be
 * installed or updated by an agent at all. This sorts instead of cutting.
 * Every row that gives the package more power is on the card, written out
 * whole; what does not is counted; and the full list, unchanged, is stored
 * with the approval and opened from the card's link.
 *
 * What the approval is bound to does not change: `bindingOf` still hashes the
 * full disclosure and the staged files, never this summary. So a package that
 * changes between the card and the click is asked about again, whatever the
 * card showed.
 *
 * Past {@link MARKETPLACE_SUMMARY_CODE_ROW_CAP} New or Broader rows that run
 * code or reach out, DorkOS does not ask in chat at all: that much is for a
 * person to review in Marketplace, where nothing is in a hurry.
 *
 * @module services/marketplace-mcp/approval-summary-card
 */
import {
  APPROVAL_DETAIL_MAX_LENGTH,
  APPROVAL_FULL_DETAIL_MAX_LENGTH,
  MARKETPLACE_SUMMARY_CODE_ROW_CAP,
  type MarketplaceApprovalSummary,
  type MarketplacePackageSummary,
  type MarketplaceRisk,
} from '@dorkos/shared/approval-schemas';
import {
  sweptMarketplaceCard,
  type MarketplaceCardInput,
} from '../core/approvals/approval-storable.js';
import { disclosedEffectsOf } from '../marketplace/preview/disclosed-effects.js';
import type { PermissionPreview, PreviewExtension } from '../marketplace/types.js';
import type { ApprovableUpdate } from '../marketplace/flows/update-installed.js';
import { codeRowCount, effectRows, sortRows, whole } from './approval-summary-rows.js';
import { placeOf, whenProgramsStart } from './update-approval-detail.js';

/** What a confirmation request carries that the summary reads. */
export interface SummarySource {
  packageName: string;
  operation: string;
  packageType?: string;
  projectPath?: string;
  preview?: PermissionPreview;
  origin?: { version?: string; source?: string };
  updates?: readonly ApprovableUpdate[];
}

/** How a Marketplace card is shown, or why it is not. */
export type MarketplaceCardPlan =
  | { kind: 'full' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'summary'; detail: string; marketplace: MarketplaceCardInput };

/** The rows an extension with server code shows: the most powerful thing a package can do. */
function extensionRows(
  extensions: readonly PreviewExtension[] | undefined,
  change: MarketplaceRisk['change']
): MarketplaceRisk[] {
  return (extensions ?? [])
    .filter((ext) => ext.hasServer !== false)
    .map((ext) => {
      const isolation = ext.isolation;
      const inProcess = !isolation || isolation.runtime === 'in-process';
      const items = isolation
        ? [
            ...isolation.net.map((host) => `Contacts ${whole(host)}`),
            ...isolation.run.map((program) => `May start ${whole(program)}`),
            ...(isolation.agents ? ['May message agents and start agent sessions'] : []),
          ]
        : [];
      const unproven =
        change === 'broader'
          ? '. DorkOS cannot show its server code is unchanged, so this counts as more power'
          : '';
      return {
        kind: 'extension' as const,
        change,
        text: inProcess
          ? `The extension ${whole(ext.id)} runs server code inside DorkOS, with full access to DorkOS${unproven}`
          : `The extension ${whole(ext.id)} runs server code in a separate process${unproven}`,
        ...(items.length > 0 && { items }),
      };
    });
}

/** The rows only an install's preview has: hosts, secrets, libraries and unreadable files. */
function installOnlyRows(preview: PermissionPreview): MarketplaceRisk[] {
  const row = (kind: MarketplaceRisk['kind'], text: string): MarketplaceRisk => ({
    kind,
    change: 'new',
    text,
  });
  return [
    ...preview.unreadableHooks.map((h) =>
      row('unreadable', `${whole(h.path)} couldn't be read, so DorkOS can't tell what it runs`)
    ),
    ...preview.unreadableDeclarations.map((d) =>
      row('unreadable', `${whole(d.path)} couldn't be read, so DorkOS can't tell what it starts`)
    ),
    ...preview.externalHosts.map((host) => row('host', `Contacts ${whole(host)}`)),
    ...preview.secrets.map((s) =>
      row('secret', `Asks for the secret ${whole(s.key)} (${s.required ? 'required' : 'optional'})`)
    ),
    ...preview.npmDependencies.map((dep) =>
      row('dependency', `Downloads the npm library ${whole(dep.name)} ${whole(dep.range)}`)
    ),
  ];
}

/** One package's summary from its rows. */
function packageSummary(
  base: Omit<MarketplacePackageSummary, 'risks' | 'power' | 'unchangedCount'>,
  rows: MarketplaceRisk[],
  unchangedCount: number
): MarketplacePackageSummary {
  const risks = sortRows(rows);
  const power = risks.some((risk) => risk.change !== 'removed') ? 'adds' : 'none';
  return { ...base, power, risks, unchangedCount };
}

/** The summary of an install, every row New. */
function installSummary(req: SummarySource): MarketplacePackageSummary {
  const preview = req.preview!;
  const agent = req.packageType === 'agent';
  const where = agent
    ? 'in the new agent’s chats'
    : req.projectPath
      ? 'declared, but not started for a project install'
      : 'in every chat';
  const { rows } = effectRows(disclosedEffectsOf(preview), undefined, where);
  return packageSummary(
    {
      name: req.packageName,
      where: `${req.packageType ?? 'package'}, ${req.projectPath ? `installed in ${whole(req.projectPath)}` : 'installed globally'}`,
      toVersion: req.origin?.version ?? 'not stated',
    },
    [...extensionRows(preview.extensions, 'new'), ...installOnlyRows(preview), ...rows],
    0
  );
}

/**
 * The summary of one reinstall, compared with what is installed. The
 * baseline is used only when the caller vouched for it (`installedDisclosed`
 * is set only for an install whose files still match their record).
 */
function updateSummary(update: ApprovableUpdate): MarketplacePackageSummary {
  const baseline = update.installedDisclosed ?? null;
  const { rows, unchangedCount } = effectRows(
    update.disclosed,
    baseline,
    whenProgramsStart(update)
  );
  return packageSummary(
    {
      name: update.packageName,
      where: `${update.type}, ${placeOf(update)}`,
      fromVersion: update.installedVersion,
      toVersion: update.latestVersion,
    },
    [...extensionRows(update.extensions, baseline ? 'broader' : 'new'), ...rows],
    unchangedCount
  );
}

/** Every row of a summary, across its packages. */
const allRows = (summary: MarketplaceApprovalSummary) =>
  summary.packages.flatMap((pkg) => pkg.risks);

/**
 * The card's `detail` beside a summary: the rows as text, for a surface that
 * cannot draw the summary. It never ends mid-row without saying so: past the
 * card's bound it stops at a whole row and says how many more there are.
 */
export function summaryDetail(summary: MarketplaceApprovalSummary): string {
  const footer = (more: number) =>
    `…and ${more} more ${more === 1 ? 'row' : 'rows'}. Open this card in DorkOS to read every one.`;
  const blocks = summary.packages.flatMap((pkg) => [
    `${whole(pkg.name)} (${pkg.where}): ${pkg.fromVersion ? `${whole(pkg.fromVersion)} → ` : ''}${whole(pkg.toVersion)}`,
    ...pkg.risks.map(
      (risk) =>
        `  [${risk.change}] ${risk.text}` +
        (risk.command ? `\n    ${risk.command}` : '') +
        (risk.items ? `\n    ${risk.items.join(', ')}` : '') +
        (risk.was ? `\n    was: ${risk.was}` : '')
    ),
    ...(pkg.unchangedCount > 0
      ? [`  ${pkg.unchangedCount} things it already runs stay the same`]
      : []),
  ]);
  const room = APPROVAL_DETAIL_MAX_LENGTH - footer(blocks.length).length - 1;
  const kept: string[] = [];
  let length = 0;
  for (const block of blocks) {
    if (length + block.length + 1 > room) break;
    kept.push(block);
    length += block.length + 1;
  }
  return kept.length === blocks.length
    ? kept.join('\n')
    : `${kept.join('\n')}\n${footer(blocks.length - kept.length)}`;
}

/** Why a card past the in-chat cap was not raised, said for the case in front of it. */
function overCapReason(req: SummarySource, count: number): string {
  const things = `${count} things that run code or reach the internet`;
  if (req.operation === 'install') {
    return (
      `Too much to approve in chat: installing it would add ${things}. Nothing was changed. ` +
      `A person can review every one of them and install it from Marketplace in DorkOS.`
    );
  }
  const updates = req.updates?.length ?? 0;
  if (updates === 1) {
    return (
      `Too much to approve in chat: this update would add or widen ${things}. Nothing was ` +
      `changed. A person can review every one of them and update it from Marketplace in DorkOS.`
    );
  }
  return (
    `Too much to approve in chat: these ${updates} updates would add or widen ${things}. ` +
    `Nothing was changed. Update fewer at a time (check first, then apply with the installPaths ` +
    `of a few of them), or a person can review and update them from Marketplace in DorkOS.`
  );
}

/**
 * Decide how a Marketplace install or update card is shown.
 *
 * @param req - The request the card is for.
 * @param fullText - Everything it would do, written out whole: what the card
 *   showed in `detail` until now, and what its link opens.
 * @returns `full` when it fits on the card as today, `summary` with the rows
 *   and the full list to store, or `refuse` with the reason nothing was asked.
 */
export function planMarketplaceCard(req: SummarySource, fullText: string): MarketplaceCardPlan {
  if (fullText.length <= APPROVAL_DETAIL_MAX_LENGTH) return { kind: 'full' };
  const packages = req.updates
    ? req.updates.map(updateSummary)
    : req.operation === 'install' && req.preview
      ? [installSummary(req)]
      : [];
  if (packages.length === 0) return { kind: 'full' };
  const summary: MarketplaceApprovalSummary = {
    operation: req.updates ? 'update' : 'install',
    packages,
    fullDetailLength: fullText.length,
  };
  const count = codeRowCount(allRows(summary));
  if (count > MARKETPLACE_SUMMARY_CODE_ROW_CAP) {
    return { kind: 'refuse', reason: overCapReason(req, count) };
  }
  if (fullText.length > APPROVAL_FULL_DETAIL_MAX_LENGTH) {
    return {
      kind: 'refuse',
      reason:
        'Too much to approve in chat: the full list is too long for DorkOS to keep with the ' +
        'card. Nothing was changed. A person can review it in Marketplace in DorkOS.',
    };
  }
  // Checked exactly as storage checks it: a summary that cannot be stored
  // whole would leave a card with a cut detail and nothing behind its link.
  const marketplace = { summary, fullDetail: fullText };
  if (!sweptMarketplaceCard(marketplace)) {
    return {
      kind: 'refuse',
      reason:
        'Too much to approve in chat: something this package declares is too long to show ' +
        'on the card. Nothing was changed. A person can review it in Marketplace in DorkOS.',
    };
  }
  return { kind: 'summary', detail: summaryDetail(summary), marketplace };
}
