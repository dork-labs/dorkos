/**
 * Reports to — who gets an agent's report and its escalations (spec
 * `heartbeats` §4.3, canon P4).
 *
 * People first (today, you), then every other agent. With nothing set, the
 * agent reports to whoever created it, else to you, and the list marks that
 * choice as the default.
 *
 * @module features/profile/ui/popovers/ReportsToPopover
 */
import { Check } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { IdentityAvatar, PRESS_ROW, Skeleton } from '@/layers/shared/ui';
import { teamMemberFace, useTeamRoster } from '@/layers/entities/team';
import { useMountedRef } from '../../model/use-mounted-ref';
import { useProfileAgent } from '../../model/use-profile-agent';
import {
  describeReportsTo,
  reportsToOptions,
  type ReportsToOption,
} from '../../lib/profile-reports-to';
import type { ProfilePickContentProps } from './types';

/** The code the server refuses a loop with. */
const CYCLE_CODE = 'REPORTS_TO_CYCLE';

/** The field-label style the settings share. */
const LABEL_CLASS = 'text-muted-foreground text-3xs font-medium tracking-wider uppercase';

/** One choice: a face, a name, and a check on the current one. */
function OptionRow({
  option,
  selected,
  isDefault,
  disabled,
  onPick,
}: {
  option: ReportsToOption;
  selected: boolean;
  isDefault: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const face = teamMemberFace(option.member);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        PRESS_ROW,
        'flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm',
        'hover:bg-accent disabled:opacity-60'
      )}
    >
      <IdentityAvatar
        size="xs"
        kind={face.kind}
        color={face.color}
        emoji={face.emoji}
        imageUrl={face.imageUrl}
        fallback={face.fallback}
        origin={face.origin}
        badge={null}
      />
      <span className="min-w-0 flex-1 truncate">
        {option.label}
        {isDefault && (
          <>
            {' '}
            <span className="text-muted-foreground">(default)</span>
          </>
        )}
      </span>
      {selected && <Check aria-hidden className="size-3.5 shrink-0" />}
    </button>
  );
}

/**
 * Choose who an agent reports to.
 *
 * Saves on a tap through the agent's own edit route, which refuses a choice
 * that would make a loop. That refusal is shown here, under the list, while the
 * popover is open; any other failure goes to the app-wide toast.
 */
export function ReportsToPopover({ member }: ProfilePickContentProps) {
  const mounted = useMountedRef();
  const { agent, isPending, isSaving, error, update } = useProfileAgent(member, {
    errorLabel: 'Couldn’t change who this agent reports to',
    isShownInline: (failure) =>
      mounted.current === true && (failure as Error & { code?: string }).code === CYCLE_CODE,
  });
  const roster = useTeamRoster();

  if (isPending || roster.isPending) return <Skeleton className="h-24 w-full" />;
  if (!agent) {
    return (
      <p className="text-muted-foreground p-1 text-sm">Couldn’t read this agent’s settings.</p>
    );
  }

  const members = roster.data?.members ?? [];
  const current = describeReportsTo(agent, members);
  const options = reportsToOptions(agent.id, members);
  const people = options.filter((option) => option.kind === 'person');
  const agents = options.filter((option) => option.kind === 'agent');
  const cycle = error?.code === CYCLE_CODE ? error.message : null;

  const group = (label: string, list: ReportsToOption[]) =>
    list.length > 0 && (
      <div className="space-y-0.5">
        <div className={cn(LABEL_CLASS, 'px-1.5')}>{label}</div>
        {list.map((option) => (
          <OptionRow
            key={option.accountId}
            option={option}
            selected={current.accountId === option.accountId}
            isDefault={current.isDefault && current.accountId === option.accountId}
            disabled={isSaving}
            onPick={() => {
              if (option.accountId !== agent.reportsTo) update({ reportsTo: option.accountId });
            }}
          />
        ))}
      </div>
    );

  return (
    <div className="space-y-3 p-1" data-slot="profile-reports-to">
      <div role="radiogroup" aria-label="Reports to" className="max-h-72 space-y-2 overflow-y-auto">
        {group('People', people)}
        {group('Agents', agents)}
      </div>
      {cycle && (
        <p role="alert" className="text-status-error px-1.5 text-xs">
          {cycle}
        </p>
      )}
      {!current.isDefault && (
        <button
          type="button"
          disabled={isSaving}
          onClick={() => update({ reportsTo: null })}
          className="text-muted-foreground hover:text-foreground px-1.5 text-xs underline-offset-2 hover:underline"
        >
          Use the default
        </button>
      )}
    </div>
  );
}
