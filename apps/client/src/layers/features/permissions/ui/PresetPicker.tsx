import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type {
  PermissionPreset,
  PermissionSurface,
  PermissionsResponse,
} from '@dorkos/shared/permissions';
import {
  PERMISSION_PRESETS,
  countAgentsFollowing,
  describeAffectedAgents,
} from '@dorkos/shared/permissions';
import {
  isAutonomyAckRefusal,
  usePermissions,
  useSetPermission,
} from '@/layers/entities/permissions';
import {
  Button,
  CANONICAL_TRUST_STOPS,
  PermissionModeScopeNote,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
} from '@/layers/shared/ui';
import { AutonomyConfirmDialog } from '@/layers/features/status';
import { PRESET_LABEL, PRESET_SUMMARY } from '../lib/permission-copy';
import { useAutonomyConsent } from '../model/use-autonomy-consent';
import { ApplyToOverridesDialog, type DifferingAgent } from './ApplyToOverridesDialog';
import { PermissionWhy } from './PermissionWhy';

/** Props for {@link PresetPicker}. */
export interface PresetPickerProps {
  /** Where the choice is made, recorded with the change. */
  surface: Extract<PermissionSurface, 'settings' | 'control-center'>;
}

/** "Full power, 2 changes"; "Full power" with none. */
function presetHeadline(preset: PermissionPreset, changeCount: number): string {
  if (changeCount === 0) return PRESET_LABEL[preset];
  return `${PRESET_LABEL[preset]}, ${changeCount} ${changeCount === 1 ? 'change' : 'changes'}`;
}

/**
 * Every agent with a setting of its own, once each, for the apply dialog. A
 * preset replaces everything, so the question is about agents, not areas.
 */
function differingAgents(overview: PermissionsResponse): DifferingAgent[] {
  const seen = new Map<string, { agentName: string; count: number }>();
  const note = (agentId: string, agentName: string) => {
    const entry = seen.get(agentId) ?? { agentName, count: 0 };
    entry.count += 1;
    seen.set(agentId, entry);
  };
  for (const e of overview.exceptions) note(e.agentId, e.agentName);
  for (const e of overview.filesAndCommands.exceptions) note(e.agentId, e.agentName);
  return [...seen].map(([agentId, { agentName, count }]) => ({
    agentId,
    agentName,
    detail: `${count} ${count === 1 ? 'setting' : 'settings'} of its own`,
  }));
}

/**
 * Careful · Balanced · Full power: the one choice that sets every area and the
 * Files & commands stop at once (spec `agent-permissions` D5).
 *
 * Choosing Full power asks the person to confirm what Full autonomy means when
 * no acknowledgement is on file, and sends the yes with the preset. When some
 * agents have settings of their own, it asks which of them should follow the
 * new preset; nothing is pre-checked. With changes on top of the chosen preset,
 * "Reset to <preset>" takes them away.
 *
 * @param props - See {@link PresetPickerProps}.
 */
