import { useState } from 'react';
import { AlertTriangle, XCircle, Puzzle, ChevronDown, ShieldCheck } from 'lucide-react';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { Badge, Button, Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

interface ExtensionCardProps {
  /** The extension record from the server. */
  extension: ExtensionRecordPublic;
  /** Called when the enable/disable toggle changes. */
  onToggle: (id: string, enabled: boolean) => void;
  /** Whether an API call for this extension is in progress. */
  isToggling: boolean;
  /** Called when the person allows or stops this extension running code in DorkOS. */
  onSetRunApproval: (id: string, approve: boolean) => void;
  /** Whether an approve/stop call for this extension is in progress. */
  isSettingApproval: boolean;
}

const TERMINAL_STATUSES = new Set(['disabled', 'discovered', 'incompatible', 'invalid']);

/** Per-extension card in the Extensions settings tab. */
export function ExtensionCard({
  extension,
  onToggle,
  isToggling,
  onSetRunApproval,
  isSettingApproval,
}: ExtensionCardProps) {
  const { manifest, status, scope, error, serverError, origin, approvedToRun } = extension;
  const [errorExpanded, setErrorExpanded] = useState(false);

  const isEnabled = !TERMINAL_STATUSES.has(status);
  const isIncompatible = status === 'incompatible';
  const isInvalid = status === 'invalid';
  const hasError = status === 'compile_error' || status === 'activate_error';
  const canToggle = !isIncompatible && !isInvalid;
  // `canDisable: false` locks ONLY core extensions (matching the server-side
  // guard in `extension-manager.disable`). User/marketplace extensions are
  // always disableable, so the manifest flag is ignored for them — keeping the
  // two enforcement points in lockstep (ADR-0271). A locked extension renders a
  // "Required" hint instead of a toggle.
  const canDisable = !(origin === 'core' && manifest.canDisable === false);
  // Nothing about an unapproved extension runs: the server refuses its `server.ts`
  // AND withholds its client bundle, so the browser never imports it either
  // (DOR-516). This only picks which reach to name, because a server entry or data
  // proxy adds "anything on this machine" to "anything you can do in DorkOS".
  const runsInServer = extension.hasServerEntry || extension.hasDataProxy;
  // Health/availability state — communicated by a badge that is visually
  // distinct from the on/off toggle (an errored extension can still be "on").
  const healthLabel = hasError
    ? 'Error'
    : isIncompatible
      ? 'Incompatible'
      : isInvalid
        ? 'Invalid'
        : null;

  return (
    <div
      data-slot="extension-card"
      data-testid={`extension-card-${extension.id}`}
      className={cn(
        'bg-card rounded-xl border p-4',
        hasError && 'border-amber-500/50',
        (isIncompatible || isInvalid) && 'opacity-70'
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* Name row */}
          <div className="flex flex-wrap items-center gap-2">
            {hasError && (
              <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
            )}
            {(isIncompatible || isInvalid) && !hasError && (
              <XCircle className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            )}
            {!hasError && !isIncompatible && !isInvalid && (
              <Puzzle className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            )}

            <span className="font-medium">{manifest.name}</span>
            <span className="text-muted-foreground text-sm">v{manifest.version}</span>
          </div>

          {/* Description */}
          {manifest.description && (
            <p className="text-muted-foreground text-sm">{manifest.description}</p>
          )}

          {/* Incompatible message */}
          {isIncompatible && manifest.minHostVersion && (
            <p className="text-muted-foreground text-sm">
              Requires DorkOS &gt;= {manifest.minHostVersion}
            </p>
          )}

          {/* Error summary with expandable details */}
          {hasError && error && (
            <div className="space-y-1">
              <p className="text-sm text-amber-600 dark:text-amber-400">
                {status === 'compile_error' ? 'Compilation error: ' : 'Activation failed: '}
                {error.message}
              </p>
              {error.details && (
                <button
                  type="button"
                  onClick={() => setErrorExpanded((v) => !v)}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                  aria-expanded={errorExpanded}
                >
                  <ChevronDown
                    className={cn('size-3 transition-transform', errorExpanded && 'rotate-180')}
                  />
                  {errorExpanded ? 'Hide details' : 'Show details'}
                </button>
              )}
              {errorExpanded && error.details && (
                <pre className="bg-muted mt-1 max-h-32 overflow-auto rounded-md p-2 text-xs">
                  {error.details}
                </pre>
              )}
            </div>
          )}

          {/* The extension's server half could not be rebuilt, so DorkOS kept the
              version it already had running. Said beside an otherwise healthy
              extension rather than through the status badge: everything else
              about it — including the part that draws in this window — is fine. */}
          {serverError && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              Server side failed to rebuild: {serverError.message}. The previous version is still
              running.
            </p>
          )}

          {/* Permission to run code inside DorkOS (DOR-516). Core extensions ship
              with DorkOS and are never asked about. */}
          {origin === 'user' &&
            (approvedToRun ? (
              <div
                className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs"
                data-testid={`extension-run-allowed-${extension.id}`}
              >
                <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
                <span>You allowed this to run inside DorkOS.</span>
                <button
                  type="button"
                  onClick={() => onSetRunApproval(extension.id, false)}
                  disabled={isSettingApproval}
                  className="hover:text-foreground underline underline-offset-2 disabled:opacity-50"
                >
                  Stop it
                </button>
              </div>
            ) : (
              <div
                className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
                data-testid={`extension-needs-approval-${extension.id}`}
              >
                <p className="text-sm font-medium">This extension is waiting for you</p>
                <p className="text-muted-foreground text-sm">
                  {runsInServer
                    ? 'None of it has run yet. Allowing it lets its code run inside DorkOS, both ' +
                      'on this machine, where it can reach anything DorkOS can, and on this page, ' +
                      'signed in as you. Allow it only if you trust where it came from.'
                    : 'None of it has run yet. Allowing it lets its code run on this page, signed ' +
                      'in as you, so it can do anything you can do in DorkOS. Allow it only if ' +
                      'you trust where it came from.'}
                </p>
                <Button
                  size="sm"
                  onClick={() => onSetRunApproval(extension.id, true)}
                  disabled={isSettingApproval}
                  data-testid={`extension-approve-run-${extension.id}`}
                >
                  Allow it to run
                </Button>
              </div>
            ))}

          {/* Metadata row */}
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">{scope}</Badge>
            {healthLabel && (
              <Badge
                variant={healthLabel === 'Error' ? 'destructive' : 'secondary'}
                data-testid={`extension-health-${extension.id}`}
              >
                {healthLabel}
              </Badge>
            )}
            {manifest.author && <span>{manifest.author}</span>}
          </div>
        </div>

        {/* Enable/disable toggle — locked for required (canDisable:false) extensions */}
        <div className="flex shrink-0 items-center pt-0.5">
          {canDisable ? (
            <Switch
              checked={isEnabled}
              onCheckedChange={(checked) => onToggle(extension.id, checked)}
              disabled={!canToggle || isToggling}
              aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${manifest.name}`}
            />
          ) : (
            <Badge
              variant="secondary"
              title="This extension is required and is always on"
              data-testid={`extension-required-${extension.id}`}
            >
              Required
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}
