/**
 * The "Allow all" card for a plugin's extensions (DOR-3583): the combined
 * grant first, then one row per member, then the two buttons.
 *
 * The words are the designer's, as written (Nov 8). "Allow all" is N
 * approvals on the server, each with its own digest; when one still fails, the
 * card stays open and says which were allowed and which weren't. Never a
 * success toast.
 *
 * @module features/extensions/ui/ApprovalSetCard
 */
import { useId, useState, type Ref } from 'react';
import { ChevronDown } from 'lucide-react';
import type {
  ApprovalSetGrant,
  ApprovalSetMemberView,
  ApprovalSetResult,
  ExtensionApprovalSet,
} from '@dorkos/shared/extension-approval-schemas';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/** Props for {@link ApprovalSetCard}. */
export interface ApprovalSetCardProps {
  /** The set, as the server derived it. */
  set: ExtensionApprovalSet;
  /** The plugin's name as the row shows it. */
  pluginName: string;
  /** Allow every waiting member. */
  onAllowAll: () => void;
  /** Whether "Allow all" is in flight. */
  isAllowing: boolean;
  /** "Not now": changes nothing, closes the row. */
  onDefer: () => void;
  /** Each member's result after "Allow all", once it answered. */
  results?: ApprovalSetResult[];
  /** The primary button, so Review can move focus to it. */
  primaryRef?: Ref<HTMLButtonElement>;
}

/**
 * "{n} run code here · {m} can reach the internet: {names}." with any zero
 * clause left out, or null when both are zero.
 *
 * @param waiting - The members waiting.
 */
export function approvalSetSummary(waiting: readonly ApprovalSetMemberView[]): string | null {
  const runs = waiting.filter((member) => member.runsInServer).length;
  const reaching = waiting.filter((member) => member.reachesInternet);
  const clauses = [
    runs > 0 ? `${runs} run code here` : null,
    reaching.length > 0
      ? `${reaching.length} can reach the internet: ${reaching.map((member) => member.name).join(', ')}`
      : null,
  ].filter((clause): clause is string => clause !== null);
  return clauses.length > 0 ? `${clauses.join(' · ')}.` : null;
}

/**
 * The set's combined grant as key and value lines, in the designer's order,
 * leaving out any with nothing to show. Drawn from the server's `grant`, which
 * it derives from the same members it hashes, so the card never shows less
 * than "Allow all" approves (Security, Nov 8).
 *
 * @param grant - The set's combined grant.
 */
export function grantLines(grant: ApprovalSetGrant): Array<[string, string]> {
  const lines: Array<[string, string]> = [['Runs as', 'You']];
  if (grant.programs.length > 0) lines.push(['Programs', grant.programs.join(', ')]);
  if (grant.agentTools.length > 0) {
    const n = grant.agentTools.length;
    lines.push([
      'Agent tools',
      `${n} new ${n === 1 ? 'tool' : 'tools'} agents can use: ${grant.agentTools.join(', ')}`,
    ]);
  }
  if (grant.agents.length > 0) {
    lines.push(['Agents', `${grant.agents.join(', ')} can message your agents and start chats`]);
  }
  if (grant.network.anything) lines.push(['Network', 'Can reach anything this computer can']);
  else if (grant.network.hosts.length > 0) {
    lines.push(['Network', `Can reach ${grant.network.hosts.join(', ')}`]);
  }
  return lines;
}

/** Access, runs as, and network for one member, as a single approval card says them. */
function memberFacts(member: ApprovalSetMemberView): Array<[string, string]> {
  const { permissions } = member;
  if (permissions.runtime === 'subprocess') {
    return [
      ['Access', 'Runs on its own, apart from DorkOS'],
      ['Runs as', 'You'],
      ...(permissions.agents
        ? [['Agents', 'Can message your agents and start chats'] as [string, string]]
        : []),
      ...(permissions.run.length > 0
        ? [
            ['Programs', permissions.run.map((program) => program.name).join(', ')] as [
              string,
              string,
            ],
          ]
        : []),
      [
        'Network',
        permissions.net.length > 0
          ? `Can reach ${permissions.net.join(', ')}`
          : 'Reaches nothing on the internet',
      ],
    ];
  }
  // Screens alone run sealed off with no access of their own (DOR-3293).
  if (!member.runsInServer) return [['Runs as', 'You']];
  return [
    ['Access', 'Runs inside DorkOS, with full access to this computer'],
    ['Runs as', 'You'],
    ['Network', 'Can reach anything this computer can'],
  ];
}

