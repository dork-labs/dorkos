/**
 * Everything about one extension past its row: the full description, the
 * facts (version, author, who it is for, where it runs from, its access, what
 * it gives agents), its settings, and what can be done with it.
 *
 * @module features/extensions/ui/ExtensionRowDetail
 */
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { StepUpExtensionRisk } from '@dorkos/shared/step-up';
import {
  extensionRestartingCopy,
  isExtensionServerErrorCode,
} from '@dorkos/shared/extension-server-status';
import { Button, DevLinkPath } from '@/layers/shared/ui';
import { openLink } from '@/layers/shared/lib';
import {
  ExtensionAgentGifts,
  agentGiftsFromRecord,
  permissionViewFromRecord,
} from '@/layers/entities/extension';
import { PanelTabPlacementSection } from './PanelTabPlacementEditor';
import { RoomAccessEditor } from './RoomAccessEditor';
import { ForwardAgentsEditor } from './ForwardAgentsEditor';
import { StepUpRiskRow } from './StepUpRiskRow';
import { isExtensionOn } from '../lib/extension-row-state';
import { RemoveExtensionControl, canRemoveHere } from './RemoveExtensionControl';

/** Where a dev link is switched or unlinked: the Marketplace's Installed list (DOR-2696). */
const INSTALLED_LINK = '/marketplace?view=installed';

/** Props for {@link ExtensionRowDetail}. */
export interface ExtensionRowDetailProps {
  /** The extension record. */
  extension: ExtensionRecordPublic;
  /** Stop an allowed extension running (revokes the approval). */
  onStopRunning: () => void;
  /** Whether an approve/stop call is in progress. */
  isSettingApproval: boolean;
  /** Turn it off, offered by the step-up row. */
  onTurnOff: () => void;
  /** Whether a toggle is in progress. */
  isToggling: boolean;
  /** Why it keeps "Confirm it's you" off, when it does (DOR-3234). */
  stepUpRisk?: StepUpExtensionRisk;
  /** Remove it (DOR-3541), when the list can. */
  onRemove?: () => void;
  /** Whether a remove is in flight. */
  isRemoving?: boolean;
}

/** Its access, in one line (the approval panel says it in full). */
function accessLine(extension: ExtensionRecordPublic): string | null {
  const permissions = permissionViewFromRecord(extension);
  if (!permissions) return null;
  if (permissions.runtime === 'subprocess') {
    return permissions.net.length > 0
      ? `Runs on its own. Can reach ${permissions.net.join(', ')}`
      : 'Runs on its own. Reaches nothing on the internet';
  }
  // Screens alone run sealed off with no access of their own (DOR-3293).
  return permissions.hasServer === false
    ? null
    : 'Runs inside DorkOS, with full access to this computer';
}

/** One fact: a label and its value. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words max-sm:mb-2">{children}</dd>
    </div>
  );
}

/**
 * The facts and actions of one open row.
 *
 * @param props - {@link ExtensionRowDetailProps}.
 */
export function ExtensionRowDetail({
  extension,
  onStopRunning,
  isSettingApproval,
  onTurnOff,
  isToggling,
  stepUpRisk,
  onRemove,
  isRemoving = false,
}: ExtensionRowDetailProps) {
  const { manifest, serverError } = extension;
  const canStop = extension.origin === 'user' && extension.approvedToRun;
  const removable = onRemove !== undefined && canRemoveHere(extension);
  const isOn = isExtensionOn(extension);
  const gifts = agentGiftsFromRecord(extension);
  const access = accessLine(extension);

  return (
    <div className="space-y-4">
      {manifest.description && <p className="text-sm">{manifest.description}</p>}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm max-sm:grid-cols-1">
        <Fact label="Version">{manifest.version}</Fact>
        {manifest.author && <Fact label="By">{manifest.author}</Fact>}
        <Fact label="For">{extension.scope === 'local' ? 'This project only' : 'Everyone'}</Fact>
        {/* Runs from a folder the person linked (DOR-2696). The switch back
            lives on the package's Installed row, which this links to. */}
        {extension.devLink && (
          <Fact label="Runs from">
            <span
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
              data-testid={`extension-dev-link-${extension.id}`}
            >
              <DevLinkPath path={extension.devLink.path} className="min-w-0" />
              <button
                type="button"
                onClick={() => void openLink(INSTALLED_LINK)}
                className="text-muted-foreground hover:text-foreground focus-ring rounded-sm text-xs underline underline-offset-2"
              >
                Unlink or switch
              </button>
            </span>
          </Fact>
        )}
        {access && <Fact label="Access">{access}</Fact>}
        {(gifts.tools.length > 0 || gifts.skills.length > 0) && (
          <Fact label="Agents">
            <ExtensionAgentGifts
              gifts={gifts}
              variant="list"
              data-testid={`extension-agent-gifts-${extension.id}`}
            />
          </Fact>
        )}
      </dl>

      {/* A failed rebuild while the last version keeps running: said beside an
          otherwise healthy extension, since everything else about it is fine. */}
      {serverError && !isExtensionServerErrorCode(serverError.code) && (
        <p
          className="text-status-warning-fg text-sm"
          data-testid={`extension-server-status-${extension.id}`}
        >
          Couldn’t rebuild its server part: {serverError.message}. The last version still runs.
        </p>
      )}
      {extension.restartingAt && !serverError && (
        <p className="text-muted-foreground text-sm" role="status">
          {extensionRestartingCopy(manifest.name)}
        </p>
      )}
      {extension.originProblem === 'changed' && extension.approvedToRun && (
        <p
          className="text-muted-foreground text-sm"
          data-testid={`extension-run-allowed-${extension.id}`}
        >
          You approved its changed files. Any further change asks again.
        </p>
      )}

      {/* Why this keeps "Confirm it's you" off, and the fix (DOR-3234). */}
      {stepUpRisk && (
        <StepUpRiskRow
          risk={stepUpRisk}
          id={extension.id}
          name={manifest.name}
          onTurnOff={onTurnOff}
          isToggling={isToggling}
        />
      )}

      {/* Its settings: where its tabs show, the rooms it may use, the agents it
          forwards to. Each draws nothing when it does not apply. */}
      {isOn && <PanelTabPlacementSection extensionId={extension.id} />}
      {manifest.capabilities?.rooms === true && (
        <RoomAccessEditor extensionId={extension.id} name={manifest.name} />
      )}
      {manifest.capabilities?.forward === true && (
        <ForwardAgentsEditor extensionId={extension.id} name={manifest.name} />
      )}

      {(canStop || removable) && (
        <div className="flex flex-wrap items-center gap-2">
          {canStop && (
            <Button
              size="sm"
              variant="ghost"
              // Pulled left by its own padding, so its words line up with the facts.
              className="-ml-3"
              onClick={onStopRunning}
              disabled={isSettingApproval}
              data-testid={`extension-stop-running-${extension.id}`}
            >
              Stop it running
            </Button>
          )}
          {/* Always last, and never beside an Allow. */}
          {removable && (
            <RemoveExtensionControl
              name={manifest.name}
              onRemove={onRemove}
              isRemoving={isRemoving}
            />
          )}
        </div>
      )}
    </div>
  );
}
