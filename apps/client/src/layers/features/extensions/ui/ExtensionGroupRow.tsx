/**
 * A plugin's extensions as one row in Settings → Extensions (DOR-3583): the
 * plugin's name, "N extensions · …", one chip when a member needs the person,
 * and one switch (or Review).
 *
 * The switch turns on or off only members already allowed; it never approves.
 * Open, the row leads with the "Allow all" card when members wait, then lists
 * each member as one short line with its own switch.
 *
 * @module features/extensions/ui/ExtensionGroupRow
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type {
  ApprovalSetResult,
  ExtensionApprovalSet,
} from '@dorkos/shared/extension-approval-schemas';
import { Button, CountPill, Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { extensionGroupState, type ExtensionGroup } from '../lib/extension-groups';
import { extensionPurpose, isExtensionOn, waitsForOk } from '../lib/extension-row-state';
import { useApproveExtensionSet } from '../api/approval-set-queries';
import { ApprovalSetCard } from './ApprovalSetCard';

/** Props for {@link ExtensionGroupRow}. */
export interface ExtensionGroupRowProps {
  /** The plugin's members. */
  group: ExtensionGroup;
  /** The set waiting to be allowed, when the server listed one. */
  set?: ExtensionApprovalSet;
  /** Whether the row is open. */
  open: boolean;
  /** Open or close it. */
  onOpenChange: (open: boolean) => void;
  /** Turn one member on or off. */
  onToggle: (id: string, enabled: boolean) => void;
  /** Ids whose switch is in flight. */
  togglingIds: ReadonlySet<string>;
  /** Draws a waiting member's own row, for a set too big to allow at once. */
  renderMember: (ext: ExtensionRecordPublic) => ReactNode;
}

/** The answer "Allow all" got, kept with the set it answered. */
interface Answered {
  set: ExtensionApprovalSet;
  results: ApprovalSetResult[];
}

/**
 * One plugin's row.
 *
 * @param props - {@link ExtensionGroupRowProps}.
 */
