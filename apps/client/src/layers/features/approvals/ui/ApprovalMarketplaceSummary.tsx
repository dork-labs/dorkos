import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type {
  MarketplaceApprovalSummary,
  MarketplacePackageSummary,
  MarketplaceRisk,
  MarketplaceRiskKind,
} from '@dorkos/shared/approval-schemas';
import { cn } from '@/layers/shared/lib';
import { ApprovalFullDetailSheet } from './ApprovalFullDetailSheet';

/** How each install group is headed, most powerful first (spec v1.1 call 5). */
const INSTALL_GROUPS: readonly { label: string; kinds: readonly MarketplaceRiskKind[] }[] = [
  { label: 'Runs inside DorkOS', kinds: ['extension'] },
  {
    label: 'Runs code',
    kinds: ['unreadable', 'hook', 'skillCommand', 'mcp', 'lsp', 'monitor', 'executable'],
  },
  { label: 'Works without you', kinds: ['schedule'] },
  { label: 'Reaches the internet', kinds: ['host'] },
  { label: 'Uses secrets and skills', kinds: ['secret', 'skillTools'] },
  { label: 'Brings in packages', kinds: ['dependency'] },
];

/** Past this many skills with tools, they are one row that opens in place (call 5a). */
const SKILL_GROUP_AFTER = 4;

/** The tag on an update row. */
const CHANGE_LABEL = { new: 'New', broader: 'Broader', removed: 'Removed' } as const;

/** Rows that give a package more power. */
const powerRows = (pkg: MarketplacePackageSummary) =>
  pkg.risks.filter((risk) => risk.change !== 'removed');

