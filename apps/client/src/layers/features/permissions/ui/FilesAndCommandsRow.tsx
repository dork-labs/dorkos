import { ChevronRight, RotateCcw } from 'lucide-react';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import {
  describeAffectedAgents,
  type AgentPermissionsResponse,
  type PermissionPreset,
  type PermissionsResponse,
} from '@dorkos/shared/permissions';
import {
  isAutonomyAckRefusal,
  useAffectedAgentCount,
  useSetPermission,
} from '@/layers/entities/permissions';
import {
  Button,
  CANONICAL_TRUST_STOPS,
  PermissionModeScopeNote,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
  SegmentedControl,
  SegmentedControlItem,
  TrustModeIcon,
  stopLabel,
} from '@/layers/shared/ui';
import { AutonomyConfirmDialog } from '@/layers/features/status';
import { PRESET_LABEL, filesSourceText } from '../lib/permission-copy';
import { filesWhy, lastChangeWhy } from '../lib/permission-why';
import { PermissionWhy } from './PermissionWhy';
import { reportPermissionFailure } from '../lib/report-failure';
import { useAutonomyConsent } from '../model/use-autonomy-consent';

/** Props for {@link AgentFilesAndCommandsRow}. */
export interface AgentFilesAndCommandsRowProps {
  /** The agent. */
  agentId: string;
  /** Its name, for the "why?" question. */
  agentName: string;
  /** Its resolved Files & commands stop, and what it would inherit. */
  files: AgentPermissionsResponse['filesAndCommands'];
}

/**
 * One agent's Files & commands row: where its sessions stop for you when they
 * edit files and run commands (spec `agent-permissions` D16). Its own stop beats
 * the runtime's and the one everyone has, for every session, scheduled run and
 * room turn it takes. Reset puts it back on the inherited stop. Moving it to
 * Full autonomy asks first when nothing is on file, and sends the yes with the
 * change.
 *
 * @param props - See {@link AgentFilesAndCommandsRowProps}.
 */