export function ExtensionGroupRow({
  group,
  set,
  open,
  onOpenChange,
  onToggle,
  togglingIds,
  renderMember,
}: ExtensionGroupRowProps) {
  const state = extensionGroupState(group);
  const panelId = useId();
  const nameId = useId();
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const focusPrimaryRef = useRef(false);
  const approveSet = useApproveExtensionSet();
  const [answered, setAnswered] = useState<Answered | null>(null);

  useEffect(() => {
    if (!open || !focusPrimaryRef.current) return;
    focusPrimaryRef.current = false;
    primaryRef.current?.focus();
  }, [open]);

  // Closing forgets the last answer, so the next open shows the set as it is.
  function setOpen(next: boolean) {
    if (!next) setAnswered(null);
    onOpenChange(next);
  }

  function toggleGroup(enabled: boolean) {
    for (const member of state.allowed) {
      if (isExtensionOn(member) !== enabled) onToggle(member.id, enabled);
    }
  }

  function allowAll(shown: ExtensionApprovalSet) {
    approveSet.mutate(shown, {
      // The card stays open with each member's answer; never a success toast.
      onSuccess: (outcome) => setAnswered({ set: shown, results: outcome.results }),
      onError: (err) => toast.error('Nothing was turned on.', { description: err.message }),
    });
  }

  const shownSet = answered?.set ?? (set && !set.tooMany ? set : undefined);
  const waitingMembers = group.members.filter(waitsForOk);

  return (
    <li
      data-testid={`extension-group-${group.plugin}`}
      data-section={`group:${group.plugin}`}
      className={cn(
        'rounded-lg transition-colors duration-150 motion-reduce:transition-none',
        open ? 'bg-muted dark:bg-foreground/5' : 'hover:bg-muted dark:hover:bg-foreground/5'
      )}
    >
      <div className="flex min-h-10 items-center gap-2 pr-2 max-sm:min-h-16">
        <button
          ref={rowButtonRef}
          type="button"
          data-row-button=""
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="group focus-ring flex min-w-0 flex-1 items-center gap-4 rounded-lg py-2 pl-3 text-left max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-2 max-sm:gap-y-0.5 max-sm:py-2.5"
        >
          <span
            id={nameId}
            title={group.name}
            className="w-[200px] shrink-0 truncate text-[13px] font-medium max-sm:w-auto max-sm:text-base"
          >
            {group.name}
          </span>
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px] max-sm:col-span-2 max-sm:row-start-2 max-sm:text-sm">
            {state.purpose}
          </span>
          {state.chip && (
            <CountPill
              count={state.needsYouCount}
              tone="neutral"
              label={state.chip}
              className="shrink-0 max-sm:col-span-2 max-sm:row-start-3 max-sm:justify-self-start"
              data-testid={`extension-group-chip-${group.plugin}`}
            />
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground size-3.5 shrink-0 opacity-0 transition-[opacity,rotate] duration-200 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none max-sm:hidden',
              open && 'rotate-180 opacity-100'
            )}
          />
        </button>
        <div className="flex w-16 shrink-0 justify-end max-sm:w-[52px]">
          {state.waiting > 0 ? (
            !open && (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => {
                  focusPrimaryRef.current = true;
                  setOpen(true);
                }}
                aria-label={`Review ${group.name}`}
                data-testid={`extension-group-review-${group.plugin}`}
              >
                Review
              </Button>
            )
          ) : (
            <Switch
              size="sm"
              checked={state.isOn}
              onCheckedChange={toggleGroup}
              disabled={
                state.allowed.length === 0 || state.allowed.some((m) => togglingIds.has(m.id))
              }
              aria-label={`${group.name}: ${state.isOn ? 'on' : 'off'}`}
            />
          )}
        </div>
      </div>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={nameId}
          className="space-y-3.5 px-3 pt-1 pb-4"
        >
          {shownSet ? (
            <ApprovalSetCard
              set={shownSet}
              pluginName={group.name}
              onAllowAll={() => allowAll(shownSet)}
              isAllowing={approveSet.isPending}
              onDefer={() => {
                setOpen(false);
                rowButtonRef.current?.focus();
              }}
              results={answered?.results}
              primaryRef={primaryRef}
            />
          ) : (
            waitingMembers.length > 0 && (
              <div className="space-y-2" data-testid={`approval-set-one-by-one-${group.plugin}`}>
                {set?.tooMany && (
                  <p className="text-sm font-semibold">
                    {waitingMembers.length} are waiting. Allow them one at a time.
                  </p>
                )}
                <ul className="space-y-0.5">{waitingMembers.map(renderMember)}</ul>
              </div>
            )
          )}
          {/* The card is the member list while it is open, answered or not. */}
          {!shownSet && (
            <ul className="space-y-0.5" aria-label={`${group.name} extensions`}>
              {group.members.map((member) => (
                <li
                  key={member.id}
                  className="flex min-h-9 items-center gap-3 rounded-md pl-2 text-[13px] max-sm:min-h-11"
                  data-testid={`extension-group-member-${member.id}`}
                >
                  <span className="w-[160px] shrink-0 truncate font-medium max-sm:w-auto">
                    {member.manifest.name}
                  </span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate max-sm:hidden">
                    {extensionPurpose(member)}
                  </span>
                  {waitsForOk(member) ? (
                    <span className="text-muted-foreground shrink-0 text-xs">Needs your OK</span>
                  ) : (
                    <Switch
                      size="sm"
                      checked={isExtensionOn(member)}
                      onCheckedChange={(checked) => onToggle(member.id, checked)}
                      disabled={togglingIds.has(member.id)}
                      aria-label={`${member.manifest.name}: ${isExtensionOn(member) ? 'on' : 'off'}`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground text-xs">From the {group.plugin} plugin</p>
        </div>
      )}
    </li>
  );
}