export function PresetPicker({ surface }: PresetPickerProps) {
  const overview = usePermissions();
  const write = useSetPermission({ kind: 'default' });
  const consent = useAutonomyConsent();
  const [pending, setPending] = useState<PermissionPreset | null>(null);
  const differing = useMemo(
    () => (overview.data ? differingAgents(overview.data) : []),
    [overview.data]
  );

  if (overview.isError) {
    return <p className="text-muted-foreground text-sm">Couldn’t read the permissions.</p>;
  }
  if (!overview.data) {
    // The three choices are drawn while the permissions load, so a surface that
    // places focus on open (the Control Center) lands it here rather than on
    // whatever comes after. Nothing can be chosen until the answer arrives.
    return (
      <div className="flex flex-col gap-3" data-testid="preset-picker" aria-busy="true">
        <SegmentedControl aria-label="Preset" className="w-full" value="" onValueChange={() => {}}>
          {PERMISSION_PRESETS.map((preset) => (
            <SegmentedControlItem key={preset} value={preset} aria-label={PRESET_LABEL[preset]}>
              <span className="truncate">{PRESET_LABEL[preset]}</span>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  const data = overview.data;
  // What choosing a preset reaches, said before anything is chosen.
  const affected = countAgentsFollowing(data, { kind: 'preset' });
  const preview = `${data.preset === null ? 'Choosing one' : 'Changing it'} ${describeAffectedAgents(affected)}`;

  const send = (preset: PermissionPreset, applyToAgents?: string[]) => {
    const once = (acknowledgeAutonomy?: true) =>
      write.mutate(
        {
          kind: 'preset',
          preset,
          surface,
          ...(applyToAgents && applyToAgents.length > 0 ? { applyToAgents } : {}),
          ...(acknowledgeAutonomy ? { acknowledgeAutonomy } : {}),
        },
        {
          onError: (err) => {
            if (isAutonomyAckRefusal(err)) consent.ask(once);
            else toast.error(err instanceof Error ? err.message : "That change didn't save.");
          },
        }
      );
    consent.run(preset === 'full', once);
  };

  const choose = (preset: PermissionPreset) => {
    if (preset === data.preset && data.changeCount === 0) return;
    if (differing.length > 0) setPending(preset);
    else send(preset);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="preset-picker">
      <SegmentedControl
        aria-label="Preset"
        className="w-full"
        value={data.preset ?? ''}
        onValueChange={(next) => next && choose(next as PermissionPreset)}
        disabled={write.isPending}
      >
        {PERMISSION_PRESETS.map((preset) => (
          <SegmentedControlItem key={preset} value={preset} aria-label={PRESET_LABEL[preset]}>
            <span className="truncate">{PRESET_LABEL[preset]}</span>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>

      {data.preset === null ? (
        <p className="text-muted-foreground text-sm" data-testid="permissions-preset">
          Not chosen yet. Your agents work as they did before.{' '}
          <span className="text-xs">{preview}.</span>
        </p>
      ) : (
        <div className="flex flex-col gap-1 @lg:flex-row @lg:items-center @lg:justify-between">
          <div className="space-y-0.5">
            <p className="text-sm" data-testid="permissions-preset">
              <span className="font-medium">{presetHeadline(data.preset, data.changeCount)}</span>
              <span className="text-muted-foreground"> · {PRESET_SUMMARY[data.preset]}</span>
            </p>
            <p className="text-muted-foreground text-xs" data-testid="permissions-preset-preview">
              {preview} ·{' '}
              <PermissionWhy
                question={`Why is the preset set to ${PRESET_LABEL[data.preset]}?`}
                sentence={`${PRESET_LABEL[data.preset]} is the preset every agent starts from.`}
                {...(data.presetLastChange ? { lastChange: data.presetLastChange } : {})}
              />
            </p>
          </div>
          {data.changeCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              disabled={write.isPending}
              onClick={() => data.preset && choose(data.preset)}
            >
              Reset to {PRESET_LABEL[data.preset]}
            </Button>
          ) : null}
        </div>
      )}

      {/* What Full power's Files & commands stop does NOT cover (DOR-2102):
          someone with a standing acknowledgement meets no dialog here, so
          without this line the correction never reaches them. */}
      <PermissionModeScopeNote
        descriptor={CANONICAL_TRUST_STOPS.find((mode) => mode.stop === data.filesAndCommands.stop)}
      />

      <ApplyToOverridesDialog
        open={pending !== null}
        onCancel={() => setPending(null)}
        subject="Preset"
        title={pending ? `Switch everyone to ${PRESET_LABEL[pending]}?` : undefined}
        next={pending ? PRESET_LABEL[pending] : ''}
        agents={differing}
        affectedCount={affected}
        onKeep={() => {
          if (pending) send(pending);
          setPending(null);
        }}
        onUpdate={(ids) => {
          if (pending) send(pending, ids);
          setPending(null);
        }}
        pending={write.isPending}
      />

      <AutonomyConfirmDialog
        descriptor={consent.descriptor}
        canRemember={false}
        consentNote="Full power starts every new session here, and DorkOS will remember that you have read this."
        onCancel={consent.cancel}
        onConfirm={consent.confirm}
      />
    </div>
  );
}