/** One row: the server's sentence, then its command, tools and old value, all as text. */
function RiskRow({ risk, tagged }: { risk: MarketplaceRisk; tagged: boolean }) {
  const removed = risk.change === 'removed';
  const unreadable = risk.kind === 'unreadable';
  return (
    <li
      data-slot="marketplace-risk"
      data-change={risk.change}
      // The tag sits above the sentence on a narrow card, beside it on a wide one.
      className="flex min-w-0 flex-col gap-0.5 @[24rem]/approval:flex-row @[24rem]/approval:gap-2"
    >
      {(tagged || unreadable) && (
        <span
          className={cn(
            'text-2xs mt-px w-14 shrink-0 font-medium',
            unreadable
              ? 'text-destructive'
              : removed
                ? 'text-muted-foreground'
                : 'text-status-warning-fg'
          )}
        >
          {unreadable ? 'Can’t read' : CHANGE_LABEL[risk.change]}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-xs break-words',
            removed ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {risk.text}
        </p>
        {risk.command !== undefined && (
          <pre className="bg-background/80 text-foreground mt-1 rounded-md px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap">
            {risk.command}
          </pre>
        )}
        {risk.items && risk.items.length > 0 && (
          <p className="text-muted-foreground mt-0.5 font-mono text-xs break-all">
            {risk.items.join(', ')}
          </p>
        )}
        {risk.was !== undefined && (
          <p className="text-muted-foreground mt-0.5 text-xs break-all">
            was: <span className="font-mono">{risk.was}</span>
          </p>
        )}
      </div>
    </li>
  );
}

/** A list of rows, with the skills that use tools folded into one row past a few. */
function RiskList({ risks, tagged }: { risks: readonly MarketplaceRisk[]; tagged: boolean }) {
  const [open, setOpen] = useState(false);
  const skills = risks.filter((risk) => risk.kind === 'skillTools' && risk.change !== 'removed');
  const folded = skills.length > SKILL_GROUP_AFTER && !open;
  const shown = folded ? risks.filter((risk) => !skills.includes(risk)) : risks;
  return (
    <ul className="flex flex-col gap-2">
      {shown.map((risk, i) => (
        <RiskRow key={i} risk={risk} tagged={tagged} />
      ))}
      {folded && (
        <li data-slot="marketplace-skill-group" className="text-foreground text-xs">
          {skills.length} skills and commands may use tools without asking.{' '}
          <button
            type="button"
            className="inline-flex min-h-6 items-center underline underline-offset-2 max-md:min-h-11"
            onClick={() => setOpen(true)}
          >
            Show all {skills.length}
          </button>
        </li>
      )}
    </ul>
  );
}

/** An install's rows, grouped by kind of power with no tags: everything is new. */
function InstallRows({ pkg }: { pkg: MarketplacePackageSummary }) {
  return (
    <div className="flex flex-col gap-3">
      {INSTALL_GROUPS.map((group) => {
        const risks = pkg.risks.filter((risk) => group.kinds.includes(risk.kind));
        if (risks.length === 0) return null;
        return (
          <section key={group.label} aria-label={group.label}>
            <h4 className="text-muted-foreground text-2xs mb-1 font-medium tracking-wide uppercase">
              {group.label} <span className="tabular-nums">{risks.length}</span>
            </h4>
            <RiskList risks={risks} tagged={false} />
          </section>
        );
      })}
    </div>
  );
}

/** The bold line that says how much this asks for. */
function verdictOf(summary: MarketplaceApprovalSummary, pkg: MarketplacePackageSummary) {
  const count = powerRows(pkg).length;
  if (summary.operation === 'install') {
    return {
      lead: `Once installed it can do ${count} ${count === 1 ? 'thing' : 'things'}.`,
      rest: 'All of them are here.',
    };
  }
  if (count === 0) {
    return {
      lead: 'No new power.',
      rest: `It runs the same ${pkg.unchangedCount} things it runs now.`,
    };
  }
  return {
    lead: `${count} ${count === 1 ? 'change gives' : 'changes give'} it more power.`,
    rest: 'Read these before you allow it.',
  };
}

/** One package's heading, verdict and rows. */
function PackageBlock({
  summary,
  pkg,
  named,
}: {
  summary: MarketplaceApprovalSummary;
  pkg: MarketplacePackageSummary;
  named: boolean;
}) {
  const verdict = verdictOf(summary, pkg);
  return (
    <div data-slot="marketplace-package" className="min-w-0">
      {named && (
        <p className="text-foreground font-mono text-xs break-all">
          {pkg.name}{' '}
          <span className="text-muted-foreground">
            {pkg.fromVersion ? `${pkg.fromVersion} → ${pkg.toVersion}` : pkg.toVersion}
          </span>
        </p>
      )}
      <p className="text-muted-foreground text-xs break-words">{pkg.where}</p>
      <p className="mt-1.5 text-xs">
        <span className="text-foreground font-medium">{verdict.lead}</span>{' '}
        <span className="text-muted-foreground">{verdict.rest}</span>
      </p>
      {pkg.risks.length > 0 && (
        <div className="bg-muted/50 mt-1.5 rounded-md p-2">
          {summary.operation === 'install' ? (
            <InstallRows pkg={pkg} />
          ) : (
            <RiskList risks={pkg.risks} tagged />
          )}
        </div>
      )}
      {summary.operation === 'update' && pkg.unchangedCount > 0 && powerRows(pkg).length > 0 && (
        <p className="text-muted-foreground mt-1.5 text-xs">
          {pkg.unchangedCount} {pkg.unchangedCount === 1 ? 'thing' : 'things'} it already runs
          {pkg.unchangedCount === 1 ? ' stays' : ' stay'} the same
        </p>
      )}
    </div>
  );
}

export interface ApprovalMarketplaceSummaryProps {
  /** The approval the summary belongs to, whose full list the link opens. */
  approvalId: string;
  /** The server's summary. */
  summary: MarketplaceApprovalSummary;
}

/**
 * A Marketplace install or update too long for one card's detail (DOR-3070,
 * designer spec v1.1): every row that gives a package more power, written out
 * whole and never collapsed, then one link to the full list.
 *
 * The server writes every sentence; this only lays them out. Nothing a
 * person must weigh lives only behind the link, and the card's own answers
 * sit after the list, so reaching Allow means scrolling past every row.
 * Packages in an update that add no power fold into one line that still
 * names each of them.
 */
export function ApprovalMarketplaceSummary({
  approvalId,
  summary,
}: ApprovalMarketplaceSummaryProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const adding = summary.packages.filter((pkg) => pkg.power === 'adds');
  const quiet = summary.packages.filter((pkg) => pkg.power === 'none');
  const several = summary.packages.length > 1;
  const listed = several ? adding : summary.packages;
  const folded = several ? quiet : [];
  return (
    <div data-slot="approval-marketplace-summary" className="mt-1.5 flex min-w-0 flex-col gap-3">
      {listed.map((pkg, i) => (
        <PackageBlock key={i} summary={summary} pkg={pkg} named={several} />
      ))}
      {folded.length > 0 && (
        <p data-slot="marketplace-folded" className="text-muted-foreground text-xs break-words">
          {folded.length}
          {listed.length > 0 ? ' more' : ''} {folded.length === 1 ? 'adds' : 'add'} no new power:{' '}
          {folded
            .map((pkg) => `${pkg.name} ${pkg.fromVersion ?? ''} → ${pkg.toVersion}`)
            .join(', ')}
        </p>
      )}
      <div>
        <button
          type="button"
          data-slot="approval-full-detail-link"
          className="text-foreground inline-flex min-h-6 items-center gap-0.5 text-xs underline underline-offset-2 max-md:min-h-11"
          onClick={() => setSheetOpen(true)}
        >
          See everything it runs
          <ChevronRight className="size-3.5" aria-hidden />
        </button>
      </div>
      <ApprovalFullDetailSheet
        approvalId={approvalId}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        length={summary.fullDetailLength}
      />
    </div>
  );
}