export function AgentFilesAndCommandsRow({
  agentId,
  agentName,
  files,
}: AgentFilesAndCommandsRowProps) {
  const write = useSetPermission({ kind: 'agent', agentId });
  const consent = useAutonomyConsent();
  const own = files.source === 'agent';
  const inherited = files.inherited.stop;
  const shown: PermissionStop | null = files.stop;

  const save = (next: PermissionStop | null) => {
    const once = (acknowledgeAutonomy?: true) =>
      write.mutate(
        {
          kind: 'patch',
          filesAndCommands: next,
          surface: 'agent-page',
          ...(acknowledgeAutonomy ? { acknowledgeAutonomy } : {}),
        },
        {
          onError: (err) => {
            if (isAutonomyAckRefusal(err)) consent.ask(once);
            else reportPermissionFailure(err);
          },
        }
      );
    consent.run(next === 'autonomy', once);
  };

  // The same words the area rows use; the source is added only when it is not
  // simply the setting everyone has.
  const inheritedText = inherited
    ? `${own ? `Everyone else: ${stopLabel(inherited)}` : `Same as everyone (${stopLabel(inherited)})`}${
        files.inherited.source === 'runtime' ? ` · ${filesSourceText('runtime')}` : ''
      }`
    : filesSourceText(files.inherited.source);

  return (
    <div className="@container" data-testid="permission-row-files">
      <div className="flex flex-col gap-3 py-3 @lg:flex-row @lg:items-start @lg:justify-between @lg:gap-6">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5">
            {own ? (
              <span
                className="bg-primary size-1.5 shrink-0 rounded-full"
                aria-label="Set differently for this agent"
                role="img"
              />
            ) : null}
            <span className="text-sm font-medium">Files &amp; commands</span>
          </div>
          <p className="text-muted-foreground text-sm">
            Editing files and running commands in this agent’s sessions
          </p>
          <p className="text-muted-foreground text-xs">
            <span>{inheritedText}</span> ·{' '}
            <PermissionWhy
              question={`Why is Files & commands ${shown ? `set to ${stopLabel(shown)}` : 'not set'} for ${agentName}?`}
              sentence={filesWhy(shown, files.source)}
              {...(files.lastChange ? { lastChange: files.lastChange } : {})}
            />
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 @lg:items-end">
          <SegmentedControl
            aria-label="Files & commands"
            className="w-full @lg:w-auto"
            value={shown ?? ''}
            disabled={write.isPending}
            onValueChange={(next) => {
              if (next && next !== shown) save(next as PermissionStop);
            }}
          >
            {CANONICAL_TRUST_STOPS.map((mode) => (
              <SegmentedControlItem key={mode.id} value={mode.id} aria-label={mode.label}>
                <TrustModeIcon descriptor={mode} className="size-(--size-icon-xs) shrink-0" />
                <span className="truncate">{mode.label}</span>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {own ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start @lg:self-end"
              onClick={() => save(null)}
              disabled={write.isPending}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Reset to default
            </Button>
          ) : null}
        </div>
      </div>
      <PermissionModeScopeNote
        descriptor={CANONICAL_TRUST_STOPS.find((mode) => mode.stop === shown)}
        className="pb-3"
      />
      <AutonomyConfirmDialog
        descriptor={consent.descriptor}
        canRemember={false}
        consentNote="This agent’s new sessions will start here, and DorkOS will remember that you have read this."
        onCancel={consent.cancel}
        onConfirm={consent.confirm}
      />
    </div>
  );
}

/** Props for {@link DefaultFilesAndCommandsRow}. */
export interface DefaultFilesAndCommandsRowProps {
  /** The default layer's Files & commands row, from `GET /api/permissions`. */
  files: PermissionsResponse['filesAndCommands'];
  /** The chosen preset, for where the stop came from. */
  preset: PermissionPreset | null;
  /**
   * Change the stop everyone has. The caller owns the write: it is the
   * `runtimes.defaultTrustStop` setting, and Settings has one consent-gated
   * path for it.
   */
  onChange: (stop: PermissionStop) => void;
  /** Disable the control while a write is in flight. */
  disabled?: boolean;
  /** Runtime ids to names, for the per-runtime note. */
  runtimeLabel?: (runtime: string) => string;
}

/**
 * The Files & commands row at the default layer: the stop every agent's new
 * sessions start at, where it came from, the runtimes set differently in
 * Settings → Runtimes, and the agents with a stop of their own (each with a
 * Reset).
 *
 * @param props - See {@link DefaultFilesAndCommandsRowProps}.
 */
export function DefaultFilesAndCommandsRow({
  files,
  preset,
  onChange,
  disabled = false,
  runtimeLabel = (runtime) => runtime,
}: DefaultFilesAndCommandsRowProps) {
  const affected = useAffectedAgentCount({ kind: 'files' });
  const source =
    files.stop === null
      ? filesSourceText('runtime-own')
      : files.presetStop === null
        ? ''
        : files.stop === files.presetStop
          ? preset
            ? `From ${PRESET_LABEL[preset]}`
            : 'From your preset'
          : 'Changed from your preset';

  return (
    <div className="@container" data-testid="permission-row-files">
      <div className="flex flex-col gap-3 py-3 @lg:flex-row @lg:items-start @lg:justify-between @lg:gap-6">
        <div className="min-w-0 space-y-1">
          <span className="text-sm font-medium">Files &amp; commands</span>
          <p className="text-muted-foreground text-sm">
            Editing files and running commands in a session
          </p>
          <p className="text-muted-foreground text-xs">
            <span>
              {[source, affected !== undefined ? describeAffectedAgents(affected) : '']
                .filter(Boolean)
                .join(' · ')}
            </span>{' '}
            ·{' '}
            <PermissionWhy
              question={`Why is Files & commands ${files.stop ? `set to ${stopLabel(files.stop)}` : 'not set'}?`}
              sentence={filesWhy(files.stop, files.stop === null ? 'runtime-own' : 'default')}
              {...(files.lastChange ? { lastChange: files.lastChange } : {})}
            />
          </p>
          {files.runtimes.map((entry) => (
            <p key={entry.runtime} className="text-muted-foreground text-xs">
              {runtimeLabel(entry.runtime)} starts at {stopLabel(entry.stop)} (Settings → Runtimes)
            </p>
          ))}
        </div>
        <div className="flex shrink-0 flex-col gap-2 @lg:items-end">
          <SegmentedControl
            aria-label="Files & commands"
            className="w-full @lg:w-auto"
            value={files.stop ?? ''}
            disabled={disabled}
            onValueChange={(next) => {
              if (next && next !== files.stop) onChange(next as PermissionStop);
            }}
          >
            {CANONICAL_TRUST_STOPS.map((mode) => (
              <SegmentedControlItem key={mode.id} value={mode.id} aria-label={mode.label}>
                <TrustModeIcon descriptor={mode} className="size-(--size-icon-xs) shrink-0" />
                <span className="truncate">{mode.label}</span>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <FilesExceptionsChip agents={files.exceptions} />
        </div>
      </div>
      <PermissionModeScopeNote
        descriptor={CANONICAL_TRUST_STOPS.find((mode) => mode.stop === files.stop)}
        className="pb-3"
      />
    </div>
  );
}

/** One agent with its own Files & commands stop, with a Reset. */
function FilesExceptionRow({
  agent,
}: {
  agent: PermissionsResponse['filesAndCommands']['exceptions'][number];
}) {
  const write = useSetPermission({ kind: 'agent', agentId: agent.agentId });
  const changed = lastChangeWhy(agent.lastChange);
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="min-w-0 text-sm">
        <span className="block break-words">
          {agent.agentName}: {stopLabel(agent.stop)}
        </span>
        {/* Why it differs: who set it, when and where. */}
        {changed ? <span className="text-muted-foreground block text-xs">{changed}</span> : null}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={write.isPending}
        aria-label={`Reset ${agent.agentName} to the default`}
        onClick={() =>
          write.mutate(
            { kind: 'patch', filesAndCommands: null, surface: 'settings' },
            { onError: reportPermissionFailure }
          )
        }
      >
        <RotateCcw className="size-3.5" aria-hidden />
        Reset
      </Button>
    </li>
  );
}

/** "2 agents differ ›" for Files & commands. Renders nothing when none do. */
function FilesExceptionsChip({
  agents,
}: {
  agents: PermissionsResponse['filesAndCommands']['exceptions'];
}) {
  if (agents.length === 0) return null;
  return (
    <ResponsivePopover>
      <ResponsivePopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground self-start @lg:self-end">
          {agents.length === 1 ? '1 agent differs' : `${agents.length} agents differ`}
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent className="w-80 space-y-2">
        <ResponsivePopoverTitle className="text-sm font-medium">
          Set differently for Files &amp; commands
        </ResponsivePopoverTitle>
        <ul className="space-y-1">
          {agents.map((agent) => (
            <FilesExceptionRow key={agent.agentId} agent={agent} />
          ))}
        </ul>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