/** A server sentence read after a colon: its first letter lowercased. */
function afterColon(reason: string): string {
  return reason.charAt(0).toLowerCase() + reason.slice(1);
}

/** One member's line, with its facts behind a disclosure. */
function MemberLine({
  member,
  result,
}: {
  member: ApprovalSetMemberView;
  result?: ApprovalSetResult;
}) {
  const [open, setOpen] = useState(false);
  const factsId = useId();
  const dim = member.state === 'allowed';
  const status = result
    ? result.ok
      ? 'Allowed'
      : `Not allowed: ${afterColon(result.reason ?? 'DorkOS refused it.')}`
    : member.state === 'allowed'
      ? 'Already allowed'
      : member.state === 'skipped'
        ? `Can’t be allowed: ${afterColon(member.reason ?? 'DorkOS can’t check it.')}`
        : null;
  // A refusal is the line: it takes the purpose's place and may wrap.
  const refused = (result && !result.ok) || member.state === 'skipped';
  return (
    <li data-testid={`approval-set-member-${member.id}`} data-state={member.state}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={factsId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'focus-ring flex min-h-9 w-full items-center gap-3 rounded-md px-2 text-left text-sm max-sm:min-h-11',
          dim && 'text-muted-foreground'
        )}
      >
        <span className="w-[160px] shrink-0 truncate font-medium max-sm:w-auto max-sm:min-w-0 max-sm:flex-1 max-sm:shrink">
          {member.name}
        </span>
        {!refused && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate max-sm:hidden">
            {member.purpose}
          </span>
        )}
        {status && (
          <span
            className={cn(
              'text-xs',
              refused ? 'min-w-0 flex-1 py-1.5 break-words' : 'shrink-0',
              result && !result.ok ? 'text-status-error-fg' : 'text-muted-foreground'
            )}
            data-testid={`approval-set-status-${member.id}`}
          >
            {status}
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-muted-foreground size-3.5 shrink-0 transition-[rotate] duration-200 ease-out motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        <dl
          id={factsId}
          className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-2 pt-1 pb-2 text-sm max-sm:grid-cols-1"
        >
          {memberFacts(member).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words max-sm:mb-1">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/**
 * The card.
 *
 * @param props - {@link ApprovalSetCardProps}.
 */
export function ApprovalSetCard({
  set,
  pluginName,
  onAllowAll,
  isAllowing,
  onDefer,
  results,
  primaryRef,
}: ApprovalSetCardProps) {
  const waiting = set.members.filter((member) => member.state === 'waiting');
  const title = `${pluginName} wants to run ${waiting.length} extensions on this computer.`;
  const summary = approvalSetSummary(waiting);
  const answered = results !== undefined;
  return (
    <div
      role="group"
      aria-label={title}
      className="bg-status-warning-bg space-y-3 rounded-lg p-4 dark:bg-[hsl(40_25%_14%)]"
      data-testid={`approval-set-${set.plugin}`}
    >
      <p className="text-sm font-semibold">{title}</p>
      {summary && (
        <p className="text-sm" data-testid={`approval-set-summary-${set.plugin}`}>
          {summary}
        </p>
      )}
      <div className="space-y-1" data-testid={`approval-set-grant-${set.plugin}`}>
        {set.grant.fullAccess.map((name) => (
          <p key={name} className="text-sm font-semibold">
            {name} gets full access to this computer.
          </p>
        ))}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm max-sm:grid-cols-1">
          {grantLines(set.grant).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words max-sm:mb-1">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <ul className="border-border/60 space-y-0.5 border-t pt-2">
        {set.members.map((member) => (
          <MemberLine
            key={member.id}
            member={member}
            result={results?.find((result) => result.id === member.id)}
          />
        ))}
      </ul>
      {!answered && (
        <p className="text-muted-foreground text-sm">
          Each is checked again when you allow. Any that changed stay off.
        </p>
      )}
      {!answered && (
        <div className="flex flex-wrap gap-2">
          <Button
            ref={primaryRef}
            size="sm"
            onClick={onAllowAll}
            disabled={isAllowing || waiting.length === 0}
            data-testid={`approval-set-allow-${set.plugin}`}
          >
            Allow all {waiting.length}
          </Button>
          <Button size="sm" variant="secondary" onClick={onDefer}>
            Not now
          </Button>
        </div>
      )}
    </div>
  );
}
